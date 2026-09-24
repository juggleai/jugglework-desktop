import { describe, expect, mock, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

import { ApiError, formatError } from "./errors.js";
import { admitOpencodePrompt, opencodeAdmissionId } from "./opencode-admission.js";

type AdmissionInput = Parameters<typeof admitOpencodePrompt>[1];
type PromptBody = Pick<AdmissionInput, "id" | "prompt" | "delivery">;

const input: AdmissionInput = {
  workspaceId: "ws_test",
  sessionId: "ses_test",
  source: "local-queue",
  id: "request_test",
  prompt: { text: "PRIVATE_PROMPT_SENTINEL" },
  delivery: "queue",
};
const mappedId = "msg_0023c9be39aee0b972e26872e0d312a457e362e214465fe72d5feb5b7276842e";
const secret = "sk-PRIVATE_SECRET_SENTINEL";
const upstreamBody = "PRIVATE_UPSTREAM_BODY_SENTINEL";
const sensitive = { message: upstreamBody, prompt: input.prompt, secret };

function mockClient(
  respond: (body: PromptBody, request: Request) => Response | Promise<Response> = (body, request) =>
    Response.json({
      data: {
        id: body.id,
        sessionID: decodeURIComponent(new URL(request.url).pathname.split("/")[3]!),
        delivery: body.delivery,
      },
    }),
  throwOnError = false,
) {
  const bodies: PromptBody[] = [];
  const fetch = mock(async (request: Request) => {
    const body = (await request.json()) as PromptBody;
    bodies.push(body);
    return respond(body, request);
  });
  const client = createOpencodeClient({
    baseUrl: "https://opencode.invalid",
    headers: { Authorization: `Bearer ${secret}` },
    fetch: fetch as unknown as typeof globalThis.fetch,
    throwOnError,
  });
  return { client, fetch, bodies };
}

async function expectAdmissionError(
  admission: Promise<void>,
  code: string,
  upstreamStatus?: number,
  sessionId = input.sessionId,
) {
  const error = await admission.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(ApiError);
  if (!(error instanceof ApiError)) throw new Error("Expected admission to reject with ApiError");
  expect(error.status).toBe(code === "opencode_admission_conflict" ? 409 : 502);
  expect(error.code).toBe(code);
  expect(error.details).toEqual({
    path: `/api/session/${encodeURIComponent(sessionId)}/prompt`,
    ...(upstreamStatus === undefined ? {} : { status: upstreamStatus }),
  });
  const serialized = JSON.stringify(formatError(error));
  for (const value of [upstreamBody, "PRIVATE_PROMPT_SENTINEL", secret]) {
    expect(serialized).not.toContain(value);
    expect(String(error)).not.toContain(value);
  }
  return error;
}

describe("opencodeAdmissionId", () => {
  test("preserves already valid legacy engine IDs across upgrades", async () => {
    const legacy = { ...input, id: "msg_existing_before_upgrade" };
    expect(opencodeAdmissionId(legacy)).toBe(legacy.id);
    const { client, bodies } = mockClient((body) => {
      if (body.id !== legacy.id) throw new Error("Retry changed the legacy identity");
      if (body.prompt?.text !== legacy.prompt?.text) return Response.json(sensitive, { status: 409 });
      return Response.json({ data: { id: legacy.id, sessionID: legacy.sessionId, delivery: legacy.delivery } });
    });
    await admitOpencodePrompt(client, legacy);
    await expectAdmissionError(admitOpencodePrompt(client, { ...legacy, prompt: { text: "edited" } }), "opencode_admission_conflict", 409);
    expect(bodies.map((body) => body.id)).toEqual([legacy.id, legacy.id]);
  });

  test("pins the versioned msg_ mapping across retries and fresh processes", async () => {
    expect(opencodeAdmissionId(input)).toBe(mappedId);
    expect(opencodeAdmissionId(structuredClone(input))).toBe(mappedId);
    expect(mappedId).toMatch(/^msg_[a-f0-9]{64}$/);

    // Separate runtimes catch accidental dependence on process-local state or randomness.
    const script = `
      import { opencodeAdmissionId } from ${JSON.stringify(new URL("./opencode-admission.ts", import.meta.url).href)};
      console.log(opencodeAdmissionId(${JSON.stringify(input)}));
    `;
    for (let restart = 0; restart < 2; restart++) {
      const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(mappedId);
    }
  });

  test("isolates workspace, session, every source, and correlation ID on the wire", async () => {
    const identities: AdmissionInput[] = [
      input,
      { ...input, workspaceId: "ws_other" },
      { ...input, sessionId: "ses_other" },
      { ...input, source: "local-steer" },
      { ...input, source: "remote-pending" },
      { ...input, id: "request_other" },
      { ...input, workspaceId: "a:b", sessionId: "c" },
      { ...input, workspaceId: "a", sessionId: "b:c" },
    ];
    const { client, bodies } = mockClient();
    for (const identity of identities) await admitOpencodePrompt(client, identity);
    expect(bodies.map((body) => body.id)).toEqual(identities.map(opencodeAdmissionId));
    expect(new Set(bodies.map((body) => body.id)).size).toBe(identities.length);
    for (const body of bodies) expect(body.id).toMatch(/^msg_[a-f0-9]{64}$/);
  });
});

describe("admitOpencodePrompt", () => {
  test.each(["queue", "steer"] as const)("accepts a matching 200 %s response and sends the mapped ID without mutating input", async (delivery) => {
    const original: AdmissionInput = { ...structuredClone(input), delivery, sessionId: "ses/path ?#%" };
    const before = structuredClone(original);
    Object.freeze(original.prompt);
    Object.freeze(original);
    const controller = new AbortController();
    const { client, fetch, bodies } = mockClient();

    expect(await admitOpencodePrompt(client, original, controller.signal)).toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(1);
    const request = fetch.mock.calls[0]![0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`https://opencode.invalid/api/session/${encodeURIComponent(original.sessionId)}/prompt`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${secret}`);
    expect(bodies).toEqual([{ id: opencodeAdmissionId(original), prompt: before.prompt, delivery }]);
    expect(bodies[0]!.id).not.toBe(original.id);
    expect(original).toEqual(before);
    controller.abort();
    expect(request.signal.aborted).toBe(true);
  });

  for (const [status, code] of [
    [400, "opencode_admission_invalid_request"],
    [401, "opencode_admission_unauthorized"],
    [403, "opencode_admission_unauthorized"],
    [404, "opencode_admission_not_found"],
    [409, "opencode_admission_conflict"],
    [500, "opencode_admission_unconfirmed"],
  ] as const) {
    test.each(["json", "text"])(`sanitizes ${status} %s failures`, async (format) => {
      const { client, fetch } = mockClient(() =>
        format === "json"
          ? Response.json(sensitive, { status })
          : new Response(JSON.stringify(sensitive), { status, headers: { "Content-Type": "text/plain" } }),
      );
      const before = structuredClone(input);
      await expectAdmissionError(admitOpencodePrompt(client, input), code, status);
      expect(input).toEqual(before);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  test.each([false, true])("sanitizes network throws with SDK throwOnError=%s", async (throwOnError) => {
    const { client, fetch } = mockClient(() => {
      throw new Error(JSON.stringify(sensitive));
    }, throwOnError);
    await expectAdmissionError(admitOpencodePrompt(client, input), "opencode_admission_unconfirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  const malformedResponses: Array<[string, () => Response]> = [
    ["missing envelope", () => Response.json(sensitive)],
    ["null body", () => Response.json(null)],
    ["null data", () => Response.json({ data: null, ...sensitive })],
    ["empty data", () => Response.json({ data: {}, ...sensitive })],
    ["unwrapped admission", () => Response.json({ id: mappedId, sessionID: input.sessionId, delivery: input.delivery, ...sensitive })],
    ["empty 200", () => new Response(null, { status: 200 })],
    ["text 200", () => new Response(JSON.stringify(sensitive), { headers: { "Content-Type": "text/plain" } })],
    ["empty 204", () => new Response(null, { status: 204 })],
  ];
  test.each(malformedResponses)("rejects malformed success: %s", async (_name, response) => {
    const { client, fetch } = mockClient(response);
    await expectAdmissionError(admitOpencodePrompt(client, input), "opencode_invalid_response", _name === "empty 204" ? 204 : 200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("sanitizes a malformed JSON 200 that throws during SDK parsing", async () => {
    const { client } = mockClient(() => new Response(`{${JSON.stringify(sensitive)}`, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await expectAdmissionError(admitOpencodePrompt(client, input), "opencode_admission_unconfirmed");
  });

  test.each([
    ["correlation ID instead of mapped ID", { id: input.id }],
    ["wrong message ID", { id: "msg_other" }],
    ["wrong session", { sessionID: "ses_other" }],
    ["wrong delivery", { delivery: "steer" }],
    ["missing ID", { id: undefined }],
    ["missing session", { sessionID: undefined }],
    ["missing delivery", { delivery: undefined }],
  ])("rejects a 200 with %s", async (_name, mismatch) => {
    const { client } = mockClient((body) => Response.json({
      data: { id: body.id, sessionID: input.sessionId, delivery: body.delivery, ...mismatch, ...sensitive },
    }));
    await expectAdmissionError(admitOpencodePrompt(client, input), "opencode_invalid_response", 200);
  });

  test("reuses the ID after an unknown outcome, including with a recreated SDK client", async () => {
    const { client, fetch, bodies } = mockClient((body) => {
      if (bodies.length === 1) throw new Error(`Response lost after upstream commit: ${JSON.stringify(sensitive)}`);
      return Response.json({ data: { id: body.id, sessionID: input.sessionId, delivery: body.delivery } });
    });
    const before = structuredClone(input);
    await expectAdmissionError(admitOpencodePrompt(client, input), "opencode_admission_unconfirmed");
    expect(fetch).toHaveBeenCalledTimes(1);
    await admitOpencodePrompt(client, structuredClone(input));
    const restarted = mockClient();
    await admitOpencodePrompt(restarted.client, structuredClone(input));
    expect([...bodies, ...restarted.bodies].map((body) => body.id)).toEqual([mappedId, mappedId, mappedId]);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(restarted.bodies[0]).toEqual(bodies[0]);
    expect(input).toEqual(before);
  });

  test.each(["content", "delivery"])("preserves the ID when retry %s changes so upstream can report conflict", async (change) => {
    const { client, bodies } = mockClient((body) => bodies.length === 1
      ? Response.json({ data: { id: body.id, sessionID: input.sessionId, delivery: body.delivery } })
      : Response.json(sensitive, { status: 409 }));
    await admitOpencodePrompt(client, input);
    const changed: AdmissionInput = change === "content"
      ? { ...input, prompt: { text: "Different content" } }
      : { ...input, delivery: "steer" };
    const before = structuredClone(changed);
    await expectAdmissionError(admitOpencodePrompt(client, changed), "opencode_admission_conflict", 409);
    expect(bodies.map((body) => body.id)).toEqual([mappedId, mappedId]);
    expect(bodies[1]).toEqual({ id: mappedId, prompt: changed.prompt, delivery: changed.delivery });
    expect(bodies[1]).not.toEqual(bodies[0]);
    expect(changed).toEqual(before);
  });
});

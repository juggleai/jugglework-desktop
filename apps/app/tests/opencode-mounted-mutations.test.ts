import { afterEach, describe, expect, test } from "bun:test";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import { createClient } from "../src/app/lib/opencode";

const originalFetch = globalThis.fetch;

type FetchCall = {
  url: string;
  method: string;
  body: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : null;
    const rawBody = init?.body ?? request?.body;
    let body: unknown = undefined;
    if (typeof rawBody === "string" && rawBody) body = JSON.parse(rawBody);
    const call = {
      url: request?.url ?? String(input),
      method: init?.method ?? request?.method ?? "GET",
      body,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function mountedClient() {
  return createClient("https://worker.example.test/workspace/workspace-1/opencode", undefined, {
    mode: "jugglework",
    token: "renderer-token",
  });
}

function activeRun(runId: string, origin: "local-renderer" | "remote-control" = "local-renderer") {
  return {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    runId,
    generation: 1,
    origin,
    startCommandCorrelationId: "start-correlation",
    abortCommandCorrelationId: null,
    status: "running",
    observedActive: true,
    startedAt: 1,
    updatedAt: 2,
    activeObservedAt: 2,
    abortRequestedAt: null,
  } as const;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mounted JuggleWork session mutations", () => {
  test("routes promptAsync through run start and preserves the complete prompt body", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/workspace/workspace-1/sessions/session-1/runs/start")) {
        return jsonResponse({ run: activeRun("run-local") }, 202);
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const prompt = {
      sessionID: "session-1",
      directory: "/not-forwarded-as-prompt-data",
      workspace: "sdk-workspace",
      messageID: "message-1",
      model: { providerID: "provider-1", modelID: "model-1" },
      agent: "build",
      noReply: true,
      tools: { read: true, write: false },
      format: { type: "json_schema" as const, schema: { type: "object" }, retryCount: 2 },
      system: "system text",
      variant: "high",
      parts: [{ type: "text" as const, text: "hello" }],
      reasoning_effort: "medium",
    };

    const result = await mountedClient().session.promptAsync(prompt);

    expect(result.error).toBeUndefined();
    expect(result.response.status).toBe(200);
    expect(result.request.method).toBe("POST");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain("/opencode/session/session-1/prompt_async");
    expect(calls[0]?.body).toEqual({
      origin: "local-renderer",
      startCommandCorrelationId: expect.any(String),
      prompt: {
        messageID: prompt.messageID,
        model: prompt.model,
        agent: prompt.agent,
        noReply: prompt.noReply,
        tools: prompt.tools,
        format: prompt.format,
        system: prompt.system,
        variant: prompt.variant,
        parts: prompt.parts,
        reasoning_effort: prompt.reasoning_effort,
      },
    });
  });

  test("returns session_busy from a local/remote start race without direct fallback", async () => {
    const calls = mockFetch(() => jsonResponse({
      code: "session_busy",
      message: "The session already has an active run",
      details: { currentRunId: "run-remote" },
    }, 409));

    const result = await mountedClient().session.promptAsync({
      sessionID: "session-1",
      parts: [{ type: "text", text: "race" }],
    });

    expect(result.response.status).toBe(409);
    expect(result.error).toBeInstanceOf(JuggleWorkServerError);
    expect(result.error).toMatchObject({
      code: "session_busy",
      details: { currentRunId: "run-remote" },
    });
    expect(calls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("/opencode/session/session-1/prompt_async"))).toBe(false);
  });

  test("aborts the authoritative active run instead of a stale locally started run", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/sessions/session-1/runs/start")) {
        return jsonResponse({ run: activeRun("run-stale-local") }, 202);
      }
      if (call.url.endsWith("/workspace/workspace-1/session-runs")) {
        return jsonResponse({ items: [activeRun("run-authoritative-remote", "remote-control")] });
      }
      if (call.url.endsWith("/sessions/session-1/runs/run-authoritative-remote/abort")) {
        return jsonResponse({
          run: { ...activeRun("run-authoritative-remote", "remote-control"), status: "aborting" },
          abortRequested: true,
        }, 202);
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = mountedClient();
    await client.session.promptAsync({ sessionID: "session-1", parts: [{ type: "text", text: "start" }] });

    const result = await client.session.abort({ sessionID: "session-1" });

    expect(result.data).toBe(true);
    expect(calls.map((call) => call.url)).toEqual([
      "https://worker.example.test/workspace/workspace-1/sessions/session-1/runs/start",
      "https://worker.example.test/workspace/workspace-1/session-runs",
      "https://worker.example.test/workspace/workspace-1/sessions/session-1/runs/run-authoritative-remote/abort",
    ]);
    expect(calls[2]?.body).toEqual({ abortCommandCorrelationId: expect.any(String) });
  });

  test("returns false when the authoritative active-run list has no matching session", async () => {
    const calls = mockFetch(() => jsonResponse({ items: [] }));

    const result = await mountedClient().session.abort({ sessionID: "session-1" });

    expect(result.data).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("returns run_mismatch from the expected-run abort without direct fallback", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/workspace/workspace-1/session-runs")) {
        return jsonResponse({ items: [activeRun("run-listed")] });
      }
      return jsonResponse({
        code: "run_mismatch",
        message: "The expected run does not match the active run",
        details: { currentRunId: "run-newer" },
      }, 409);
    });

    const result = await mountedClient().session.abort({ sessionID: "session-1" });

    expect(result.response.status).toBe(409);
    expect(result.error).toBeInstanceOf(JuggleWorkServerError);
    expect(result.error).toMatchObject({
      code: "run_mismatch",
      details: { currentRunId: "run-newer" },
    });
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.includes("/opencode/session/session-1/abort"))).toBe(false);
  });
});

describe("direct OpenCode session mutations", () => {
  test("retains SDK promptAsync and abort behavior", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/session/session-direct/prompt_async")) return new Response(null, { status: 204 });
      if (call.url.endsWith("/session/session-direct/abort")) return jsonResponse(true);
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = createClient("https://opencode.example.test");

    const promptResult = await client.session.promptAsync({
      sessionID: "session-direct",
      parts: [{ type: "text", text: "direct" }],
    });
    const abortResult = await client.session.abort({ sessionID: "session-direct" });

    expect(promptResult.error).toBeUndefined();
    expect(promptResult.response.status).toBe(204);
    expect(abortResult.data).toBe(true);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://opencode.example.test/session/session-direct/prompt_async",
      "POST https://opencode.example.test/session/session-direct/abort",
    ]);
  });
});

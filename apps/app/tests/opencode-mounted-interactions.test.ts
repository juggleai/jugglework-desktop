import { afterEach, describe, expect, test } from "bun:test";

import { JuggleWorkServerError } from "../src/app/lib/jugglework-server";
import { createClient } from "../src/app/lib/opencode";

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; method: string; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = request.method === "GET" || request.method === "HEAD" ? "" : await request.clone().text();
    const call = {
      url: request.url,
      method: request.method,
      body: text ? JSON.parse(text) : undefined,
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

const questions = [
  { id: "explicit", question: "First question", header: "First", options: [{ label: "A", description: "A" }] },
  { question: "Question without an explicit identifier beyond thirty-two characters", header: "Second", options: [{ label: "B", description: "B" }] },
];

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("mounted JuggleWork interaction mutations", () => {
  test("routes legacy and v2 permission replies through semantic APIs", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/opencode/permission")) {
        return jsonResponse([{ id: "permission-legacy", sessionID: "session-1", permission: "bash", patterns: [], metadata: {}, always: [] }]);
      }
      if (call.url.includes("/interactions/") && call.url.endsWith("/permission/reply")) {
        return jsonResponse({ interactionId: "resolved", status: "resolved" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = mountedClient();

    const legacy = await client.permission.reply({ requestID: "permission-legacy", reply: "once" });
    const v2 = await client.v2.session.permission.reply({ sessionID: "session-2", requestID: "permission-v2", reply: "always" });

    expect(legacy.data).toBe(true);
    expect(v2.error).toBeUndefined();
    const semantic = calls.filter((call) => call.url.endsWith("/permission/reply"));
    expect(semantic).toHaveLength(2);
    expect(semantic[0]?.url).toContain("/sessions/session-1/interactions/permission-legacy/");
    expect(semantic[0]?.body).toEqual({
      origin: "local-renderer",
      commandCorrelationId: expect.any(String),
      response: "allow_once",
    });
    expect(semantic[1]?.url).toContain("/sessions/session-2/interactions/permission-v2/");
    expect(semantic[1]?.body).toEqual({
      origin: "local-renderer",
      commandCorrelationId: expect.any(String),
      response: "always",
    });
    expect(calls.some((call) => call.url.includes("/opencode/permission/permission-legacy/reply"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/opencode/api/session/session-2/permission/permission-v2/reply"))).toBe(false);
  });

  test("routes legacy and v2 questions with deterministic normalized question IDs", async () => {
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/opencode/question")) {
        return jsonResponse([{ id: "question-legacy", sessionID: "session-1", questions }]);
      }
      if (call.url.endsWith("/opencode/api/session/session-2/question")) {
        return jsonResponse({ data: [{ id: "question-v2", sessionID: "session-2", questions }] });
      }
      if (call.url.includes("/interactions/") && call.url.endsWith("/question/reply")) {
        return jsonResponse({ interactionId: "resolved", status: "resolved" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = mountedClient();

    const legacy = await client.question.reply({ requestID: "question-legacy", answers: [["A"], ["custom"]] });
    const v2 = await client.v2.session.question.reply({
      sessionID: "session-2",
      requestID: "question-v2",
      questionV2Reply: { answers: [["A"], ["B"]] },
    });

    expect(legacy.data).toBe(true);
    expect(v2.error).toBeUndefined();
    const semantic = calls.filter((call) => call.url.endsWith("/question/reply"));
    expect(semantic.map((call) => call.body)).toEqual([
      {
        origin: "local-renderer",
        commandCorrelationId: expect.any(String),
        answers: [
          { questionId: "explicit", values: ["A"] },
          { questionId: "q_Question without an explicit ide", values: ["custom"] },
        ],
      },
      {
        origin: "local-renderer",
        commandCorrelationId: expect.any(String),
        answers: [
          { questionId: "explicit", values: ["A"] },
          { questionId: "q_Question without an explicit ide", values: ["B"] },
        ],
      },
    ]);
    expect(calls.some((call) => /\/opencode\/(?:api\/session\/[^/]+\/)?question\/[^/]+\/reply$/.test(call.url))).toBe(false);
  });

  test("propagates coordinator and mutation errors without direct fallback", async () => {
    for (const [status, code] of [[409, "already_resolved"], [410, "interaction_expired"], [404, "interaction_not_found"], [502, "opencode_request_failed"]] as const) {
      const calls = mockFetch((call) => {
        if (call.url.endsWith("/permission/reply")) return jsonResponse({ code, message: code }, status);
        throw new Error(`Unexpected request: ${call.method} ${call.url}`);
      });
      const result = await mountedClient().v2.session.permission.reply({
        sessionID: "session-1",
        requestID: `permission-${code}`,
        reply: "reject",
      });

      expect(result.response.status).toBe(status);
      expect(result.error).toBeInstanceOf(JuggleWorkServerError);
      expect(result.error).toMatchObject({ status, code });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).not.toContain("/opencode/");
    }
  });
});

describe("direct OpenCode interaction mutations", () => {
  test("retains all legacy and v2 SDK reply paths", async () => {
    const calls = mockFetch((call) => call.url.includes("/api/")
      ? new Response(null, { status: 204 })
      : jsonResponse(true));
    const client = createClient("https://opencode.example.test");

    expect((await client.permission.reply({ requestID: "permission-legacy", reply: "always" })).data).toBe(true);
    expect((await client.question.reply({ requestID: "question-legacy", answers: [["A"]] })).data).toBe(true);
    expect((await client.v2.session.permission.reply({ sessionID: "session-1", requestID: "permission-v2", reply: "once" })).error).toBeUndefined();
    expect((await client.v2.session.question.reply({
      sessionID: "session-1",
      requestID: "question-v2",
      questionV2Reply: { answers: [["A"]] },
    })).error).toBeUndefined();

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://opencode.example.test/permission/permission-legacy/reply",
      "POST https://opencode.example.test/question/question-legacy/reply",
      "POST https://opencode.example.test/api/session/session-1/permission/permission-v2/reply",
      "POST https://opencode.example.test/api/session/session-1/question/question-v2/reply",
    ]);
  });
});

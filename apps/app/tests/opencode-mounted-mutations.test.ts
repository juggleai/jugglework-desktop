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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
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

function eventResponse(events: unknown[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
}

async function drainEvents(client: ReturnType<typeof mountedClient>): Promise<void> {
  const subscription = await client.event.subscribe();
  for await (const _event of subscription.stream) {
    // Observation delivery happens on a serialized side-effect queue.
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
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

  test("hydrates an active run when a status event arrives before local start registration", async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes("/opencode/event")) {
        return eventResponse([{
          type: "session.status",
          properties: { sessionID: "session-1", status: { type: "running" } },
        }]);
      }
      if (call.url.endsWith("/workspace/workspace-1/session-runs")) {
        return jsonResponse({ items: [{ ...activeRun("run-hydrated"), generation: 4 }] });
      }
      if (call.url.endsWith("/sessions/session-1/runs/run-hydrated/observations")) {
        return jsonResponse({ cleared: false, run: activeRun("run-hydrated"), terminalStatus: null });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });

    await drainEvents(mountedClient());

    expect(calls.map((call) => call.url)).toEqual([
      "https://worker.example.test/workspace/workspace-1/session-runs",
      "https://worker.example.test/workspace/workspace-1/opencode/event",
      "https://worker.example.test/workspace/workspace-1/sessions/session-1/runs/run-hydrated/observations",
    ]);
    expect(calls[2]?.body).toEqual({ status: "running" });
  });

  test("retries a transient terminal observation without forgetting its run fence", async () => {
    let observationAttempts = 0;
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/sessions/session-1/runs/start")) {
        return jsonResponse({ run: { ...activeRun("run-terminal"), generation: 7 } }, 202);
      }
      if (call.url.includes("/opencode/event")) {
        return eventResponse([{
          type: "session.status",
          properties: { sessionID: "session-1", status: { type: "completed" } },
        }]);
      }
      if (call.url.endsWith("/workspace/workspace-1/session-runs")) {
        return jsonResponse({ items: [{ ...activeRun("run-terminal"), generation: 7 }] });
      }
      if (call.url.endsWith("/sessions/session-1/runs/run-terminal/observations")) {
        observationAttempts += 1;
        if (observationAttempts === 1) {
          return jsonResponse({ code: "temporary", message: "retry" }, 503);
        }
        return jsonResponse({ cleared: true, run: null, terminalStatus: "completed" });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = mountedClient();
    await client.session.promptAsync({ sessionID: "session-1", parts: [{ type: "text", text: "start" }] });

    await drainEvents(client);
    await waitUntil(() => observationAttempts === 2);

    expect(observationAttempts).toBe(2);
    const observations = calls.filter((call) => call.url.endsWith("/sessions/session-1/runs/run-terminal/observations"));
    expect(observations.map((call) => call.body)).toEqual([{ status: "completed" }, { status: "completed" }]);
  });

  test("does not let an older empty active-run snapshot erase a newly accepted generation", async () => {
    const listResponse = deferred<Response>();
    let started = false;
    const calls = mockFetch((call) => {
      if (call.url.endsWith("/workspace/workspace-1/session-runs")) {
        return listResponse.promise;
      }
      if (call.url.includes("/opencode/event")) {
        return eventResponse([{
          type: "session.status",
          properties: { sessionID: "session-1", status: { type: "running" } },
        }]);
      }
      if (call.url.endsWith("/sessions/session-1/runs/start")) {
        started = true;
        return jsonResponse({ run: { ...activeRun("run-new"), generation: 20 } }, 202);
      }
      if (call.url.endsWith("/sessions/session-1/runs/run-new/observations")) {
        return jsonResponse({ cleared: false, run: { ...activeRun("run-new"), generation: 20 }, terminalStatus: null });
      }
      throw new Error(`Unexpected request: ${call.method} ${call.url}`);
    });
    const client = mountedClient();
    const subscribing = client.event.subscribe();
    await waitUntil(() => calls.some((call) => call.url.endsWith("/workspace/workspace-1/session-runs")));
    await client.session.promptAsync({ sessionID: "session-1", parts: [{ type: "text", text: "new generation" }] });
    expect(started).toBe(true);
    listResponse.resolve(jsonResponse({ items: [] }));
    const subscription = await subscribing;
    for await (const _event of subscription.stream) {
      // Drain the running event after the stale list response applies.
    }
    await waitUntil(() => calls.some((call) => call.url.endsWith("/sessions/session-1/runs/run-new/observations")));
    expect(calls.some((call) => call.url.endsWith("/sessions/session-1/runs/run-new/observations"))).toBe(true);
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

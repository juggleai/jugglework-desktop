import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JuggleWorkContextOverflow } from "./jugglework-context-overflow.js";

const originalFetch = globalThis.fetch;
let nextResponse = new Response("ok");
let responseQueue: Response[] = [];
let nextError: unknown = null;
let fetchCalls = 0;
let receivedHeaders: Headers[] = [];
let fetchHandler: ((request: Request) => Promise<Response>) | null = null;
const fakeBase = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
  fetchCalls += 1;
  const request = new Request(input, init);
  receivedHeaders.push(request.headers);
  if (fetchHandler) return fetchHandler(request);
  if (nextError) {
    const error = nextError;
    nextError = null;
    throw error;
  }
  return responseQueue.shift() ?? nextResponse;
}, originalFetch);
let patchedFetch: typeof fetch;

beforeAll(async () => {
  globalThis.fetch = fakeBase;
  await JuggleWorkContextOverflow();
  patchedFetch = globalThis.fetch;
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("JuggleWorkContextOverflow fetch patch", () => {
  test.each([409, 429, 503])("makes exhausted points terminal even when the gateway returns %s", async (status) => {
    fetchCalls = 0;
    nextResponse = new Response(JSON.stringify({ error: {
      code: "insufficient_points",
      message: "The organization does not have enough available points for this managed model request.",
    } }), { status, headers: { "x-request-id": "points-request", "retry-after": "30" } });
    const response = await patchedFetch("https://provider.test/v1/chat/completions");
    expect(response.status).toBe(402);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("points-request");
    expect(await response.json()).toMatchObject({ error: { code: "insufficient_points", type: "insufficient_quota" } });
    expect(fetchCalls).toBe(1);
  });

  test("retries one transient TLS handshake failure without exposing the destination path", async () => {
    fetchCalls = 0;
    nextResponse = new Response("ok", { status: 200 });
    nextError = Object.assign(new Error("unknown certificate verification error"), {
      cause: { code: "CERT_HAS_EXPIRED" },
    });
    const response = await patchedFetch("https://provider.test/secret/path?token=secret", {
      method: "POST",
      body: JSON.stringify({ prompt: "hello" }),
    });
    expect(response.status).toBe(200);
    expect(fetchCalls).toBe(2);
  });

  test("does not retry non-replayable streaming request bodies", async () => {
    fetchCalls = 0;
    nextError = Object.assign(new Error("unknown certificate verification error"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const body = new ReadableStream({ start(controller) { controller.close(); } });
    await expect(patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit)).rejects.toThrow("unknown certificate verification error");
    expect(fetchCalls).toBe(1);
  });

  test("normalizes a plain context overflow response", async () => {
    nextResponse = new Response("Your input exceeds the context window of this model.", {
      status: 400,
      statusText: "Bad Request",
      headers: { "x-request-id": "req_1" },
    });
    const response = await patchedFetch("https://provider.test/v1/chat/completions");
    expect(response.status).toBe(400);
    expect(response.statusText).toBe("Bad Request");
    expect(response.headers.get("x-request-id")).toBe("req_1");
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        code: "context_length_exceeded",
        type: "invalid_request_error",
        message: "Your input exceeds the context window of this model.",
      },
    });
  });

  test("retries an empty unknown SSE response inside one logical model call", async () => {
    fetchCalls = 0;
    receivedHeaders = [];
    responseQueue = [
      new Response([
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"unknown"}],"usage":{"completion_tokens":0}}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream" } }),
      new Response([
        'data: {"choices":[{"index":0,"delta":{"content":"continued"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { headers: { "content-type": "text/event-stream", "x-request-id": "req_retry" } }),
    ];

    const response = await patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ model: "gpt-5.6-sol", stream: true, messages: [] }),
    });

    expect(fetchCalls).toBe(2);
    expect(receivedHeaders.every((headers) => !headers.has("x-jugglework-empty-stream-retry"))).toBe(true);
    expect(response.headers.get("x-request-id")).toBe("req_retry");
    expect(await response.text()).toContain("continued");
    expect(await Promise.resolve(responseQueue.length)).toBe(0);
  }, 10_000);

  test("does not retry after any text or tool-call output", async () => {
    const bodies = [
      'data: {"choices":[{"index":0,"delta":{"content":"visible"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    ];
    for (const body of bodies) {
      fetchCalls = 0;
      responseQueue = [];
      nextResponse = new Response(body, { headers: { "content-type": "text/event-stream" } });
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(fetchCalls).toBe(1);
      expect(await response.text()).toBe(body);
    }
  });

  test("does not retry a deliberate empty stop or a non-zero-token response", async () => {
    const bodies = [
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":0}}\n\ndata: [DONE]\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"unknown"}],"usage":{"completion_tokens":4}}\n\ndata: [DONE]\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":null}],"usage":{"completion_tokens":0}}\n\ndata: [DONE]\n\n',
    ];
    for (const body of bodies) {
      fetchCalls = 0;
      nextResponse = new Response(body, { headers: { "content-type": "text/event-stream" } });
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(fetchCalls).toBe(1);
      expect(await response.text()).toBe(body);
    }
  });

  test("stops after two retries when every provider attempt is empty", async () => {
    fetchCalls = 0;
    const empty = () => new Response([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"other"}],"usage":{"completion_tokens":0}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
    responseQueue = [empty(), empty(), empty()];

    await expect(patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ stream: true }),
    })).rejects.toThrow("Provider returned an empty response after 3 attempts.");

    expect(fetchCalls).toBe(3);
  }, 10_000);

  test("recognizes meaningful output when an SSE frame spans chunks", async () => {
    fetchCalls = 0;
    responseQueue = [];
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"index":0,"delta":{"conte',
      'nt":"continued"},"finish_reason":null}]}\n\ndata: [DONE]\n\n',
    ];
    nextResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const response = await patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ stream: true }),
    });

    expect(fetchCalls).toBe(1);
    expect(await response.text()).toBe(chunks.join(""));
  });

  test("returns a meaningful stream before its upstream connection closes", async () => {
    fetchCalls = 0;
    responseQueue = [];
    const encoder = new TextEncoder();
    let upstreamCancelled = false;
    nextResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"index":0,"delta":{"content":"streaming"},"finish_reason":null}]}\n\n',
        ));
        // Deliberately leave the provider connection open. A streaming fetch
        // must return as soon as meaningful output exists, not at stream EOF.
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), { headers: { "content-type": "text/event-stream" } });

    const response = await patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ stream: true }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("streaming");
    await reader.cancel();
    expect(fetchCalls).toBe(1);
    expect(upstreamCancelled).toBe(true);
  }, 2_000);

  test("retries when the provider sends no first byte before the deadline", async () => {
    fetchCalls = 0;
    fetchHandler = null;
    process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS = "20";
    const hanging = new Response(new ReadableStream<Uint8Array>({}), {
      headers: { "content-type": "text/event-stream" },
    });
    const recoveredBody = 'data: {"choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    responseQueue = [hanging, new Response(recoveredBody, { headers: { "content-type": "text/event-stream" } })];
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(fetchCalls).toBe(2);
      expect(await response.text()).toBe(recoveredBody);
    } finally {
      delete process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS;
    }
  }, 10_000);

  test("aborts and releases a timed-out attempt before dispatching its retry", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS = "20";
    let attempt = 0;
    let aborted = false;
    let released = false;
    const body = 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n';
    fetchHandler = async (request) => {
      if (++attempt > 1) {
        expect(aborted).toBe(true);
        expect(released).toBe(true);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      request.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Response(new ReadableStream<Uint8Array>({
        async cancel() {
          expect(aborted).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 15));
          released = true;
        },
      }), { headers: { "content-type": "text/event-stream" } });
    };
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST", headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(await response.text()).toBe(body);
      expect(attempt).toBe(2);
    } finally {
      fetchHandler = null;
      delete process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS;
    }
  }, 5_000);

  test("hands off delayed reasoning without replaying or waiting for stream EOF", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS = "200";
    const encoder = new TextEncoder();
    const initial = 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n';
    const reasoning = 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n';
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    nextResponse = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(initial));
        timer = setTimeout(() => controller.enqueue(encoder.encode(reasoning)), 70);
      },
      cancel() { clearTimeout(timer); cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
    responseQueue = [];
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST", headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      const reader = response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(initial);
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(reasoning);
      await reader.cancel();
      expect(cancelled).toBe(true);
      expect(fetchCalls).toBe(1);
    } finally {
      delete process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS;
      clearTimeout(timer!);
    }
  }, 2_000);

  test("closes the real upstream connection before a timeout retry", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS = "40";
    let started = 0;
    let active = 0;
    let peak = 0;
    let closed = false;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch() {
        started++;
        if (started > 1) {
          expect(closed).toBe(true);
          expect(active).toBe(0);
          return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        }
        active++;
        peak = Math.max(peak, active);
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(": connected\n\n")); },
          cancel() { active--; closed = true; },
        }), { headers: { "content-type": "text/event-stream" } });
      },
    });
    fetchHandler = (request) => originalFetch(new Request(
      `http://127.0.0.1:${server.port}/chat/completions`, request,
    ));
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST", headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(await response.text()).toContain('"ok"');
      expect(started).toBe(2);
      expect(peak).toBe(1);
      expect(active).toBe(0);
    } finally {
      fetchHandler = null;
      delete process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS;
      await server.stop(true);
    }
  }, 5_000);

  test("retries when metadata heartbeats never produce model output", async () => {
    fetchCalls = 0;
    fetchHandler = null;
    process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS = "20";
    process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS = "30";
    const encoder = new TextEncoder();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    const heartbeat = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(": connected\n\n"));
        heartbeatTimer = setInterval(() => controller.enqueue(encoder.encode(": keepalive\n\n")), 5);
      },
      cancel() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const recoveredBody = 'data: {"choices":[{"index":0,"delta":{"content":"after heartbeat"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    responseQueue = [heartbeat, new Response(recoveredBody, { headers: { "content-type": "text/event-stream" } })];
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(fetchCalls).toBe(2);
      expect(await response.text()).toBe(recoveredBody);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      delete process.env.JUGGLEWORK_PROVIDER_FIRST_BYTE_TIMEOUT_MS;
      delete process.env.JUGGLEWORK_PROVIDER_NO_PROGRESS_TIMEOUT_MS;
    }
  }, 10_000);

  test("retries when response headers never arrive", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS = "20";
    let attempt = 0;
    const recoveredBody = 'data: {"choices":[{"index":0,"delta":{"content":"headers recovered"},"finish_reason":null}]}\n\ndata: [DONE]\n\n';
    fetchHandler = async (request) => {
      attempt += 1;
      if (attempt > 1) return new Response(recoveredBody, { headers: { "content-type": "text/event-stream" } });
      return await new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
    try {
      const response = await patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      });
      expect(fetchCalls).toBe(2);
      expect(await response.text()).toBe(recoveredBody);
    } finally {
      fetchHandler = null;
      delete process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS;
    }
  }, 10_000);

  test("fails clearly after response-header timeouts exhaust all attempts", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS = "10";
    fetchHandler = async (request) => await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    try {
      await expect(patchedFetch("https://provider.test/v1/chat/completions", {
        method: "POST",
        headers: { "x-jugglework-empty-stream-retry": "1" },
        body: JSON.stringify({ stream: true }),
      })).rejects.toThrow("Managed model produced no output after 3 attempts (response_timeout).");
      expect(fetchCalls).toBe(3);
    } finally {
      fetchHandler = null;
      delete process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS;
    }
  }, 10_000);

  test("marks only lpr providers for empty-stream retry", async () => {
    const hooks = await JuggleWorkContextOverflow() as {
      config: (config: { provider?: Record<string, { options?: Record<string, unknown> }> }) => Promise<void>;
      "chat.headers": (
        input: { model: { providerID: string } },
        output: { headers: Record<string, string> },
      ) => Promise<void>;
    };
    const managed = { headers: {} as Record<string, string> };
    const local = { headers: {} as Record<string, string> };
    await hooks["chat.headers"]({ model: { providerID: "lpr_router" } }, managed);
    await hooks["chat.headers"]({ model: { providerID: "openai" } }, local);
    expect(managed.headers["x-jugglework-empty-stream-retry"]).toBe("1");
    expect(local.headers["x-jugglework-empty-stream-retry"]).toBeUndefined();
  });

  test("binds the guarded fetch and bounded stream wait directly to managed providers", async () => {
    const hooks = await JuggleWorkContextOverflow() as {
      config: (config: { provider?: Record<string, { options?: Record<string, unknown> }> }) => Promise<void>;
    };
    const config = {
      provider: {
        lpr_managed: { options: { baseURL: "https://work.juggle.im/jwork/api/gateway/v1/lpr_managed" } },
        local: { options: { baseURL: "http://127.0.0.1:11434/v1" } },
      },
    };
    await hooks.config(config);
    const managedOptions = config.provider.lpr_managed.options as Record<string, unknown>;
    expect(typeof managedOptions.fetch).toBe("function");
    expect(managedOptions.headerTimeout).toBe(false);
    expect(managedOptions.chunkTimeout).toBe(120_000);
    expect(config.provider.local.options).toEqual({ baseURL: "http://127.0.0.1:11434/v1" });
  });

  test("guards a managed gateway stream even when the SDK drops the marker header", async () => {
    fetchCalls = 0;
    process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS = "10";
    fetchHandler = async (request) => await new Promise<Response>((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    });
    try {
      await expect(patchedFetch(
        "https://work.juggle.im/jwork/api/gateway/v1/lpr_managed/chat/completions",
        { method: "POST", body: JSON.stringify({ stream: true }) },
      )).rejects.toThrow("Managed model produced no output after 3 attempts (response_timeout).");
      expect(fetchCalls).toBe(3);
    } finally {
      fetchHandler = null;
      delete process.env.JUGGLEWORK_PROVIDER_RESPONSE_TIMEOUT_MS;
    }
  }, 10_000);

  test("does not continue retrying after the request is aborted", async () => {
    fetchCalls = 0;
    responseQueue = [new Response([
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"unknown"}],"usage":{"completion_tokens":0}}',
      "data: [DONE]",
      "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } })];
    const controller = new AbortController();
    const promise = patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ stream: true }),
    });
    setTimeout(() => controller.abort(), 10);
    await expect(promise).rejects.toThrow();
    expect(fetchCalls).toBe(1);
  });

  test("fails open on malformed SSE instead of replaying an uncertain response", async () => {
    fetchCalls = 0;
    const body = "data: {not-json}\n\ndata: [DONE]\n\n";
    nextResponse = new Response(body, { headers: { "content-type": "text/event-stream" } });
    const response = await patchedFetch("https://provider.test/v1/chat/completions", {
      method: "POST",
      headers: { "x-jugglework-empty-stream-retry": "1" },
      body: JSON.stringify({ stream: true }),
    });
    expect(fetchCalls).toBe(1);
    expect(await response.text()).toBe(body);
  });

  test("leaves successful, structured, rate-limit, and oversized responses untouched", async () => {
    const values = [
      new Response("ok", { status: 200 }),
      new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), { status: 400 }),
      new Response("Too many requests: rate limit exceeded", { status: 429 }),
      new Response("Prompt is too long", { status: 400, headers: { "content-length": "100000" } }),
    ];
    for (const value of values) {
      nextResponse = value;
      expect(await patchedFetch("https://provider.test/v1/chat/completions")).toBe(value);
    }
  });

  test("module exposes only the plugin factory", async () => {
    const mod = await import("./jugglework-context-overflow.js");
    expect(Object.keys(mod)).toEqual(["JuggleWorkContextOverflow"]);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCodexCredentialBroker } from "./codex-credential-broker.mjs";

const binding = { organizationId: "org_1", deviceId: "device_123", providerId: "lpr_jugglerouter" };

function tokenProviderFixture() {
  let generation = 0;
  const invalidations = [];
  return {
    invalidations,
    async getToken(input) {
      assert.deepEqual(input, binding);
      generation += 1;
      return {
        accessToken: `remote-token-${generation}`,
        gatewayBaseUrl: "https://gateway.example.test/jwork/api/gateway/v1/lpr_jugglerouter",
      };
    },
    invalidate(input) { invalidations.push(input); },
  };
}

describe("Codex credential broker", () => {
  it("binds to loopback, replaces the local secret and streams Responses SSE", async () => {
    const tokenProvider = tokenProviderFixture();
    const calls = [];
    const broker = createCodexCredentialBroker({
      tokenProvider,
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: response.output_text.delta\n"));
            controller.enqueue(new TextEncoder().encode('data: {"delta":"ok"}\n\n'));
            controller.close();
          },
        }), { headers: { "Content-Type": "text/event-stream", "X-Request-Id": "req_1" } });
      },
    });
    const access = await broker.start(binding);
    try {
      assert.match(access.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/v1$/);
      assert.deepEqual(broker.status(), { running: true, organizationId: "org_1" });
      assert.doesNotMatch(JSON.stringify(broker.status()), new RegExp(access.localSecret));
      assert.doesNotMatch(JSON.stringify(broker.status()), /127\.0\.0\.1|\/v1/);

      const response = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access.localSecret}`,
          "Content-Type": "application/json",
          "User-Agent": "codex-cli/test",
        },
        body: JSON.stringify({ model: "gpt-5.6-terra", input: "hello" }),
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /response\.output_text\.delta/);
      assert.equal(calls[0].url, "https://gateway.example.test/jwork/api/gateway/v1/lpr_jugglerouter/responses");
      assert.equal(calls[0].init.headers.get("authorization"), "Bearer remote-token-1");
      assert.notEqual(calls[0].init.headers.get("authorization"), `Bearer ${access.localSecret}`);
      assert.equal(calls[0].init.headers.get("user-agent"), "codex-cli/test");
    } finally {
      await broker.dispose();
    }
    assert.deepEqual(broker.status(), { running: false, organizationId: null });
  });

  it("refreshes and replays one 401 only with a stable idempotency key", async () => {
    const tokenProvider = tokenProviderFixture();
    const calls = [];
    const broker = createCodexCredentialBroker({
      tokenProvider,
      fetcher: async (_url, init) => {
        calls.push(init.headers.get("authorization"));
        return calls.length === 1
          ? Response.json({ error: { code: "TOKEN_EXPIRED" } }, { status: 401 })
          : Response.json({ id: "resp_1" });
      },
    });
    const access = await broker.start(binding);
    try {
      const response = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${access.localSecret}`,
          "Content-Type": "application/json",
          "Idempotency-Key": "turn_stable_1",
        },
        body: `{}`,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(calls, ["Bearer remote-token-1", "Bearer remote-token-2"]);
      assert.deepEqual(tokenProvider.invalidations, [{ organizationId: "org_1" }]);
    } finally {
      await broker.dispose();
    }
  });

  it("does not replay a 401 without idempotency and rejects browser origins", async () => {
    const tokenProvider = tokenProviderFixture();
    let calls = 0;
    const broker = createCodexCredentialBroker({
      tokenProvider,
      fetcher: async () => {
        calls += 1;
        return Response.json({ error: { code: "TOKEN_EXPIRED" } }, { status: 401 });
      },
    });
    const access = await broker.start(binding);
    try {
      const unauthorized = await fetch(`${access.baseUrl}/responses`, { method: "POST", body: `{}` });
      assert.equal(unauthorized.status, 401);
      const origin = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.localSecret}`, Origin: "https://evil.example" },
        body: `{}`,
      });
      assert.equal(origin.status, 403);
      const response = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.localSecret}`, "Content-Type": "application/json" },
        body: `{}`,
      });
      assert.equal(response.status, 401);
      assert.equal(calls, 1);
      assert.deepEqual(tokenProvider.invalidations, []);
    } finally {
      await broker.dispose();
    }
  });

  it("bounds request bodies and keeps errors free of local and remote credentials", async () => {
    const tokenProvider = tokenProviderFixture();
    const broker = createCodexCredentialBroker({ tokenProvider, maxRequestBytes: 8, fetcher: async () => Response.json({}) });
    const access = await broker.start(binding);
    try {
      const response = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.localSecret}`, "Content-Type": "application/json" },
        body: `{"value":"too large"}`,
      });
      assert.equal(response.status, 413);
      const payload = await response.text();
      assert.doesNotMatch(payload, new RegExp(access.localSecret));
      assert.doesNotMatch(payload, /remote-token|too large/);
    } finally {
      await broker.dispose();
    }
  });

  it("preserves safe 429/5xx status metadata without exposing upstream credentials", async () => {
    const tokenProvider = tokenProviderFixture();
    let status = 429;
    const broker = createCodexCredentialBroker({
      tokenProvider,
      fetcher: async () => Response.json({ error: { code: "RATE_LIMITED", message: "safe gateway error" } }, {
        status,
        headers: { "Retry-After": "7", "X-Request-Id": "req_safe", "X-Secret": "never-forward" },
      }),
    });
    const access = await broker.start(binding);
    try {
      const call = () => fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.localSecret}`, "Content-Type": "application/json" },
        body: `{}`,
      });
      const limited = await call();
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "7");
      assert.equal(limited.headers.get("x-request-id"), "req_safe");
      assert.equal(limited.headers.get("x-secret"), null);
      status = 503;
      assert.equal((await call()).status, 503);
    } finally {
      await broker.dispose();
    }
  });

  it("bounds upstream timeouts and tears down an interrupted stream", async () => {
    const tokenProvider = tokenProviderFixture();
    const timed = createCodexCredentialBroker({
      tokenProvider,
      timeoutMs: 5,
      fetcher: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    });
    const access = await timed.start(binding);
    try {
      const response = await fetch(`${access.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access.localSecret}` },
        body: `{}`,
      });
      assert.equal(response.status, 504);
      assert.deepEqual(await response.json(), { error: { code: "timeout", message: "The Codex gateway request failed." } });
    } finally {
      await timed.dispose();
    }

    const interrupted = createCodexCredentialBroker({
      tokenProvider,
      fetcher: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error("upstream disconnected"));
        },
      }), { headers: { "Content-Type": "text/event-stream" } }),
    });
    const interruptedAccess = await interrupted.start(binding);
    try {
      const response = await fetch(`${interruptedAccess.baseUrl}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${interruptedAccess.localSecret}` },
        body: `{}`,
      });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { error: { code: "upstream_unavailable", message: "The Codex gateway request failed." } });
    } finally {
      await interrupted.dispose();
    }
  });
});

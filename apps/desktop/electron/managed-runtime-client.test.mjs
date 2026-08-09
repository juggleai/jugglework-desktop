import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ManagedRuntimeClientError,
  createManagedRuntimeClient,
} from "./managed-runtime-client.mjs";

function access() {
  return { baseUrl: "http://127.0.0.1:48123", clientToken: "collaborator-secret" };
}

describe("managed runtime client", () => {
  it("uses only the collaborator token with bounded no-store non-redirecting requests", async () => {
    const requests = [];
    const client = createManagedRuntimeClient({
      getAccess: access,
      fetcher: async (url, init) => {
        requests.push({ url: String(url), init });
        return Response.json({ items: [] });
      },
    });

    assert.deepEqual(await client.getJson("/workspace/ws_1/sessions?limit=10"), { items: [] });
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "http://127.0.0.1:48123/workspace/ws_1/sessions?limit=10");
    assert.equal(request.init.headers.Authorization, "Bearer collaborator-secret");
    assert.equal(request.init.credentials, "omit");
    assert.equal(request.init.cache, "no-store");
    assert.equal(request.init.redirect, "manual");
    assert.equal(request.init.method, "GET");
    assert.doesNotMatch(JSON.stringify(await client.getJson("/safe")), /secret|127\.0\.0\.1|48123/);
  });

  it("rejects redirects, malformed JSON, declared and streamed oversized responses", async () => {
    const cases = [
      {
        expected: "redirect",
        response: new Response(null, { status: 302, headers: { Location: "https://example.test/leak" } }),
      },
      { expected: "invalid_response", response: new Response("{bad") },
      {
        expected: "response_too_large",
        response: new Response("{}", { headers: { "Content-Length": "999" } }),
      },
      { expected: "response_too_large", response: new Response(JSON.stringify({ value: "x".repeat(100) })) },
    ];
    for (const testCase of cases) {
      const client = createManagedRuntimeClient({
        getAccess: access,
        maxResponseBytes: 32,
        fetcher: async () => testCase.response,
      });
      await assert.rejects(client.getJson("/test"), (error) => {
        assert.ok(error instanceof ManagedRuntimeClientError);
        assert.equal(error.code, testCase.expected);
        assert.doesNotMatch(error.message, /example|secret|127\.0\.0\.1/);
        return true;
      });
    }
  });

  it("times out and rejects unavailable or over-broad access input without leaking it", async () => {
    const timeoutClient = createManagedRuntimeClient({
      getAccess: access,
      timeoutMs: 5,
      fetcher: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted secret")), { once: true });
      }),
    });
    await assert.rejects(timeoutClient.getJson("/slow"), (error) => error instanceof ManagedRuntimeClientError && error.code === "timeout" && !error.message.includes("secret"));

    const invalidClient = createManagedRuntimeClient({
      getAccess: () => ({ ...access(), ownerToken: "must-not-be-accepted" }),
    });
    await assert.rejects(invalidClient.getJson("/safe"), (error) => error instanceof ManagedRuntimeClientError && error.code === "unavailable");
    await assert.rejects(() => timeoutClient.getJson("https://evil.test/path"), /absolute pathnames/);
  });
});

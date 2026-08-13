import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CodexGatewayTokenError,
  createCodexGatewayTokenProvider,
  createDenCodexGatewayExchange,
  createDenCodexModelCatalogLoader,
} from "./codex-gateway-token-provider.mjs";

const request = { organizationId: "org_1", deviceId: "device_1", providerId: "jugglerouter" };
const tokenResponse = (overrides = {}) => ({
  accessToken: "gateway-short-token",
  tokenType: "Bearer",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  organizationId: "org_1",
  deviceId: "device_1",
  audience: "jugglework-codex-gateway",
  scopes: ["responses:create", "models:read"],
  gatewayBaseUrl: "https://gateway.example.test/v1",
  ...overrides,
});

describe("Codex gateway token provider", () => {
  it("reuses the current Den organization session without putting it in the request body", async () => {
    const calls = [];
    const exchange = createDenCodexGatewayExchange({
      getSession: () => ({ baseUrl: "https://work.example.test", bearerToken: "login-secret", organizationId: "org_1" }),
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json(tokenResponse());
      },
    });
    assert.equal((await exchange(request)).organizationId, "org_1");
    assert.equal(calls[0].url, "https://work.example.test/jwork/api/v1/codex/gateway-token");
    assert.equal(calls[0].init.headers.Authorization, "Bearer login-secret");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.cache, "no-store");
    assert.doesNotMatch(calls[0].init.body, /login-secret/);
  });

  it("singleflights exchange and caches only while the token is fresh", async () => {
    let calls = 0;
    const provider = createCodexGatewayTokenProvider({
      exchange: async () => {
        calls += 1;
        await Promise.resolve();
        return tokenResponse();
      },
    });
    const [first, second] = await Promise.all([provider.getToken(request), provider.getToken(request)]);
    assert.equal(first.accessToken, second.accessToken);
    await provider.getToken(request);
    assert.equal(calls, 1);
    provider.invalidate({ organizationId: "org_1" });
    await provider.getToken(request);
    assert.equal(calls, 2);
  });

  it("rejects cross-organization/device and insufficient-scope responses", async () => {
    for (const response of [
      tokenResponse({ organizationId: "org_2" }),
      tokenResponse({ deviceId: "device_2" }),
      tokenResponse({ scopes: ["models:read"] }),
    ]) {
      const provider = createCodexGatewayTokenProvider({ exchange: async () => response });
      await assert.rejects(provider.getToken(request), (error) => error instanceof CodexGatewayTokenError && error.code === "INVALID_RESPONSE");
    }
  });

  it("maps server errors without retaining server messages or credentials", async () => {
    const exchange = createDenCodexGatewayExchange({
      getSession: () => ({ baseUrl: "https://work.example.test", bearerToken: "login-secret", organizationId: "org_1" }),
      fetcher: async () => Response.json({
        error: {
          code: "RATE_LIMITED",
          message: "secret prompt content",
          retryable: true,
          retryAfterMs: 2500,
          requestId: "req_1",
        },
      }, { status: 429 }),
    });
    await assert.rejects(exchange(request), (error) => {
      assert.ok(error instanceof CodexGatewayTokenError);
      assert.equal(error.code, "RATE_LIMITED");
      assert.equal(error.status, 429);
      assert.equal(error.retryAfterMs, 2500);
      assert.doesNotMatch(JSON.stringify(error), /secret|prompt|login/);
      return true;
    });
  });

  it("refuses an organization mismatch before making a network request", async () => {
    let called = false;
    const exchange = createDenCodexGatewayExchange({
      getSession: () => ({ baseUrl: "https://work.example.test", bearerToken: "login-secret", organizationId: "org_2" }),
      fetcher: async () => {
        called = true;
        return Response.json(tokenResponse());
      },
    });
    await assert.rejects(exchange(request), (error) => error instanceof CodexGatewayTokenError && error.code === "AUTH_REQUIRED");
    assert.equal(called, false);
  });

  it("loads the organization model catalog without returning the login credential", async () => {
    const calls = [];
    const loadModels = createDenCodexModelCatalogLoader({
      getSession: () => ({ baseUrl: "https://work.example.test/jwork/api", bearerToken: "login-secret", organizationId: "org_1" }),
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return Response.json({
          organizationId: "org_1",
          fetchedAt: new Date().toISOString(),
          models: [{
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6 Terra",
            enabled: true,
            capabilities: { images: true, tools: true, reasoning: true, reasoningEfforts: ["low", "medium", "high"] },
          }],
        });
      },
    });
    const catalog = await loadModels({ organizationId: "org_1", providerId: "lpr_jugglerouter" });
    assert.equal(catalog.models[0].capabilities.images, true);
    assert.equal(calls[0].url, "https://work.example.test/jwork/api/v1/codex/models?providerId=lpr_jugglerouter");
    assert.equal(calls[0].init.headers.Authorization, "Bearer login-secret");
    assert.doesNotMatch(JSON.stringify(catalog), /login-secret/);
  });
});

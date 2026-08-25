import { afterEach, describe, expect, test } from "bun:test";

import { createDenClient } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
const PROVIDER_ID = "lpr_3f8d77482bd4da3bdc4ae54f79d749c28ee5bde7";
const GATEWAY_URL = `https://cloud.example.test/jwork/api/gateway/v1/${PROVIDER_ID}`;

const models = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    config: {
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      family: "deepseek-flash",
      reasoning: true,
      tool_call: true,
      limit: { context: 1_000_000, output: 384_000 },
      cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
      modalities: { input: ["text"], output: ["text"] },
    },
    createdAt: "2026-08-24T01:02:03Z",
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    config: {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      family: "deepseek-thinking",
      reasoning: true,
      tool_call: true,
      limit: { context: 1_000_000, output: 384_000 },
    },
    createdAt: "2026-08-24T01:02:03Z",
  },
];

const managedListProvider = {
  id: PROVIDER_ID,
  source: "juggle_router",
  providerId: "JuggleRouter",
  name: "JuggleRouter",
  providerConfig: {
    id: "jugglerouter",
    name: "JuggleRouter",
    npm: "@ai-sdk/openai-compatible",
    api: "https://router.internal.example/v1",
    env: ["JUGGLEROUTER_API_KEY"],
  },
  hasApiKey: true,
  managed: true,
  managedKind: "juggle_router",
  accessScope: "organization",
  enabled: true,
  models,
  createdAt: "2026-08-24T01:02:03Z",
  updatedAt: "2026-08-25T01:02:03Z",
};

describe("managed JuggleRouter Den provider parser", () => {
  afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test("accepts the managed list shape and preserves lifecycle metadata", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      llmProviders: [
        managedListProvider,
        {
          ...managedListProvider,
          id: "lpr_disabled",
          enabled: false,
        },
      ],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    const providers = await createDenClient({
      baseUrl: "https://cloud.example.test",
      token: "session-token",
    }).listOrgLlmProviders("org_test");

    expect(providers).toHaveLength(2);
    expect(providers[0]).toMatchObject({
      id: PROVIDER_ID,
      source: "juggle_router",
      providerId: "JuggleRouter",
      managed: true,
      managedKind: "juggle_router",
      accessScope: "organization",
      enabled: true,
    });
    expect(providers[0]?.models.map((model) => model.id)).toEqual([
      "deepseek-v4-flash",
      "deepseek-v4-pro",
    ]);
    expect(providers[1]?.enabled).toBe(false);
  });

  test("still parses a legacy hosted row so import filtering can reject it", async () => {
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      llmProviders: [{
        ...managedListProvider,
        id: "lpr_legacy_hosted",
        source: "jugglework",
        providerId: "jugglework",
        name: "Legacy hosted provider",
        managed: false,
        managedKind: null,
        accessScope: "explicit",
      }],
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    const providers = await createDenClient({
      baseUrl: "https://cloud.example.test",
      token: "session-token",
    }).listOrgLlmProviders("org_test");

    expect(providers[0]).toMatchObject({
      id: "lpr_legacy_hosted",
      source: "jugglework",
      providerId: "jugglework",
    });
  });

  test("accepts the gateway connect shape without losing its opaque token or config", async () => {
    const gatewayToken = "jwgw_desktop_opaque_token";
    const fetchMock: typeof fetch = async () => new Response(JSON.stringify({
      llmProvider: {
        ...managedListProvider,
        providerConfig: {
          id: "jugglerouter",
          name: "JuggleRouter",
          npm: "@ai-sdk/openai-compatible",
          api: GATEWAY_URL,
          env: [`JUGGLEWORK_GATEWAY_KEY_${PROVIDER_ID.toUpperCase()}`],
          options: { baseURL: GATEWAY_URL },
        },
        apiKey: gatewayToken,
        apiKeys: null,
      },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchMock });

    const provider = await createDenClient({
      baseUrl: "https://cloud.example.test",
      token: "session-token",
    }).getOrgLlmProviderConnection("org_test", PROVIDER_ID);

    expect(provider.apiKey).toBe(gatewayToken);
    expect(provider.apiKeys).toBeNull();
    expect(provider.providerConfig.api).toBe(GATEWAY_URL);
    expect(provider.providerConfig.options).toEqual({ baseURL: GATEWAY_URL });
    expect(provider.source).toBe("juggle_router");
    expect(provider.managedKind).toBe("juggle_router");
  });
});

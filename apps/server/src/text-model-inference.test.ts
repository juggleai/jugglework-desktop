import { afterEach, expect, test } from "bun:test";
import { describeConfiguredTextModel, requestTextModel, textModelIneligibility } from "./text-model-inference.js";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const ref = { providerID: "synthetic", modelID: "public-alias" };
function describe(model: Record<string, unknown> = {}, options: Record<string, unknown> = {}, liveModel: Record<string, unknown> = {}, liveOptions: Record<string, unknown> = {}) {
  return describeConfiguredTextModel({ provider: { synthetic: {
    npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://synthetic.example/v1", ...options }, models: { "public-alias": model },
  } } }, { all: [{ id: "synthetic", options: liveOptions, models: { "public-alias": liveModel } }] }, ref);
}

test("fixed engine public key stays separate from config id and resolved live api.id", () => {
  expect(describe({ id: "upstream-config" })?.upstreamModelId).toBe("upstream-config");
  expect(describe({}, {}, { id: "public-alias", api: { id: "upstream-catalog" } })?.upstreamModelId).toBe("upstream-catalog");
  expect(describe()?.upstreamModelId).toBe("public-alias");
  expect(describe({ id: "upstream-config" }, {}, { api: { id: "upstream-config" } })?.upstreamModelId).toBe("upstream-config");
  expect(describe({ id: "new-config" }, {}, { api: { id: "old-live" } })).toBeNull();
  for (const id of ["", " spaced ", "bad\nmodel", "${MODEL}", "{env:MODEL}", 7]) expect(describe({ id })).toBeNull();
  expect(describe({ api: { id: "unsupported-raw-output-shape" } })).toBeNull();
});

test("effective header precedence: live provider, configured provider, inherited model, configured model (case insensitive)", () => {
  const result = describe({ headers: { "X-Route": "configured-model", "x-model-only": "model-value" } },
    { headers: { "X-Tenant": "configured-provider", "X-Route": "provider-route" } },
    { headers: { "x-route": "live-model", "x-inherited": "inherited" } },
    { headers: { "x-tenant": "live-provider", "x-live-only": "live-value" } });
  expect(result?.headers).toEqual({ "x-tenant": "configured-provider", "x-route": "configured-model", "x-model-only": "model-value", "x-inherited": "inherited", "x-live-only": "live-value" });
});

test("model provider overrides follow fixed engine api/npm rules, provider baseURL overrides api URL", () => {
  const effective = { provider: { synthetic: {
    npm: "@ai-sdk/openai", api: "https://provider.example/v1",
    models: { "public-alias": { provider: { npm: "@ai-sdk/anthropic", api: "https://model.example/v1" } } },
  } } };
  const live = { all: [{ id: "synthetic", models: { "public-alias": { api: { id: "live-alias", npm: "@ai-sdk/openai-compatible", url: "https://live.example/v1" } } } }] };
  expect(describeConfiguredTextModel(effective, live, ref)).toMatchObject({ upstreamModelId: "live-alias", baseURL: "https://model.example/v1", protocol: "anthropic-messages" });
  Object.assign(effective.provider.synthetic, { options: { baseURL: "https://gateway.example/v1" } });
  expect(describeConfiguredTextModel(effective, live, ref)?.baseURL).toBe("https://gateway.example/v1");
});

test("unsupported or unresolved routing configuration skips instead of dropping fields", () => {
  for (const headers of [null, [], "bad", { "bad header": "value" }, { "x-tenant": 3 }, { "x-tenant": "bad\r\nheader" },
    { "x-tenant": "{env:TENANT}" }, { "x-route": "${ROUTE}" }, { Host: "different.example" }, { "Content-Length": "100" }, { "Content-Type": "text/plain" }]) {
    expect(describe({}, { headers })).toBeNull(); expect(describe({ headers })).toBeNull();
  }
  expect(describe({}, { fetch: "custom-transport" })).toBeNull();
  expect(describe({ options: { headers: { "x-route": "unsupported-layer" } } })).toBeNull();
  expect(describe({}, { baseURL: "https://${HOST}/v1" })).toBeNull();
  expect(describe({ provider: { npm: "@ai-sdk/google-vertex/anthropic" } })).toBeNull();
});

test("reasoning capability or options never make a text model ineligible", () => {
  for (const model of [{ reasoning: true }, { capabilities: { reasoning: true, output: { text: true } } },
    { options: { thinking: { type: "enabled", budgetTokens: 1024 } } }, { options: { reasoningEffort: "high" } }]) {
    expect(textModelIneligibility(model)).toBeNull();
  }
  expect(textModelIneligibility({ capabilities: { output: { text: false } } })).toBe("model_non_text");
  expect(textModelIneligibility({ limit: { output: 256 } })).toBe("model_output_limit");
});

for (const [protocol, npm, endpoint] of [
  ["openai-completions", "@ai-sdk/openai-compatible", "chat/completions"],
  ["openai-responses", "@ai-sdk/openai", "responses"],
  ["anthropic-messages", "@ai-sdk/anthropic", "messages"],
] as const) {
  test(`${protocol}: resolved alias and gateway headers reach the single upstream request`, async () => {
    const described = describe({ id: "tenant-deployment", provider: { npm }, headers: { "x-route": "model-route" } },
      { headers: { "X-Tenant": "synthetic-tenant", "X-Route": "provider-route", "Authorization": "Bearer synthetic-header-key", "anthropic-beta": "synthetic-beta" } },
      { api: { id: "tenant-deployment" } })!;
    expect(described.protocol).toBe(protocol);
    let calls = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls++;
      expect(url).toBe(`https://synthetic.example/v1/${endpoint}`);
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("tenant-deployment"); expect(body.stream).toBe(false); expect(body.tools).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.get("x-tenant")).toBe("synthetic-tenant"); expect(headers.get("x-route")).toBe("model-route");
      expect(headers.get("authorization")).toBe("Bearer synthetic-header-key");
      if (protocol === "anthropic-messages") {
        expect(headers.get("x-api-key")).toBe("synthetic-resolver-key");
        expect(headers.get("anthropic-beta")).toBe("synthetic-beta,synthetic-payload-beta");
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    await requestTextModel({ model: { ...described, key: "synthetic-resolver-key" },
      payload: { model: "client-cannot-select", stream: false, ...(protocol === "anthropic-messages" ? { betas: ["synthetic-payload-beta"] } : {}) }, signal: new AbortController().signal });
    expect(calls).toBe(1);
  });
}

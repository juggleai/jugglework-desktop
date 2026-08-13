import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildCodexGatewayEnvironment,
  codexProviderInputFromOpenCodeConnection,
  serializeCodexProviderConfig,
} from "./codex-provider-config.mjs";

function connection(overrides = {}) {
  return {
    id: "lpr_org_managed",
    name: "JuggleWork Models",
    apiKey: "organization-secret-must-not-leak",
    providerConfig: {
      api: "https://gateway.juggle.test/v1/",
      npm: "@ai-sdk/openai-compatible",
      env: ["JUGGLEROUTER_API_KEY"],
    },
    models: [
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", config: {} },
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", config: {} },
    ],
    ...overrides,
  };
}

describe("Codex provider config", () => {
  it("translates the OpenCode organization-provider payload without copying credentials", () => {
    const input = codexProviderInputFromOpenCodeConnection(connection(), {
      preferredModel: "gpt-5.6-sol",
    });
    assert.deepEqual(input, {
      providerId: "jugglework",
      providerName: "JuggleWork Models",
      baseUrl: "https://gateway.juggle.test/v1",
      tokenEnv: "JUGGLEWORK_CODEX_GATEWAY_TOKEN",
      model: "gpt-5.6-sol",
      availableModels: ["gpt-5.6-terra", "gpt-5.6-sol"],
    });
    assert.equal(JSON.stringify(input).includes("organization-secret"), false);
  });

  it("falls back to OpenCode options.baseURL and the first available model", () => {
    const input = codexProviderInputFromOpenCodeConnection(connection({
      providerConfig: { options: { baseURL: "http://127.0.0.1:9876/v1" } },
    }), { preferredModel: "missing-model" });
    assert.equal(input.baseUrl, "http://127.0.0.1:9876/v1");
    assert.equal(input.model, "gpt-5.6-terra");
  });

  it("serializes a Responses-only custom provider using an environment credential", () => {
    const input = codexProviderInputFromOpenCodeConnection(connection());
    const config = serializeCodexProviderConfig({ ...input, reasoningEffort: "high" });
    assert.match(config, /model_provider = "jugglework"/);
    assert.match(config, /base_url = "https:\/\/gateway\.juggle\.test\/v1"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /env_key = "JUGGLEWORK_CODEX_GATEWAY_TOKEN"/);
    assert.match(config, /model_reasoning_effort = "high"/);
    assert.equal(config.includes("organization-secret"), false);
  });

  it("injects the short-lived token into a child-only environment without mutating the source", () => {
    const source = { PATH: "/bin" };
    const env = buildCodexGatewayEnvironment(source, {
      tokenEnv: "JUGGLEWORK_CODEX_GATEWAY_TOKEN",
      token: "short-lived-token",
    });
    assert.deepEqual(source, { PATH: "/bin" });
    assert.deepEqual(env, {
      PATH: "/bin",
      JUGGLEWORK_CODEX_GATEWAY_TOKEN: "short-lived-token",
    });
  });

  it("rejects unsafe provider URLs, ids, environment names and empty model catalogs", () => {
    assert.throws(
      () => codexProviderInputFromOpenCodeConnection(connection({ providerConfig: { api: "file:///tmp/gateway" } })),
      /HTTP\(S\)/,
    );
    assert.throws(
      () => codexProviderInputFromOpenCodeConnection(connection(), { providerId: "bad.id" }),
      /provider id/,
    );
    assert.throws(
      () => codexProviderInputFromOpenCodeConnection(connection(), { tokenEnv: "bad-name" }),
      /environment name/,
    );
    assert.throws(
      () => codexProviderInputFromOpenCodeConnection(connection({ models: [] })),
      /does not expose a model/,
    );
  });
});

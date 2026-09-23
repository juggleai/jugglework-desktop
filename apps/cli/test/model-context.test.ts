import assert from "node:assert/strict";
import test from "node:test";
import { modelContextLabel, resolveModelContext } from "../src/model-context.js";
import type { JuggleWorkApiClient } from "../src/api.js";

test("model display reports provider, model and reasoning from explicit CLI selection", async () => {
  const api = { workspaceConfig: async () => { throw new Error("should not read config"); } } as unknown as JuggleWorkApiClient;
  const context = await resolveModelContext(api, { id: "ws" }, { model: "openai/gpt-5.6", reasoningEffort: "high" });
  assert.deepEqual(context, { provider: "openai", model: "gpt-5.6", reasoningEffort: "high", source: "cli" });
  assert.equal(modelContextLabel(context), "openai/gpt-5.6 · high reasoning");
});

test("model display reads workspace default without claiming an unknown reasoning effort", async () => {
  const api = { workspaceConfig: async () => ({ opencode: { model: "anthropic/claude-sonnet" } }) } as unknown as JuggleWorkApiClient;
  const context = await resolveModelContext(api, { id: "ws" }, { model: null, reasoningEffort: null });
  assert.deepEqual(context, { provider: "anthropic", model: "claude-sonnet", reasoningEffort: null, source: "workspace" });
  assert.equal(modelContextLabel(context), "anthropic/claude-sonnet · default reasoning");
});

test("model display marks unknown runtime defaults instead of inventing a model", async () => {
  const api = { workspaceConfig: async () => ({ opencode: {} }), providerList: async () => ({ all: [], connected: [], default: {} }) } as unknown as JuggleWorkApiClient;
  const context = await resolveModelContext(api, { id: "ws" }, { model: null, reasoningEffort: null });
  assert.equal(modelContextLabel(context), "runtime default model · default reasoning");
});

test("model display uses the connected runtime default when workspace has no explicit model", async () => {
  const api = {
    workspaceConfig: async () => ({ opencode: {} }),
    providerList: async () => ({ all: [], connected: ["openai"], default: { openai: "gpt-5" } }),
  } as unknown as JuggleWorkApiClient;
  const context = await resolveModelContext(api, { id: "ws" }, { model: null, reasoningEffort: null });
  assert.equal(modelContextLabel(context), "openai/gpt-5 · default reasoning");
});

import assert from "node:assert/strict";
import test from "node:test";
import { availableModels, loadAvailableModels } from "../src/model-catalog.js";
import type { JuggleWorkApiClient, RuntimeProviderList } from "../src/api.js";

const inventory: RuntimeProviderList = {
  connected: ["openai", "opencode"],
  default: { openai: "gpt-5" },
  all: [
    { id: "unused", models: { hidden: { name: "Hidden" } } },
    { id: "opencode", name: "OpenCode", models: { "big-pickle": { name: "Big Pickle" } } },
    { id: "openai", name: "OpenAI", models: {
      "gpt-5": { name: "GPT-5", variants: { low: {}, high: {} }, capabilities: { output: { text: true } } },
      image: { name: "Image", capabilities: { output: { image: true } } },
    } },
  ],
};

test("model picker lists connected chat models and reasoning variants only", async () => {
  assert.deepEqual(availableModels(inventory), [{ id: "openai/gpt-5", provider: "openai", providerName: "OpenAI", model: "gpt-5", label: "GPT-5", variants: ["low", "high"] }]);
  const api = { providerList: async (workspaceId: string) => {
    assert.equal(workspaceId, "ws_1");
    return inventory;
  } } as unknown as JuggleWorkApiClient;
  assert.deepEqual(await loadAvailableModels(api, { id: "ws_1" }), availableModels(inventory));
});

test("provider names are display-only and missing names fall back to the routing ID", () => {
  const models = availableModels({ connected: ["lpr_one", "lpr_two", "local"], all: [
    { id: "lpr_one", name: "组织模型服务", models: { chat: {} } },
    { id: "lpr_two", name: "组织模型服务", models: { chat: {} } },
    { id: "local", name: " ", models: { chat: {} } },
  ] });
  assert.deepEqual(models.map((model) => model.id), ["local/chat", "lpr_one/chat", "lpr_two/chat"]);
  assert.deepEqual(models.map((model) => model.providerName), ["local", "组织模型服务", "组织模型服务"]);
});

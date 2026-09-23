import assert from "node:assert/strict";
import test from "node:test";
import { availableModels, loadAvailableModels } from "../src/model-catalog.js";
import type { JuggleWorkApiClient, RuntimeProviderList } from "../src/api.js";

const inventory: RuntimeProviderList = {
  connected: ["openai"],
  default: { openai: "gpt-5" },
  all: [
    { id: "unused", models: { hidden: { name: "Hidden" } } },
    { id: "openai", models: {
      "gpt-5": { name: "GPT-5", variants: { low: {}, high: {} }, capabilities: { output: { text: true } } },
      image: { name: "Image", capabilities: { output: { image: true } } },
    } },
  ],
};

test("model picker lists connected chat models and reasoning variants only", async () => {
  assert.deepEqual(availableModels(inventory), [{ id: "openai/gpt-5", provider: "openai", model: "gpt-5", label: "GPT-5", variants: ["low", "high"] }]);
  const api = { providerList: async (workspaceId: string) => {
    assert.equal(workspaceId, "ws_1");
    return inventory;
  } } as unknown as JuggleWorkApiClient;
  assert.deepEqual(await loadAvailableModels(api, { id: "ws_1" }), availableModels(inventory));
});

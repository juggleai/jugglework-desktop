import { expect, test } from "bun:test";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  },
  addEventListener() {},
} });
const { readFileWindowConversationOptions } = await import("../src/react-app/kernel/file-window-options");
const { setSessionModelChoice, setSessionVariantChoice } = await import("../src/react-app/kernel/session-model-store");
const { setSessionAgentChoice } = await import("../src/react-app/kernel/session-agent-store");

test("file-window seed uses target workspace/session overrides and paired defaults without writing storage", () => {
  const defaultModel = { providerID: "default", modelID: "model" };
  const model = { providerID: "target", modelID: "model/with/slash" };
  const prefs = { defaultModel, modelVariant: "high" };
  setSessionModelChoice("ws", "target", model);
  setSessionAgentChoice("ws", "target", "plan");
  setSessionModelChoice("other", "target", defaultModel);
  const before = [...storage];
  expect(readFileWindowConversationOptions("ws", "target", prefs)).toEqual({ model, agent: "plan", variant: null });
  expect(readFileWindowConversationOptions("ws", "new", prefs)).toEqual({ model: defaultModel, agent: null, variant: "high" });
  expect(readFileWindowConversationOptions("other", "target", prefs)).toEqual({ model: defaultModel, agent: null, variant: "high" });
  expect([...storage]).toEqual(before);
  setSessionVariantChoice("ws", "target", "low");
  expect(readFileWindowConversationOptions("ws", "target", prefs).variant).toBe("low");
  setSessionVariantChoice("ws", "target", null);
  expect(readFileWindowConversationOptions("ws", "target", prefs).variant).toBeNull();
});

test("file-window seed reuses persisted session schemas and strips unrelated preference fields", () => {
  storage.set("jugglework.sessionModels.persisted", JSON.stringify({ ses: { model: "provider/model/nested", variant: "high" }, other: "other/model" }));
  storage.set("jugglework.sessionAgents.persisted", JSON.stringify({ ses: " plan ", other: "build" }));
  const prefs = { defaultModel: null, modelVariant: null, token: "synthetic-canary", selectedAgent: "legacy" };
  expect(readFileWindowConversationOptions("persisted", "ses", prefs)).toEqual({ model: { providerID: "provider", modelID: "model/nested" }, agent: "plan", variant: "high" });
  expect(readFileWindowConversationOptions("persisted", "new", prefs)).toEqual({ model: null, agent: null, variant: null });
});

import { beforeEach, describe, expect, test } from "bun:test";
const storage = new Map<string, string>();
const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
Object.defineProperty(globalThis, "window", { value: { localStorage }, configurable: true });
const store = await import("../src/react-app/kernel/session-media-model-store");

describe("session media model store", () => {
  beforeEach(() => storage.clear());
  test("isolates session video defaults by workspace", () => {
    store.setSessionMediaModelChoice("ws-a", "session", { providerID: "a", modelID: "video" });
    store.setSessionMediaModelChoice("ws-b", "session", { providerID: "b", modelID: "video" });
    expect(store.readSessionMediaModelChoices("ws-a").session.providerID).toBe("a");
    expect(store.readSessionMediaModelChoices("ws-b").session.providerID).toBe("b");
  });
  test("resolves explicit then session then workspace then stable ready fallback", () => {
    const ready = [{ providerID: "ready", modelID: "one" }, { providerID: "ready", modelID: "two" }];
    expect(store.resolveVideoModelPreference({ explicit: { providerID: "missing", modelID: "x" }, session: ready[1], workspace: ready[0], ready }).model).toEqual(ready[1]);
    expect(store.resolveVideoModelPreference({ ready }).model).toEqual(ready[0]);
  });
});

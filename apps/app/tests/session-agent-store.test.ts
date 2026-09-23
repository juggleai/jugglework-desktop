import { beforeEach, describe, expect, test } from "bun:test";

const storage = new Map<string, string>();
const storageListeners: Array<(event: { key: string }) => void> = [];
const localStorageStub = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
};
Object.defineProperty(globalThis, "window", {
  value: {
    localStorage: localStorageStub,
    addEventListener: (event: string, listener: (event: { key: string }) => void) => {
      if (event === "storage") storageListeners.push(listener);
    },
  },
  configurable: true,
});

const {
  migrateLegacyAgentChoice,
  readSessionAgentChoice,
  setSessionAgentChoice,
} = await import("../src/react-app/kernel/session-agent-store");

let sequence = 0;
let workspaceId = "";

describe("session agent store", () => {
  beforeEach(() => {
    storage.clear();
    workspaceId = `agent-workspace-${++sequence}`;
  });

  test("isolates choices by session and workspace; a new session uses the default", () => {
    setSessionAgentChoice(workspaceId, "session-a", "plan");
    setSessionAgentChoice(workspaceId, "session-c", "custom");

    expect(readSessionAgentChoice(workspaceId, "session-a")).toBe("plan");
    expect(readSessionAgentChoice(workspaceId, "session-b")).toBeNull();
    expect(readSessionAgentChoice(workspaceId, "session-c")).toBe("custom");
    expect(readSessionAgentChoice("other-workspace", "session-a")).toBeNull();
    expect(readSessionAgentChoice(workspaceId, null)).toBeNull();
  });

  test("persists the active session across reload and clearing does not affect another session", () => {
    setSessionAgentChoice(workspaceId, "session-a", "plan");
    setSessionAgentChoice(workspaceId, "session-b", "custom");
    const key = `jugglework.sessionAgents.${workspaceId}`;
    expect(JSON.parse(storage.get(key)!)).toEqual({ "session-a": "plan", "session-b": "custom" });

    // A storage event simulates another window or a reload of the cached state.
    storageListeners.forEach((listener) => listener({ key }));
    expect(readSessionAgentChoice(workspaceId, "session-a")).toBe("plan");

    setSessionAgentChoice(workspaceId, "session-a", null);
    expect(readSessionAgentChoice(workspaceId, "session-a")).toBeNull();
    expect(readSessionAgentChoice(workspaceId, "session-b")).toBe("custom");
  });

  test("migrates a legacy global choice only to the active session without overriding a choice", () => {
    migrateLegacyAgentChoice(workspaceId, "session-a", "plan");
    expect(readSessionAgentChoice(workspaceId, "session-a")).toBe("plan");
    expect(readSessionAgentChoice(workspaceId, "session-b")).toBeNull();

    setSessionAgentChoice(workspaceId, "session-a", "custom");
    migrateLegacyAgentChoice(workspaceId, "session-a", "plan");
    expect(readSessionAgentChoice(workspaceId, "session-a")).toBe("custom");
  });

  test("ignores malformed persisted values", () => {
    const key = `jugglework.sessionAgents.${workspaceId}`;
    storage.set(key, JSON.stringify({ "session-a": 42, "session-b": "  plan  " }));
    storageListeners.forEach((listener) => listener({ key }));
    expect(readSessionAgentChoice(workspaceId, "session-a")).toBeNull();
    expect(readSessionAgentChoice(workspaceId, "session-b")).toBe("plan");
  });
});

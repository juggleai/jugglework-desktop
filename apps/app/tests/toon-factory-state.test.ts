import { afterEach, describe, expect, test } from "bun:test";

import {
  clearToonTextDraft,
  flushToonTextDrafts,
  readToonTextDraft,
  toonProjectKey,
  toonQueryScope,
  toonTextDraftKey,
  toonTextRequestFingerprint,
  registerToonTextDraftFlusher,
  writeToonTextDraft,
} from "../src/react-app/domains/toon-factory/toon-factory-state";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

describe("Toon Factory request and retained state", () => {
  const request = {
    workspaceId: "workspace-1",
    projectId: "project-1",
    episodeId: "episode-1",
    canvasId: "canvas-1",
    nodeId: "node-1",
    selectedModel: { kind: "text" as const, providerID: "provider", modelID: "model" },
    action: "script",
    prompt: "Write a pilot",
    outputSchema: { type: "object", properties: { title: { type: "string" } } },
  };

  test("invalidates exact approval for every request identity field", () => {
    const approved = toonTextRequestFingerprint(request);
    for (const [field, value] of [
      ["workspaceId", "workspace-2"], ["projectId", "project-2"], ["episodeId", "episode-2"],
      ["canvasId", "canvas-2"], ["nodeId", "node-2"], ["action", "storyboard"], ["prompt", "Changed"],
    ] as const) {
      expect(toonTextRequestFingerprint({ ...request, [field]: value })).not.toBe(approved);
    }
    expect(toonTextRequestFingerprint({ ...request, selectedModel: { ...request.selectedModel, modelID: "other" } })).not.toBe(approved);
    expect(toonTextRequestFingerprint({ ...request, outputSchema: { type: "array" } })).not.toBe(approved);
  });

  test("scopes query keys by normalized endpoint and workspace", () => {
    expect(toonProjectKey(toonQueryScope("http://one/", "workspace-1"), "project-1")).toEqual(["toon-factory", "http://one", "workspace-1", "project", "project-1"]);
    expect(toonProjectKey(toonQueryScope("http://two", "workspace-1"), "project-1")).not.toEqual(toonProjectKey(toonQueryScope("http://one", "workspace-1"), "project-1"));
  });

  test("retains drafts independently across node and episode switches", () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } } });
    const first = toonTextDraftKey("workspace", "project", "episode-1", "node-1");
    const nodeSwitch = toonTextDraftKey("workspace", "project", "episode-1", "node-2");
    const episodeSwitch = toonTextDraftKey("workspace", "project", "episode-2", "node-1");
    writeToonTextDraft(first, { content: "unsaved scene", baseRevision: "a".repeat(64), dirty: true });
    expect(readToonTextDraft(first)?.content).toBe("unsaved scene");
    expect(readToonTextDraft(nodeSwitch)).toBeNull();
    expect(readToonTextDraft(episodeSwitch)).toBeNull();
    clearToonTextDraft(first);
    expect(readToonTextDraft(first)).toBeNull();
  });

  test("awaits registered draft flushes before a node, episode, or route switch", async () => {
    const order: string[] = [];
    const unregister = registerToonTextDraftFlusher("draft", async () => {
      await Promise.resolve();
      order.push("saved");
    });
    try {
      const switching = flushToonTextDrafts().then(() => order.push("switched"));
      expect(order).toEqual([]);
      await switching;
      expect(order).toEqual(["saved", "switched"]);
    } finally {
      unregister();
    }
  });
});

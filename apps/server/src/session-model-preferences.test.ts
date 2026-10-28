import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionModelPreferenceStore } from "./session-model-preferences.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("session model preference store", () => {
  test("persists revisioned auto/explicit updates and committed events", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-model-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    let time = 100;
    const store = await createSessionModelPreferenceStore({ path, now: () => ++time });
    expect(store.get("ws", "ses")).toMatchObject({ revision: 0, mode: "auto", model: null });
    const model = { providerID: "provider", modelID: "model" };
    expect(store.set({ workspaceId: "ws", sessionId: "ses", expectedRevision: 0, mode: "explicit", model })).toMatchObject({ updated: true, preference: { revision: 1, mode: "explicit", model } });
    expect(store.set({ workspaceId: "ws", sessionId: "ses", expectedRevision: 0, mode: "auto", model: null })).toMatchObject({ updated: false, preference: { revision: 1 } });
    expect(store.set({ workspaceId: "ws", sessionId: "ses", expectedRevision: 1, mode: "auto", model: null })).toMatchObject({ updated: true, preference: { revision: 2, mode: "auto", model: null } });
    expect(store.events("ws", 0)).toMatchObject({ cursor: 2, items: [{ revision: 1 }, { revision: 2 }] });
    store.delete("ws", "ses");
    expect(store.get("ws", "ses")).toMatchObject({ revision: 0, mode: "auto", model: null });
    expect(store.events("ws", 0).items).toEqual([]);
    store.close();
    const reopened = await createSessionModelPreferenceStore({ path });
    expect(reopened.get("ws", "ses")).toMatchObject({ revision: 0, mode: "auto" });
    reopened.close();
  });
});

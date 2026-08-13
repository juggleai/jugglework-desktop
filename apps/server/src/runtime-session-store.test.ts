import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RuntimeEvent } from "@jugglework/types/agent-runtime";
import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";
import { RuntimeSessionStore, RuntimeSessionStoreError } from "./runtime-session-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "runtime-session-store-"));
  roots.push(root);
  const store = await RuntimeSessionStore.open(join(root, "runtime.sqlite"));
  const record: RuntimeSessionRecord = {
    schemaVersion: 1, id: "ses_1", orgId: "org_1", workspaceId: "ws_1", runtimeKind: "codex",
    backendThreadId: "thr_1", agentProfileId: null, modelProviderId: "gateway", modelId: "model_1",
    reasoningEffort: "medium", cwd: root, title: "Session", runtimeLocked: true, configSnapshot: {}, attachments: [],
    createdAt: 1, updatedAt: 1, archivedAt: null,
  };
  store.putSession(record);
  return { store, record, scope: { orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1" } };
}

function event(type: "turn.started" | "turn.completed", eventId: string, occurredAt: number): RuntimeEvent {
  return {
    schemaVersion: 1, eventId, occurredAt, workspaceId: "ws_1", orgId: "org_1", runtimeKind: "codex",
    sessionId: "ses_1", threadId: "thr_1", turnId: "turn_1", type,
  } as RuntimeEvent;
}

describe("runtime session store", () => {
  test("persists scoped mappings and rejects cross-organization reads", async () => {
    const { store, record, scope } = await fixture();
    try {
      assert.deepEqual(store.getSession(scope), record);
      assert.throws(() => store.getSession({ ...scope, orgId: "org_2" }), RuntimeSessionStoreError);
      assert.deepEqual(store.listSessions({ orgId: "org_2", workspaceId: "ws_1" }), []);
    } finally { store.close(); }
  });

  test("deduplicates backend events and does not regress a terminal turn", async () => {
    const { store, scope } = await fixture();
    try {
      assert.equal(store.appendEvent(scope, "backend-start", event("turn.started", "event-start", 20)).inserted, true);
      assert.equal(store.appendEvent(scope, "backend-end", event("turn.completed", "event-end", 30)).inserted, true);
      assert.equal(store.appendEvent(scope, "backend-end", event("turn.completed", "event-end", 30)).inserted, false);
      assert.equal(store.appendEvent(scope, "late-start", event("turn.started", "event-late", 10)).inserted, true);
      assert.deepEqual(store.readEvents(scope).map((item) => item.eventId), ["event-late", "event-start", "event-end"]);
      assert.deepEqual(store.listIncompleteTurns(scope), []);
    } finally { store.close(); }
  });

  test("archives without deleting authoritative history", async () => {
    const { store, scope } = await fixture();
    try {
      store.appendEvent(scope, "start", event("turn.started", "start", 2));
      store.archiveSession(scope, 3);
      assert.deepEqual(store.listSessions({ orgId: "org_1", workspaceId: "ws_1" }), []);
      assert.equal(store.listSessions({ orgId: "org_1", workspaceId: "ws_1", includeArchived: true }).length, 1);
      assert.equal(store.readEvents(scope).length, 1);
    } finally { store.close(); }
  });

  test("migrates legacy OpenCode sessions deterministically and supports scoped search", async () => {
    const { store, record } = await fixture();
    try {
      store.putSession({ ...record, title: "Codex image analysis" });
      const migrated = store.migrateLegacyOpenCodeSessions([{
        id: "legacy_1", directory: record.cwd, title: "Legacy planning", time: { created: 2, updated: 3 },
      }], { orgId: "org_1", workspaceId: "ws_1", modelProviderId: "provider", modelId: "model" });
      const repeated = store.migrateLegacyOpenCodeSessions([{
        id: "legacy_1", directory: record.cwd, title: "Legacy planning", time: { created: 2, updated: 3 },
      }], { orgId: "org_1", workspaceId: "ws_1", modelProviderId: "provider", modelId: "model" });
      assert.equal(migrated[0]?.id, repeated[0]?.id);
      assert.equal(migrated[0]?.backendThreadId, "legacy_1");
      assert.deepEqual(store.searchSessions({ orgId: "org_1", workspaceId: "ws_1", search: "legacy" }).map((item) => item.id), [migrated[0]?.id]);
      assert.deepEqual(store.searchSessions({ orgId: "org_2", workspaceId: "ws_1", search: "legacy" }), []);
    } finally { store.close(); }
  });

  test("rejects inline attachment bodies", async () => {
    const { store, record } = await fixture();
    try {
      assert.throws(() => store.putSession({ ...record, id: "ses_inline", attachments: [{
        id: "img", kind: "image", source: "upload", name: "a.png", mimeType: "image/png", sizeBytes: 1,
        sha256: null, objectRef: "data:image/png;base64,AA==", previewRef: null,
      }] }), RuntimeSessionStoreError);
    } finally { store.close(); }
  });
});

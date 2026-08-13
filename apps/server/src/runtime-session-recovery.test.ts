import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import type { RuntimeSessionRecord } from "@jugglework/types/runtime-session";
import { reconcileRuntimeSession } from "./runtime-session-recovery.js";
import { RuntimeSessionStore } from "./runtime-session-store.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("runtime session recovery", () => {
  test("recreates a missing thread and converges an interrupted turn exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "runtime-session-recovery-"));
    roots.push(root);
    const store = await RuntimeSessionStore.open(join(root, "runtime.sqlite"));
    const record: RuntimeSessionRecord = {
      schemaVersion: 1, id: "ses_1", orgId: "org_1", workspaceId: "ws_1", runtimeKind: "codex", backendThreadId: "lost",
      agentProfileId: null, modelProviderId: "gateway", modelId: "model", reasoningEffort: null, cwd: root, title: "Session",
      runtimeLocked: true, configSnapshot: {}, attachments: [], createdAt: 1, updatedAt: 1, archivedAt: null,
    };
    const scope = { orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1" };
    try {
      store.putSession(record);
      store.appendEvent(scope, "start", {
        schemaVersion: 1, eventId: "start", occurredAt: 4, workspaceId: "ws_1", orgId: "org_1", runtimeKind: "codex",
        sessionId: "ses_1", threadId: "lost", turnId: "turn_1", type: "turn.started",
      });
      const result = await reconcileRuntimeSession({ store, ...scope, threadExists: async () => false, recreateThread: async () => "thr_new", now: () => 10 });
      assert.equal(result.record.backendThreadId, "thr_new");
      assert.deepEqual(result.failedTurns, ["turn_1"]);
      assert.deepEqual(store.listIncompleteTurns(scope), []);
      const again = await reconcileRuntimeSession({ store, ...scope, threadExists: async () => true, recreateThread: async () => "unused", now: () => 20 });
      assert.deepEqual(again.failedTurns, []);
    } finally { store.close(); }
  });
});

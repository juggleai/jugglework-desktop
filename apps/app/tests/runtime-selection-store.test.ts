import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newRuntimeSessionId, selectedRuntimeFor, useRuntimeSelectionStore } from "../src/react-app/domains/session/sync/runtime-selection-store.ts";

describe("runtime selection store", () => {
  test("allows Codex only for a local draft and locks a created session", () => {
    const store = useRuntimeSelectionStore.getState();
    assert.equal(store.setWorkspaceDraftRuntime("local", "codex", "local"), "codex");
    assert.equal(store.setWorkspaceDraftRuntime("remote", "codex", "remote"), "opencode");
    assert.equal(selectedRuntimeFor({ workspaceId: "local", workspaceType: "local", sessionId: null, state: useRuntimeSelectionStore.getState() }), "codex");
    assert.equal(selectedRuntimeFor({ workspaceId: "local", workspaceType: "local", sessionId: "legacy_opencode", state: useRuntimeSelectionStore.getState() }), "opencode");
    store.bindThread({ id: "thr_1", backendThreadId: "thr_1", orgId: "org", workspaceId: "local", sessionId: "ses_1",
      runtimeKind: "codex", modelProviderId: "provider", modelId: "model", createdAt: 1 });
    store.setWorkspaceDraftRuntime("local", "opencode", "local");
    assert.equal(selectedRuntimeFor({ workspaceId: "local", workspaceType: "local", sessionId: "ses_1", state: useRuntimeSelectionStore.getState() }), "codex");
    assert.equal(useRuntimeSelectionStore.getState().sessionBindings.ses_1?.ready, true);
  });

  test("tracks active turn lifecycle and creates independent JuggleWork ids", () => {
    const store = useRuntimeSelectionStore.getState();
    store.applyEvent({ schemaVersion: 1, eventId: "1", occurredAt: 1, orgId: "org", workspaceId: "local", runtimeKind: "codex",
      sessionId: "ses_1", threadId: "thr_1", turnId: "turn_1", type: "turn.started" });
    assert.equal(useRuntimeSelectionStore.getState().sessionBindings.ses_1?.activeTurnId, "turn_1");
    store.applyEvent({ schemaVersion: 1, eventId: "2", occurredAt: 2, orgId: "org", workspaceId: "local", runtimeKind: "codex",
      sessionId: "ses_1", threadId: "thr_1", turnId: "turn_1", type: "turn.completed" });
    assert.equal(useRuntimeSelectionStore.getState().sessionBindings.ses_1?.activeTurnId, null);
    assert.equal(newRuntimeSessionId(() => "1234-5678"), "jws_12345678");
  });
});

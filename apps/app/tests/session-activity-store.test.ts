import { beforeEach, describe, expect, test } from "bun:test";

import {
  SESSION_STALLED_AFTER_MS,
  useSessionActivityStore,
} from "../src/react-app/domains/session/status/session-activity-store";

const workspaceId = "workspace-1";
const sessionId = "session-1";

function resetStore() {
  useSessionActivityStore.setState({
    recordsByWorkspaceId: {},
    statusesByWorkspaceId: {},
  });
}

describe("session activity reconciliation", () => {
  beforeEach(resetStore);

  test("authoritative workspace snapshots clear a stale running indicator", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");

    store.seedWorkspaceSessions(workspaceId, [{ id: sessionId, status: { type: "idle" } }]);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
  });

  test("authoritative session snapshots clear stale activity and waiting state", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    store.setWaitingRequest(workspaceId, sessionId, "permission", "permission-1", true);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("waiting");

    store.seedSessionRun(workspaceId, sessionId, { type: "idle" }, false);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
  });

  test("live status events can start and finish activity normally", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");

    store.setRunStatus(workspaceId, sessionId, { type: "idle" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");
  });

  test("marks a silent busy session as stalled without stopping it", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt!;

    store.refreshStalledStatuses(startedAt + SESSION_STALLED_AFTER_MS + 1);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("stalled");
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.runActive).toBe(true);
  });

  test("meaningful progress clears stalled and allows a later retry window", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt!;
    store.refreshStalledStatuses(startedAt + SESSION_STALLED_AFTER_MS + 1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("stalled");

    store.markProgress(workspaceId, sessionId, startedAt + SESSION_STALLED_AFTER_MS + 2);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
  });

  test("provider retry updates runtime liveness without resetting meaningful progress", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt!;

    store.setProviderRetry(workspaceId, sessionId, {
      attempt: 2,
      message: "Provider stream failed",
      next: startedAt + 10_000,
      observedAt: startedAt + 5_000,
    });

    const retrying = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
    expect(retrying.status).toBe("retrying");
    expect(retrying.lastMeaningfulProgressAt).toBe(startedAt);
    expect(retrying.lastRuntimeEventAt).toBe(startedAt + 5_000);
    expect(retrying.providerRetry).toMatchObject({ attempt: 2, message: "Provider stream failed" });

    store.refreshStalledStatuses(startedAt + SESSION_STALLED_AFTER_MS + 1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("stalled");
    expect(useSessionActivityStore.getState().getProviderRetry(workspaceId, sessionId)?.attempt).toBe(2);
  });

  test("meaningful progress clears provider retry activity", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    store.setProviderRetry(workspaceId, sessionId, {
      attempt: 3,
      message: "Temporary provider error",
      next: null,
    });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("retrying");

    store.markProgress(workspaceId, sessionId);

    expect(useSessionActivityStore.getState().getProviderRetry(workspaceId, sessionId)).toBeNull();
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
  });

  test("replayed busy status is not treated as progress", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt;

    store.setRunStatus(workspaceId, sessionId, { type: "busy" });

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt).toBe(startedAt);
  });

  test("keeps an incomplete completion diagnostic reload-blocking after idle", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    store.setRunStatus(workspaceId, sessionId, { type: "idle" });
    store.setCompletionDiagnostic(workspaceId, sessionId, true, "tool_loop_terminated");

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("incomplete");
    expect(useSessionActivityStore.getState().getFinishReason(workspaceId, sessionId)).toBe("tool_loop_terminated");

    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
    expect(useSessionActivityStore.getState().getFinishReason(workspaceId, sessionId)).toBeNull();
  });

  test("a stale busy workspace snapshot cannot revive a run the live stream already ended", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    // 中断（aborted）走的就是这条路径：实时事件宣告结束，但没有 incomplete 诊断兜底。
    store.setRunStatus(workspaceId, sessionId, { type: "idle" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");

    // 侧栏列表仍留着运行期间取到的 busy，且列表每次变更都会重新 seed 一遍。
    store.seedWorkspaceSessions(workspaceId, [{ id: sessionId, status: { type: "busy" } }]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("idle");

    // 真正的新任务仍然由实时事件重新点亮。
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
  });

  test("a failed session stays failed across stale busy workspace snapshots", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    store.setError(workspaceId, sessionId, "boom");

    store.seedWorkspaceSessions(workspaceId, [{ id: sessionId, status: { type: "busy" } }]);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("error");
  });

  test("an on-demand session snapshot still outranks the live end marker", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    store.setRunStatus(workspaceId, sessionId, { type: "idle" });

    store.seedSessionRun(workspaceId, sessionId, { type: "busy" }, false);

    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
  });

  test("treats finish_reason stop with an incomplete diagnostic as terminal across stale busy snapshots", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt!;
    store.refreshStalledStatuses(startedAt + SESSION_STALLED_AFTER_MS + 1);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("stalled");

    store.setCompletionDiagnostic(workspaceId, sessionId, true, "stop");

    const completed = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!;
    expect(completed.status).toBe("incomplete");
    expect(completed.runActive).toBeFalse();
    expect(completed.stalledAt).toBeNull();

    store.seedWorkspaceSessions(workspaceId, [{ id: sessionId, status: { type: "busy" } }]);
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("incomplete");

    // A real new run comes through the live status path and remains restartable.
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    expect(useSessionActivityStore.getState().getStatus(workspaceId, sessionId)).toBe("thinking");
    expect(useSessionActivityStore.getState().getFinishReason(workspaceId, sessionId)).toBeNull();
  });
});

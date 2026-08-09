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

  test("replayed busy status is not treated as progress", () => {
    const store = useSessionActivityStore.getState();
    store.setRunStatus(workspaceId, sessionId, { type: "busy" });
    const startedAt = useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt;

    store.setRunStatus(workspaceId, sessionId, { type: "busy" });

    expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]![sessionId]!.lastMeaningfulProgressAt).toBe(startedAt);
  });
});

import { beforeEach, describe, expect, test } from "bun:test";

import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

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
});

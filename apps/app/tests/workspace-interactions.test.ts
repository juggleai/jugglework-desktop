import { afterEach, describe, expect, test } from "bun:test";

import type { JuggleWorkInteractionSnapshot } from "../src/app/lib/jugglework-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  captureInteractionSnapshotFence,
  getWorkspaceInteractionState,
  INTERACTION_TOMBSTONE_CAPACITY,
  INTERACTION_TOMBSTONE_TTL_MS,
  pendingInteractionsForRoot,
  reconcileInteractionSnapshot,
  resolveLiveInteraction,
  seedWorkspaceSessionAncestry,
  taskHasPendingInteraction,
  upsertLivePermission,
  upsertLiveQuestion,
} from "../src/react-app/domains/session/sync/workspace-interactions";
import {
  isTerminalInteractionReplyError,
  permissionInteractionReply,
  questionInteractionReply,
} from "../src/react-app/domains/session/sync/use-session-interactions";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

const syncInput = {
  workspaceId: "workspace-a",
  baseUrl: "http://127.0.0.1:1234",
  juggleworkToken: "token",
};

function permission(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    permission: "external_directory",
    patterns: ["/outside/project"],
    metadata: {},
    always: [],
  };
}

function question(id: string, sessionID: string) {
  return {
    id,
    sessionID,
    questions: [{
      id: "choice",
      header: "Choice",
      question: "Continue?",
      options: [{ label: "Yes", description: "Proceed" }],
    }],
  };
}

function snapshot(
  permissions: JuggleWorkInteractionSnapshot["permissions"] = [],
  questions: JuggleWorkInteractionSnapshot["questions"] = [],
  snapshotStartedAt = 100,
): JuggleWorkInteractionSnapshot {
  return {
    snapshotStartedAt,
    rootSessionId: "root",
    includeDescendants: true,
    permissions,
    questions,
  };
}

afterEach(() => {
  getReactQueryClient().clear();
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
});

describe("workspace canonical interactions", () => {
  test("keeps an untracked nested child event and presents it only under its root", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
      { id: "other-root", parentID: undefined },
    ]);
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.asked",
        properties: permission("perm-nested", "grandchild"),
      } as any);

      const state = getWorkspaceInteractionState("workspace-a");
      expect(pendingInteractionsForRoot(state, "root").permissions).toMatchObject([{
        id: "perm-nested",
        targetSessionId: "grandchild",
        parentSessionId: "child",
        rootSessionId: "root",
      }]);
      expect(pendingInteractionsForRoot(state, "other-root").permissions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("retains an orphan and rehomes it when ancestry arrives", () => {
    upsertLiveQuestion("workspace-a", question("question-orphan", "child") as any, 10);
    expect(getWorkspaceInteractionState("workspace-a").questions[0]).toMatchObject({
      targetSessionId: "child",
      rootSessionId: null,
    });

    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);

    expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root").questions).toMatchObject([{
      id: "question-orphan",
      targetSessionId: "child",
      rootSessionId: "root",
    }]);
  });

  test("uses a renderer-local fence when the server clock is five minutes slow", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    const fence = captureInteractionSnapshotFence("workspace-a");
    upsertLivePermission("workspace-a", permission("perm-live", "child") as any);

    reconcileInteractionSnapshot("workspace-a", snapshot([], [], Date.now() - 5 * 60_000), fence);

    expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root").permissions)
      .toMatchObject([{ id: "perm-live", targetSessionId: "child" }]);
  });

  test("does not let a stale snapshot overwrite a newer schema for the same identity", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    const fence = captureInteractionSnapshotFence("workspace-a");
    upsertLiveQuestion("workspace-a", {
      ...question("question-schema", "child"),
      questions: [{
        ...question("question-schema", "child").questions[0]!,
        question: "New schema?",
      }],
    } as any);

    reconcileInteractionSnapshot("workspace-a", snapshot([], [{
      ...question("question-schema", "child"),
      protocol: "legacy",
      targetSessionId: "child",
      parentSessionId: "root",
      rootSessionId: "root",
      ancestryPath: ["root", "child"],
    }], Date.now() + 5 * 60_000), fence);

    expect(getWorkspaceInteractionState("workspace-a").questions[0]?.questions[0]?.question).toBe("New schema?");
  });

  test("uses tombstones to prevent an in-flight snapshot from resurrecting a reply", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-resolved", "child") as any);
    const fence = captureInteractionSnapshotFence("workspace-a");
    resolveLiveInteraction("workspace-a", "permission", "child", "perm-resolved");

    reconcileInteractionSnapshot("workspace-a", snapshot([{
      ...permission("perm-resolved", "child"),
      protocol: "legacy",
      targetSessionId: "child",
      parentSessionId: "root",
      rootSessionId: "root",
      ancestryPath: ["root", "child"],
    }], [], Date.now() + 5 * 60_000), fence);

    expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root").permissions).toEqual([]);
  });

  test("does not let a late asked event resurrect a terminal interaction", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-late", "child") as any);
    resolveLiveInteraction("workspace-a", "permission", "child", "perm-late");

    upsertLivePermission("workspace-a", permission("perm-late", "child") as any);

    expect(pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root").permissions).toEqual([]);
  });

  test("does not restore Activity waiting for a late asked event after terminal cleanup", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-late-waiting", "child") as any);
    useSessionActivityStore.getState().setWaitingRequest("workspace-a", "child", "permission", "perm-late-waiting", true);
    resolveLiveInteraction("workspace-a", "permission", "child", "perm-late-waiting");

    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.asked",
        properties: permission("perm-late-waiting", "child"),
      } as any);
      expect(
        useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]?.child?.waitingPermissionIds,
      ).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("snapshot recovers questions and removes stale root records", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-stale", "child") as any, 50);
    const fence = captureInteractionSnapshotFence("workspace-a");

    reconcileInteractionSnapshot("workspace-a", snapshot([], [{
      ...question("question-recovered", "child"),
      protocol: "legacy",
      targetSessionId: "child",
      parentSessionId: "root",
      rootSessionId: "root",
      ancestryPath: ["root", "child"],
    }], Date.now() + 5 * 60_000), fence);

    const root = pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root");
    expect(root.permissions).toEqual([]);
    expect(root.questions).toMatchObject([{
      id: "question-recovered",
      targetSessionId: "child",
    }]);
  });

  test("keeps an authoritative nested root when the intermediate session is not locally tracked", () => {
    const fence = captureInteractionSnapshotFence("workspace-a");
    reconcileInteractionSnapshot("workspace-a", snapshot([{
      ...permission("perm-grandchild", "grandchild"),
      protocol: "legacy",
      targetSessionId: "grandchild",
      parentSessionId: "child",
      rootSessionId: "root",
      ancestryPath: ["root", "child", "grandchild"],
    }], [], 100), fence);

    seedWorkspaceSessionAncestry("workspace-a", [{ id: "unrelated", parentID: undefined }]);

    const state = getWorkspaceInteractionState("workspace-a");
    expect(pendingInteractionsForRoot(state, "root").permissions).toMatchObject([{
      id: "perm-grandchild",
      targetSessionId: "grandchild",
      parentSessionId: "child",
      rootSessionId: "root",
    }]);
    expect(taskHasPendingInteraction(state, "root", "child")).toBe(true);
  });

  test("preserves the authoritative root hint when a partial ancestry seed marks the target rootless", () => {
    const fence = captureInteractionSnapshotFence("workspace-a");
    reconcileInteractionSnapshot("workspace-a", snapshot([{
      ...permission("perm-hinted", "grandchild"),
      protocol: "legacy",
      targetSessionId: "grandchild",
      parentSessionId: "child",
      rootSessionId: "root",
      ancestryPath: ["root", "child", "grandchild"],
    }]), fence);

    seedWorkspaceSessionAncestry("workspace-a", [{ id: "grandchild", parentID: undefined }]);
    upsertLiveQuestion("workspace-a", question("question-hinted", "grandchild") as any);

    const hinted = getWorkspaceInteractionState("workspace-a").questions[0];
    expect(hinted).toMatchObject({ rootSessionId: "root" });
    expect(hinted?.ancestryPath).toEqual(["root", "grandchild"]);
  });

  test("uses authoritative ancestryPath for a deep Task when the local chain is incomplete", () => {
    const fence = captureInteractionSnapshotFence("workspace-a");
    reconcileInteractionSnapshot("workspace-a", snapshot([{
      ...permission("perm-deep", "leaf"),
      protocol: "legacy",
      targetSessionId: "leaf",
      parentSessionId: "missing-parent",
      rootSessionId: "root",
      ancestryPath: ["root", "task-child", "missing-parent", "leaf"],
    }], [], 100), fence);

    const state = getWorkspaceInteractionState("workspace-a");
    expect(taskHasPendingInteraction(state, "root", "task-child")).toBe(true);
    expect(state.permissions[0]?.ancestryPath).toEqual(["root", "task-child", "missing-parent", "leaf"]);
  });

  test("bounds tombstones while fencing snapshots that were in flight before eviction", () => {
    const staleFence = captureInteractionSnapshotFence("workspace-a");
    const now = 1_000;
    for (let index = 0; index < INTERACTION_TOMBSTONE_CAPACITY + 5; index += 1) {
      resolveLiveInteraction("workspace-a", "permission", "child", `resolved-${index}`, now + index);
    }

    let state = getWorkspaceInteractionState("workspace-a");
    expect(Object.keys(state.tombstones)).toHaveLength(INTERACTION_TOMBSTONE_CAPACITY);
    expect(state.invalidSnapshotBeforeRevision).toBeGreaterThan(staleFence);

    reconcileInteractionSnapshot("workspace-a", snapshot([{
      ...permission("resolved-0", "child"),
      protocol: "legacy",
      targetSessionId: "child",
      parentSessionId: "root",
      rootSessionId: "root",
      ancestryPath: ["root", "child"],
    }]), staleFence, now + INTERACTION_TOMBSTONE_TTL_MS + INTERACTION_TOMBSTONE_CAPACITY + 10);

    state = getWorkspaceInteractionState("workspace-a");
    expect(state.permissions).toEqual([]);
    expect(Object.keys(state.tombstones)).toHaveLength(0);
  });

  test("authoritative snapshots synchronize Activity waiting for each target session", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    useSessionActivityStore.getState().setWaitingRequest("workspace-a", "child", "permission", "stale", true);
    useSessionActivityStore.getState().setWaitingRequest("workspace-a", "child", "question", "stale-question", true);

    const fence = captureInteractionSnapshotFence("workspace-a");
    reconcileInteractionSnapshot("workspace-a", snapshot([], [], Date.now() - 5 * 60_000), fence);

    const activity = useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]?.child;
    expect(activity?.waitingPermissionIds).toEqual([]);
    expect(activity?.waitingQuestionIds).toEqual([]);
  });

  test("local terminal cleanup clears Activity waiting for the exact child", () => {
    useSessionActivityStore.getState().setWaitingRequest("workspace-a", "child", "question", "question-child", true);
    resolveLiveInteraction("workspace-a", "question", "child", "question-child");
    expect(
      useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]?.child?.waitingQuestionIds,
    ).toEqual([]);
  });

  test("session deletion clears descendant interactions, tombstones, ancestry, and waiting state", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "task-child", parentID: "root" },
      { id: "nested-child", parentID: "task-child" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-child", "task-child") as any);
    upsertLiveQuestion("workspace-a", question("question-nested", "nested-child") as any);
    upsertLivePermission("workspace-a", permission("perm-resolved", "nested-child") as any);
    resolveLiveInteraction("workspace-a", "permission", "nested-child", "perm-resolved");
    const staleFence = captureInteractionSnapshotFence("workspace-a");
    const activity = useSessionActivityStore.getState();
    activity.setWaitingRequest("workspace-a", "task-child", "permission", "perm-child", true);
    activity.setWaitingRequest("workspace-a", "nested-child", "question", "question-nested", true);

    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.deleted",
        properties: { sessionID: "task-child" },
      } as any);

      let state = getWorkspaceInteractionState("workspace-a");
      expect(pendingInteractionsForRoot(state, "root")).toEqual({ permissions: [], questions: [] });
      expect(state.sessions).toEqual({
        root: { parentSessionId: null },
      });
      expect(state.tombstones).toEqual({});
      expect(taskHasPendingInteraction(state, "root", "task-child")).toBe(false);
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]?.["task-child"]).toBeUndefined();
      expect(useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]?.["nested-child"]).toBeUndefined();

      reconcileInteractionSnapshot("workspace-a", snapshot([{
        ...permission("perm-stale", "nested-child"),
        protocol: "legacy",
        targetSessionId: "nested-child",
        parentSessionId: "task-child",
        rootSessionId: "root",
        ancestryPath: ["root", "task-child", "nested-child"],
      }]), staleFence);
      state = getWorkspaceInteractionState("workspace-a");
      expect(state.permissions).toEqual([]);
    } finally {
      cleanup();
    }
  });

  test("correlates nested interactions to Task metadata and clears waiting after rejection", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "task-child", parentID: "root" },
      { id: "nested-child", parentID: "task-child" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-task", "nested-child") as any, 10);
    let state = getWorkspaceInteractionState("workspace-a");
    expect(taskHasPendingInteraction(state, "root", "task-child")).toBe(true);

    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.replied",
        properties: {
          sessionID: "nested-child",
          requestID: "perm-task",
          reply: "reject",
        },
      } as any);
      state = getWorkspaceInteractionState("workspace-a");
      expect(taskHasPendingInteraction(state, "root", "task-child")).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("builds permission and question replies for the exact child target", () => {
    seedWorkspaceSessionAncestry("workspace-a", [
      { id: "root", parentID: undefined },
      { id: "child", parentID: "root" },
    ]);
    upsertLivePermission("workspace-a", permission("perm-child", "child") as any, 10);
    upsertLiveQuestion("workspace-a", question("question-child", "child") as any, 11);
    const root = pendingInteractionsForRoot(getWorkspaceInteractionState("workspace-a"), "root");

    expect(permissionInteractionReply(root.permissions[0]!, "once")).toEqual({
      targetSessionId: "child",
      interactionId: "perm-child",
      input: {
        origin: "local-renderer",
        commandCorrelationId: null,
        response: "allow_once",
      },
    });
    expect(questionInteractionReply(root.questions[0]!, [["Yes"]])).toEqual({
      targetSessionId: "child",
      interactionId: "question-child",
      input: {
        origin: "local-renderer",
        commandCorrelationId: null,
        answers: [{ questionId: "choice", values: ["Yes"] }],
      },
    });
  });

  test("treats a remote race winner as terminal local cleanup", () => {
    expect(isTerminalInteractionReplyError({ code: "already_resolved" })).toBe(true);
    expect(isTerminalInteractionReplyError({ code: "interaction_expired" })).toBe(true);
    expect(isTerminalInteractionReplyError({ code: "interaction_not_found" })).toBe(true);
    expect(isTerminalInteractionReplyError({ code: "opencode_request_failed" })).toBe(false);
  });
});

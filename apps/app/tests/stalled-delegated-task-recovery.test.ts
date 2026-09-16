import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  planDelegatedTaskStallRecovery,
  shouldRecoverStalledDelegatedTask,
} from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

function taskMessage(
  state: "input-streaming" | "output-available",
  childSessionId: string | null = "child-session",
): UIMessage {
  return {
    id: "assistant-task",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "task",
      toolCallId: "call-task",
      state,
      input: { description: "Review" },
      ...(state === "output-available" ? { output: "done" } : {}),
      ...(childSessionId ? {
        callProviderMetadata: {
          opencode: { toolMetadata: { sessionId: childSessionId, parentSessionId: "session-a" } },
        },
      } : {}),
    }],
  };
}

function stalledRecord() {
  useSessionActivityStore.setState({ recordsByWorkspaceId: {}, statusesByWorkspaceId: {} });
  const store = useSessionActivityStore.getState();
  store.setRunStatus("workspace-a", "session-a", { type: "busy" });
  store.markProgress("workspace-a", "session-a", 1_000);
  store.refreshStalledStatuses(1_000 + 5 * 60_000 + 1);
  return useSessionActivityStore.getState().recordsByWorkspaceId["workspace-a"]!["session-a"]!;
}

describe("stalled delegated task recovery", () => {
  test("recovers only an in-flight delegated task after the second-stage grace period", () => {
    const record = stalledRecord();
    expect(shouldRecoverStalledDelegatedTask({
      record,
      messages: [taskMessage("input-streaming")],
      now: record.stalledAt! + 60_000,
    })).toBeTrue();
    expect(shouldRecoverStalledDelegatedTask({
      record,
      messages: [taskMessage("input-streaming")],
      now: record.stalledAt! + 59_999,
    })).toBeFalse();
    expect(shouldRecoverStalledDelegatedTask({
      record,
      messages: [taskMessage("output-available")],
      now: record.stalledAt! + 60_000,
    })).toBeFalse();
  });

  test("does not recover while a provider retry is active", () => {
    const record = { ...stalledRecord(), providerRetry: {
      attempt: 1,
      message: "retrying",
      next: null,
      observedAt: 1_000,
    } };
    expect(shouldRecoverStalledDelegatedTask({
      record,
      messages: [taskMessage("input-streaming")],
      now: record.stalledAt! + 60_000,
    })).toBeFalse();
  });

  test("treats recent child activity as parent progress instead of aborting the parent", () => {
    const record = stalledRecord();
    // Parent liveness is refreshed immediately; destructive child recovery
    // still waits for the second-stage grace period.
    const now = record.stalledAt! + 10_000;
    const child = {
      ...record,
      stalledAt: null,
      lastMeaningfulProgressAt: now - 1_000,
      lastRuntimeEventAt: now - 500,
    };

    expect(planDelegatedTaskStallRecovery({
      record,
      messages: [taskMessage("input-streaming")],
      recordsBySessionId: { "child-session": child },
      now,
    })).toEqual({
      activeChildProgressAt: now - 1_000,
      stalledChildSessionIds: [],
    });
  });

  test("keeps the parent alive at the legacy six-minute abort point when the child just streamed", () => {
    const record = stalledRecord();
    const now = record.stalledAt! + 60_000;
    const child = {
      ...record,
      stalledAt: null,
      lastMeaningfulProgressAt: now - 1_000,
      lastRuntimeEventAt: now - 1_000,
    };

    expect(shouldRecoverStalledDelegatedTask({
      record,
      messages: [taskMessage("input-streaming")],
      now,
    })).toBeTrue();
    expect(planDelegatedTaskStallRecovery({
      record,
      messages: [taskMessage("input-streaming")],
      recordsBySessionId: { "child-session": child },
      now,
    })).toEqual({
      activeChildProgressAt: now - 1_000,
      stalledChildSessionIds: [],
    });
  });

  test("targets only a child whose own stall grace period expired", () => {
    const record = stalledRecord();
    const now = record.stalledAt! + 60_000;
    const stalledChild = {
      ...record,
      stalledAt: now - 60_000,
      lastMeaningfulProgressAt: now - 6 * 60_000,
      lastRuntimeEventAt: now - 6 * 60_000,
    };

    expect(planDelegatedTaskStallRecovery({
      record,
      messages: [taskMessage("input-streaming")],
      recordsBySessionId: { "child-session": stalledChild },
      now,
    })).toEqual({
      activeChildProgressAt: null,
      stalledChildSessionIds: ["child-session"],
    });
  });

  test("does not perform destructive recovery without authoritative child metadata", () => {
    const record = stalledRecord();
    const now = record.stalledAt! + 60_000;

    expect(planDelegatedTaskStallRecovery({
      record,
      messages: [taskMessage("input-streaming", null)],
      recordsBySessionId: {},
      now,
    })).toEqual({ activeChildProgressAt: null, stalledChildSessionIds: [] });
  });

  test("does not abort a stalled child while it is waiting for approval", () => {
    const record = stalledRecord();
    const now = record.stalledAt! + 60_000;
    const waitingChild = {
      ...record,
      stalledAt: now - 60_000,
      waitingPermissionIds: ["permission-a"],
    };

    expect(planDelegatedTaskStallRecovery({
      record,
      messages: [taskMessage("input-streaming")],
      recordsBySessionId: { "child-session": waitingChild },
      now,
    }).stalledChildSessionIds).toEqual([]);
  });
});

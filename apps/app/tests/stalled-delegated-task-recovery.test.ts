import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { shouldRecoverStalledDelegatedTask } from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

function taskMessage(state: "input-streaming" | "output-available"): UIMessage {
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
});

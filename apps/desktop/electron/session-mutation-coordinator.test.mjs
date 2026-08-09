import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionMutationCoordinator, SessionMutationError } from "./session-mutation-coordinator.mjs";

function harness() {
  let counter = 0;
  return createSessionMutationCoordinator({
    randomUUID: () => `run_${++counter}`,
    now: () => 1000 + counter,
  });
}

test("beginRun returns a new runId and monotonically increasing generation", () => {
  const coordinator = harness();
  const first = coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(first.runId, "run_1");
  assert.equal(first.generation, 1);
  coordinator.markTerminal({ workspaceId: "ws_1", sessionId: "ses_1" });
  const second = coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(second.runId, "run_2");
  assert.equal(second.generation, 2);
});

test("beginRun rejects with session_busy when a run is active", () => {
  const coordinator = harness();
  coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.throws(
    () => coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" }),
    (error) => error instanceof SessionMutationError && error.code === "session_busy" && error.currentRunId === "run_1",
  );
});

test("resolveRun rejects with run_mismatch and currentRunId for wrong expectedRunId", () => {
  const coordinator = harness();
  coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.throws(
    () => coordinator.resolveRun({ workspaceId: "ws_1", sessionId: "ses_1", expectedRunId: "wrong" }),
    (error) => error instanceof SessionMutationError && error.code === "run_mismatch" && error.currentRunId === "run_1",
  );
});

test("resolveRun rejects with null currentRunId when no run exists", () => {
  const coordinator = harness();
  assert.throws(
    () => coordinator.resolveRun({ workspaceId: "ws_1", sessionId: "ses_1", expectedRunId: "run_x" }),
    (error) => error instanceof SessionMutationError && error.code === "run_mismatch" && error.currentRunId === null,
  );
});

test("markTerminal clears the active run so a new prompt can start", () => {
  const coordinator = harness();
  coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  coordinator.markTerminal({ workspaceId: "ws_1", sessionId: "ses_1" });
  const next = coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(next.runId, "run_2");
});

test("activeRuns lists all non-terminal runs across sessions", () => {
  const coordinator = harness();
  coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_a" });
  coordinator.beginRun({ workspaceId: "ws_2", sessionId: "ses_b" });
  const runs = coordinator.activeRuns();
  assert.equal(runs.length, 2);
  coordinator.markTerminal({ workspaceId: "ws_1", sessionId: "ses_a" });
  assert.equal(coordinator.activeRuns().length, 1);
});

test("recordPromptAccepted transitions started to running", () => {
  const coordinator = harness();
  const { runId } = coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  coordinator.recordPromptAccepted({ workspaceId: "ws_1", sessionId: "ses_1", runId });
  const runs = coordinator.activeRuns();
  assert.equal(runs[0].status, "running");
});

test("markAborting transitions to aborting", () => {
  const coordinator = harness();
  const { runId } = coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  coordinator.markAborting({ workspaceId: "ws_1", sessionId: "ses_1", runId });
  assert.equal(coordinator.activeRuns()[0].status, "aborting");
});

test("getActiveRunId returns null after terminal", () => {
  const coordinator = harness();
  coordinator.beginRun({ workspaceId: "ws_1", sessionId: "ses_1" });
  coordinator.markTerminal({ workspaceId: "ws_1", sessionId: "ses_1" });
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), null);
});

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSessionMutationCoordinator } from "./session-mutation-coordinator.mjs";

function run(overrides = {}) {
  return {
    workspaceId: "ws_1",
    sessionId: "ses_1",
    runId: "run_1",
    generation: 1,
    origin: "remote-control",
    startCommandCorrelationId: "command_start",
    abortCommandCorrelationId: null,
    status: "running",
    observedActive: false,
    startedAt: 1_000,
    updatedAt: 1_001,
    activeObservedAt: null,
    abortRequestedAt: null,
    ...overrides,
  };
}

test("records server-owned run metadata but exposes only the safe activeRuns projection", () => {
  const coordinator = createSessionMutationCoordinator();
  assert.equal(coordinator.recordServerRun(run()), true);
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), "run_1");
  assert.deepEqual(coordinator.activeRuns(), [{
    workspaceId: "ws_1",
    sessionId: "ses_1",
    runId: "run_1",
    status: "running",
  }]);
  assert.doesNotMatch(JSON.stringify(coordinator.activeRuns()), /command_start|origin|generation/);
});

test("validates server run fields before recording them", () => {
  const coordinator = createSessionMutationCoordinator();
  assert.throws(() => coordinator.recordServerRun(run({ origin: "remote" })), /invalid session run/);
  assert.throws(() => coordinator.recordServerRun(run({ startCommandCorrelationId: "bad\ncommand" })), /invalid session run/);
  assert.deepEqual(coordinator.activeRuns(), []);
});

test("a newer generation replaces the mirror and older responses are fenced", () => {
  const coordinator = createSessionMutationCoordinator();
  assert.equal(coordinator.recordServerRun(run({ runId: "run_2", generation: 2, updatedAt: 2_001 })), true);
  assert.equal(coordinator.recordServerRun(run()), false);
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), "run_2");
});

test("an accepted abort remains aborting despite a delayed ordinary update", () => {
  const coordinator = createSessionMutationCoordinator();
  assert.equal(coordinator.recordServerRun(run({
    status: "aborting",
    abortCommandCorrelationId: "command_abort",
    abortRequestedAt: 1_002,
    updatedAt: 1_002,
  })), true);
  assert.equal(coordinator.recordServerRun(run({ status: "running", updatedAt: 1_003 })), false);
  assert.equal(coordinator.activeRuns()[0].status, "aborting");
});

test("terminal clearing is exact-run fenced and cannot clear a replacement", () => {
  const coordinator = createSessionMutationCoordinator();
  coordinator.recordServerRun(run());
  assert.equal(coordinator.clearTerminalRun({ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_stale" }), false);
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), "run_1");

  assert.equal(coordinator.clearTerminalRun({ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1" }), true);
  assert.equal(coordinator.recordServerRun(run()), false);
  coordinator.recordServerRun(run({ runId: "run_2", generation: 2, updatedAt: 2_001 }));
  assert.equal(coordinator.clearTerminalRun({ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1" }), false);
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), "run_2");
});

test("notifies only for admitted remote runs and stale terminal cannot release a replacement", () => {
  const counts = [];
  const coordinator = createSessionMutationCoordinator({ onActiveRemoteRunCountChanged: (count) => counts.push(count) });
  coordinator.recordServerRun(run({ origin: "local-renderer", runId: "local_1" }));
  coordinator.recordServerRun(run({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_1" }));
  assert.deepEqual(counts, [0, 1]);
  coordinator.recordServerRun(run({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_2", generation: 2, updatedAt: 2_001 }));
  assert.equal(coordinator.clearTerminalRun({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_1" }), false);
  assert.deepEqual(counts, [0, 1, 1]);
  assert.equal(coordinator.clearTerminalRun({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_2" }), true);
  assert.deepEqual(counts, [0, 1, 1, 0]);
});

test("authorization loss clears remote mirrors without clearing local runs or generation fences", () => {
  const coordinator = createSessionMutationCoordinator();
  coordinator.recordServerRun(run({ origin: "local-renderer", runId: "local_1" }));
  coordinator.recordServerRun(run({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_1" }));
  assert.equal(coordinator.clearRemoteRuns(), true);
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_1", sessionId: "ses_1" }), "local_1");
  assert.equal(coordinator.getActiveRunId({ workspaceId: "ws_2", sessionId: "ses_2" }), null);
  assert.equal(coordinator.recordServerRun(run({ workspaceId: "ws_2", sessionId: "ses_2", runId: "remote_1" })), false);
});

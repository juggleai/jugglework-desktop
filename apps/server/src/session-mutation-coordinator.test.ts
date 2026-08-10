import { describe, expect, test } from "bun:test";

import { createSessionMutationCoordinator, SessionMutationError } from "./session-mutation-coordinator.js";

function harness() {
  let id = 0;
  let timestamp = 1_000;
  return createSessionMutationCoordinator({
    randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
    now: () => ++timestamp,
  });
}

describe("session mutation coordinator", () => {
  test("reserves synchronously, separates command correlation from run identity, and increments generations", () => {
    const coordinator = harness();
    const first = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_start",
    });
    expect(first).toMatchObject({
      generation: 1,
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_start",
      abortCommandCorrelationId: null,
      status: "starting",
      observedActive: false,
    });
    expect(first.runId).not.toBe(first.startCommandCorrelationId);
    expect(() => coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "remote-control",
      startCommandCorrelationId: "cmd_remote",
    })).toThrow(new SessionMutationError("session_busy", first.runId));

    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: first.runId, status: "completed" });
    expect(coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "remote-control",
      startCommandCorrelationId: null,
    }).generation).toBe(2);
  });

  test("does not let idle clear a run until engine activity was observed", () => {
    const coordinator = harness();
    const run = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: null,
    });
    expect(coordinator.acceptStart({ workspaceId: "ws", sessionId: "ses", runId: run.runId })).toMatchObject({
      status: "running",
      observedActive: false,
    });
    expect(coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "idle" })).toMatchObject({
      cleared: false,
    });
    expect(coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "waiting" }).run).toMatchObject({
      status: "waiting",
      observedActive: true,
    });
    expect(coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "idle" })).toEqual({
      cleared: true,
      run: null,
      terminalStatus: "completed",
    });
  });

  test("keeps a delayed abort fenced until upstream accepts it", () => {
    const coordinator = harness();
    const run = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "remote-control",
      startCommandCorrelationId: "cmd_start",
    });
    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "running" });
    const abort = coordinator.reserveAbort({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      abortCommandCorrelationId: "cmd_abort",
    });
    expect(abort.run).toMatchObject({ status: "aborting", abortCommandCorrelationId: "cmd_abort" });
    expect(coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "idle" }).cleared).toBe(false);
    coordinator.acceptAbort({ workspaceId: "ws", sessionId: "ses", runId: run.runId, abortCommandCorrelationId: "cmd_abort" });
    expect(coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "idle" }).terminalStatus).toBe("aborted");
  });

  test("stale terminal observations and rollbacks cannot clear a replacement", () => {
    const coordinator = harness();
    const first = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_1",
    });
    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: first.runId, status: "failed" });
    const second = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "remote-control",
      startCommandCorrelationId: "cmd_2",
    });

    expect(coordinator.rollbackStart({ workspaceId: "ws", sessionId: "ses", runId: first.runId })).toBe(false);
    expect(() => coordinator.observe({
      workspaceId: "ws",
      sessionId: "ses",
      runId: first.runId,
      status: "completed",
    })).toThrow(new SessionMutationError("run_mismatch", second.runId));
    expect(coordinator.getActive("ws", "ses")?.runId).toBe(second.runId);
  });
});

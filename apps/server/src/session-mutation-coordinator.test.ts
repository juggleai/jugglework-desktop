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

describe("inconclusive idle settlement", () => {
  function clocked() {
    let id = 0;
    let timestamp = 1_000;
    const coordinator = createSessionMutationCoordinator({
      randomUUID: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      now: () => timestamp,
    });
    return { coordinator, advance: (ms: number) => { timestamp += ms; } };
  }
  const key = { workspaceId: "ws", sessionId: "ses" };
  function startRunning(coordinator: ReturnType<typeof clocked>["coordinator"]) {
    const run = coordinator.reserveStart({ ...key, origin: "local-renderer", startCommandCorrelationId: null });
    coordinator.acceptStart({ ...key, runId: run.runId });
    return run;
  }

  test("keeps a run until the engine has stayed idle for the full window, then settles it as failed", () => {
    const { coordinator, advance } = clocked();
    const run = startRunning(coordinator);
    const settle = () => coordinator.settleInconclusiveIdle({ ...key, runId: run.runId, settleAfterMs: 60_000 });

    expect(settle()).toMatchObject({ cleared: false, retryAfterMs: 60_000 });
    advance(59_999);
    expect(settle()).toMatchObject({ cleared: false, retryAfterMs: 1 });
    expect(coordinator.getActive(key.workspaceId, key.sessionId)).not.toBeNull();
    advance(1);
    expect(settle()).toMatchObject({ cleared: true, terminalStatus: "failed" });
    expect(coordinator.getActive(key.workspaceId, key.sessionId)).toBeNull();
  });

  test("engine activity restarts the window so a working run is never settled", () => {
    const { coordinator, advance } = clocked();
    const run = startRunning(coordinator);
    const settle = () => coordinator.settleInconclusiveIdle({ ...key, runId: run.runId, settleAfterMs: 60_000 });

    settle();
    advance(59_000);
    coordinator.observe({ ...key, runId: run.runId, status: "running" });
    advance(59_000);
    expect(settle()).toMatchObject({ cleared: false });
    advance(59_999);
    expect(settle()).toMatchObject({ cleared: false });
    expect(coordinator.getActive(key.workspaceId, key.sessionId)).not.toBeNull();
  });

  test("never settles a starting or aborting run and rejects a stale run id", () => {
    const { coordinator, advance } = clocked();
    const reserved = coordinator.reserveStart({ ...key, origin: "local-renderer", startCommandCorrelationId: null });
    advance(120_000);
    expect(coordinator.settleInconclusiveIdle({ ...key, runId: reserved.runId, settleAfterMs: 0 })).toMatchObject({ cleared: false });
    expect(() => coordinator.settleInconclusiveIdle({ ...key, runId: "other", settleAfterMs: 0 })).toThrow("run_mismatch");
  });
});

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

  test("clears an accepted unobserved run only after two separated authoritative idle samples", () => {
    let timestamp = 1_000;
    const coordinator = createSessionMutationCoordinator({
      randomUUID: () => "run-1",
      now: () => timestamp,
    });
    const run = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: null,
    });
    coordinator.acceptStart({ workspaceId: "ws", sessionId: "ses", runId: run.runId });

    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 500,
    })).toMatchObject({ cleared: false, retryAfterMs: 500 });

    timestamp += 499;
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 500,
    })).toMatchObject({ cleared: false, retryAfterMs: 1 });

    timestamp += 1;
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 500,
    })).toEqual({ cleared: true, run: null, terminalStatus: "completed", retryAfterMs: null });
  });

  test("active engine evidence resets authoritative idle confirmation", () => {
    let timestamp = 1_000;
    const coordinator = createSessionMutationCoordinator({
      randomUUID: () => "run-1",
      now: () => timestamp,
    });
    const run = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: null,
    });
    coordinator.acceptStart({ workspaceId: "ws", sessionId: "ses", runId: run.runId });
    coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 500,
    });

    timestamp += 500;
    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: run.runId, status: "running" });
    expect(coordinator.getActive("ws", "ses")).toMatchObject({ observedActive: true });
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 500,
    })).toMatchObject({ cleared: false, retryAfterMs: 500 });
    timestamp += 500;
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws", sessionId: "ses", runId: run.runId, minimumIntervalMs: 500,
    })).toEqual({ cleared: true, run: null, terminalStatus: "completed", retryAfterMs: null });
  });

  test("fails a restored run after confirmed authoritative idle without terminal evidence", () => {
    let timestamp = 1_000;
    const coordinator = createSessionMutationCoordinator({
      now: () => timestamp,
      initialRuns: [{
        workspaceId: "ws",
        sessionId: "ses",
        runId: "restored-run",
        generation: 1,
        revision: 2,
        title: "Interrupted task",
        origin: "local-renderer",
        startCommandCorrelationId: null,
        abortCommandCorrelationId: null,
        status: "running",
        observedActive: true,
        startedAt: 500,
        updatedAt: 600,
        activeObservedAt: 550,
        abortRequestedAt: null,
      }],
    });

    expect(coordinator.isRestored("ws", "ses", "restored-run")).toBe(true);
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: "restored-run",
      minimumIntervalMs: 500,
      terminalStatus: "failed",
    })).toMatchObject({ cleared: false, retryAfterMs: 500 });

    timestamp += 500;
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: "restored-run",
      minimumIntervalMs: 500,
      terminalStatus: "failed",
    })).toEqual({ cleared: true, run: null, terminalStatus: "failed", retryAfterMs: null });
  });

  test("active engine evidence adopts a restored run into the current runtime", () => {
    const restored = {
      workspaceId: "ws", sessionId: "ses", runId: "restored-run", generation: 1, revision: 2,
      title: "Continuing task", origin: "local-renderer" as const, startCommandCorrelationId: null,
      abortCommandCorrelationId: null, status: "running" as const, observedActive: true,
      startedAt: 500, updatedAt: 600, activeObservedAt: 550, abortRequestedAt: null,
    };
    const coordinator = createSessionMutationCoordinator({ initialRuns: [restored] });

    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: "restored-run", status: "running" });

    expect(coordinator.isRestored("ws", "ses", "restored-run")).toBe(false);
  });

  test("never reconciles a starting run away", () => {
    const coordinator = harness();
    const run = coordinator.reserveStart({
      workspaceId: "ws",
      sessionId: "ses",
      origin: "local-renderer",
      startCommandCorrelationId: null,
    });
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 0,
      terminalStatus: "failed",
    })).toMatchObject({ cleared: false, retryAfterMs: null, run: { status: "starting" } });
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws",
      sessionId: "ses",
      runId: run.runId,
      minimumIntervalMs: 0,
      terminalStatus: "failed",
    })).toMatchObject({ cleared: false, retryAfterMs: null, run: { status: "starting" } });
    expect(coordinator.getActive("ws", "ses")?.runId).toBe(run.runId);
  });

  test("requires explicit terminal classification before reconciling a restored starting run", () => {
    let timestamp = 1_000;
    const coordinator = createSessionMutationCoordinator({
      now: () => timestamp,
      initialRuns: [{
        workspaceId: "ws", sessionId: "ses", runId: "restored-starting", generation: 1, revision: 1,
        title: "Interrupted admission", origin: "local-renderer", startCommandCorrelationId: null,
        abortCommandCorrelationId: null, status: "starting", observedActive: false,
        startedAt: 500, updatedAt: 500, activeObservedAt: null, abortRequestedAt: null,
      }],
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(coordinator.reconcileAuthoritativeIdle({
        workspaceId: "ws", sessionId: "ses", runId: "restored-starting", minimumIntervalMs: 0,
      })).toMatchObject({ cleared: false, retryAfterMs: null, run: { status: "starting" } });
    }
    expect(coordinator.isRestored("ws", "ses", "restored-starting")).toBe(true);

    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws", sessionId: "ses", runId: "restored-starting", minimumIntervalMs: 500, terminalStatus: "failed",
    })).toMatchObject({ cleared: false, retryAfterMs: 500 });
    timestamp += 500;
    expect(coordinator.reconcileAuthoritativeIdle({
      workspaceId: "ws", sessionId: "ses", runId: "restored-starting", minimumIntervalMs: 500, terminalStatus: "failed",
    })).toEqual({ cleared: true, run: null, terminalStatus: "failed", retryAfterMs: null });
  });

  test("active evidence adopts a restored starting run before normal reconciliation", () => {
    const coordinator = createSessionMutationCoordinator({
      initialRuns: [{
        workspaceId: "ws", sessionId: "ses", runId: "restored-starting", generation: 1, revision: 1,
        title: "Continuing admission", origin: "local-renderer", startCommandCorrelationId: null,
        abortCommandCorrelationId: null, status: "starting", observedActive: false,
        startedAt: 500, updatedAt: 500, activeObservedAt: null, abortRequestedAt: null,
      }],
    });
    coordinator.observe({ workspaceId: "ws", sessionId: "ses", runId: "restored-starting", status: "running" });
    expect(coordinator.getActive("ws", "ses")).toMatchObject({ status: "running", observedActive: true });
    expect(coordinator.isRestored("ws", "ses", "restored-starting")).toBe(false);
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

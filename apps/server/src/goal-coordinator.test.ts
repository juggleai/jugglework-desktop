import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalCoordinator, GOAL_DISPATCH_FAILURE_LIMIT, type GoalDispatchOutcome } from "./goal-coordinator.js";
import { createGoalStore, GOAL_NO_PROGRESS_LIMIT, type GoalStore } from "./goal-store.js";

const roots: string[] = [];
const stores: GoalStore[] = [];
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

const base = { workspaceId: "ws", sessionId: "ses", objective: "Ship export", criteria: [{ text: "CSV works" }, { text: "Docs", required: false }] };

async function setup(overrides: Partial<Parameters<typeof createGoalCoordinator>[0]> = {}, cap?: number) {
  const root = await mkdtemp(join(tmpdir(), "goal-coordinator-"));
  roots.push(root);
  const store = await createGoalStore({ path: join(root, "runtime.sqlite") });
  stores.push(store);
  const goal = store.create({ ...base, ...(cap ? { continuationCap: cap } : {}) });
  const dispatched: Array<{ ordinal: number; key: string; prompt: Record<string, unknown> }> = [];
  let outcome: GoalDispatchOutcome | ((ordinal: number) => GoalDispatchOutcome) = { kind: "started", runId: "run_auto" };
  const state = { status: "idle" as "idle" | "busy", interaction: false, activeRun: false, enabled: true, workspaceOk: true, activeRunIds: new Set<string>() };
  const coordinator = createGoalCoordinator({
    store,
    isAutoContinuationEnabled: () => state.enabled,
    getSessionStatus: async () => state.status,
    hasPendingInteraction: async () => state.interaction,
    hasActiveRun: () => state.activeRun,
    isGoalWorkspace: async () => state.workspaceOk,
    isRunActive: (_goal, runId) => state.activeRunIds.has(runId),
    dispatch: async (input) => {
      dispatched.push({ ordinal: input.ordinal, key: input.idempotencyKey, prompt: input.prompt });
      return typeof outcome === "function" ? outcome(input.ordinal) : outcome;
    },
    intervalMs: 3_600_000,
    ...overrides,
  });
  /** Complete the goal's first run normally, as a user-started run would. */
  const finishFirstRun = (opts: { progress?: boolean; outcome?: string } = {}) => {
    store.reserveRun(goal.id, { trigger: "create" });
    store.markRunStarted(goal.id, 1, "run_1");
    if (opts.progress !== false) store.reportProgress("ws", "ses", { criteria: [], checkpoint: "step 1", madeProgress: true });
    return store.observeRunTerminal("ws", "ses", "run_1", opts.outcome ?? "completed");
  };
  return { store, goal, coordinator, dispatched, state, finishFirstRun, setOutcome: (next: typeof outcome) => { outcome = next; } };
}

describe("goal coordinator", () => {
  test("continues an idle active goal once after a normal run, with the envelope and tagged request", async () => {
    const { store, goal, coordinator, dispatched, finishFirstRun } = await setup();
    finishFirstRun();
    await coordinator.wake();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ ordinal: 2, key: `${goal.id}:2` });
    const prompt = dispatched[0]!.prompt as { system: string; parts: Array<{ metadata: unknown; text: string }> };
    expect(prompt.system).toContain("## Active goal");
    expect(prompt.system).toContain("step 1");
    expect(prompt.parts[0]!.metadata).toEqual({ jugglework_goal: { goalId: goal.id, ordinal: 2, trigger: "auto" } });
    expect(store.get(goal.id)).toMatchObject({ execution: "running", activeRunId: "run_auto", continuationStreak: 1, continuationTotal: 1 });
    await coordinator.close();
  });

  test("duplicate passes and a running goal never start a second run", async () => {
    const { coordinator, dispatched, finishFirstRun } = await setup();
    finishFirstRun();
    await Promise.all([coordinator.wake(), coordinator.wake(), coordinator.wake()]);
    await coordinator.wake();
    expect(dispatched).toHaveLength(1);
    await coordinator.close();
  });

  test("a goal that was never run, or whose run failed, is not continued automatically", async () => {
    const { coordinator, dispatched, finishFirstRun, store, goal } = await setup();
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    finishFirstRun({ outcome: "failed" });
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "run_failed" });
    await coordinator.close();
  });

  test("an aborted run (user Stop) waits for the user instead of continuing", async () => {
    const { coordinator, dispatched, finishFirstRun, store, goal } = await setup();
    finishFirstRun({ outcome: "aborted" });
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "run_aborted", status: "active" });
    await coordinator.close();
  });

  test("each gate prevents dispatch: disabled, busy, active run, pending interaction, non-local workspace", async () => {
    const { coordinator, dispatched, state, finishFirstRun } = await setup();
    finishFirstRun();
    for (const [name, apply, revert] of [
      ["disabled", () => { state.enabled = false; }, () => { state.enabled = true; }],
      ["busy", () => { state.status = "busy"; }, () => { state.status = "idle"; }],
      ["active run", () => { state.activeRun = true; }, () => { state.activeRun = false; }],
      ["interaction", () => { state.interaction = true; }, () => { state.interaction = false; }],
      ["workspace", () => { state.workspaceOk = false; }, () => { state.workspaceOk = true; }],
    ] as const) {
      apply();
      await coordinator.wake();
      expect({ name, dispatched: dispatched.length }).toEqual({ name, dispatched: 0 });
      revert();
    }
    await coordinator.wake();
    expect(dispatched).toHaveLength(1);
    await coordinator.close();
  });

  test("an archived session is not continued, and an unreadable session fails closed", async () => {
    let archived = true;
    const { coordinator, dispatched, finishFirstRun } = await setup({ isSessionArchived: async () => archived });
    finishFirstRun();
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    archived = false;
    await coordinator.wake();
    expect(dispatched).toHaveLength(1);
    await coordinator.close();

    const unreadable = await setup({ isSessionArchived: async () => { throw new Error("engine unavailable"); } });
    unreadable.finishFirstRun();
    await unreadable.coordinator.wake();
    expect(unreadable.dispatched).toHaveLength(0);
    expect(unreadable.store.get(unreadable.goal.id)).toMatchObject({ execution: "idle", continuationStreak: 0 });
    await unreadable.coordinator.close();
  });

  test("paused, blocked, cancelled and waiting goals are not continued", async () => {
    for (const stop of ["pause", "cancel", "blocker"] as const) {
      const { coordinator, dispatched, store, goal, finishFirstRun } = await setup();
      if (stop === "blocker") {
        store.reserveRun(goal.id, { trigger: "create" });
        store.markRunStarted(goal.id, 1, "run_1");
        store.reportBlocker("ws", "ses", { reason: "need credentials", needsUser: true });
        store.observeRunTerminal("ws", "ses", "run_1", "completed");
      } else {
        finishFirstRun();
        const current = store.get(goal.id)!;
        if (stop === "pause") store.pause(goal.id, current.version); else store.cancel(goal.id, current.version);
      }
      await coordinator.wake();
      expect({ stop, dispatched: dispatched.length }).toEqual({ stop, dispatched: 0 });
      await coordinator.close();
    }
  });

  test("a busy session releases the reservation without using the cap", async () => {
    const { coordinator, dispatched, store, goal, finishFirstRun, setOutcome } = await setup();
    finishFirstRun();
    setOutcome({ kind: "busy" });
    await coordinator.wake();
    expect(dispatched).toHaveLength(1);
    expect(store.get(goal.id)).toMatchObject({ execution: "idle", continuationStreak: 0, continuationTotal: 0 });
    expect(store.runs(goal.id).map((run) => run.ordinal)).toEqual([1]);
    setOutcome({ kind: "started", runId: "run_auto" });
    await coordinator.wake();
    // The abandoned ordinal is reused, so the idempotency key stays unique and ordered.
    expect(dispatched.map((item) => item.ordinal)).toEqual([2, 2]);
    expect(store.get(goal.id)).toMatchObject({ execution: "running", continuationStreak: 1 });
    await coordinator.close();
  });

  test("repeated dispatch failures stop automatic continuation and wait for the user", async () => {
    const { coordinator, dispatched, store, goal, finishFirstRun, setOutcome } = await setup();
    finishFirstRun();
    setOutcome({ kind: "failed", code: "model_unavailable" });
    for (let attempt = 1; attempt <= GOAL_DISPATCH_FAILURE_LIMIT; attempt += 1) await coordinator.wake();
    expect(dispatched).toHaveLength(GOAL_DISPATCH_FAILURE_LIMIT);
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "dispatch_failed", status: "active" });
    await coordinator.wake();
    expect(dispatched).toHaveLength(GOAL_DISPATCH_FAILURE_LIMIT);
    await coordinator.close();
  });

  test("a thrown dispatch is treated as a failure, not an unhandled error", async () => {
    const { coordinator, store, goal, finishFirstRun } = await setup({
      dispatch: async () => { throw new Error("boom"); },
    });
    finishFirstRun();
    await coordinator.wake();
    expect(store.get(goal.id)).toMatchObject({ execution: "idle", activeRunId: null });
    expect(store.runs(goal.id)[0]).toMatchObject({ state: "ended", outcome: "Error" });
    await coordinator.close();
  });

  test("the consecutive cap stops automatic runs and waits for the user; Continue resets it", async () => {
    const { coordinator, dispatched, store, goal, finishFirstRun, setOutcome } = await setup({}, 2);
    finishFirstRun();
    let runCount = 0;
    setOutcome(() => ({ kind: "started", runId: `run_auto_${++runCount}` }));
    for (let round = 0; round < 4; round += 1) {
      await coordinator.wake();
      const running = store.get(goal.id)!;
      if (running.activeRunId) {
        store.reportProgress("ws", "ses", { criteria: [], checkpoint: `step ${round + 2}`, madeProgress: true });
        store.observeRunTerminal("ws", "ses", running.activeRunId, "completed");
      }
    }
    expect(dispatched).toHaveLength(2);
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "continuation_cap", continuationStreak: 2 });
    const waiting = store.get(goal.id)!;
    store.reserveRun(goal.id, { trigger: "user_continue", expectedVersion: waiting.version });
    expect(store.get(goal.id)).toMatchObject({ continuationStreak: 0, stopReason: null });
    await coordinator.close();
  });

  test("runs without recorded progress stop after the no-progress limit", async () => {
    const { coordinator, dispatched, store, goal, finishFirstRun, setOutcome } = await setup();
    finishFirstRun();
    let runCount = 0;
    setOutcome(() => ({ kind: "started", runId: `run_auto_${++runCount}` }));
    for (let round = 0; round < 6; round += 1) {
      await coordinator.wake();
      const running = store.get(goal.id)!;
      if (running.activeRunId) store.observeRunTerminal("ws", "ses", running.activeRunId, "completed");
    }
    // The first run reported progress, so the limit counts the silent runs after it.
    expect(dispatched).toHaveLength(GOAL_NO_PROGRESS_LIMIT);
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "no_progress", noProgressCount: GOAL_NO_PROGRESS_LIMIT });
    await coordinator.close();
  });

  test("a completed goal stops the loop", async () => {
    const { coordinator, dispatched, store, goal } = await setup();
    store.reserveRun(goal.id, { trigger: "create" });
    store.markRunStarted(goal.id, 1, "run_1");
    const [first] = goal.criteria;
    store.reportProgress("ws", "ses", { criteria: [{ id: first!.id, status: "met", evidence: "tests pass" }], checkpoint: "done", madeProgress: true });
    store.requestCompletion("ws", "ses");
    store.observeRunTerminal("ws", "ses", "run_1", "completed");
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    expect(store.get(goal.id)?.status).toBe("completed");
    await coordinator.close();
  });

  test("restart recovery: a running run the engine no longer has is closed as orphaned and waits for the user", async () => {
    const { coordinator, dispatched, store, goal, state } = await setup();
    store.reserveRun(goal.id, { trigger: "create" });
    store.markRunStarted(goal.id, 1, "run_lost");
    await coordinator.wake();
    expect(store.get(goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "run_lost", activeRunId: null });
    expect(store.runs(goal.id)[0]).toMatchObject({ state: "ended", outcome: "orphaned" });
    expect(dispatched).toHaveLength(0);
    void state;
    await coordinator.close();
  });

  test("restart recovery leaves a live run alone, and never re-dispatches a queued run of unknown outcome", async () => {
    const live = await setup();
    live.store.reserveRun(live.goal.id, { trigger: "create" });
    live.store.markRunStarted(live.goal.id, 1, "run_live");
    live.state.activeRunIds.add("run_live");
    await live.coordinator.wake();
    expect(live.store.get(live.goal.id)).toMatchObject({ execution: "running", activeRunId: "run_live" });
    await live.coordinator.close();

    const queued = await setup();
    queued.store.reserveRun(queued.goal.id, { trigger: "create" });
    await queued.coordinator.wake();
    expect(queued.dispatched).toHaveLength(0);
    expect(queued.store.get(queued.goal.id)).toMatchObject({ execution: "waiting_user", stopReason: "run_lost" });
    await queued.coordinator.close();
  });

  test("a stale candidate whose goal changed before its turn is skipped", async () => {
    const { coordinator, dispatched, store, goal, finishFirstRun } = await setup({
      getSessionStatus: async () => {
        // A user pauses while the coordinator is checking the session.
        const current = store.get(goal.id)!;
        if (current.status === "active") store.pause(goal.id, current.version);
        return "idle";
      },
    });
    finishFirstRun();
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
    expect(store.get(goal.id)).toMatchObject({ status: "paused", execution: "idle" });
    await coordinator.close();
  });

  test("an unreadable session status or interaction snapshot fails closed: no run is started", async () => {
    for (const failing of ["status", "interaction"] as const) {
      const { coordinator, dispatched, store, goal, finishFirstRun } = await setup(
        failing === "status"
          ? { getSessionStatus: async () => { throw new Error("engine down"); } }
          : { hasPendingInteraction: async () => { throw new Error("snapshot incomplete"); } },
      );
      finishFirstRun();
      await coordinator.wake();
      expect({ failing, dispatched: dispatched.length }).toEqual({ failing, dispatched: 0 });
      // Nothing was reserved, so the goal stays eligible and the cap is untouched.
      expect(store.get(goal.id)).toMatchObject({ execution: "idle", continuationStreak: 0 });
      expect(store.runs(goal.id)).toHaveLength(1);
      await coordinator.close();
    }
  });

  test("closing the coordinator stops further passes", async () => {
    const { coordinator, dispatched, finishFirstRun } = await setup();
    finishFirstRun();
    await coordinator.close();
    await coordinator.wake();
    expect(dispatched).toHaveLength(0);
  });
});


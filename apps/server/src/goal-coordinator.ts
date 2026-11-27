import {
  buildGoalEnvelope,
  goalRunPromptPart,
  GOAL_NO_PROGRESS_LIMIT,
  GoalStoreError,
  type GoalStopReason,
  type GoalStore,
  type SessionGoal,
} from "./goal-store.js";

export const GOAL_COORDINATOR_INTERVAL_MS = 2_000;
export const GOAL_COORDINATOR_MAX_GOALS_PER_PASS = 20;
/** Failed dispatches in a row before automatic continuation waits for the user. */
export const GOAL_DISPATCH_FAILURE_LIMIT = 3;

export type GoalSessionStatus = "idle" | "busy";

export type GoalDispatchOutcome =
  | { kind: "started"; runId: string }
  /** The session is not available right now; try again later without counting a failure. */
  | { kind: "busy" }
  /** The engine or account refused the run in a way retrying unattended will not fix. */
  | { kind: "failed"; code: string };

export type GoalCoordinatorOptions = {
  store: GoalStore;
  /** Reads automatic continuation gate; checked on every pass so it can be turned off at runtime. */
  isAutoContinuationEnabled: () => boolean | Promise<boolean>;
  /** Authoritative engine status for the goal's session. */
  getSessionStatus: (goal: SessionGoal, signal: AbortSignal) => Promise<GoalSessionStatus>;
  /** True while the session (or a child) has an unanswered permission or question. */
  hasPendingInteraction: (goal: SessionGoal, signal: AbortSignal) => Promise<boolean>;
  /**
   * True when the session was archived. An archived session must not start new
   * work on its own. Failing to read the session is reported as an error, which
   * stops dispatch for this pass.
   */
  isSessionArchived?: (goal: SessionGoal, signal: AbortSignal) => Promise<boolean>;
  /** True when a mutation coordinator run is active for the session. */
  hasActiveRun: (goal: SessionGoal) => boolean;
  /** Whether the workspace still supports goals (local and not sandboxed). */
  isGoalWorkspace: (goal: SessionGoal) => Promise<boolean>;
  /** Start one run through the shared session start boundary. */
  dispatch: (input: {
    goal: SessionGoal;
    ordinal: number;
    idempotencyKey: string;
    prompt: Record<string, unknown>;
  }, signal: AbortSignal) => Promise<GoalDispatchOutcome>;
  /** Whether a run id is still known to the mutation coordinator (for orphan recovery). */
  isRunActive: (goal: SessionGoal, runId: string) => boolean;
  intervalMs?: number;
  maxGoalsPerPass?: number;
  attemptTimeoutMs?: number;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

/**
 * Server-owned automatic continuation for active goals.
 *
 * A goal is continued only when every gate holds: the feature is enabled, the
 * goal is active and idle, its last run ended normally, the session is
 * authoritatively idle with no active run and no pending interaction, and the
 * cap and no-progress limits are not reached. Reservation is durable and
 * idempotent before dispatch, so duplicate passes cannot start a second run.
 */
export function createGoalCoordinator(options: GoalCoordinatorOptions) {
  const intervalMs = options.intervalMs ?? GOAL_COORDINATOR_INTERVAL_MS;
  const maxGoalsPerPass = options.maxGoalsPerPass ?? GOAL_COORDINATOR_MAX_GOALS_PER_PASS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 10_000;
  const log = options.log ?? (() => undefined);
  let closed = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controllers = new Set<AbortController>();
  /** Consecutive dispatch failures per goal; in memory because a restart deserves a fresh try. */
  const dispatchFailures = new Map<string, number>();

  async function guarded<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error("Goal continuation timed out")), attemptTimeoutMs);
    timeout.unref?.();
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function continueGoal(candidate: SessionGoal): Promise<void> {
    // Re-read: the candidate list can be stale by the time its turn comes.
    const goal = options.store.get(candidate.id);
    if (!goal || goal.status !== "active" || goal.execution !== "idle" || goal.activeRunId !== null) return;
    if (goal.noProgressCount >= GOAL_NO_PROGRESS_LIMIT) return;
    if (!(await options.isGoalWorkspace(goal))) return;
    if (options.hasActiveRun(goal)) return;
    const eligible = await guarded(async (signal) => {
      if (options.isSessionArchived && await options.isSessionArchived(goal, signal)) return false;
      if (await options.getSessionStatus(goal, signal) !== "idle") return false;
      return !(await options.hasPendingInteraction(goal, signal));
    });
    if (!eligible || closed) return;

    let reserved;
    try {
      reserved = options.store.reserveRun(goal.id, { trigger: "auto", expectedVersion: goal.version });
    } catch (error) {
      // A concurrent user action or pass already changed the goal, or the cap was reached.
      if (error instanceof GoalStoreError) return;
      throw error;
    }
    const current = reserved.goal;
    const outcome = await guarded((signal) => options.dispatch({
      goal: current,
      ordinal: reserved.run.ordinal,
      idempotencyKey: reserved.run.idempotencyKey,
      prompt: {
        parts: [goalRunPromptPart(current, { ordinal: reserved.run.ordinal, trigger: "auto" })],
        system: buildGoalEnvelope(current, { ordinal: reserved.run.ordinal, trigger: "auto" }),
      },
    }, signal)).catch((error): GoalDispatchOutcome => ({ kind: "failed", code: error instanceof Error ? error.name : "dispatch_error" }));

    if (outcome.kind === "started") {
      dispatchFailures.delete(goal.id);
      options.store.markRunStarted(goal.id, reserved.run.ordinal, outcome.runId);
      return;
    }
    if (outcome.kind === "busy") {
      // Not a failure: release the reservation so waiting does not use the cap.
      options.store.abandonRun(goal.id, reserved.run.ordinal);
      return;
    }
    const failures = (dispatchFailures.get(goal.id) ?? 0) + 1;
    dispatchFailures.set(goal.id, failures);
    const stop: GoalStopReason | undefined = failures >= GOAL_DISPATCH_FAILURE_LIMIT ? "dispatch_failed" : undefined;
    options.store.markRunFailed(goal.id, reserved.run.ordinal, outcome.code, stop ? { stop } : {});
    if (stop) dispatchFailures.delete(goal.id);
    log("goal_auto_dispatch_failed", { goalId: goal.id, ordinal: reserved.run.ordinal, code: outcome.code, failures });
  }

  /**
   * Reconcile runs a restart or lost event left behind. A run the mutation
   * coordinator no longer knows cannot finish by itself, so it is closed as
   * orphaned and the goal waits for the user rather than silently retrying.
   */
  function recoverInterrupted(): void {
    for (const { goal, run } of options.store.interruptedRuns()) {
      if (run.state === "running" && run.runId && options.isRunActive(goal, run.runId)) continue;
      if (run.state === "running" && run.runId) {
        options.store.observeRunTerminal(goal.workspaceId, goal.sessionId, run.runId, "orphaned");
        log("goal_run_orphaned", { goalId: goal.id, ordinal: run.ordinal });
        continue;
      }
      // Queued or dispatching without an accepted run: the dispatch outcome is unknown.
      // Never re-dispatch it automatically; the user decides after seeing the checkpoint.
      options.store.markRunFailed(goal.id, run.ordinal, "interrupted", { stop: "run_lost" });
      log("goal_run_interrupted", { goalId: goal.id, ordinal: run.ordinal });
    }
  }

  async function pass(): Promise<void> {
    if (closed) return;
    recoverInterrupted();
    if (!(await options.isAutoContinuationEnabled())) return;
    const candidates = options.store.autoContinuationCandidates().slice(0, maxGoalsPerPass);
    for (const goal of candidates) {
      if (closed) return;
      try {
        await continueGoal(goal);
      } catch (error) {
        log("goal_auto_continue_error", { goalId: goal.id, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }

  function schedule(delay: number) {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void trigger(); }, delay);
    timer.unref?.();
  }

  function trigger(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun && !closed);
      } finally {
        running = null;
        schedule(intervalMs);
      }
    })();
    return running;
  }

  return {
    start() {
      if (!closed) schedule(0);
    },
    /** Evaluate immediately, for example after a run ended. Safe to call repeatedly. */
    wake(): Promise<void> {
      return trigger();
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const controller of controllers) controller.abort(new Error("Goal coordinator closed"));
      await running?.catch(() => undefined);
    },
  };
}

export type GoalCoordinator = ReturnType<typeof createGoalCoordinator>;

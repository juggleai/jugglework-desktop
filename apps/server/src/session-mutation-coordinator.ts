import { randomUUID as cryptoRandomUUID } from "node:crypto";

export type SessionMutationOrigin = "local-renderer" | "remote-control";
export type SessionMutationStatus = "starting" | "running" | "waiting" | "retrying" | "aborting";
export type SessionMutationTerminalStatus = "completed" | "failed" | "aborted";
export type SessionMutationObservationStatus = SessionMutationStatus | "idle" | SessionMutationTerminalStatus;

export interface ActiveSessionMutation {
  workspaceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  origin: SessionMutationOrigin;
  startCommandCorrelationId: string | null;
  abortCommandCorrelationId: string | null;
  status: SessionMutationStatus;
  observedActive: boolean;
  startedAt: number;
  updatedAt: number;
  activeObservedAt: number | null;
  abortRequestedAt: number | null;
}

interface StoredSessionMutation extends ActiveSessionMutation {
  abortAccepted: boolean;
  authoritativeIdleObservedAt: number | null;
}

export interface SessionMutationIdleReconciliation {
  cleared: boolean;
  run: ActiveSessionMutation | null;
  terminalStatus: SessionMutationTerminalStatus | null;
  retryAfterMs: number | null;
}

export type SessionMutationLifecycleEvent = {
  event:
    | "run_reserved"
    | "run_started"
    | "progress"
    | "idle_suspected"
    | "abort_requested"
    | "abort_accepted"
    | "abort_rolled_back"
    | "start_rolled_back"
    | "run_terminal";
  run: ActiveSessionMutation;
  terminalReason?: SessionMutationTerminalStatus | "dispatch_failed" | null;
};

export class SessionMutationError extends Error {
  readonly currentRunId: string | null;

  constructor(
    public readonly code: "session_busy" | "run_mismatch",
    currentRunId: string | null,
  ) {
    super(code);
    this.name = "SessionMutationError";
    this.currentRunId = currentRunId?.slice(0, 256) ?? null;
  }
}

function sessionKey(workspaceId: string, sessionId: string): string {
  return `${workspaceId}\0${sessionId}`;
}

function publicRun(run: StoredSessionMutation): ActiveSessionMutation {
  const {
    abortAccepted: _abortAccepted,
    authoritativeIdleObservedAt: _authoritativeIdleObservedAt,
    ...safe
  } = run;
  return { ...safe };
}

export function createSessionMutationCoordinator(options: {
  randomUUID?: () => string;
  now?: () => number;
  onLifecycleEvent?: (event: SessionMutationLifecycleEvent) => void;
} = {}) {
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;
  const now = options.now ?? Date.now;
  const runs = new Map<string, StoredSessionMutation>();
  const generations = new Map<string, number>();
  const emit = (event: SessionMutationLifecycleEvent) => {
    try { options.onLifecycleEvent?.(event); } catch {
      // Diagnostics must never change command execution semantics.
    }
  };

  function reserveStart(input: {
    workspaceId: string;
    sessionId: string;
    origin: SessionMutationOrigin;
    startCommandCorrelationId: string | null;
  }): ActiveSessionMutation {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const existing = runs.get(key);
    if (existing) throw new SessionMutationError("session_busy", existing.runId);

    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    const timestamp = now();
    const run: StoredSessionMutation = {
      ...input,
      runId: randomUUID(),
      generation,
      abortCommandCorrelationId: null,
      status: "starting",
      observedActive: false,
      startedAt: timestamp,
      updatedAt: timestamp,
      activeObservedAt: null,
      abortRequestedAt: null,
      abortAccepted: false,
      authoritativeIdleObservedAt: null,
    };
    runs.set(key, run);
    emit({ event: "run_reserved", run: publicRun(run) });
    return publicRun(run);
  }

  function acceptStart(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
  }): ActiveSessionMutation | null {
    const run = runs.get(sessionKey(input.workspaceId, input.sessionId));
    if (!run || run.runId !== input.runId) return null;
    if (run.status === "starting") {
      run.status = "running";
      run.updatedAt = now();
      emit({ event: "run_started", run: publicRun(run) });
    }
    // Idle evidence observed before upstream accepted the start may belong to
    // the previous engine state. Require fresh authoritative samples.
    run.authoritativeIdleObservedAt = null;
    return publicRun(run);
  }

  function rollbackStart(input: { workspaceId: string; sessionId: string; runId: string }): boolean {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const run = runs.get(key);
    if (!run || run.runId !== input.runId) return false;
    const deleted = runs.delete(key);
    if (deleted) emit({ event: "start_rolled_back", run: publicRun(run), terminalReason: "dispatch_failed" });
    return deleted;
  }

  function reserveAbort(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    abortCommandCorrelationId: string | null;
  }): { run: ActiveSessionMutation; previousStatus: SessionMutationStatus } {
    const run = runs.get(sessionKey(input.workspaceId, input.sessionId));
    if (!run || run.runId !== input.runId) {
      throw new SessionMutationError("run_mismatch", run?.runId ?? null);
    }
    if (run.status === "aborting") throw new SessionMutationError("session_busy", run.runId);

    const previousStatus = run.status;
    const timestamp = now();
    run.status = "aborting";
    run.abortCommandCorrelationId = input.abortCommandCorrelationId;
    run.abortRequestedAt = timestamp;
    run.updatedAt = timestamp;
    run.abortAccepted = false;
    run.authoritativeIdleObservedAt = null;
    emit({ event: "abort_requested", run: publicRun(run) });
    return { run: publicRun(run), previousStatus };
  }

  function acceptAbort(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    abortCommandCorrelationId: string | null;
  }): ActiveSessionMutation | null {
    const run = runs.get(sessionKey(input.workspaceId, input.sessionId));
    if (!run || run.runId !== input.runId || run.status !== "aborting" ||
      run.abortCommandCorrelationId !== input.abortCommandCorrelationId) return null;
    run.abortAccepted = true;
    run.updatedAt = now();
    emit({ event: "abort_accepted", run: publicRun(run) });
    return publicRun(run);
  }

  function rollbackAbort(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    abortCommandCorrelationId: string | null;
    previousStatus: SessionMutationStatus;
  }): boolean {
    const run = runs.get(sessionKey(input.workspaceId, input.sessionId));
    if (!run || run.runId !== input.runId || run.status !== "aborting" || run.abortAccepted ||
      run.abortCommandCorrelationId !== input.abortCommandCorrelationId) return false;
    run.status = input.previousStatus;
    run.abortCommandCorrelationId = null;
    run.abortRequestedAt = null;
    run.updatedAt = now();
    run.authoritativeIdleObservedAt = null;
    emit({ event: "abort_rolled_back", run: publicRun(run) });
    return true;
  }

  function observe(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    status: SessionMutationObservationStatus;
  }): { cleared: boolean; run: ActiveSessionMutation | null; terminalStatus: SessionMutationTerminalStatus | null } {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const run = runs.get(key);
    if (!run || run.runId !== input.runId) {
      throw new SessionMutationError("run_mismatch", run?.runId ?? null);
    }

    if (input.status === "idle") {
      const canClear = run.status === "aborting" ? run.abortAccepted : run.observedActive;
      if (!canClear) return { cleared: false, run: publicRun(run), terminalStatus: null };
      runs.delete(key);
      const terminalReason = run.status === "aborting" ? "aborted" : "completed";
      emit({ event: "run_terminal", run: publicRun(run), terminalReason });
      return {
        cleared: true,
        run: null,
        terminalStatus: terminalReason,
      };
    }

    if (input.status === "completed" || input.status === "failed" || input.status === "aborted") {
      runs.delete(key);
      emit({ event: "run_terminal", run: publicRun(run), terminalReason: input.status });
      return { cleared: true, run: null, terminalStatus: input.status };
    }

    const timestamp = now();
    run.authoritativeIdleObservedAt = null;
    if (input.status !== "starting" && !run.observedActive) {
      run.observedActive = true;
      run.activeObservedAt = timestamp;
    }
    // Once abort is reserved, ordinary engine activity cannot downgrade it.
    if (run.status !== "aborting" || input.status === "aborting") run.status = input.status;
    run.updatedAt = timestamp;
    emit({ event: "progress", run: publicRun(run) });
    return { cleared: false, run: publicRun(run), terminalStatus: null };
  }

  /**
   * Reconcile a coordinator reservation against a fresh `/session/status`
   * sample that says the engine is idle.
   *
   * A single idle sample cannot clear an accepted run whose active event was
   * never observed: it may be a pre-start status racing with prompt dispatch.
   * Two authoritative samples separated by a grace interval close the
   * fast-completion / lost-event case without weakening the start fence.
   */
  function reconcileAuthoritativeIdle(input: {
    workspaceId: string;
    sessionId: string;
    runId: string;
    minimumIntervalMs: number;
  }): SessionMutationIdleReconciliation {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const run = runs.get(key);
    if (!run || run.runId !== input.runId) {
      throw new SessionMutationError("run_mismatch", run?.runId ?? null);
    }

    if (!Number.isFinite(input.minimumIntervalMs) || input.minimumIntervalMs < 0) {
      throw new TypeError("minimumIntervalMs must be a non-negative finite number");
    }

    if (run.status === "starting") {
      return {
        cleared: false,
        run: publicRun(run),
        terminalStatus: null,
        retryAfterMs: null,
      };
    }

    if (run.status === "aborting") {
      if (!run.abortAccepted) {
        return {
          cleared: false,
          run: publicRun(run),
          terminalStatus: null,
          retryAfterMs: null,
        };
      }
      runs.delete(key);
      emit({ event: "run_terminal", run: publicRun(run), terminalReason: "aborted" });
      return { cleared: true, run: null, terminalStatus: "aborted", retryAfterMs: null };
    }

    if (run.observedActive) {
      runs.delete(key);
      emit({ event: "run_terminal", run: publicRun(run), terminalReason: "completed" });
      return { cleared: true, run: null, terminalStatus: "completed", retryAfterMs: null };
    }

    const timestamp = now();
    if (run.authoritativeIdleObservedAt === null) {
      run.authoritativeIdleObservedAt = timestamp;
      run.updatedAt = timestamp;
      emit({ event: "idle_suspected", run: publicRun(run) });
      return {
        cleared: false,
        run: publicRun(run),
        terminalStatus: null,
        retryAfterMs: input.minimumIntervalMs,
      };
    }

    const elapsed = Math.max(0, timestamp - run.authoritativeIdleObservedAt);
    if (elapsed < input.minimumIntervalMs) {
      return {
        cleared: false,
        run: publicRun(run),
        terminalStatus: null,
        retryAfterMs: input.minimumIntervalMs - elapsed,
      };
    }

    runs.delete(key);
    emit({ event: "run_terminal", run: publicRun(run), terminalReason: "completed" });
    return { cleared: true, run: null, terminalStatus: "completed", retryAfterMs: null };
  }

  function listActive(workspaceId?: string): ActiveSessionMutation[] {
    return [...runs.values()]
      .filter((run) => workspaceId === undefined || run.workspaceId === workspaceId)
      .map(publicRun);
  }

  function getActive(workspaceId: string, sessionId: string): ActiveSessionMutation | null {
    const run = runs.get(sessionKey(workspaceId, sessionId));
    return run ? publicRun(run) : null;
  }

  return Object.freeze({
    reserveStart,
    acceptStart,
    rollbackStart,
    reserveAbort,
    acceptAbort,
    rollbackAbort,
    observe,
    reconcileAuthoritativeIdle,
    listActive,
    getActive,
  });
}

export type SessionMutationCoordinator = ReturnType<typeof createSessionMutationCoordinator>;

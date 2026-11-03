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
  revision: number;
  title: string;
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
    | "title_updated"
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
  allocateGeneration?: () => number;
  onLifecycleEvent?: (event: SessionMutationLifecycleEvent) => void;
  initialRuns?: ActiveSessionMutation[];
} = {}) {
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;
  const now = options.now ?? Date.now;
  const runs = new Map<string, StoredSessionMutation>();
  const generations = new Map<string, number>();
  const emit = (event: SessionMutationLifecycleEvent) => options.onLifecycleEvent?.(event);
  for (const restored of options.initialRuns ?? []) {
    const run: StoredSessionMutation = {
      ...restored,
      abortAccepted: restored.status === "aborting",
      authoritativeIdleObservedAt: null,
    };
    runs.set(sessionKey(run.workspaceId, run.sessionId), run);
    generations.set(sessionKey(run.workspaceId, run.sessionId), run.generation);
  }

  function reserveStart(input: {
    workspaceId: string;
    sessionId: string;
    origin: SessionMutationOrigin;
    startCommandCorrelationId: string | null;
    title?: string;
  }): ActiveSessionMutation {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const existing = runs.get(key);
    if (existing) throw new SessionMutationError("session_busy", existing.runId);

    // Allocate before exposing a run. Storage failures must not silently fall
    // back to a counter that can reuse an already published generation.
    const generation = options.allocateGeneration?.() ?? (generations.get(key) ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("invalid_run_generation");
    generations.set(key, generation);
    const timestamp = now();
    const run: StoredSessionMutation = {
      ...input,
      runId: randomUUID(),
      generation,
      revision: 1,
      title: input.title?.slice(0, 120) ?? "",
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
    emit({ event: "run_reserved", run: publicRun(run) });
    runs.set(key, run);
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
      const next = { ...run, status: "running" as const, revision: run.revision + 1, updatedAt: now() };
      emit({ event: "run_started", run: publicRun(next) });
      runs.set(sessionKey(input.workspaceId, input.sessionId), next);
      return publicRun(next);
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
    emit({ event: "start_rolled_back", run: publicRun(run), terminalReason: "dispatch_failed" });
    return runs.delete(key);
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
    const previous = { ...run };
    const timestamp = now();
    run.revision += 1;
    run.status = "aborting";
    run.abortCommandCorrelationId = input.abortCommandCorrelationId;
    run.abortRequestedAt = timestamp;
    run.updatedAt = timestamp;
    run.abortAccepted = false;
    run.authoritativeIdleObservedAt = null;
    try { emit({ event: "abort_requested", run: publicRun(run) }); } catch (error) {
      Object.assign(run, previous);
      throw error;
    }
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
    const previous = { ...run };
    run.abortAccepted = true;
    run.revision += 1;
    run.updatedAt = now();
    try { emit({ event: "abort_accepted", run: publicRun(run) }); } catch (error) {
      Object.assign(run, previous);
      throw error;
    }
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
    const previous = { ...run };
    run.status = input.previousStatus;
    run.revision += 1;
    run.abortCommandCorrelationId = null;
    run.abortRequestedAt = null;
    run.updatedAt = now();
    run.authoritativeIdleObservedAt = null;
    try { emit({ event: "abort_rolled_back", run: publicRun(run) }); } catch (error) {
      Object.assign(run, previous);
      throw error;
    }
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
      const terminalReason = run.status === "aborting" ? "aborted" : "completed";
      emit({ event: "run_terminal", run: publicRun(run), terminalReason });
      runs.delete(key);
      return {
        cleared: true,
        run: null,
        terminalStatus: terminalReason,
      };
    }

    if (input.status === "completed" || input.status === "failed" || input.status === "aborted") {
      emit({ event: "run_terminal", run: publicRun(run), terminalReason: input.status });
      runs.delete(key);
      return { cleared: true, run: null, terminalStatus: input.status };
    }

    const previous = { ...run };
    const timestamp = now();
    run.revision += 1;
    run.authoritativeIdleObservedAt = null;
    if (input.status !== "starting" && !run.observedActive) {
      run.observedActive = true;
      run.activeObservedAt = timestamp;
    }
    // Once abort is reserved, ordinary engine activity cannot downgrade it.
    if (run.status !== "aborting" || input.status === "aborting") run.status = input.status;
    run.updatedAt = timestamp;
    try { emit({ event: "progress", run: publicRun(run) }); } catch (error) {
      Object.assign(run, previous);
      throw error;
    }
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
      emit({ event: "run_terminal", run: publicRun(run), terminalReason: "aborted" });
      runs.delete(key);
      return { cleared: true, run: null, terminalStatus: "aborted", retryAfterMs: null };
    }

    const timestamp = now();
    if (run.authoritativeIdleObservedAt === null) {
      const previous = { ...run };
      run.authoritativeIdleObservedAt = timestamp;
      run.revision += 1;
      run.updatedAt = timestamp;
      try { emit({ event: "idle_suspected", run: publicRun(run) }); } catch (error) {
        Object.assign(run, previous);
        throw error;
      }
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

    emit({ event: "run_terminal", run: publicRun(run), terminalReason: "completed" });
    runs.delete(key);
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

  function updateTitle(input: { workspaceId: string; sessionId: string; title: string }): ActiveSessionMutation | null {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const run = runs.get(key);
    if (!run) return null;
    const title = input.title.slice(0, 120);
    if (!title || title === run.title) return publicRun(run);
    const previous = { ...run };
    run.title = title;
    run.revision += 1;
    run.updatedAt = now();
    try { emit({ event: "title_updated", run: publicRun(run) }); } catch (error) {
      Object.assign(run, previous);
      throw error;
    }
    return publicRun(run);
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
    updateTitle,
  });
}

export type SessionMutationCoordinator = ReturnType<typeof createSessionMutationCoordinator>;

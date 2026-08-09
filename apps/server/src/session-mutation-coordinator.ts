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
}

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
  const { abortAccepted: _abortAccepted, ...safe } = run;
  return { ...safe };
}

export function createSessionMutationCoordinator(options: {
  randomUUID?: () => string;
  now?: () => number;
} = {}) {
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;
  const now = options.now ?? Date.now;
  const runs = new Map<string, StoredSessionMutation>();
  const generations = new Map<string, number>();

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
    };
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
      run.status = "running";
      run.updatedAt = now();
    }
    return publicRun(run);
  }

  function rollbackStart(input: { workspaceId: string; sessionId: string; runId: string }): boolean {
    const key = sessionKey(input.workspaceId, input.sessionId);
    const run = runs.get(key);
    if (!run || run.runId !== input.runId) return false;
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
    const timestamp = now();
    run.status = "aborting";
    run.abortCommandCorrelationId = input.abortCommandCorrelationId;
    run.abortRequestedAt = timestamp;
    run.updatedAt = timestamp;
    run.abortAccepted = false;
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
      return {
        cleared: true,
        run: null,
        terminalStatus: run.status === "aborting" ? "aborted" : "completed",
      };
    }

    if (input.status === "completed" || input.status === "failed" || input.status === "aborted") {
      runs.delete(key);
      return { cleared: true, run: null, terminalStatus: input.status };
    }

    const timestamp = now();
    if (input.status !== "starting" && !run.observedActive) {
      run.observedActive = true;
      run.activeObservedAt = timestamp;
    }
    // Once abort is reserved, ordinary engine activity cannot downgrade it.
    if (run.status !== "aborting" || input.status === "aborting") run.status = input.status;
    run.updatedAt = timestamp;
    return { cleared: false, run: publicRun(run), terminalStatus: null };
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
    listActive,
    getActive,
  });
}

export type SessionMutationCoordinator = ReturnType<typeof createSessionMutationCoordinator>;

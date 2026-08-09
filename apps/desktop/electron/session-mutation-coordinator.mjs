import { randomUUID as cryptoRandomUUID } from "node:crypto";

/**
 * @typedef {"started" | "running" | "aborting"} ActiveRunStatus
 * @typedef {{ runId: string, status: ActiveRunStatus, generation: number, startedAt: number }} ActiveRun
 * @typedef {{ workspaceId: string, sessionId: string, runId: string, status: ActiveRunStatus }} ActiveRunView
 */

export class SessionMutationError extends Error {
  /**
   * @param {string} code
   * @param {string | null} currentRunId
   */
  constructor(code, currentRunId = null) {
    super(code);
    this.name = "SessionMutationError";
    this.code = code;
    this.currentRunId = currentRunId;
  }
}

function sessionKey(workspaceId, sessionId) {
  return `${workspaceId}\0${sessionId}`;
}

/**
 * In-memory per-session mutation state machine. Ensures only one active run
 * per session and provides run_mismatch fencing for abort.
 *
 * @param {{ randomUUID?: () => string, now?: () => number }} [options]
 */
export function createSessionMutationCoordinator({ randomUUID = cryptoRandomUUID, now = Date.now } = {}) {
  if (typeof randomUUID !== "function" || typeof now !== "function") {
    throw new TypeError("SessionMutationCoordinator options are invalid.");
  }

  /** @type {Map<string, ActiveRun>} */
  const runs = new Map();
  /** @type {Map<string, number>} */
  const generations = new Map();

  /**
   * @param {{ workspaceId: string, sessionId: string }} input
   * @returns {{ runId: string, generation: number }}
   */
  function beginRun({ workspaceId, sessionId }) {
    const key = sessionKey(workspaceId, sessionId);
    const existing = runs.get(key);
    if (existing && (existing.status === "started" || existing.status === "running" || existing.status === "aborting")) {
      throw new SessionMutationError("session_busy", existing.runId);
    }
    const prevGen = generations.get(key) ?? 0;
    const generation = prevGen + 1;
    generations.set(key, generation);
    const runId = randomUUID();
    runs.set(key, { runId, status: "started", generation, startedAt: now() });
    return { runId, generation };
  }

  /**
   * @param {{ workspaceId: string, sessionId: string, runId: string }} input
   */
  function recordPromptAccepted({ workspaceId, sessionId, runId }) {
    const key = sessionKey(workspaceId, sessionId);
    const run = runs.get(key);
    if (run && run.runId === runId && run.status === "started") {
      run.status = "running";
    }
  }

  /**
   * @param {{ workspaceId: string, sessionId: string, expectedRunId: string }} input
   * @returns {{ runId: string }}
   */
  function resolveRun({ workspaceId, sessionId, expectedRunId }) {
    const key = sessionKey(workspaceId, sessionId);
    const run = runs.get(key);
    if (!run) throw new SessionMutationError("run_mismatch", null);
    if (run.runId !== expectedRunId) throw new SessionMutationError("run_mismatch", run.runId);
    return { runId: expectedRunId };
  }

  /**
   * @param {{ workspaceId: string, sessionId: string, runId: string }} input
   */
  function markAborting({ workspaceId, sessionId, runId }) {
    const key = sessionKey(workspaceId, sessionId);
    const run = runs.get(key);
    if (run && run.runId === runId) {
      run.status = "aborting";
    }
  }

  /**
   * @param {{ workspaceId: string, sessionId: string }} input
   */
  function markTerminal({ workspaceId, sessionId }) {
    const key = sessionKey(workspaceId, sessionId);
    runs.delete(key);
  }

  /**
   * @param {{ workspaceId: string, sessionId: string }} input
   * @returns {string | null}
   */
  function getActiveRunId({ workspaceId, sessionId }) {
    const key = sessionKey(workspaceId, sessionId);
    return runs.get(key)?.runId ?? null;
  }

  /**
   * @returns {ActiveRunView[]}
   */
  function activeRuns() {
    /** @type {ActiveRunView[]} */
    const result = [];
    for (const [key, run] of runs) {
      const [workspaceId, sessionId] = key.split("\0");
      result.push({ workspaceId, sessionId, runId: run.runId, status: run.status });
    }
    return result;
  }

  return Object.freeze({
    beginRun,
    recordPromptAccepted,
    resolveRun,
    markAborting,
    markTerminal,
    getActiveRunId,
    activeRuns,
  });
}

const ACTIVE_STATUSES = new Set(["starting", "running", "waiting", "retrying", "aborting"]);
const ORIGINS = new Set(["local-renderer", "remote-control"]);
const MAX_ACTIVE_RUNS = 100;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {unknown} value */
function nullableIdentifier(value) {
  return value === null || identifier(value);
}

/** @param {unknown} value */
function timestamp(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** @param {unknown} value */
function nullableTimestamp(value) {
  return value === null || timestamp(value);
}

/**
 * @param {unknown} value
 * @returns {{ workspaceId: string, sessionId: string, runId: string, generation: number, origin: "local-renderer" | "remote-control", startCommandCorrelationId: string | null, abortCommandCorrelationId: string | null, status: "starting" | "running" | "waiting" | "retrying" | "aborting", observedActive: boolean, startedAt: number, updatedAt: number, activeObservedAt: number | null, abortRequestedAt: number | null }}
 */
function serverRun(value) {
  if (!isRecord(value) || !identifier(value.workspaceId) || !identifier(value.sessionId) || !identifier(value.runId) ||
      !Number.isSafeInteger(value.generation) || Number(value.generation) <= 0 || !ORIGINS.has(/** @type {string} */ (value.origin)) ||
      !nullableIdentifier(value.startCommandCorrelationId) || !nullableIdentifier(value.abortCommandCorrelationId) ||
      !ACTIVE_STATUSES.has(/** @type {string} */ (value.status)) || typeof value.observedActive !== "boolean" ||
      !timestamp(value.startedAt) || !timestamp(value.updatedAt) || !nullableTimestamp(value.activeObservedAt) ||
      !nullableTimestamp(value.abortRequestedAt)) {
    throw new TypeError("The managed server returned an invalid session run.");
  }
  return /** @type {any} */ ({
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    runId: value.runId,
    generation: value.generation,
    origin: value.origin,
    startCommandCorrelationId: value.startCommandCorrelationId,
    abortCommandCorrelationId: value.abortCommandCorrelationId,
    status: value.status,
    observedActive: value.observedActive,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    activeObservedAt: value.activeObservedAt,
    abortRequestedAt: value.abortRequestedAt,
  });
}

function sessionKey(workspaceId, sessionId) {
  return `${workspaceId}\0${sessionId}`;
}

/**
 * Keeps a fenced, content-minimized mirror of the server-owned run state.
 * Generation fences survive terminal clearing so delayed responses cannot
 * resurrect an old run.
 */
export function createSessionMutationCoordinator() {
  /** @type {Map<string, ReturnType<typeof serverRun>>} */
  const runs = new Map();
  /** @type {Map<string, { generation: number, runId: string }>} */
  const fences = new Map();

  /** @param {unknown} input */
  function recordServerRun(input) {
    const incoming = serverRun(input);
    const key = sessionKey(incoming.workspaceId, incoming.sessionId);
    const fence = fences.get(key);
    const current = runs.get(key);
    if (fence && (incoming.generation < fence.generation ||
        (incoming.generation === fence.generation && incoming.runId !== fence.runId))) return false;
    if (fence && !current && incoming.generation === fence.generation) return false;
    if (current && incoming.generation === current.generation) {
      if (incoming.runId !== current.runId || incoming.origin !== current.origin ||
          incoming.startCommandCorrelationId !== current.startCommandCorrelationId || incoming.startedAt !== current.startedAt ||
          incoming.updatedAt < current.updatedAt ||
          (current.status === "aborting" && incoming.status !== "aborting") ||
          (current.abortCommandCorrelationId !== null && incoming.abortCommandCorrelationId === null)) return false;
    }
    runs.set(key, incoming);
    fences.set(key, { generation: incoming.generation, runId: incoming.runId });
    return true;
  }

  /** @param {{ workspaceId: string, sessionId: string, runId: string }} input */
  function clearTerminalRun({ workspaceId, sessionId, runId }) {
    const key = sessionKey(workspaceId, sessionId);
    const current = runs.get(key);
    if (!current || current.runId !== runId) return false;
    runs.delete(key);
    return true;
  }

  /** @param {{ workspaceId: string, sessionId: string }} input */
  function getActiveRunId({ workspaceId, sessionId }) {
    return runs.get(sessionKey(workspaceId, sessionId))?.runId ?? null;
  }

  function activeRuns() {
    return [...runs.values()].slice(0, MAX_ACTIVE_RUNS).map((run) => ({
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      runId: run.runId,
      status: run.status === "starting" ? "started" : run.status,
    }));
  }

  return Object.freeze({ recordServerRun, clearTerminalRun, getActiveRunId, activeRuns });
}

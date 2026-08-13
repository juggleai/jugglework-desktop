import { createRemoteSessionProjector } from "./remote-session-projector.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value */
function identifier(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

/** @param {string | null} type @param {Record<string, any> | null} data */
function observationStatus(type, data) {
  if (type === "session.idle") return "idle";
  if (type === "session.error") return "failed";
  if (type !== "session.status" || !data) return null;
  const raw = isRecord(data.status) ? data.status.type : data.status;
  if (raw === "busy" || raw === "running") return "running";
  if (raw === "retry" || raw === "retrying") return "retrying";
  return ["starting", "waiting", "aborting", "idle", "completed", "failed", "aborted"].includes(raw) ? raw : null;
}

function canonicalObservation(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !identifier(raw.sessionId) || !isRecord(raw.data)) return null;
  const type = raw.data.type;
  const status = type === "session.status"
    ? observationStatus("session.status", raw.data)
    : type === "run.completed" ? "completed"
      : type === "run.failed" ? "failed"
        : type === "run.aborted" ? "aborted" : null;
  return status ? { sessionId: raw.sessionId, status } : null;
}

/**
 * @param {{
 *   sseClient: { subscribe(input: { workspaceId: string, onEvent(raw: unknown): void | Promise<void>, onReconnectGap(reason: "sequence_gap"): void | Promise<void>, signal: AbortSignal }): Promise<void> },
 *   coordinator: { getActiveRunId(input: { workspaceId: string, sessionId: string }): string | null, recordServerRun(input: unknown): boolean, clearTerminalRun(input: { workspaceId: string, sessionId: string, runId: string }): boolean },
 *   listActiveRuns(input: { workspaceId: string }): Promise<unknown>,
 *   observeRun(input: { workspaceId: string, sessionId: string, runId: string, status: "starting" | "running" | "waiting" | "retrying" | "aborting" | "idle" | "completed" | "failed" | "aborted" }): Promise<unknown>,
 *   publish(event: unknown, options: { connectionGeneration: number }): boolean,
 *   randomUUID: () => string,
 *   now: () => number | Date,
 *   timers: { setTimeout(callback: () => void, delay: number): unknown, clearTimeout(handle: unknown): void },
 *   logger?: { warn?: (message: string, metadata?: object) => void },
 *   coalesceMs?: number,
 *   onNotificationEvent?: (event: unknown) => void,
 *   onStop?: () => void,
 * }} options
 */
export function createRemoteSessionEventBridge({ sseClient, coordinator, listActiveRuns, observeRun, publish, randomUUID, now, timers, logger = {}, coalesceMs = 25, onNotificationEvent = null, onStop = null }) {
  if (!sseClient || typeof sseClient.subscribe !== "function" || !coordinator ||
      typeof coordinator.getActiveRunId !== "function" || typeof coordinator.recordServerRun !== "function" ||
      typeof coordinator.clearTerminalRun !== "function" || typeof listActiveRuns !== "function" || typeof observeRun !== "function" ||
       typeof publish !== "function" || !(onNotificationEvent === null || typeof onNotificationEvent === "function") ||
       !(onStop === null || typeof onStop === "function")) {
    throw new TypeError("Remote session event bridge dependencies are invalid.");
  }

  /** @type {Map<string, Readonly<{ controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string, connectionGeneration: number }>>} */
  const bindings = new Map();
  /** @type {Map<string, { identity: object, controller: AbortController }>} */
  const subscriptions = new Map();
  let lifetime = 1;
  let stopped = false;
  let projector = createProjector();

  function createProjector() {
    return createRemoteSessionProjector({
      randomUUID,
      now,
      timers,
      coalesceMs,
      getActiveRunId: (input) => coordinator.getActiveRunId(input),
      emit: (event) => {
        const binding = bindings.get(event.controlSessionId);
        if (binding && binding.workspaceId === event.workspaceId && binding.sessionId === event.sessionId) {
          const accepted = publish(event, { connectionGeneration: binding.connectionGeneration });
          if (!accepted) {
            unbind(binding.controlSessionId);
          } else if (event.data.type === "interaction.upsert" &&
              (event.data.interaction.type === "permission" || event.data.interaction.type === "question")) {
            try {
              onNotificationEvent?.({
                origin: "live",
                type: "interaction.waiting",
                workspaceId: event.workspaceId,
                sessionId: event.sessionId,
                interactionId: event.data.interaction.id,
                interactionType: event.data.interaction.type,
              });
            } catch {}
          }
          return accepted;
        }
        return false;
      },
    });
  }

  /** @param {string} workspaceId */
  function ensureSubscription(workspaceId) {
    if (stopped || subscriptions.has(workspaceId)) return;
    const controller = new AbortController();
    const identity = {};
    const generation = lifetime;
    subscriptions.set(workspaceId, { identity, controller });
    const current = () => !stopped && generation === lifetime && subscriptions.get(workspaceId)?.identity === identity;
    void listActiveRuns({ workspaceId }).then((response) => {
      if (!current() || !isRecord(response) || !Array.isArray(response.items)) return;
      for (const run of response.items) {
        if (!current()) return;
        try { coordinator.recordServerRun(run); } catch {}
      }
    }).catch(() => undefined);
    void sseClient.subscribe({
      workspaceId,
      signal: controller.signal,
      onEvent: async (raw) => {
        if (!current()) return;
        if (isRecord(raw) && raw.schemaVersion === 1 && Array.isArray(raw.snapshots)) {
          projector.reconnectGap(workspaceId, "cursor_missing");
          return;
        }
        const canonical = canonicalObservation(raw);
        const event = isRecord(raw) && isRecord(raw.payload) ? raw.payload : raw;
        const data = isRecord(event) ? (isRecord(event.data) ? event.data : event.properties) : null;
        const type = isRecord(event) && typeof event.type === "string" ? event.type : null;
        const sessionId = canonical?.sessionId ?? (isRecord(data)
          ? (identifier(data.sessionID) ? data.sessionID : identifier(data.sessionId) ? data.sessionId : null)
          : null);
        const status = canonical?.status ?? observationStatus(type, data);
        let runId = sessionId && status ? coordinator.getActiveRunId({ workspaceId, sessionId }) : null;
        // A queued operation is intentionally absent from the mirror until the
        // server admits it. Hydrate that new authoritative run on its first SSE
        // status rather than treating the queued item itself as active.
        if (sessionId && status && !runId) {
          try {
            const response = await listActiveRuns({ workspaceId });
            if (!current() || !isRecord(response) || !Array.isArray(response.items)) return;
            for (const run of response.items) coordinator.recordServerRun(run);
            runId = coordinator.getActiveRunId({ workspaceId, sessionId });
          } catch {}
        }
        projector.accept(workspaceId, raw);
        if (!current() || !sessionId || !status || !runId) return;
        try {
          const response = await observeRun({ workspaceId, sessionId, runId, status });
          if (!current() || !isRecord(response)) return;
          if (response.cleared === true && response.run === null) {
            if (response.terminalStatus === "completed" || response.terminalStatus === "failed" || response.terminalStatus === "aborted") {
              try {
                onNotificationEvent?.({
                  origin: "live",
                  type: "run.terminal",
                  workspaceId,
                  sessionId,
                  runId,
                  outcome: response.terminalStatus,
                });
              } catch {}
            }
            coordinator.clearTerminalRun({ workspaceId, sessionId, runId });
          } else if (response.cleared === false && isRecord(response.run)) {
            coordinator.recordServerRun(response.run);
          }
        } catch {}
      },
      onReconnectGap: async (reason) => {
        if (current()) projector.reconnectGap(workspaceId, reason);
      },
    }).catch(() => {
      if (!current()) return;
      subscriptions.delete(workspaceId);
      projector.reconnectGap(workspaceId);
      try { logger.warn?.("Remote session event subscription failed.", { workspaceId }); } catch {}
    });
  }

  /** @param {unknown} input */
  function bind(input) {
    if (stopped || !isRecord(input) || !UUID_PATTERN.test(input.controlSessionId) || !UUID_PATTERN.test(input.deviceId) ||
        !identifier(input.workspaceId) || !identifier(input.sessionId) ||
        !Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration <= 0) return false;
    const binding = Object.freeze({
      controlSessionId: input.controlSessionId,
      deviceId: input.deviceId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      connectionGeneration: input.connectionGeneration,
    });
    const existing = bindings.get(binding.controlSessionId);
    if (existing) {
      if (existing.deviceId !== binding.deviceId || existing.workspaceId !== binding.workspaceId ||
          existing.sessionId !== binding.sessionId || existing.connectionGeneration !== binding.connectionGeneration) return false;
      ensureSubscription(binding.workspaceId);
      return true;
    }
    try {
      if (!projector.bind(binding)) return false;
    } catch {
      return false;
    }
    bindings.set(binding.controlSessionId, binding);
    ensureSubscription(binding.workspaceId);
    return true;
  }

  /** @param {string} controlSessionId */
  function unbind(controlSessionId) {
    const binding = bindings.get(controlSessionId);
    if (!binding) return false;
    bindings.delete(controlSessionId);
    projector.unbind(controlSessionId);
    if (![...bindings.values()].some((candidate) => candidate.workspaceId === binding.workspaceId)) {
      subscriptions.get(binding.workspaceId)?.controller.abort();
      subscriptions.delete(binding.workspaceId);
    }
    return true;
  }

  function clear() {
    lifetime += 1;
    for (const subscription of subscriptions.values()) subscription.controller.abort();
    subscriptions.clear();
    bindings.clear();
    projector.stop();
    if (!stopped) projector = createProjector();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clear();
    try { onStop?.(); } catch {}
  }

  return Object.freeze({ bind, unbind, clear, stop });
}

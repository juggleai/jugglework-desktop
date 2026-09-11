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

/** @param {Record<string, any> | null} data */
function eventSessionId(data) {
  if (!data) return null;
  for (const candidate of [data, data.info, data.part]) {
    if (!isRecord(candidate)) continue;
    if (identifier(candidate.sessionID)) return candidate.sessionID;
    if (identifier(candidate.sessionId)) return candidate.sessionId;
  }
  return null;
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
 *   logger?: { debug?: (message: string, metadata?: object) => void, info?: (message: string, metadata?: object) => void, warn?: (message: string, metadata?: object) => void, error?: (message: string, metadata?: object) => void },
 *   coalesceMs?: number,
 *   subscriptionRetryDelaysMs?: number[],
 *   onNotificationEvent?: (event: unknown) => void,
 *   onStop?: () => void,
 *   interactions?: { resolveOwnership(input: { workspaceId: string, targetSessionId: string }): Promise<unknown> } | null,
 * }} options
 */
export function createRemoteSessionEventBridge({ sseClient, coordinator, listActiveRuns, observeRun, publish, randomUUID, now, timers, logger = {}, coalesceMs = 25, subscriptionRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000], onNotificationEvent = null, onStop = null, interactions = null }) {
  if (!sseClient || typeof sseClient.subscribe !== "function" || !coordinator ||
      typeof coordinator.getActiveRunId !== "function" || typeof coordinator.recordServerRun !== "function" ||
      typeof coordinator.clearTerminalRun !== "function" || typeof listActiveRuns !== "function" || typeof observeRun !== "function" ||
       typeof publish !== "function" || !(onNotificationEvent === null || typeof onNotificationEvent === "function") ||
       !(onStop === null || typeof onStop === "function") ||
       !(interactions === null || typeof interactions?.resolveOwnership === "function") ||
       !Array.isArray(subscriptionRetryDelaysMs) || subscriptionRetryDelaysMs.length === 0 ||
       subscriptionRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 1 || delay > 60_000)) {
    throw new TypeError("Remote session event bridge dependencies are invalid.");
  }

  /** @type {Map<string, Readonly<{ controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string, rootSessionId: string, payloadVersion: 1 | 2, connectionGeneration: number }>>} */
  const bindings = new Map();
  /** @type {Map<string, { identity: object, controller: AbortController }>} */
  const subscriptions = new Map();
  let lifetime = 1;
  let stopped = false;
  let projector = createProjector();
  const projectedCounts = new Map();

  /** @param {number} attempt */
  function retryDelay(attempt) {
    return [100, 500, 2_000][attempt] ?? 2_000;
  }

  /** @param {number} ms */
  function wait(ms, signal = null) {
    if (signal?.aborted) return Promise.resolve();
    if (!signal) return new Promise((resolve) => timers.setTimeout(() => resolve(), ms));
    return new Promise((resolve) => {
      let handle = null;
      function done() {
        signal.removeEventListener("abort", done);
        if (handle !== null) timers.clearTimeout(handle);
        resolve(undefined);
      }
      signal.addEventListener("abort", done, { once: true });
      handle = timers.setTimeout(done, ms);
    });
  }

  /** @param {unknown} error */
  function retryableObservationError(error) {
    if (!isRecord(error)) return true;
    const status = Number(error.status);
    return !Number.isFinite(status) || status >= 500;
  }

  /** @param {string} workspaceId @param {string | null} sessionId */
  async function hydrateWorkspaceRuns(workspaceId, sessionId = null) {
    const response = await listActiveRuns({ workspaceId });
    if (!isRecord(response) || !Array.isArray(response.items)) return null;
    const activeSessionIds = new Set();
    for (const run of response.items) {
      if (isRecord(run) && identifier(run.sessionId)) activeSessionIds.add(run.sessionId);
      try { coordinator.recordServerRun(run); } catch {}
    }
    if (sessionId && !activeSessionIds.has(sessionId)) {
      const staleRunId = coordinator.getActiveRunId({ workspaceId, sessionId });
      if (staleRunId) coordinator.clearTerminalRun({ workspaceId, sessionId, runId: staleRunId });
    }
    return response;
  }

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
          let accepted = false;
          try {
            accepted = publish(event, { connectionGeneration: binding.connectionGeneration });
            try { logger.debug?.("remote_session_publish", { eventType: event.data.type, accepted }); } catch {}
          } catch {
            try { logger.error?.("remote_session_publish_failed", { eventType: event.data.type, reason: "publisher_exception" }); } catch {}
          }
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
          if (accepted) projectedCounts.set(event.workspaceId, (projectedCounts.get(event.workspaceId) ?? 0) + 1);
          return accepted;
        }
        try { logger.debug?.("remote_session_projection_dropped", { reason: "binding_mismatch", eventType: event.data?.type ?? "unknown" }); } catch {}
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
    void hydrateWorkspaceRuns(workspaceId).then(() => {
      if (!current()) return;
    }).catch(() => undefined);
    const onEvent = async (raw) => {
        if (!current()) return;
        const event = isRecord(raw) && isRecord(raw.payload) ? raw.payload : raw;
        const data = isRecord(event) ? (isRecord(event.data) ? event.data : event.properties) : null;
        const type = isRecord(event) && typeof event.type === "string" ? event.type : null;
        const before = projectedCounts.get(workspaceId) ?? 0;
        const bindingCount = [...bindings.values()].filter((binding) => binding.workspaceId === workspaceId).length;
        try { logger.debug?.("remote_session_raw_received", { eventType: type ?? "unknown", bindingCount }); } catch {}
        const sessionId = eventSessionId(data);
        if (!type || !data) {
          try { logger.debug?.("remote_session_projection_dropped", { reason: "invalid_envelope", eventType: type ?? "unknown" }); } catch {}
          return;
        }
        if (!sessionId) {
          try { logger.debug?.("remote_session_projection_dropped", { reason: "missing_session", eventType: type }); } catch {}
        }
        const status = observationStatus(type, data);
        let runId = sessionId && status ? coordinator.getActiveRunId({ workspaceId, sessionId }) : null;
        // A queued operation is intentionally absent from the mirror until the
        // server admits it. Hydrate that new authoritative run on its first SSE
        // status rather than treating the queued item itself as active.
        if (sessionId && status && !runId) {
          try {
            const response = await hydrateWorkspaceRuns(workspaceId, sessionId);
            if (!current() || !isRecord(response) || !Array.isArray(response.items)) return;
            runId = coordinator.getActiveRunId({ workspaceId, sessionId });
          } catch {}
        }
        let interactionOwnership = null;
        if (sessionId && (type?.startsWith("permission.") || type?.startsWith("question.")) && interactions) {
          try {
            interactionOwnership = await interactions.resolveOwnership({ workspaceId, targetSessionId: sessionId });
          } catch {}
        }
        if (sessionId && (type?.startsWith("permission.") || type?.startsWith("question.")) && !interactionOwnership) {
          try { logger.warn?.("remote_session_projection_dropped", { reason: "interaction_ownership", eventType: type }); } catch {}
          projector.reconnectGap(workspaceId, "sequence_gap");
          return;
        }
        projector.accept(workspaceId, raw, interactionOwnership);
        const projected = (projectedCounts.get(workspaceId) ?? 0) - before;
        try {
          if (projected > 0) logger.debug?.("remote_session_projected", { eventType: type, projectedCount: projected });
          else logger.debug?.("remote_session_projection_dropped", { reason: "projector_filtered", eventType: type });
        } catch {}
        if (!current() || !sessionId || !status || !runId) return;
        try {
          let response;
          for (let attempt = 0; attempt < 4; attempt++) {
            try {
              response = await observeRun({ workspaceId, sessionId, runId, status });
              break;
            } catch (error) {
              if (!current() || coordinator.getActiveRunId({ workspaceId, sessionId }) !== runId ||
                  attempt === 3 || !retryableObservationError(error)) throw error;
              await wait(retryDelay(attempt));
            }
          }
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
        } catch (error) {
          if (isRecord(error) && error.serverCode === "run_mismatch" && current()) {
            try { await hydrateWorkspaceRuns(workspaceId, sessionId); } catch {}
          }
          // Keep the exact mirrored run. A later event/reconnect or server-side
          // authoritative status reconciliation can complete it safely.
        }
      };
    const onReconnectGap = async (reason) => {
        if (!current()) return;
        projector.reconnectGap(workspaceId, reason);
        try { await hydrateWorkspaceRuns(workspaceId); } catch {}
      };
    void (async () => {
      let attempt = 0;
      while (current() && [...bindings.values()].some((binding) => binding.workspaceId === workspaceId)) {
        try { logger.info?.("remote_session_subscription_start", { attempt: attempt + 1, bindingCount: [...bindings.values()].filter((binding) => binding.workspaceId === workspaceId).length }); } catch {}
        try {
          await sseClient.subscribe({ workspaceId, signal: controller.signal, onEvent, onReconnectGap });
          if (!current()) return;
          throw Object.assign(new Error("subscription ended"), { code: "stream_ended" });
        } catch (error) {
          if (!current()) return;
          projector.reconnectGap(workspaceId);
          const code = isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 64) : "unknown";
          const status = isRecord(error) && Number.isSafeInteger(error.status) ? Number(error.status) : undefined;
          const retryDelayMs = subscriptionRetryDelaysMs[Math.min(attempt, subscriptionRetryDelaysMs.length - 1)];
          try { logger.warn?.("remote_session_subscription_retry", { code, ...(status ? { status } : {}), attempt: attempt + 1, retryDelayMs }); } catch {}
          attempt += 1;
          await wait(retryDelayMs, controller.signal);
        }
      }
      if (current()) subscriptions.delete(workspaceId);
    })();
  }

  /** @param {unknown} input */
  function bind(input) {
    if (isRecord(input) && input.payloadVersion === undefined) input = { ...input, payloadVersion: 1, rootSessionId: input.sessionId };
    if (stopped || !isRecord(input) || !UUID_PATTERN.test(input.controlSessionId) || !UUID_PATTERN.test(input.deviceId) ||
        !identifier(input.workspaceId) || !identifier(input.sessionId) || input.rootSessionId !== input.sessionId ||
        ![1, 2].includes(input.payloadVersion) ||
        !Number.isSafeInteger(input.connectionGeneration) || input.connectionGeneration <= 0) return false;
    const binding = Object.freeze({
      controlSessionId: input.controlSessionId,
      deviceId: input.deviceId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      rootSessionId: input.rootSessionId,
      payloadVersion: input.payloadVersion,
      connectionGeneration: input.connectionGeneration,
    });
    const existing = bindings.get(binding.controlSessionId);
    if (existing) {
      if (existing.deviceId !== binding.deviceId || existing.workspaceId !== binding.workspaceId ||
          existing.sessionId !== binding.sessionId ||
          existing.connectionGeneration !== binding.connectionGeneration) return false;
      if (binding.payloadVersion === 2 && existing.payloadVersion === 1) {
        if (!projector.bind(binding)) return false;
        bindings.set(binding.controlSessionId, Object.freeze({ ...existing, payloadVersion: 2 }));
      }
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
    projectedCounts.clear();
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

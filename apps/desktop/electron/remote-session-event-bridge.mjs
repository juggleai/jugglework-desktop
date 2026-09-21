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

/** @typedef {{ identity: object, controller: AbortController, live: boolean, attempt: number, waiters: Set<(ready: boolean) => void> }} WorkspaceSubscription */

/**
 * @param {{
 *   sseClient: { subscribe(input: { workspaceId: string, onConnected?: () => void | Promise<void>, onEvent(raw: unknown): void | Promise<void>, onReconnectGap(reason: "sequence_gap"): void | Promise<void>, signal: AbortSignal }): Promise<void> },
 *   coordinator: { getActiveRunId(input: { workspaceId: string, sessionId: string }): string | null, recordServerRun(input: unknown): boolean, clearTerminalRun(input: { workspaceId: string, sessionId: string, runId: string }): boolean },
 *   listActiveRuns(input: { workspaceId: string }): Promise<unknown>,
 *   observeRun(input: { workspaceId: string, sessionId: string, runId: string, status: "starting" | "running" | "waiting" | "retrying" | "aborting" | "idle" | "completed" | "failed" | "aborted" }): Promise<unknown>,
 *   publish(event: unknown, options: { connectionGeneration: number }): boolean,
 *   randomUUID: () => string,
 *   now: () => number | Date,
 *   timers: { setTimeout(callback: () => void, delay: number): unknown, clearTimeout(handle: unknown): void },
 *   logger?: { debug?: (message: string, metadata?: object) => void, info?: (message: string, metadata?: object) => void, warn?: (message: string, metadata?: object) => void, error?: (message: string, metadata?: object) => void },
 *   coalesceMs?: number,
 *   subscriptionReadinessTimeoutMs?: number,
 *   subscriptionRetryDelaysMs?: number[],
 *   onNotificationEvent?: (event: unknown) => void,
 *   onStop?: () => void,
 *   interactions?: { resolveOwnership(input: { workspaceId: string, targetSessionId: string }): Promise<unknown> } | null,
 * }} options
 */
export function createRemoteSessionEventBridge({ sseClient, coordinator, listActiveRuns, observeRun, publish, randomUUID, now, timers, logger = {}, coalesceMs = 25, subscriptionReadinessTimeoutMs = 3_000, subscriptionRetryDelaysMs = [1_000, 2_000, 5_000, 10_000, 30_000], onNotificationEvent = null, onStop = null, interactions = null }) {
  if (!sseClient || typeof sseClient.subscribe !== "function" || !coordinator ||
      typeof coordinator.getActiveRunId !== "function" || typeof coordinator.recordServerRun !== "function" ||
      typeof coordinator.clearTerminalRun !== "function" || typeof listActiveRuns !== "function" || typeof observeRun !== "function" ||
       typeof publish !== "function" || !(onNotificationEvent === null || typeof onNotificationEvent === "function") ||
       !(onStop === null || typeof onStop === "function") ||
       !(interactions === null || typeof interactions?.resolveOwnership === "function") ||
       !Number.isSafeInteger(subscriptionReadinessTimeoutMs) || subscriptionReadinessTimeoutMs < 1 || subscriptionReadinessTimeoutMs > 10_000 ||
       !Array.isArray(subscriptionRetryDelaysMs) || subscriptionRetryDelaysMs.length === 0 ||
       subscriptionRetryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 1 || delay > 60_000)) {
    throw new TypeError("Remote session event bridge dependencies are invalid.");
  }

  /** @type {Map<string, Readonly<{ controlSessionId: string, deviceId: string, workspaceId: string, sessionId: string, rootSessionId: string, payloadVersion: 1 | 2, connectionGeneration: number }>>} */
  const bindings = new Map();
  /** @type {Map<string, WorkspaceSubscription>} */
  const subscriptions = new Map();
  /** @type {Map<string, { identity: object, binding: Readonly<any>, promise: Promise<boolean>, cancel: () => void }>} */
  const pendingBindings = new Map();
  /** @type {Map<string, { identity: object, tail: Promise<void> }>} */
  const observationChains = new Map();
  let lifetime = 1;
  let stopped = false;
  const sequenceStore = new Map();
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

  /** @param {string} workspaceId @param {string | null} sessionId @param {() => boolean} [current] */
  async function hydrateWorkspaceRuns(workspaceId, sessionId = null, current = () => true) {
    const response = await listActiveRuns({ workspaceId });
    if (!current() || !isRecord(response) || !Array.isArray(response.items)) return null;
    const activeSessionIds = new Set();
    for (const run of response.items) {
      if (isRecord(run) && identifier(run.sessionId)) activeSessionIds.add(run.sessionId);
      try { coordinator.recordServerRun(run); } catch {}
    }
    const reconciledSessionIds = sessionId
      ? [sessionId]
      : [...new Set([...bindings.values()]
        .filter((binding) => binding.workspaceId === workspaceId)
        .map((binding) => binding.sessionId))];
    for (const reconciledSessionId of reconciledSessionIds) {
      if (activeSessionIds.has(reconciledSessionId)) continue;
      const staleRunId = coordinator.getActiveRunId({ workspaceId, sessionId: reconciledSessionId });
      if (staleRunId) coordinator.clearTerminalRun({ workspaceId, sessionId: reconciledSessionId, runId: staleRunId });
    }
    return response;
  }

  /** @param {string} workspaceId @param {string} sessionId */
  const observationKey = (workspaceId, sessionId) => `${workspaceId}\u0000${sessionId}`;

  /** @param {string} workspaceId @param {string} sessionId */
  function clearObservationChain(workspaceId, sessionId) {
    observationChains.delete(observationKey(workspaceId, sessionId));
  }

  /**
   * @param {string} workspaceId
   * @param {string} sessionId
   * @param {ReturnType<typeof observationStatus>} status
   * @param {() => boolean} subscriptionCurrent
   */
  function enqueueRunObservation(workspaceId, sessionId, status, subscriptionCurrent) {
    if (!status) return;
    const key = observationKey(workspaceId, sessionId);
    const capturedBindings = [...bindings.values()].filter((binding) =>
      binding.workspaceId === workspaceId && binding.sessionId === sessionId);
    if (capturedBindings.length === 0) return;
    const capturedRunId = coordinator.getActiveRunId({ workspaceId, sessionId });
    let chain = observationChains.get(key);
    const hadChain = Boolean(chain);
    if (!chain) {
      chain = { identity: {}, tail: Promise.resolve() };
      observationChains.set(key, chain);
    }
    const identity = chain.identity;
    const current = () => subscriptionCurrent() && observationChains.get(key)?.identity === identity &&
      capturedBindings.some((binding) => bindings.get(binding.controlSessionId) === binding);

    const reconcile = async () => {
      if (!current()) return;
      let runId = capturedRunId;
      // A queued operation is absent from the mirror until the server admits it.
      if (!runId) {
        try { await hydrateWorkspaceRuns(workspaceId, sessionId, current); } catch {}
        if (!current()) return;
        runId = coordinator.getActiveRunId({ workspaceId, sessionId });
      }
      if (!runId) return;
      const exactRunCurrent = () => current() && coordinator.getActiveRunId({ workspaceId, sessionId }) === runId;
      if (!exactRunCurrent()) return;
      try {
        let response;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!exactRunCurrent()) return;
          try {
            response = await observeRun({ workspaceId, sessionId, runId, status });
            break;
          } catch (error) {
            if (!exactRunCurrent() || attempt === 3 || !retryableObservationError(error)) throw error;
            await wait(retryDelay(attempt));
          }
        }
        if (!exactRunCurrent() || !isRecord(response)) return;
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
        if (isRecord(error) && error.serverCode === "run_mismatch" && exactRunCurrent()) {
          try { await hydrateWorkspaceRuns(workspaceId, sessionId, exactRunCurrent); } catch {}
        }
        // Keep the exact mirrored run. A later event/reconnect or server-side
        // authoritative status reconciliation can complete it safely.
      }
    };

    const task = hadChain ? chain.tail.then(reconcile) : reconcile();
    chain.tail = task.catch(() => undefined);
    const tail = chain.tail;
    void tail.then(() => {
      if (observationChains.get(key)?.identity === identity && observationChains.get(key)?.tail === tail) {
        observationChains.delete(key);
      }
    });
  }

  function createProjector() {
    return createRemoteSessionProjector({
      randomUUID,
      now,
      timers,
      coalesceMs,
      sequenceStore,
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

  /** @param {WorkspaceSubscription} subscription @param {boolean} ready */
  function settleWaiters(subscription, ready) {
    const waiters = [...subscription.waiters];
    subscription.waiters.clear();
    for (const resolve of waiters) resolve(ready);
  }

  /** @param {string} workspaceId */
  function workspaceNeeded(workspaceId) {
    return [...bindings.values()].some((binding) => binding.workspaceId === workspaceId) ||
      [...pendingBindings.values()].some((pending) => pending.binding.workspaceId === workspaceId);
  }

  /** @param {string} workspaceId @returns {WorkspaceSubscription | null} */
  function ensureSubscription(workspaceId) {
    if (stopped) return null;
    const existing = subscriptions.get(workspaceId);
    if (existing) return existing;
    const controller = new AbortController();
    const identity = {};
    const generation = lifetime;
    const subscription = { identity, controller, live: false, attempt: 0, waiters: new Set() };
    subscriptions.set(workspaceId, subscription);
    const current = () => !stopped && generation === lifetime && subscriptions.get(workspaceId)?.identity === identity;
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
        if (current() && sessionId && status) enqueueRunObservation(workspaceId, sessionId, status, current);
      };
    const onReconnectGap = async (reason) => {
        if (!current()) return;
        const wasLive = subscription.live;
        subscription.live = false;
        subscription.attempt += 1;
        if (!wasLive) return;
        projector.reconnectGap(workspaceId, reason);
      };
    void (async () => {
      let attempt = 0;
      while (current() && workspaceNeeded(workspaceId)) {
        try { logger.info?.("remote_session_subscription_start", { attempt: attempt + 1, bindingCount: [...bindings.values()].filter((binding) => binding.workspaceId === workspaceId).length }); } catch {}
        try {
          await sseClient.subscribe({
            workspaceId,
            signal: controller.signal,
            onConnected: async () => {
              if (!current()) return;
              const connectionAttempt = subscription.attempt;
              try {
                await hydrateWorkspaceRuns(workspaceId, null, () => current() && subscription.attempt === connectionAttempt);
              } catch (error) {
                throw error;
              }
              if (!current() || subscription.attempt !== connectionAttempt) return;
              subscription.live = true;
              settleWaiters(subscription, true);
            },
            onEvent,
            onReconnectGap,
          });
          if (!current()) return;
          throw Object.assign(new Error("subscription ended"), { code: "stream_ended" });
        } catch (error) {
          if (!current()) return;
          await onReconnectGap("sequence_gap");
          const code = isRecord(error) && typeof error.code === "string" ? error.code.slice(0, 64) : "unknown";
          const status = isRecord(error) && Number.isSafeInteger(error.status) ? Number(error.status) : undefined;
          const retryDelayMs = subscriptionRetryDelaysMs[Math.min(attempt, subscriptionRetryDelaysMs.length - 1)];
          try { logger.warn?.("remote_session_subscription_retry", { code, ...(status ? { status } : {}), attempt: attempt + 1, retryDelayMs }); } catch {}
          attempt += 1;
          await wait(retryDelayMs, controller.signal);
        }
      }
      if (current()) {
        settleWaiters(subscription, false);
        subscriptions.delete(workspaceId);
      }
    })();
    return subscription;
  }

  /** @param {string} workspaceId @param {() => boolean} current */
  function waitForLive(workspaceId, current) {
    const subscription = ensureSubscription(workspaceId);
    if (!subscription || !current()) return Promise.resolve(false);
    if (subscription.live) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (ready) => {
        if (settled) return;
        settled = true;
        if (timer !== null) timers.clearTimeout(timer);
        subscription.waiters.delete(finish);
        resolve(Boolean(ready && current() && subscription.live));
      };
      subscription.waiters.add(finish);
      timer = timers.setTimeout(() => finish(false), subscriptionReadinessTimeoutMs);
    });
  }

  /** @param {unknown} input @returns {Promise<boolean>} */
  async function bind(input) {
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
      return waitForLive(binding.workspaceId, () => {
        const current = bindings.get(binding.controlSessionId);
        return current === existing || (current?.payloadVersion === 2 && existing.payloadVersion === 1);
      });
    }
    const concurrent = pendingBindings.get(binding.controlSessionId);
    if (concurrent) {
      const candidate = concurrent.binding;
      if (candidate.deviceId !== binding.deviceId || candidate.workspaceId !== binding.workspaceId ||
          candidate.sessionId !== binding.sessionId || candidate.connectionGeneration !== binding.connectionGeneration) return false;
      return concurrent.promise;
    }
    const identity = {};
    let cancel = () => {};
    const cancelled = new Promise((resolve) => { cancel = () => resolve(false); });
    const pending = { identity, binding, promise: Promise.resolve(false), cancel };
    pendingBindings.set(binding.controlSessionId, pending);
    const promise = (async () => {
      const isCurrent = () => pendingBindings.get(binding.controlSessionId)?.identity === identity;
      const ready = await Promise.race([waitForLive(binding.workspaceId, isCurrent), cancelled]);
      if (!ready || !isCurrent()) return false;
      try {
        if (!projector.bind(binding)) return false;
      } catch {
        return false;
      }
      bindings.set(binding.controlSessionId, binding);
      return true;
    })();
    pending.promise = promise;
    void promise.finally(() => {
      if (pendingBindings.get(binding.controlSessionId)?.identity !== identity) return;
      pendingBindings.delete(binding.controlSessionId);
      if (!bindings.has(binding.controlSessionId) && !workspaceNeeded(binding.workspaceId)) {
        const subscription = subscriptions.get(binding.workspaceId);
        if (subscription) settleWaiters(subscription, false);
        subscription?.controller.abort();
        subscriptions.delete(binding.workspaceId);
      }
    });
    return promise;
  }

  /** @param {string} controlSessionId */
  function unbind(controlSessionId) {
    const binding = bindings.get(controlSessionId);
    const pending = pendingBindings.get(controlSessionId);
    if (!binding && !pending) return false;
    pending?.cancel();
    pendingBindings.delete(controlSessionId);
    if (!binding) {
      const workspaceId = pending.binding.workspaceId;
      if (!workspaceNeeded(workspaceId)) {
        const subscription = subscriptions.get(workspaceId);
        if (subscription) settleWaiters(subscription, false);
        subscription?.controller.abort();
        subscriptions.delete(workspaceId);
      }
      return true;
    }
    bindings.delete(controlSessionId);
    projector.unbind(controlSessionId);
    clearObservationChain(binding.workspaceId, binding.sessionId);
    if (![...bindings.values()].some((candidate) => candidate.workspaceId === binding.workspaceId)) {
      const subscription = subscriptions.get(binding.workspaceId);
      if (subscription) settleWaiters(subscription, false);
      subscription?.controller.abort();
      subscriptions.delete(binding.workspaceId);
    }
    return true;
  }

  function clear() {
    lifetime += 1;
    for (const pending of pendingBindings.values()) pending.cancel();
    pendingBindings.clear();
    for (const subscription of subscriptions.values()) {
      settleWaiters(subscription, false);
      subscription.controller.abort();
    }
    subscriptions.clear();
    observationChains.clear();
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

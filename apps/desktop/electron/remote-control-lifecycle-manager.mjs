import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

const ERROR_MESSAGES = Object.freeze({
  replacement_in_progress: "Device identity replacement is already in progress.",
  not_eligible: "Remote control is not eligible for device identity replacement.",
  stop_failed: "Remote control could not be stopped safely. Try again.",
  enrollment_failed: "A new remote-control device could not be registered. Request fresh authorization and try again.",
  enable_failed: "The new device was saved, but remote control could not be enabled. Try again.",
  startup_failed: "The new device was saved, but its connection could not be started. Try again.",
  cancelled: "Device identity replacement was cancelled because remote control was disabled.",
});
const STARTUP_WELCOME_TIMEOUT_MS = 15_000;
const REPLACEMENT_FAILURE_STAGES = new Set([
  "eligibility",
  "stop",
  "enrollment",
  "enable",
  "startup",
  "welcome",
  "pending_policy",
]);
const WELCOME_FAILURE_CODES = new Set([
  "welcome_aborted",
  "welcome_unavailable",
  "welcome_timeout",
  "welcome_connection_changed",
  "welcome_context_changed",
  "welcome_disabled",
  "invalid_welcome",
  "invalid_message",
  "transport_error",
  "transport_send_failed",
]);
const AGENT_FAILURE_CODES = new Set([
  "policy_version_unavailable",
  "policy_unavailable",
  "credentials_unavailable",
  "credentials_context_mismatch",
  "settings_disable_failed",
  "credentials_delete_failed",
  "device_disabled",
  "token_unavailable",
  "invalid_token",
  "transport_create_failed",
  "transport_error",
  "transport_send_failed",
  "transport_stale",
  "invalid_welcome",
  "invalid_message",
  "invalid_protocol",
  "encryption_negotiation_failed",
  "identity_replacement_failed",
]);

function safeError(code) {
  return Object.freeze({ code, message: ERROR_MESSAGES[code], retryable: code !== "not_eligible" });
}

function validGrant(input) {
  return input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === 2 && typeof input.grant === "string" &&
    input.grant.length >= 1 && input.grant.length <= 16_384 && input.grant.trim() === input.grant &&
    input.scope && typeof input.scope === "object" && !Array.isArray(input.scope) &&
    Object.keys(input.scope).length === 3 && ["controlPlaneBaseUrl", "userId", "organizationId"].every((key) =>
      typeof input.scope[key] === "string" && input.scope[key].length >= 1 && input.scope[key].length <= 512 && input.scope[key].trim() === input.scope[key]);
}

function isExplicitlyQuiescent(status) {
  return status?.locallyDisabled === true && status.connected === false &&
    status.activeControlSessionCount === 0 && status.remoteOperationCount === 0;
}

function canIgnorePendingCancellationFailure(error, beforeStopStatus, afterStopStatus) {
  return error instanceof ManagedRuntimeClientError && ["unavailable", "timeout"].includes(error.code) &&
    isExplicitlyQuiescent(beforeStopStatus) && isExplicitlyQuiescent(afterStopStatus);
}

function closeCode(value) {
  const match = /^transport_closed_(\d{3,4})(?:_|$)/.exec(typeof value === "string" ? value : "");
  if (!match) return null;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code >= 1000 && code <= 4999 ? code : null;
}

function stableAgentErrorCode(value) {
  if (closeCode(value) !== null) return "transport_closed";
  return AGENT_FAILURE_CODES.has(value) ? value : null;
}

function stableFailureCode(stage, cause) {
  if (cause?.code === "replacement_cancelled") return "replacement_cancelled";
  if (stage === "pending_policy" && cause instanceof ManagedRuntimeClientError) {
    return `pending_policy_${cause.code}`;
  }
  if (stage === "welcome") {
    if (closeCode(cause?.code) !== null) return "welcome_transport_closed";
    if (WELCOME_FAILURE_CODES.has(cause?.code)) return cause.code;
    return "welcome_failed";
  }
  return stage === "eligibility" ? "not_eligible"
    : stage === "stop" ? "stop_failed"
      : stage === "enrollment" ? "enrollment_failed"
        : stage === "enable" ? "enable_failed"
          : stage === "startup" ? "startup_initialize_failed"
            : "pending_policy_failed";
}

function failureSnapshot(stage, cause, agentStatus) {
  const normalizedStage = REPLACEMENT_FAILURE_STAGES.has(stage) ? stage : "startup";
  return Object.freeze({
    stage: normalizedStage,
    code: stableFailureCode(normalizedStage, cause),
    agentErrorCode: stableAgentErrorCode(agentStatus?.lastErrorCode),
    closeCode: closeCode(cause?.code) ?? closeCode(agentStatus?.lastErrorCode),
    lifecycleGeneration: Number.isSafeInteger(agentStatus?.lifecycleGeneration) ? agentStatus.lifecycleGeneration : 0,
    connectionGeneration: Number.isSafeInteger(agentStatus?.connectionGeneration) ? agentStatus.connectionGeneration : null,
  });
}

export function createRemoteControlLifecycleManager({
  getAgent,
  disableSettings,
  enableSettings,
  applyLocalEffects,
  cancelPendingWork,
  synchronizePendingPolicy,
  logger = null,
}) {
  if (typeof getAgent !== "function" || typeof disableSettings !== "function" ||
      typeof enableSettings !== "function" || typeof applyLocalEffects !== "function" ||
      typeof cancelPendingWork !== "function" || typeof synchronizePendingPolicy !== "function") {
    throw new TypeError("Remote-control lifecycle manager dependencies are invalid.");
  }

  let pending = false;
  let replacementStatus = "idle";
  let replacementErrorCode = null;
  let replacementFailure = null;
  let cancellationEpoch = 0;
  let replacementController = null;
  let replacementSettled = Promise.resolve();
  let settleReplacement = () => {};
  /** @type {Promise<unknown> | null} */
  let disablePending = null;

  function project(status) {
    return Object.freeze({
      ...status,
      replacementPending: pending,
      replacementStatus,
      replacementErrorCode,
      replacementFailure,
    });
  }

  function status() {
    return project(getAgent().status());
  }

  function assertMutationAvailable() {
    if (pending || disablePending) throw new Error(ERROR_MESSAGES.replacement_in_progress);
  }

  function assertCurrent(epoch, signal) {
    if (epoch !== cancellationEpoch || signal.aborted) {
      const error = Object.assign(new Error(ERROR_MESSAGES.cancelled), { code: "replacement_cancelled" });
      throw error;
    }
  }

  function disable() {
    if (disablePending) return disablePending;
    cancellationEpoch += 1;
    replacementController?.abort();
    const pendingReplacement = replacementSettled;
    const agent = getAgent();
    const operation = (async () => {
      const settings = await disableSettings();
      applyLocalEffects(settings);
      const beforeStopStatus = agent.status();
      const stopped = agent.stopAll();
      let cancelError;
      try { await cancelPendingWork(); } catch (error) { cancelError = error; }
      await stopped;
      if (cancelError && canIgnorePendingCancellationFailure(cancelError, beforeStopStatus, agent.status())) cancelError = undefined;
      await agent.refreshLocalSettings();
      await synchronizePendingPolicy();
      await pendingReplacement;
      if (cancelError) throw cancelError;
      return settings;
    })();
    let tracked;
    tracked = operation.finally(() => {
      if (disablePending === tracked) disablePending = null;
    });
    disablePending = tracked;
    return tracked;
  }

  async function cleanup(agent, { deleteIdentity }) {
    let settings;
    try { settings = await disableSettings(); } catch {}
    if (settings) {
      try { applyLocalEffects(settings); } catch {}
    }
    try { await agent.stopAll(); } catch {}
    if (deleteIdentity) {
      try { await agent.deleteCredential(); } catch {}
    }
    try { await agent.refreshLocalSettings(); } catch {}
    try { await synchronizePendingPolicy(); } catch {}
  }

  async function reregisterAndEnable(input) {
    if (pending || disablePending) {
      const error = safeError("replacement_in_progress");
      return Object.freeze({ ok: false, status: status(), error });
    }
    const agent = getAgent();
    const initialStatus = agent.status();
    if (!validGrant(input) || !initialStatus.enrollmentAuthorized || !initialStatus.locallyDisabled) {
      replacementStatus = "failed";
      replacementErrorCode = "not_eligible";
      replacementFailure = failureSnapshot("eligibility", null, initialStatus);
      const error = safeError("not_eligible");
      return Object.freeze({ ok: false, status: status(), error });
    }

    pending = true;
    replacementStatus = "idle";
    replacementErrorCode = null;
    replacementFailure = null;
    let stage = "stop";
    let identityReplacementStarted = false;
    const epoch = cancellationEpoch;
    const controller = new AbortController();
    replacementController = controller;
    replacementSettled = new Promise((resolve) => { settleReplacement = resolve; });
    try {
      assertCurrent(epoch, controller.signal);
      const disabled = await disableSettings();
      applyLocalEffects(disabled);
      const beforeStopStatus = agent.status();
      const stopped = agent.stopAll();
      let cancelError;
      try { await cancelPendingWork(); } catch (error) { cancelError = error; }
      await stopped;
      if (cancelError && !canIgnorePendingCancellationFailure(cancelError, beforeStopStatus, agent.status())) throw cancelError;
      await agent.refreshLocalSettings();
      await agent.drainOldOperations();
      assertCurrent(epoch, controller.signal);

      stage = "enrollment";
      identityReplacementStarted = true;
      await agent.replaceIdentity(input, { signal: controller.signal });
      assertCurrent(epoch, controller.signal);

      stage = "enable";
      const enabled = await enableSettings();
      assertCurrent(epoch, controller.signal);
      applyLocalEffects(enabled);

      stage = "startup";
      const started = await agent.refreshLocalSettings();
      assertCurrent(epoch, controller.signal);
      if (!started || !["connecting", "awaiting_welcome", "connected"].includes(started.state)) {
        throw new Error("Remote-control startup did not initialize.");
      }
      stage = "welcome";
      const connected = await agent.waitForWelcome({ timeoutMs: STARTUP_WELCOME_TIMEOUT_MS, signal: controller.signal });
      assertCurrent(epoch, controller.signal);
      if (!connected || connected.state !== "connected" || connected.connected !== true) {
        throw new Error("Remote-control startup did not receive a welcome.");
      }
      stage = "pending_policy";
      await synchronizePendingPolicy();
      assertCurrent(epoch, controller.signal);
      replacementStatus = "succeeded";
      replacementFailure = null;
      pending = false;
      return Object.freeze({ ok: true, status: project(agent.status()), error: null });
    } catch (cause) {
      const cancelled = cause?.code === "replacement_cancelled" || epoch !== cancellationEpoch || controller.signal.aborted;
      const code = cancelled ? "cancelled" : stage === "stop" ? "stop_failed"
        : stage === "enrollment" ? "enrollment_failed"
          : stage === "enable" ? "enable_failed"
            : "startup_failed";
      const failedStatus = agent.status();
      replacementFailure = failureSnapshot(stage, cause, failedStatus);
      try { logger?.warn?.("remote_control_replacement_failed", replacementFailure); } catch {}
      await cleanup(agent, {
        deleteIdentity: identityReplacementStarted && (!cancelled || stage !== "enrollment"),
      });
      replacementStatus = "failed";
      replacementErrorCode = code;
      const error = safeError(code);
      pending = false;
      return Object.freeze({ ok: false, status: project(agent.status()), error });
    } finally {
      if (replacementController === controller) replacementController = null;
      settleReplacement();
      settleReplacement = () => {};
      pending = false;
    }
  }

  return Object.freeze({ disable, reregisterAndEnable, assertMutationAvailable, status, project });
}

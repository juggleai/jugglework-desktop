const ERROR_MESSAGES = Object.freeze({
  replacement_in_progress: "Device identity replacement is already in progress.",
  not_eligible: "Remote control is not eligible for device identity replacement.",
  stop_failed: "Remote control could not be stopped safely. Try again.",
  enrollment_failed: "A new remote-control device could not be registered. Request fresh authorization and try again.",
  enable_failed: "The new device was saved, but remote control could not be enabled. Try again.",
  startup_failed: "The new device was saved, but its connection could not be started. Try again.",
  cancelled: "Device identity replacement was cancelled because remote control was disabled.",
});

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

export function createRemoteControlLifecycleManager({
  getAgent,
  disableSettings,
  enableSettings,
  applyLocalEffects,
  cancelPendingWork,
  synchronizePendingPolicy,
}) {
  if (typeof getAgent !== "function" || typeof disableSettings !== "function" ||
      typeof enableSettings !== "function" || typeof applyLocalEffects !== "function" ||
      typeof cancelPendingWork !== "function" || typeof synchronizePendingPolicy !== "function") {
    throw new TypeError("Remote-control lifecycle manager dependencies are invalid.");
  }

  let pending = false;
  let replacementStatus = "idle";
  let replacementErrorCode = null;
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
      const stopped = agent.stopAll();
      let cancelError;
      try { await cancelPendingWork(); } catch (error) { cancelError = error; }
      await stopped;
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
      const error = safeError("not_eligible");
      return Object.freeze({ ok: false, status: status(), error });
    }

    pending = true;
    replacementStatus = "idle";
    replacementErrorCode = null;
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
      const stopped = agent.stopAll();
      let cancelError;
      try { await cancelPendingWork(); } catch (error) { cancelError = error; }
      await stopped;
      if (cancelError) throw cancelError;
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
      await synchronizePendingPolicy();
      replacementStatus = "succeeded";
      pending = false;
      return Object.freeze({ ok: true, status: project(agent.status()), error: null });
    } catch (cause) {
      const cancelled = cause?.code === "replacement_cancelled" || epoch !== cancellationEpoch || controller.signal.aborted;
      const code = cancelled ? "cancelled" : stage === "stop" ? "stop_failed"
        : stage === "enrollment" ? "enrollment_failed"
          : stage === "enable" ? "enable_failed"
            : "startup_failed";
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

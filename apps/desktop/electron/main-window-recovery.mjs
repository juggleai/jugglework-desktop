const DEFAULT_RECOVERY_DELAY_MS = 15_000;
const DEFAULT_ATTEMPT_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Diagnose live renderer hangs; recover an exited renderer with a reload-loop guard.
 * @param {import("electron").BrowserWindow | any} window
 * @param {{
 *   beforeReload?: (input: {reason: string, attempt: number}) => Promise<void> | void,
 *   record?: (event: string, data?: Record<string, unknown>) => void,
 *   recoveryDelayMs?: number,
 *   attemptWindowMs?: number,
 *   maxAttempts?: number,
 *   now?: () => number,
 *   setTimeoutFn?: (callback: () => void, delay?: number) => any,
 *   clearTimeoutFn?: (timer: any) => void,
 * }} options
 */
export function installMainWindowRecovery(window, options = {}) {
  const {
    beforeReload = async () => {},
    record = () => {},
    recoveryDelayMs = DEFAULT_RECOVERY_DELAY_MS,
    attemptWindowMs = DEFAULT_ATTEMPT_WINDOW_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    now = Date.now,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = options;
  if (!window?.webContents) throw new Error("window.webContents is required");
  let disposed = false;
  let unresponsive = false;
  let recoveryTimer = null;
  let recoveryInFlight = false;
  let generation = 0;
  let attempts = [];

  const clearRecoveryTimer = () => {
    if (recoveryTimer !== null) clearTimeoutFn(recoveryTimer);
    recoveryTimer = null;
  };

  const context = () => ({
    windowId: window.id ?? null,
    pid: window.webContents.isDestroyed?.() ? null : window.webContents.getOSProcessId?.() ?? null,
  });

  const recover = async (reason) => {
    if (disposed || recoveryInFlight || window.isDestroyed?.() || window.webContents.isDestroyed?.()) return;
    // A live, unresponsive renderer may still hold unsaved state or a running
    // session. Only an observed renderer exit authorizes automatic reload.
    if (reason !== "renderer-gone" || !unresponsive) return;
    const startedGeneration = generation;
    const timestamp = now();
    attempts = attempts.filter((value) => timestamp - value < attemptWindowMs);
    if (attempts.length >= maxAttempts) {
      record("main.recovery.suppressed", { ...context(), reason, attempts: attempts.length });
      return;
    }
    attempts.push(timestamp);
    recoveryInFlight = true;
    record("main.recovery.started", { ...context(), reason, attempt: attempts.length });
    try {
      await beforeReload({ reason, attempt: attempts.length });
      if (!disposed && generation === startedGeneration && unresponsive && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) {
        window.webContents.reload();
        record("main.recovery.reload-requested", { ...context(), reason, attempt: attempts.length });
      }
    } catch {
      record("main.recovery.failed", {
        ...context(),
        reason,
        attempt: attempts.length,
      });
      if (!disposed && generation === startedGeneration && unresponsive && !window.isDestroyed?.() && !window.webContents.isDestroyed?.()) {
        // The renderer has already exited; a failed diagnostic callback must
        // not prevent its bounded recovery. Never restart the session runtime.
        try { window.webContents.reload(); }
        catch { record("main.recovery.reload-failed", { ...context(), reason }); }
      }
    } finally {
      recoveryInFlight = false;
    }
  };

  const scheduleRecovery = (reason, delay = recoveryDelayMs) => {
    clearRecoveryTimer();
    recoveryTimer = setTimeoutFn(() => {
      recoveryTimer = null;
      if (reason === "unresponsive") {
        if (unresponsive) record("main.recovery.deferred", { ...context(), reason: "live-renderer-state" });
        return;
      }
      void recover(reason);
    }, delay);
    recoveryTimer?.unref?.();
  };

  const onUnresponsive = () => {
    if (disposed || unresponsive) return;
    unresponsive = true;
    record("main.unresponsive", context());
    scheduleRecovery("unresponsive");
  };
  const onResponsive = () => {
    if (!unresponsive) return;
    unresponsive = false;
    generation += 1;
    clearRecoveryTimer();
    record("main.responsive", context());
  };
  const onRendererGone = (_event, details = {}) => {
    if (disposed) return;
    generation += 1;
    unresponsive = true;
    record("main.renderer-gone", {
      ...context(),
      reason: String(details.reason ?? "unknown").slice(0, 100),
      exitCode: Number.isFinite(details.exitCode) ? details.exitCode : null,
    });
    scheduleRecovery("renderer-gone", 0);
  };
  const onFinishedLoad = () => {
    if (!unresponsive) return;
    unresponsive = false;
    generation += 1;
    clearRecoveryTimer();
    record("main.recovery.loaded", context());
  };

  window.on("unresponsive", onUnresponsive);
  window.on("responsive", onResponsive);
  window.webContents.on("render-process-gone", onRendererGone);
  window.webContents.on("did-finish-load", onFinishedLoad);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearRecoveryTimer();
    window.removeListener("unresponsive", onUnresponsive);
    window.removeListener("responsive", onResponsive);
    window.webContents.removeListener("render-process-gone", onRendererGone);
    window.webContents.removeListener("did-finish-load", onFinishedLoad);
    window.removeListener("closed", dispose);
  };
  window.once("closed", dispose);

  return { dispose, recover };
}

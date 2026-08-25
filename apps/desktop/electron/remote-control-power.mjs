/**
 * Owns one Electron power-save blocker for all admitted remote-control runs.
 * The caller supplies only a count, so no session content crosses this seam.
 *
 * @param {{
 *   powerSaveBlocker: { start(type: "prevent-app-suspension"): number, stop(id: number): void },
 *   logger?: { warn?: (message: string) => void },
 * }} options
 */
export function createRemoteControlSleepController({ powerSaveBlocker, logger = {} }) {
  if (!powerSaveBlocker || typeof powerSaveBlocker.start !== "function" || typeof powerSaveBlocker.stop !== "function") {
    throw new TypeError("Remote-control sleep controller dependencies are invalid.");
  }

  let authorized = false;
  let preventSleepWhileWaiting = false;
  let activeRunCount = 0;
  let blockerId = null;
  let stopped = false;

  function release() {
    const id = blockerId;
    blockerId = null;
    if (id === null) return;
    try { powerSaveBlocker.stop(id); } catch { try { logger.warn?.("Remote-control sleep blocker could not be released."); } catch {} }
  }

  function reconcile() {
    if (stopped || !authorized || (activeRunCount === 0 && !preventSleepWhileWaiting)) {
      release();
      return;
    }
    if (blockerId !== null) return;
    try {
      const id = powerSaveBlocker.start("prevent-app-suspension");
      if (!Number.isSafeInteger(id) || id < 0) throw new TypeError("Invalid power-save blocker id.");
      blockerId = id;
    } catch {
      blockerId = null;
      try { logger.warn?.("Remote-control sleep blocker could not be started."); } catch {}
    }
  }

  function setAuthorized(value) {
    authorized = value === true;
    reconcile();
  }

  function setActiveRunCount(value) {
    activeRunCount = Number.isSafeInteger(value) && value > 0 ? value : 0;
    reconcile();
  }

  /**
   * 设置等待远程任务时的空闲休眠策略。
   * @param {boolean} value 是否在等待期间阻止应用挂起
   */
  function setPreventSleepWhileWaiting(value) {
    preventSleepWhileWaiting = value === true;
    reconcile();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    authorized = false;
    preventSleepWhileWaiting = false;
    activeRunCount = 0;
    release();
  }

  return Object.freeze({ setAuthorized, setActiveRunCount, setPreventSleepWhileWaiting, stop });
}

/**
 * Registers Electron powerMonitor handlers exactly once. Agent methods fence
 * transport synchronously before their returned promises are observed.
 *
 * @param {{
 *   powerMonitor: { on(event: "suspend" | "resume", listener: () => void): unknown, removeListener(event: "suspend" | "resume", listener: () => void): unknown },
 *   getAgent: () => { suspend?: () => unknown, resume?: () => unknown } | null,
 *   onResume?: () => unknown,
 *   logger?: { warn?: (message: string) => void },
 * }} options
 */
export function createRemoteControlPowerMonitorController({ powerMonitor, getAgent, onResume = () => {}, logger = {} }) {
  if (!powerMonitor || typeof powerMonitor.on !== "function" || typeof powerMonitor.removeListener !== "function" || typeof getAgent !== "function") {
    throw new TypeError("Remote-control power monitor dependencies are invalid.");
  }
  let started = false;

  function invoke(method) {
    try {
      Promise.resolve(getAgent()?.[method]?.()).catch(() => {
        try { logger.warn?.(`Remote-control ${method} handling failed.`); } catch {}
      });
    } catch {
      try { logger.warn?.(`Remote-control ${method} handling failed.`); } catch {}
    }
  }
  const onSuspend = () => invoke("suspend");
  const handleResume = () => {
    invoke("resume");
    try { Promise.resolve(onResume()).catch(() => {}); } catch {}
  };

  function start() {
    if (started) return;
    started = true;
    powerMonitor.on("suspend", onSuspend);
    powerMonitor.on("resume", handleResume);
  }

  function stop() {
    if (!started) return;
    started = false;
    powerMonitor.removeListener("suspend", onSuspend);
    powerMonitor.removeListener("resume", handleResume);
  }

  return Object.freeze({ start, stop });
}

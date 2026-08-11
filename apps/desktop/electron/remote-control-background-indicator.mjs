export const REMOTE_CONTROL_BACKGROUND_TOOLTIP = "JuggleWork remote control is running in the background.";

/**
 * @param {{
 *   createTray: () => { on(event: "click", listener: () => void): unknown, setToolTip(value: string): void, setContextMenu(menu: unknown): void, destroy(): void },
 *   buildMenu: (template: unknown[]) => unknown,
 *   restoreWindow: () => unknown,
 *   stopAll: () => unknown,
 *   logger?: { warn?: (message: string) => void },
 * }} options
 */
export function createRemoteControlBackgroundIndicator({ createTray, buildMenu, restoreWindow, stopAll, logger = {} }) {
  if (typeof createTray !== "function" || typeof buildMenu !== "function" || typeof restoreWindow !== "function" || typeof stopAll !== "function") {
    throw new TypeError("Remote-control background indicator dependencies are invalid.");
  }
  let tray = null;
  let stopped = false;

  function safeInvoke(action) {
    try { Promise.resolve(action()).catch(() => undefined); } catch {}
  }

  function disposeTray() {
    const current = tray;
    tray = null;
    if (!current) return;
    try { current.destroy(); } catch {}
  }

  function update(settings) {
    const enabled = !stopped && settings?.enabled === true && settings?.backgroundMode === true;
    if (!enabled) {
      disposeTray();
      return false;
    }
    if (tray) return true;
    let created = null;
    try {
      created = createTray();
      created.setToolTip(REMOTE_CONTROL_BACKGROUND_TOOLTIP);
      created.setContextMenu(buildMenu([
        { label: "Open JuggleWork", click: () => safeInvoke(restoreWindow) },
        { type: "separator" },
        { label: "Stop All", click: () => safeInvoke(stopAll) },
      ]));
      created.on("click", () => safeInvoke(restoreWindow));
      tray = created;
      return true;
    } catch {
      tray = null;
      try { created?.destroy(); } catch {}
      try { logger.warn?.("Remote-control background indicator is unavailable."); } catch {}
      return false;
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    disposeTray();
  }

  return Object.freeze({ update, active: () => tray !== null, stop });
}

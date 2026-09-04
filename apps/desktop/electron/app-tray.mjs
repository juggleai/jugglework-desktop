export const APP_TRAY_TOOLTIP = "JuggleWork";
export const REMOTE_CONTROL_BACKGROUND_TOOLTIP = "JuggleWork remote control is running in the background.";

/**
 * 常驻应用托盘指示器（macOS 状态栏 / Windows 系统托盘）。
 *
 * 应用启动后即创建托盘图标，作为主窗口被隐藏（关闭仅最小化）后的唯一可见入口：
 * - 单击托盘：恢复主窗口
 * - 右键菜单：打开 JuggleWork / 停止所有远程控制（仅后台模式开启时展示）/ 退出 JuggleWork
 *
 * @param {{
 *   createTray: () => { on(event: "click", listener: () => void): unknown, setToolTip(value: string): void, setContextMenu(menu: unknown): void, destroy(): void },
 *   buildMenu: (template: unknown[]) => unknown,
 *   restoreWindow: () => unknown,
 *   quitApp: () => unknown,
 *   logger?: { warn?: (message: string) => void },
 * }} options 依赖注入集合，createTray/buildMenu/restoreWindow/quitApp 均为必填
 * @returns 冻结的指示器对象：{ start, updateRemoteControl, active, stop }
 */
export function createAppTrayIndicator({ createTray, buildMenu, restoreWindow, quitApp, logger = {} }) {
  if (typeof createTray !== "function" || typeof buildMenu !== "function" || typeof restoreWindow !== "function" || typeof quitApp !== "function") {
    throw new TypeError("App tray indicator dependencies are invalid.");
  }
  let tray = null;
  let stopped = false;
  // 非空表示远程控制后台模式开启，菜单中需要追加 "Stop All" 项并切换 tooltip。
  let remoteControlMenu = null;

  function safeInvoke(action) {
    try { Promise.resolve(action()).catch(() => undefined); } catch {}
  }

  function disposeTray() {
    const current = tray;
    tray = null;
    if (!current) return;
    try { current.destroy(); } catch {}
  }

  function currentTooltip() {
    return remoteControlMenu ? REMOTE_CONTROL_BACKGROUND_TOOLTIP : APP_TRAY_TOOLTIP;
  }

  function buildTrayMenu() {
    const template = [
      { label: "Open JuggleWork", click: () => safeInvoke(restoreWindow) },
      ...(remoteControlMenu ? [
        { type: "separator" },
        { label: "Stop All", click: () => safeInvoke(remoteControlMenu.stopAll) },
      ] : []),
      { type: "separator" },
      { label: "Quit JuggleWork", click: () => safeInvoke(quitApp) },
    ];
    return buildMenu(template);
  }

  /**
   * 创建常驻托盘图标（应用启动时调用一次，幂等）。
   *
   * TIPS: fail-closed —— 托盘创建失败时返回 false，调用方必须放弃"关闭仅隐藏"
   * 与隐藏启动等后台续跑行为，否则用户会得到一个无任何可见入口的进程。
   *
   * @returns {boolean} 托盘是否处于激活状态
   */
  function start() {
    if (stopped) return false;
    if (tray) return true;
    let created = null;
    try {
      created = createTray();
      created.setToolTip(currentTooltip());
      created.setContextMenu(buildTrayMenu());
      created.on("click", () => safeInvoke(restoreWindow));
      tray = created;
      return true;
    } catch (error) {
      tray = null;
      try { created?.destroy(); } catch {}
      const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown";
      try { logger.warn?.(`App tray indicator is unavailable: ${reason}`); } catch {}
      return false;
    }
  }

  /**
   * 根据远程控制后台模式开关刷新托盘菜单与提示文案（托盘已存在时热更新，不重建图标）。
   *
   * @param {{ backgroundRequested?: boolean, stopAll?: () => unknown }} [state] backgroundRequested 为 true 且提供 stopAll 时展示 "Stop All" 菜单项
   */
  function updateRemoteControl({ backgroundRequested = false, stopAll } = {}) {
    remoteControlMenu = backgroundRequested === true && typeof stopAll === "function"
      ? { stopAll }
      : null;
    if (!tray) return;
    try {
      tray.setToolTip(currentTooltip());
      tray.setContextMenu(buildTrayMenu());
    } catch {}
  }

  /**
   * 应用退出前销毁托盘；销毁后指示器永久停用，start 不再重建。
   */
  function stop() {
    if (stopped) return;
    stopped = true;
    disposeTray();
  }

  return Object.freeze({ start, updateRemoteControl, active: () => tray !== null, stop });
}

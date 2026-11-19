import { randomUUID } from "node:crypto";

/**
 * Native-action requests from the local server are executed by the main
 * window's renderer, which holds the sign-in session. The renderer verifies the
 * request's frozen identity against its live session before touching any API.
 * @param {{ getWindow: () => any, timeoutMs?: number }} options main window and timeout
 */
export function createNativeActionsApi({ getWindow, timeoutMs = 40_000 }) {
  const pending = new Map();

  /** Sends one request and resolves with the renderer's result. */
  function request(input) {
    const window = getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(Object.assign(new Error("桌面主窗口不可用"), { code: "native_actions_unavailable" }));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(Object.assign(new Error("原生能力请求超时"), { code: "native_action_timeout" }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer });
      window.webContents.send("jugglework:native-actions:request", { requestId, ...input });
    });
  }

  /** Accepts responses only from the main window's main frame. */
  function registerIpc(ipcMain) {
    ipcMain.on("jugglework:native-actions:response", (event, message) => {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      const task = pending.get(message?.requestId);
      if (!task) return;
      pending.delete(message.requestId);
      clearTimeout(task.timer);
      if (message.ok === true) task.resolve(message.result);
      else task.reject(Object.assign(new Error(String(message.error ?? "原生能力请求失败").slice(0, 300)), { code: typeof message.code === "string" ? message.code.slice(0, 64) : "native_action_failed" }));
    });
  }

  return { request, registerIpc };
}

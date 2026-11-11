import { randomUUID } from "node:crypto";

/**
 * 本地 Server 的云文档请求经主窗口渲染进程执行：渲染进程持有组织登录态，
 * 负责保证目标组织的 product 视图在线，再由主进程把请求交给该视图的受管会话。
 * @param {{ getWindow: () => any, timeoutMs?: number }} options 主窗口与超时
 */
export function createCloudDocsApi({ getWindow, timeoutMs = 330_000 }) {
  const pending = new Map();

  /** 发起一次云文档请求，返回 Docs 的 HTTP 状态与响应体。 */
  function request(input) {
    const window = getWindow();
    if (!window || window.isDestroyed()) return Promise.reject(new Error("桌面主窗口不可用"));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("云文档请求超时"));
      }, timeoutMs);
      timer.unref?.();
      pending.set(requestId, { resolve, reject, timer });
      window.webContents.send("jugglework:cloud-docs:api-request", { requestId, ...input });
    });
  }

  /** 只接受主窗口主框架的响应。 */
  function registerIpc(ipcMain) {
    ipcMain.on("jugglework:cloud-docs:api-response", (event, message) => {
      const window = getWindow();
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
      const task = pending.get(message?.requestId);
      if (!task) return;
      pending.delete(message.requestId);
      clearTimeout(task.timer);
      if (message.ok === true) task.resolve({ status: Number(message.status) || 200, body: message.body });
      else task.reject(new Error(String(message.error ?? "云文档请求失败").slice(0, 300)));
    });
  }

  return { request, registerIpc };
}

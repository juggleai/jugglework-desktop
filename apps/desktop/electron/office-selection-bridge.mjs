import { randomUUID } from "node:crypto";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

/**
 * 将选区通道的已知失败转换为本地文案，不向编辑页转发任意服务端错误正文。
 * @param {unknown} error 本机运行时客户端捕获的失败
 */
export function officeSelectionFailure(error) {
  if (!(error instanceof ManagedRuntimeClientError)) throw error;
  const messages = {
    office_selection_proof_unavailable: "暂时无法完整核对所选内容，请选择较短的普通正文或文本框后重试",
    office_selection_stale: "选区已变化，请重新选择内容",
    office_selection_capacity: "选区记录过多，请先移除不再使用的选区后重试",
    office_wrong_document: "选区不属于当前聊天，请在所属聊天中重新打开文件",
    office_page_invalidated: "文件页面已变化，请重新打开文件后选择",
    office_not_ready: "文档尚未就绪，请载入完成后重新选择",
    invalid_office_selection: "当前选区暂不支持，请重新选择普通文字或单元格",
  };
  const message = error.serverCode && Object.hasOwn(messages, error.serverCode) ? messages[error.serverCode] : (error.code === "timeout"
    ? "选区读取超时，请稍后重新选择"
    : "暂时无法读取文档选区，请稍后重试");
  return { error: { message } };
}

/**
 * 原生页面与所属聊天草稿的有限请求桥；回复必须来自请求时绑定的主窗口。
 * @param {{ipcMain: Electron.IpcMain, getWindow: () => Electron.BrowserWindow | null}} options 主窗口所有者
 */
export function createOfficeSelectionBridge({ ipcMain, getWindow }) {
  const pending = new Map();
  let generation = 0;
  ipcMain.on("jugglework:office:composer-reply", (event, message) => {
    const task = pending.get(message?.requestId);
    if (!task || event.sender !== task.sender) return;
    pending.delete(message.requestId);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(String(message.error)));
    else task.resolve({ ...message.result, bridgeGeneration: task.generation });
  });
  return {
    /** 只发送 Office 草稿动作，不向原生页面暴露任意桌面命令。 */
    request(input) {
      if (input.action === "append" && input.bridgeGeneration !== generation) return Promise.reject(new Error("聊天页面已变化，请重新选择"));
      const window = getWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.reject(new Error("请先打开所属聊天窗口"));
      const sender = window.webContents;
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("聊天窗口未响应，请打开所属聊天后重试"));
        }, input.action === "guard" ? 120_000 : 15_000);
        pending.set(requestId, { sender, timer, resolve, reject, generation });
        sender.send("jugglework:office:composer-request", { ...input, requestId });
      });
    },
    /** 主窗口导航或退出时取消旧请求，迟到回复不能作用于新页面。 */
    cancel() {
      generation++;
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("聊天窗口已变化，请重试")); }
      pending.clear();
    },
  };
}

import { randomUUID } from "node:crypto";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

/**
 * 将选区通道的已知失败转换为本地文案，不向编辑页转发任意服务端错误正文。
 * @param {unknown} error 本机运行时客户端捕获的失败
 */
export function officeSelectionFailure(error) {
  if (!(error instanceof ManagedRuntimeClientError)) throw error;
  const messages = {
    office_selection_slide_picture_selected: "当前选区包含图片，不是整页选择；请点击左侧幻灯片缩略图选择整页。图片内文字暂不支持直接改写",
    office_selection_slide_objects_unsupported: "所选页包含暂不支持完整核对的对象或合并表格，请选择普通文本框编辑；这些对象尚未修改",
    office_selection_review_required: "存在尚未核对的修改，请检查文档并重新选择内容",
    office_selection_save_blocked: "文档选区操作仍在运行或尚未核对，请结束后重新选择",
    office_selection_slide_pages_unsupported: "整页编辑目前一次支持一页，请只选择一张幻灯片",
    office_selection_proof_unavailable: "选区内容尚未读取完整，请等待文档加载完成后重新选择；当前内容尚未修改",
    office_selection_content_limit: "当前内容超过选区编辑的处理范围，请缩小选择或分段处理；当前内容尚未修改",
    office_selection_doc_structure_unsupported: "Word 选区暂不支持直接修改表格、图片或分页结构，请选择正文文字",
    office_selection_sheet_partial_merge: "请完整选择合并单元格后重试，不能只修改合并区域的一部分",
    office_selection_sheet_dimension_unsupported: "当前工作表暂不支持整行列删除，请选择具体单元格编辑；公式和合并内容保持不变",
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
 * 原生页面与所属聊天草稿的有限请求桥；回复必须来自请求时绑定的宿主窗口。
 * @param {{ipcMain: Electron.IpcMain, getWindow: (input: any) => Electron.BrowserWindow | null}} options 草稿宿主所有者
 */
export function createOfficeSelectionBridge({ ipcMain, getWindow }) {
  const pending = new Map();
  let sequence = 0, generation = 0;
  let hostGenerations = new WeakMap();
  ipcMain.on("jugglework:office:composer-reply", (event, message) => {
    const task = pending.get(message?.requestId);
    if (!task || event.sender !== task.sender || event.senderFrame !== event.sender.mainFrame) return;
    pending.delete(message.requestId);
    clearTimeout(task.timer);
    if (message.error) task.reject(new Error(String(message.error)));
    else task.resolve({ ...message.result, bridgeGeneration: task.generation });
  });
  return {
    /** 只发送 Office 草稿动作，不向原生页面暴露任意桌面命令。 */
    request(input) {
      const window = getWindow(input);
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.reject(new Error("请先打开所属聊天窗口"));
      const sender = window.webContents;
      const hostGeneration = hostGenerations.get(sender) ?? generation;
      if (input.action === "append" && input.bridgeGeneration !== hostGeneration) return Promise.reject(new Error("聊天页面已变化，请重新选择"));
      return new Promise((resolve, reject) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error("聊天窗口未响应，请打开所属聊天后重试"));
        }, input.action === "guard" ? 120_000 : 15_000);
        pending.set(requestId, { sender, timer, resolve, reject, generation: hostGeneration });
        sender.send("jugglework:office:composer-request", { ...input, requestId });
      });
    },
    /**
     * 导航时只取消对应宿主的旧请求；未指定宿主时取消所有请求。
     * @param {Electron.WebContents} [sender] 发生导航或销毁的窗口页面
     */
    cancel(sender) {
      // TIPS: 两个宿主有独立草稿，主窗口导航不能使文件窗口的准备结果失效。
      if (sender) hostGenerations.set(sender, ++sequence);
      else { generation = ++sequence; hostGenerations = new WeakMap(); }
      for (const [id, task] of pending) {
        if (sender && task.sender !== sender) continue;
        clearTimeout(task.timer);
        task.reject(new Error("聊天窗口已变化，请重试"));
        pending.delete(id);
      }
    },
  };
}

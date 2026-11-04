import { contextBridge, ipcRenderer } from "electron";

/** 订阅窗口事件并返回卸载函数。 */
const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

let composerHandler;
const earlyComposerRequests = [];
/** 初始化期间保留只读准备/检查请求；追加或清理不能在超时后迟到执行。 */
async function dispatchComposerRequest(input) {
  if (!composerHandler) {
    if (["prepare", "guard"].includes(input?.action) && earlyComposerRequests.length < 16) earlyComposerRequests.push(input);
    else ipcRenderer.send("jugglework:office:composer-reply", { requestId: input?.requestId, error: "文件草稿尚未就绪，请稍后重试" });
    return;
  }
  try {
    const result = await composerHandler(input);
    ipcRenderer.send("jugglework:office:composer-reply", { requestId: input.requestId, result });
  } catch (error) {
    ipcRenderer.send("jugglework:office:composer-reply", { requestId: input.requestId, error: error instanceof Error ? error.message : String(error) });
  }
}
ipcRenderer.on("jugglework:office:composer-request", (_event, input) => { void dispatchComposerRequest(input); });

/** 订阅 ID 不进入页面 API；处理 invoke 返回之前的事件及提前卸载。 */
function subscribeSessionEvents(listener) {
  let id;
  let stopped = false;
  const early = [];
  const channel = "jugglework:file-window:session-event";
  const handler = (_event, payload) => {
    if (stopped) return;
    if (!id) { if (early.length < 32) early.push(payload); return; }
    if (payload?.id === id) listener(payload.event);
  };
  ipcRenderer.on(channel, handler);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    early.length = 0;
    ipcRenderer.removeListener(channel, handler);
    if (id) void ipcRenderer.invoke("jugglework:file-window:session-unsubscribe", id).catch(() => {});
  };
  void ipcRenderer.invoke("jugglework:file-window:session-subscribe").then((value) => {
    id = value;
    if (stopped) { void ipcRenderer.invoke("jugglework:file-window:session-unsubscribe", id).catch(() => {}); return; }
    for (const payload of early.splice(0)) if (payload?.id === id) listener(payload.event);
  }).catch(stop);
  return stop;
}

// TIPS: 文件窗口只获得文件、Office 与本地请求能力，不启动主应用状态和第二份 Runtime。
contextBridge.exposeInMainWorld("__JUGGLEWORK_ELECTRON__", {
  platform: process.platform,
  invokeDesktop(command, ...args) {
    // Shared UI modules synchronize main-window preferences during import.
    // File windows own neither the application menu nor global theme; these
    // notifications must be harmless without granting broader desktop IPC.
    if (command === "__setNativeTheme" || command === "__setApplicationMenuVisible") return Promise.resolve();
    if (command !== "__fetch") throw new Error("文件窗口不支持此操作");
    return ipcRenderer.invoke("jugglework:desktop", command, ...args);
  },
  office: {
    /** 文件目标切换与主窗口共用草稿选区确认。 */
    confirmFileSwitch: (input) => ipcRenderer.invoke("jugglework:office:confirm-file-switch", input),
    /** 只释放当前窗口收到的真实选区引用。 */
    releaseReferences: (input) => ipcRenderer.invoke("jugglework:office:release-selections", input),
    /** 在同一原生模型中定位选区。 */
    revealSelection: (input) => ipcRenderer.invoke("jugglework:office:reveal-selection", input),
    /** 处理所属文件窗口草稿动作，不通过主窗口中转本地草稿。 */
    onComposerRequest(callback) {
      composerHandler = callback;
      for (const input of earlyComposerRequests.splice(0)) void dispatchComposerRequest(input);
      return () => { if (composerHandler === callback) composerHandler = undefined; };
    },
    /** 读取两种宿主共用的文档资源状态。 */
    resources: (documentId) => ipcRenderer.invoke("jugglework:office:resources", { documentId }),
    /** 主动获取当前页面缺失字体，下次打开生效。 */
    retryFonts: (documentId) => ipcRenderer.invoke("jugglework:office:font-retry", documentId),
    /** 订阅资源变化并提供清理函数。 */
    onResourcesChanged: (callback) => listen("jugglework:office:resources-changed", callback),
    /** 原生确认丢弃未保存内容后恢复故障文档，取消返回 null。 */
    recover: (workspaceId, documentId) => ipcRenderer.invoke("jugglework:office:recover", { workspaceId, documentId }),
    /** 同步文档故障及已保存版本恢复。 */
    onDocumentChanged: (callback) => listen("jugglework:office:document", callback),
    /** 为另一处文件视图返回同一存活编辑页面的当前内容。 */
    snapshot: (id) => ipcRenderer.invoke("jugglework:office:snapshot", id),
    /** 显示已经登记的文档页面。 */
    show: (input) => ipcRenderer.invoke("jugglework:office:show", input),
    /** 仅隐藏当前宿主拥有的页面。 */
    hide: (id, snapshot = false) =>
      ipcRenderer.invoke("jugglework:office:hide", id, snapshot),
    /** 关闭前询问保存决定。 */
    close: (workspaceId, documentId) =>
      ipcRenderer.invoke("jugglework:office:close", {
        workspaceId,
        documentId,
      }),
    /** 释放已关闭文档的页面。 */
    destroy: (id) => ipcRenderer.invoke("jugglework:office:destroy", id),
    /** 接收快捷键关闭事件。 */
    onClosed: (callback) => listen("jugglework:office:closed", callback),
    /** 宿主恢复显示后重新确认当前文件区域，不沿用旧坐标。 */
    onLayoutInvalidated: (callback) => listen("jugglework:office:layout-invalidated", callback),
    /** 接收存活页面迁移后的宿主位置。 */
    onLocation: (callback) => listen("jugglework:office:location", callback),
  },
  fileEditor: {
    /** 查询共享草稿及保存结果。 */
    state: (input) => ipcRenderer.invoke("jugglework:file-editor:state", input),
    /** 将单元格或文本修改同步到同一文件的其他视图。 */
    update: (input, draft) => ipcRenderer.invoke("jugglework:file-editor:update", input, draft),
    /** 保存共享草稿，失败保留内容。 */
    save: (input) => ipcRenderer.invoke("jugglework:file-editor:save", input),
    /** 原生文件操作前先保存或取消。 */
    prepare: (input) => ipcRenderer.invoke("jugglework:file-editor:prepare", input),
    /** 关闭前处理共享草稿。 */
    close: (input) => ipcRenderer.invoke("jugglework:file-editor:close", input),
    /** 同步外部应用接管标记。 */
    external: (input, external) => ipcRenderer.invoke("jugglework:file-editor:external", input, external),
    /** 监听同一文件的草稿与保存更新。 */
    onChanged(callback) {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("jugglework:file-editor:changed", handler);
      return () => ipcRenderer.removeListener("jugglework:file-editor:changed", handler);
    },
  },
  fileWindow: {
    subscribeSessionEvents,
    /** 确认本机文件窗口能力已经注册。 */
    available: () =>
      ipcRenderer.invoke("jugglework:file-window:available").catch(() => false),
    /** 打开所属聊天的文件。 */
    open: (input) => ipcRenderer.invoke("jugglework:file-window:open", input),
    /** 读取当前窗口状态及已有本机连接。 */
    state: () => ipcRenderer.invoke("jugglework:file-window:state"),
    /** 由主进程选择工作区内的 Word 或 PowerPoint 目标并创建。 */
    create: (input) => ipcRenderer.invoke("jugglework:file-window:create", input),
    /** 执行原生文件动作。 */
    action: (action, path) =>
      ipcRenderer.invoke("jugglework:file-window:action", action, path),
    /** 接收标签与最近文件变化。 */
    onChanged: (callback) => listen("jugglework:file-window:changed", callback),
  },
});

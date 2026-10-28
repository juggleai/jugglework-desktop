import { contextBridge, ipcRenderer } from "electron";

/** 订阅窗口事件并返回卸载函数。 */
const listen = (channel, callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

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

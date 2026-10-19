import { contextBridge, ipcRenderer, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "jugglework:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "jugglework:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "jugglework:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "jugglework:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "jugglework:native-menu:zoom";
const REMOTE_CONTROL_POLICY_RECOVERY_EVENT = "jugglework:remote-control:policy-recovery";
const JUGGLECHAT_SKILL_INVOKE_CHANNEL = "jugglework:jugglechat:skill-invoke";
const JUGGLECHAT_SKILL_REPLY_CHANNEL = "jugglework:jugglechat:skill-reply";

let activeJuggleChatSkillHandler = null;

function setJuggleChatSkillEvent(callback) {
  if (activeJuggleChatSkillHandler) {
    ipcRenderer.removeListener(JUGGLECHAT_SKILL_INVOKE_CHANNEL, activeJuggleChatSkillHandler);
    activeJuggleChatSkillHandler = null;
  }
  if (typeof callback !== "function") return () => {};

  const handler = async (_event, payload) => {
    const requestId = payload?.requestId;
    if (!requestId) return;

    let envelope;
    try {
      envelope = await callback(payload);
      if (!envelope || typeof envelope !== "object") {
        envelope = {
          ok: false,
          error: { code: "INVALID_ENVELOPE", message: "callback must return { ok, data | error }" },
        };
      }
    } catch (error) {
      envelope = {
        ok: false,
        error: {
          code: "CB_REJECTED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    ipcRenderer.send(JUGGLECHAT_SKILL_REPLY_CHANNEL, { requestId, ...envelope });
  };

  activeJuggleChatSkillHandler = handler;
  ipcRenderer.on(JUGGLECHAT_SKILL_INVOKE_CHANNEL, handler);
  return () => {
    if (activeJuggleChatSkillHandler !== handler) return;
    ipcRenderer.removeListener(JUGGLECHAT_SKILL_INVOKE_CHANNEL, handler);
    activeJuggleChatSkillHandler = null;
  };
}

function normalizePlatform(value) {
  if (value === "darwin" || value === "linux") return value;
  if (value === "win32") return "windows";
  return "linux";
}

function applyShellDocumentMarkers() {
  try {
    const root = document?.documentElement;
    if (!root) return false;

    root.dataset.juggleworkShell = "electron";
    root.classList.add("jugglework-electron");
    if (process.platform === "darwin") {
      root.classList.add("jugglework-platform-mac");
    } else if (process.platform === "win32") {
      root.classList.add("jugglework-platform-windows");
    } else if (process.platform === "linux") {
      root.classList.add("jugglework-platform-linux");
    }
    return true;
  } catch {
    return false;
  }
}

function notifyMenuOverlayDismiss() {
  ipcRenderer.send("jugglework:menu-overlay:dismiss");
}

function installMenuOverlayDismissListeners() {
  try {
    const target = window;
    target.addEventListener("pointerdown", notifyMenuOverlayDismiss, { capture: true });
    target.addEventListener("wheel", notifyMenuOverlayDismiss, { capture: true, passive: true });
    target.addEventListener("keydown", notifyMenuOverlayDismiss, { capture: true });
    return true;
  } catch {
    return false;
  }
}

let desktopBootstrap = null;
try {
  desktopBootstrap = ipcRenderer.sendSync("jugglework:desktop-bootstrap-sync");
} catch {
  desktopBootstrap = null;
}

contextBridge.exposeInMainWorld("__JUGGLEWORK_ELECTRON__", {
  invokeDesktop(command, ...args) {
    return ipcRenderer.invoke("jugglework:desktop", command, ...args);
  },
  shell: {
    openExternal(url) {
      return ipcRenderer.invoke("jugglework:shell:openExternal", url);
    },
    relaunch() {
      return ipcRenderer.invoke("jugglework:shell:relaunch");
    },
  },
  system: {
    getArchitectureInfo() {
      return ipcRenderer.invoke("jugglework:system:architecture");
    },
    getMicrophoneStatus() {
      return ipcRenderer.invoke("jugglework:system:microphoneStatus");
    },
    askMicrophoneAccess() {
      return ipcRenderer.invoke("jugglework:system:askMicrophoneAccess");
    },
  },
  migration: {
    readSnapshot() {
      return ipcRenderer.invoke("jugglework:migration:read");
    },
    ackSnapshot() {
      return ipcRenderer.invoke("jugglework:migration:ack");
    },
  },
  brandIcon: {
    apply(url) {
      return ipcRenderer.invoke("jugglework:desktop", "__applyBrandIcon", url ?? null);
    },
    getState() {
      return ipcRenderer.invoke("jugglework:desktop", "__getBrandIconState");
    },
  },
  dev: {
    evalRelaunch() {
      return ipcRenderer.invoke("jugglework:desktop", "__evalRelaunch");
    },
  },
  nuke: {
    preview(options) {
      return ipcRenderer.invoke("jugglework:desktop", "nukeJuggleWorkAndOpencodeConfigPreview", options);
    },
    execute(options) {
      return ipcRenderer.invoke("jugglework:desktop", "nukeJuggleWorkAndOpencodeConfigAndExit", options);
    },
  },
  updater: {
    getChannel() {
      return ipcRenderer.invoke("jugglework:updater:getChannel");
    },
    setChannel(channel) {
      return ipcRenderer.invoke("jugglework:updater:setChannel", channel);
    },
    check(channel, targetVersion) {
      return ipcRenderer.invoke("jugglework:updater:check", channel, targetVersion);
    },
    download(updateId) {
      if (typeof updateId !== "string" || !updateId.trim()) {
        return Promise.resolve({ ok: false, reason: "A non-empty updateId is required.", code: "missing-update-id" });
      }
      return ipcRenderer.invoke("jugglework:updater:download", updateId);
    },
    installAndRestart(updateId) {
      if (typeof updateId !== "string" || !updateId.trim()) {
        return Promise.resolve({ ok: false, reason: "A non-empty updateId is required.", code: "missing-update-id" });
      }
      return ipcRenderer.invoke("jugglework:updater:installAndRestart", updateId);
    },
    /** Subscribe to incremental download progress from electron-updater. */
    onDownloadProgress(callback) {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("jugglework:updater:download-progress", handler);
      return () => {
        ipcRenderer.removeListener("jugglework:updater:download-progress", handler);
      };
    },
  },
  office: {
    /** 文件目标变化前核对所属聊天草稿；目标准备失败不清理选区。 */
    confirmFileSwitch: (input) => ipcRenderer.invoke("jugglework:office:confirm-file-switch", input),
    /** 仅移除未发送引用登记，已接收和排队任务不随草稿清理。 */
    releaseReferences: (input) => ipcRenderer.invoke("jugglework:office:release-selections", input),
    /** 由主窗口处理所属聊天草稿的有限请求，并把错误回传至原请求。 */
    onComposerRequest(callback) {
      const handler = async (_event, input) => {
        try {
          const result = await callback(input);
          ipcRenderer.send("jugglework:office:composer-reply", { requestId: input.requestId, result });
        } catch (error) {
          ipcRenderer.send("jugglework:office:composer-reply", { requestId: input.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      };
      ipcRenderer.on("jugglework:office:composer-request", handler);
      return () => ipcRenderer.removeListener("jugglework:office:composer-request", handler);
    },
    /** 在已核对的文档中定位固定草稿选区。 */
    revealSelection: (input) => ipcRenderer.invoke("jugglework:office:reveal-selection", input),
    /** 读取当前文档的字体及必需资源状态。 */
    resources: (documentId) => ipcRenderer.invoke("jugglework:office:resources", { documentId }),
    /** 预取当前页面缺失字体，下次打开生效，不重载编辑模型。 */
    retryFonts: (documentId) => ipcRenderer.invoke("jugglework:office:font-retry", documentId),
    /** 订阅字体及必需资源状态变更，返回取消订阅函数。 */
    onResourcesChanged(callback) {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on("jugglework:office:resources-changed", handler);
      return () => ipcRenderer.removeListener("jugglework:office:resources-changed", handler);
    },
    /** 原生确认丢弃未保存内容后恢复故障文档，取消返回 null。 */
    recover: (workspaceId, documentId) => ipcRenderer.invoke("jugglework:office:recover", { workspaceId, documentId }),
    /** 同步文档故障及已保存版本恢复。 */
    onDocumentChanged(callback) {
      const handler = (_event, document) => callback(document);
      ipcRenderer.on("jugglework:office:document", handler);
      return () => ipcRenderer.removeListener("jugglework:office:document", handler);
    },
    /** 为另一处文件视图返回同一存活编辑页面的当前内容。 */
    snapshot: (id) => ipcRenderer.invoke("jugglework:office:snapshot", id),
    /** 显示已绑定文档的原生编辑页面并更新宿主区域。 */
    show(input) { return ipcRenderer.invoke("jugglework:office:show", input); },
    /** 隐藏页面并保留文档模型与撤销记录。 */
    hide(documentId, snapshot = false) { return ipcRenderer.invoke("jugglework:office:hide", documentId, snapshot); },
    /** 根据用户保存、放弃或取消的决定关闭文档。 */
    close(workspaceId, documentId) { return ipcRenderer.invoke("jugglework:office:close", { workspaceId, documentId }); },
    /** 文档已释放或转入外部编辑后销毁原生页面。 */
    destroy(documentId) { return ipcRenderer.invoke("jugglework:office:destroy", documentId); },
    /** 监听原生快捷键关闭文档，供对应聊天移除文件标签。 */
    onClosed(callback) {
      const handler = (_event, input) => callback(input);
      ipcRenderer.on("jugglework:office:closed", handler);
      return () => ipcRenderer.removeListener("jugglework:office:closed", handler);
    },
    /** 宿主恢复显示后重新确认当前文件面板区域，不沿用旧坐标。 */
    onLayoutInvalidated(callback) {
      const handler = () => callback();
      ipcRenderer.on("jugglework:office:layout-invalidated", handler);
      return () => ipcRenderer.removeListener("jugglework:office:layout-invalidated", handler);
    },
    /** 监听存活页面在主面板和独立窗口之间的迁移。 */
    onLocation(callback) {
      const handler = (_event, input) => callback(input);
      ipcRenderer.on("jugglework:office:location", handler);
      return () => ipcRenderer.removeListener("jugglework:office:location", handler);
    },
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
    /** 旧主进程缺少入口时返回不可用，不把底层 IPC 错误暴露给用户。 */
    available: () => ipcRenderer.invoke("jugglework:file-window:available").catch(() => false),
    /** 打开或激活所属聊天的文件窗口。 */
    open: (input) => ipcRenderer.invoke("jugglework:file-window:open", input),
    /** 主窗口无需读取子窗口状态。 */
    state: () => ipcRenderer.invoke("jugglework:file-window:state"),
    /** 将操作路由到所属文件窗口。 */
    action: (action, path) => ipcRenderer.invoke("jugglework:file-window:action", action, path),
    /** 监听文件窗口标签变化。 */
    onChanged(callback) {
      const handler = (_event, input) => callback(input);
      ipcRenderer.on("jugglework:file-window:changed", handler);
      return () => ipcRenderer.removeListener("jugglework:file-window:changed", handler);
    },
    /** 在所属聊天右侧复用文件标签。 */
    onOpenInPanel(callback) {
      const handler = (_event, input) => callback(input);
      ipcRenderer.on("jugglework:file-window:open-in-panel", handler);
      return () => ipcRenderer.removeListener("jugglework:file-window:open-in-panel", handler);
    },
  },
  browser: {
    show(bounds) { return ipcRenderer.invoke("jugglework:browser:show", bounds); },
    hide() { return ipcRenderer.invoke("jugglework:browser:hide"); },
    openUrl(url, provider) { return ipcRenderer.invoke("jugglework:browser:openUrl", url, provider); },
    navigate(url) { return ipcRenderer.invoke("jugglework:browser:navigate", url); },
    back() { return ipcRenderer.invoke("jugglework:browser:back"); },
    forward() { return ipcRenderer.invoke("jugglework:browser:forward"); },
    reload() { return ipcRenderer.invoke("jugglework:browser:reload"); },
    setBounds(bounds) { return ipcRenderer.invoke("jugglework:browser:bounds", bounds); },
    getState() { return ipcRenderer.invoke("jugglework:browser:state"); },
    createTab(url) { return ipcRenderer.invoke("jugglework:browser:createTab", url); },
    closeTab(tabId) { return ipcRenderer.invoke("jugglework:browser:closeTab", tabId); },
    closeAllTabs() { return ipcRenderer.invoke("jugglework:browser:closeAllTabs"); },
    selectTab(tabId) { return ipcRenderer.invoke("jugglework:browser:selectTab", tabId); },
    reorderTabs(tabIds) { return ipcRenderer.invoke("jugglework:browser:reorderTabs", tabIds); },
    listTabs() { return ipcRenderer.invoke("jugglework:browser:listTabs"); },
    setProxy(proxy) { return ipcRenderer.invoke("jugglework:browser:setProxy", proxy); },
    getProxy() { return ipcRenderer.invoke("jugglework:browser:getProxy"); },
    showTabContextMenu(tabId, point) { return ipcRenderer.invoke("jugglework:browser:tabContextMenu", tabId, point); },
    destroy() { return ipcRenderer.invoke("jugglework:browser:destroy"); },
    onStateChange(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("jugglework:browser:state", handler);
      return () => ipcRenderer.removeListener("jugglework:browser:state", handler);
    },
    onPanelOpened(callback) {
      const handler = () => callback();
      ipcRenderer.on("jugglework:browser:panel-opened", handler);
      return () => ipcRenderer.removeListener("jugglework:browser:panel-opened", handler);
    },
    onPanelClosed(callback) {
      const handler = () => callback();
      ipcRenderer.on("jugglework:browser:panel-closed", handler);
      return () => ipcRenderer.removeListener("jugglework:browser:panel-closed", handler);
    },
  },
  terminal: {
    create(options) { return ipcRenderer.invoke("jugglework:terminal:create", options); },
    write(terminalId, data) { return ipcRenderer.invoke("jugglework:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("jugglework:terminal:resize", terminalId, cols, rows); },
    kill(terminalId) { return ipcRenderer.invoke("jugglework:terminal:kill", terminalId); },
    onData(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("jugglework:terminal:data", handler);
      return () => ipcRenderer.removeListener("jugglework:terminal:data", handler);
    },
    onExit(callback) {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on("jugglework:terminal:exit", handler);
      return () => ipcRenderer.removeListener("jugglework:terminal:exit", handler);
    },
  },
  juggleChat: {
    setSkillEvent(callback) {
      return setJuggleChatSkillEvent(callback);
    },
  },
  file: {
    /**
     * 获取粘贴/拖拽 File 对象的完整磁盘路径（Electron 32+ 替代已废弃的 File.path）。
     * @param {File} file 渲染进程 paste/drop 事件中的 File 对象
     * @returns {string} 完整文件路径
     */
    getPathForFile(file) {
      return webUtils.getPathForFile(file);
    },
  },
  meta: {
    desktopBootstrap,
    initialDeepLinks: [],
    platform: normalizePlatform(process.platform),
    version: process.versions.electron,
  },
});

ipcRenderer.on(NATIVE_DEEP_LINK_EVENT, (_event, urls) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_DEEP_LINK_EVENT, { detail: urls }));
});

ipcRenderer.on(NATIVE_MENU_OPEN_SETTINGS_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_OPEN_SETTINGS_EVENT));
});

ipcRenderer.on(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT));
});

ipcRenderer.on(NATIVE_MENU_CHECK_UPDATES_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(NATIVE_MENU_CHECK_UPDATES_EVENT));
});

ipcRenderer.on(NATIVE_MENU_ZOOM_EVENT, (_event, action) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NATIVE_MENU_ZOOM_EVENT, { detail: action }));
});

ipcRenderer.on(REMOTE_CONTROL_POLICY_RECOVERY_EVENT, () => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(REMOTE_CONTROL_POLICY_RECOVERY_EVENT));
});

if (!applyShellDocumentMarkers() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", applyShellDocumentMarkers, { once: true });
}

if (!installMenuOverlayDismissListeners() && typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", installMenuOverlayDismissListeners, { once: true });
}

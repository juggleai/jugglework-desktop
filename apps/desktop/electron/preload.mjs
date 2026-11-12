import { contextBridge, ipcRenderer, webUtils } from "electron";

const NATIVE_DEEP_LINK_EVENT = "jugglework:deep-link-native";
const NATIVE_MENU_OPEN_SETTINGS_EVENT = "jugglework:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "jugglework:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "jugglework:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "jugglework:native-menu:zoom";
const REMOTE_CONTROL_POLICY_RECOVERY_EVENT = "jugglework:remote-control:policy-recovery";
const JUGGLECHAT_SKILL_INVOKE_CHANNEL = "jugglework:jugglechat:skill-invoke";
const JUGGLECHAT_SKILL_REPLY_CHANNEL = "jugglework:jugglechat:skill-reply";
const DESKTOP_NOTIFICATION_ACTION_CHANNEL = "jugglework:desktop-notification-action";
const DESKTOP_NOTIFICATION_ACTIONS_READY_CHANNEL = "jugglework:desktop-notification-actions-ready";
const DESKTOP_NOTIFICATION_ACTIONS_NOT_READY_CHANNEL = "jugglework:desktop-notification-actions-not-ready";

let activeJuggleChatSkillHandler = null;
let desktopNotificationActionListenerCount = 0;

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
  pet: {
    /** 读取原生宠物的实际可见状态与任务展示快照。 */
    getState: () => ipcRenderer.invoke("jugglework:pet:state"),
    /** 显示或隐藏唯一宠物窗口。 */
    setVisible: (visible) => ipcRenderer.invoke("jugglework:pet:visible", visible),
    /** 用户明确要求键盘操作时聚焦宠物工具条。 */
    focus: () => ipcRenderer.invoke("jugglework:pet:focus"),
    /** 发布主宿主产生的业务展示数据，不传递客户端凭据。 */
    publish: (state) => ipcRenderer.send("jugglework:pet:publish", state),
    /** 监听原生可见状态及任务展示变化。 */
    onState(callback) {
      const handler = (_event, state) => callback(state);
      ipcRenderer.on("jugglework:pet:state-changed", handler);
      return () => ipcRenderer.removeListener("jugglework:pet:state-changed", handler);
    },
    /** 将宠物操作交给保留的主任务宿主，结果回到原宠物请求。 */
    onAction(callback) {
      const handler = async (_event, request) => {
        try {
          const result = await callback(request.action);
          ipcRenderer.send("jugglework:pet:host-reply", { requestId: request.requestId, result });
        } catch (error) {
          ipcRenderer.send("jugglework:pet:host-reply", { requestId: request.requestId, error: error instanceof Error ? error.message : String(error) });
        }
      };
      ipcRenderer.on("jugglework:pet:host-action", handler);
      return () => ipcRenderer.removeListener("jugglework:pet:host-action", handler);
    },
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
    /** 仅主窗口可提交一次性 Docs 交接创建独立标签。 */
    openCloud: (input) => ipcRenderer.invoke("jugglework:file-window:open-cloud", input),
    /** 仅主窗口处理 Main 固定目标的停止准备；确认前不会中止运行。 */
    onSessionStopRequest(callback) {
      const handler = async (_event, input) => {
        let ok = false;
        try { ok = (await callback({ workspaceId: input.workspaceId, sessionId: input.sessionId }))?.ok === true; }
        catch { /* Main 收到失败确认后保持原运行，不转发 renderer 错误正文。 */ }
        await ipcRenderer.invoke("jugglework:file-window:session-stop-reply", { requestId: input.requestId, ok }).catch(() => {});
      };
      ipcRenderer.on("jugglework:file-window:session-stop-request", handler);
      return () => ipcRenderer.removeListener("jugglework:file-window:session-stop-request", handler);
    },
    /** 旧主进程缺少入口时返回不可用，不把底层 IPC 错误暴露给用户。 */
    available: () => ipcRenderer.invoke("jugglework:file-window:available").catch(() => false),
    /** 打开或激活所属聊天的文件窗口。 */
    open: (input) => ipcRenderer.invoke("jugglework:file-window:open", input),
    /** 主窗口无需读取子窗口状态。 */
    state: () => ipcRenderer.invoke("jugglework:file-window:state"),
    /** 由主进程选择工作区内的 Word 或 PowerPoint 目标并创建。 */
    create: (input) => ipcRenderer.invoke("jugglework:file-window:create", input),
    /** 将操作路由到所属文件窗口。 */
    action: (action, path) => ipcRenderer.invoke("jugglework:file-window:action", action, path),
    /** 独立文件窗口请求把当前文件上传为云文档，由主窗口按当前组织执行。 */
    /** 只发布当前范围的非敏感链接，独立窗口不能调用。 */
    setCloudUploads: (input) => ipcRenderer.invoke("jugglework:file-window:cloud-uploads", input),
    onUploadCloud(callback) {
      const handler = (_event, input) => callback(input);
      ipcRenderer.on("jugglework:file-window:upload-cloud", handler);
      return () => ipcRenderer.removeListener("jugglework:file-window:upload-cloud", handler);
    },
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
  cloudDocs: {
    status: instanceId => ipcRenderer.invoke("jugglework:docs:status", instanceId),
    /** 以一次性凭据进入当前组织的云文档。 */
    open: (input) => ipcRenderer.invoke('jugglework:docs:open', input),
    /** 释放指定实例或全部云文档视图。 */
    close: (instanceId) => ipcRenderer.invoke('jugglework:docs:close', instanceId),
    /** 宿主浮窗打开时保留云文档画面，不销毁编辑会话。 */
    snapshot: (instanceId) => ipcRenderer.invoke('jugglework:docs:snapshot', instanceId),
    /** 对齐 React 内容区域并在宿主菜单打开时隐藏原生视图。 */
    setBounds: (input) => ipcRenderer.send('jugglework:docs:bounds', input),
    /** 只向当前云文档传递展示配置。 */
    setAppearance: (input) => ipcRenderer.send('jugglework:docs:appearance', input),
    /** 将顶部按钮操作传给当前实例的原生侧栏或搜索。 */
    layoutCommand: (input) => ipcRenderer.send('jugglework:docs:layout-command', input),
    /** 监听 AFFiNE 原生侧栏状态，包含快捷键和拖动改宽后的结果。 */
    onLayout(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on('jugglework:docs:layout', handler); return () => ipcRenderer.removeListener('jugglework:docs:layout', handler); },
    /** 监听当前原生页面就绪或身份失效。 */
    onState(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on('jugglework:docs:state', handler); return () => ipcRenderer.removeListener('jugglework:docs:state', handler); },
    /** 在当前组织的 product 视图中执行文件上传（lookup／upload）。 */
    fileIntake: (input) => ipcRenderer.invoke('jugglework:docs:file-intake', input),
    /** 在当前页面滚动并高亮指定块。 */
    highlightBlocks: (input) => ipcRenderer.send('jugglework:docs:highlight-blocks', input),
    /** 在当前组织 product 视图中执行 Docs AI 接口（search／read／edit／create）。 */
    api: (input) => ipcRenderer.invoke('jugglework:docs:api', input),
    /** 监听本地 Server 经主进程转来的云文档请求。 */
    onApiRequest(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on('jugglework:cloud-docs:api-request', handler); return () => ipcRenderer.removeListener('jugglework:cloud-docs:api-request', handler); },
    /** 返回云文档请求结果。 */
    apiResponse: (value) => ipcRenderer.send('jugglework:cloud-docs:api-response', value),
    /** 监听页面发来的块选区引用。 */
    onAiReference(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on('jugglework:docs:ai-reference', handler); return () => ipcRenderer.removeListener('jugglework:docs:ai-reference', handler); },
  },
  desktopNotifications: {
    /** 监听系统原生通知点击；主进程只回传已校验的受限应用动作。 */
    onAction(callback) {
      if (typeof callback !== "function") return () => {};
      const handler = (_event, action) => callback(action);
      ipcRenderer.on(DESKTOP_NOTIFICATION_ACTION_CHANNEL, handler);
      desktopNotificationActionListenerCount += 1;
      // TIPS: 先安装监听再声明就绪，保证主进程冲刷启动期暂存动作时不会丢失点击。
      if (desktopNotificationActionListenerCount === 1) {
        ipcRenderer.send(DESKTOP_NOTIFICATION_ACTIONS_READY_CHANNEL);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        ipcRenderer.removeListener(DESKTOP_NOTIFICATION_ACTION_CHANNEL, handler);
        desktopNotificationActionListenerCount = Math.max(0, desktopNotificationActionListenerCount - 1);
        if (desktopNotificationActionListenerCount === 0) {
          ipcRenderer.send(DESKTOP_NOTIFICATION_ACTIONS_NOT_READY_CHANNEL);
        }
      };
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
    open(target) { return ipcRenderer.invoke("jugglework:terminal:open", target); },
    read(terminalId, cursor) { return ipcRenderer.invoke("jugglework:terminal:read", terminalId, cursor); },
    write(terminalId, data) { return ipcRenderer.invoke("jugglework:terminal:write", terminalId, data); },
    resize(terminalId, cols, rows) { return ipcRenderer.invoke("jugglework:terminal:resize", terminalId, cols, rows); },
    terminate(terminalId) { return ipcRenderer.invoke("jugglework:terminal:terminate", terminalId); },
    restart(terminalId) { return ipcRenderer.invoke("jugglework:terminal:restart", terminalId); },
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

for (const channel of ["jugglework:meeting:screen-picker", "jugglework:meeting:screen-picker-closed"]) {
  ipcRenderer.on(channel, (_event, payload) => {
    if (typeof payload?.requestId !== "string") return;
    window.dispatchEvent(new CustomEvent(channel, { detail: { requestId: payload.requestId } }));
  });
}

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

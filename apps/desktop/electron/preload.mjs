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
    download() {
      return ipcRenderer.invoke("jugglework:updater:download");
    },
    installAndRestart() {
      return ipcRenderer.invoke("jugglework:updater:installAndRestart");
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

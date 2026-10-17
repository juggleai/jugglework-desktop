// Native application menu: template installation, the macOS/system menu
// actions that forward into the renderer (settings, updates, sidebar, zoom),
// and Windows/Linux menu-bar visibility. Extracted from main.mjs as a
// factory (createRuntimeManager pattern); the NATIVE_MENU_* channels are
// consumed by the preload bridge.
import { BrowserWindow, Menu, shell } from "electron";

const NATIVE_MENU_OPEN_SETTINGS_EVENT = "jugglework:native-menu:open-settings";
const NATIVE_MENU_TOGGLE_SIDEBAR_EVENT = "jugglework:native-menu:toggle-sidebar";
const NATIVE_MENU_CHECK_UPDATES_EVENT = "jugglework:native-menu:check-updates";
const NATIVE_MENU_ZOOM_EVENT = "jugglework:native-menu:zoom";

/** 创建应用菜单；活动文件窗口只改变显示名称，品牌与应用身份仍由主应用维护。 */
export function createApplicationMenu({ appName, docsUrl, getWindow }) {
  let applicationMenuVisible = process.platform === "darwin";
  let currentAppName = appName;
  let fileWindowActive = false;

  async function openSettingsFromNativeMenu() {
    const win = await getWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(NATIVE_MENU_OPEN_SETTINGS_EVENT);
  }

  async function checkForUpdatesFromNativeMenu() {
    const win = await getWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(NATIVE_MENU_CHECK_UPDATES_EVENT);
  }

  async function toggleSidebarFromNativeMenu() {
    const win = await getWindow();
    win.webContents.send(NATIVE_MENU_TOGGLE_SIDEBAR_EVENT);
  }

  // Zoom must flow through the renderer's font-zoom pathway so the persisted
  // preference and the applied webContents zoom factor never drift apart. The
  // built-in resetZoom/zoomIn/zoomOut roles bypass that pathway (and zoom
  // whichever webContents is focused, including the embedded browser view).
  async function zoomFromNativeMenu(action) {
    const win = await getWindow();
    win.webContents.send(NATIVE_MENU_ZOOM_EVENT, action);
  }

  function install() {
    const isMac = process.platform === "darwin";
    // TIPS: AppKit 的应用菜单名还取自进程显示标题，不能只改菜单模板 label。
    if (isMac) process.title = fileWindowActive ? "JuggleWork 文件浏览器" : currentAppName;
    const template = /** @type {import("electron").MenuItemConstructorOptions[]} */ ([
      ...(isMac
        ? [
            {
              label: fileWindowActive ? "JuggleWork 文件浏览器" : currentAppName,
              submenu: [
                { role: "about" },
                {
                  label: "Check for Updates...",
                  click: () => {
                    void checkForUpdatesFromNativeMenu();
                  },
                },
                { type: "separator" },
                {
                  label: "Settings...",
                  accelerator: "Command+,",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "File",
        submenu: [
          ...(isMac
            ? []
            : [
                {
                  label: "Settings",
                  accelerator: "Control+,",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
                { type: "separator" },
              ]),
          { role: "close" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          ...(isMac
            ? [
                { role: "pasteAndMatchStyle" },
                { role: "delete" },
                { role: "selectAll" },
                { type: "separator" },
                {
                  label: "Speech",
                  submenu: [
                    { role: "startSpeaking" },
                    { role: "stopSpeaking" },
                  ],
                },
                { type: "separator" },
                {
                  label: "Settings...",
                  click: () => {
                    void openSettingsFromNativeMenu();
                  },
                },
              ]
            : [
                { role: "delete" },
                { type: "separator" },
                { role: "selectAll" },
              ]),
        ],
      },
      {
        label: "View",
        submenu: [
          {
            label: "Toggle Sidebar",
            accelerator: "CommandOrControl+B",
            click: () => {
              void toggleSidebarFromNativeMenu();
            },
          },
          { type: "separator" },
          { role: "reload" },
          { role: "forceReload" },
          // 打开/关闭开发者控制台，统一使用 Cmd/Ctrl+Shift+I 快捷键。
          { role: "toggleDevTools", accelerator: "CommandOrControl+Shift+I" },
          { type: "separator" },
          {
            label: "Actual Size",
            accelerator: "CommandOrControl+0",
            click: () => {
              void zoomFromNativeMenu("reset");
            },
          },
          {
            label: "Zoom In",
            accelerator: "CommandOrControl+Plus",
            click: () => {
              void zoomFromNativeMenu("in");
            },
          },
          {
            label: "Zoom Out",
            accelerator: "CommandOrControl+-",
            click: () => {
              void zoomFromNativeMenu("out");
            },
          },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(isMac
            ? [
                { type: "separator" },
                { role: "front" },
                { type: "separator" },
                { role: "window" },
              ]
            : [
                { role: "close" },
              ]),
        ],
      },
      {
        role: "help",
        submenu: [
          ...(isMac
            ? []
            : [
                {
                  label: "Check for Updates...",
                  click: () => {
                    void checkForUpdatesFromNativeMenu();
                  },
                },
                { type: "separator" },
              ]),
          {
            label: "Docs",
            click: async () => {
              await shell.openExternal(docsUrl);
            },
          },
        ],
      },
    ]);

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  function applyVisibility(window) {
    if (process.platform === "darwin") return;
    window.setAutoHideMenuBar(false);
    window.setMenuBarVisibility(applicationMenuVisible);
  }

  function setVisible(visible) {
    applicationMenuVisible = visible === true;
    for (const window of BrowserWindow.getAllWindows()) {
      applyVisibility(window);
    }
    return applicationMenuVisible;
  }

  function setAppName(nextAppName) {
    currentAppName = typeof nextAppName === "string" && nextAppName.trim() ? nextAppName.trim() : appName;
    install();
    return currentAppName;
  }

  /** macOS 激活独立文件窗口时切换菜单标题，切回主窗口恢复品牌名。 */
  function setFileWindowActive(active) {
    const next = active === true;
    if (process.platform !== "darwin" || next === fileWindowActive) return;
    fileWindowActive = next;
    install();
  }

  return { install, applyVisibility, setVisible, setAppName, setFileWindowActive };
}

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const STATE_CHANNEL = "jugglework:pet:state-changed";
const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;

/**
 * 固定画布覆盖工作区高度，开合面板只改变网页内布局。
 * @param anchor 人物左上角的屏幕坐标
 * @param workArea 当前显示器可用区域，保留系统菜单栏和任务栏
 */
export function petViewportBounds(anchor, workArea) {
  const width = Math.min(400, workArea.width);
  return { x: Math.round(clamp(anchor.x + 52 - width / 2, workArea.x, workArea.x + workArea.width - width)), y: workArea.y, width, height: workArea.height };
}

/**
 * 创建唯一透明宠物窗口，所有业务操作转交现有主窗口宿主。
 * @param options Electron依赖、偏好路径、页面加载器及主窗口访问器
 */
export function createDesktopPet({ BrowserWindow, screen, ipcMain, Menu, preferencesPath, preloadPath, loadPage, getMainWindow }) {
  let preference = { schemaVersion: 1, enabled: false, position: null };
  try {
    const saved = JSON.parse(readFileSync(preferencesPath, "utf8"));
    preference = { schemaVersion: 1, enabled: saved.enabled === true, position: saved.position };
  } catch { /* 首次启动和损坏偏好均按默认隐藏处理。 */ }
  let window = null;
  let creating = null;
  let desiredVisible = false;
  let tick = null;
  let dragging = null;
  let keyboard = false;
  let passthrough = null;
  let anchor = null;
  let lastViewport = "";
  let layout = { width: 400, height: 181, character: { x: 244, y: 28 }, regions: [{ x: 244, y: 28, width: 104, height: 113 }] };
  let host = { ready: false, syncing: true, partial: false, tasks: [], locale: "zh", theme: "light", editing: false, voicePhase: "idle" };
  const pending = new Map();
  let interaction = { drafts: {}, targets: {}, dismissed: {}, target: null };

  const state = () => ({ ...host, interaction, submitting: [...new Set([...pending.values()].filter((item) => item.submission).map((item) => item.submission.target.key))], visible: Boolean(window && !window.isDestroyed()) });
  const save = () => {
    try { writeFileSync(preferencesPath, JSON.stringify(preference), "utf8"); }
    catch (error) { console.warn("[pet] 无法保存宠物偏好", error); }
  };
  const publish = () => {
    for (const target of [getMainWindow(), window]) {
      if (target && !target.isDestroyed()) target.webContents.send(STATE_CHANNEL, state());
    }
  };
  const mainSender = (event) => event.sender === getMainWindow()?.webContents;
  const petSender = (event) => event.sender === window?.webContents;
  const area = () => screen.getDisplayNearestPoint(anchor ?? screen.getCursorScreenPoint()).workArea;
  const viewport = () => {
    const bounds = window.getBounds();
    return { width: bounds.width, height: bounds.height, screenX: bounds.x, character: { x: anchor.x - bounds.x, y: anchor.y - bounds.y }, workArea: area() };
  };
  const reposition = () => {
    if (!window || window.isDestroyed() || !anchor) return;
    const workArea = area();
    anchor = { x: clamp(anchor.x, workArea.x + 40, workArea.x + workArea.width - 144), y: clamp(anchor.y, workArea.y + 28, workArea.y + workArea.height - 193) };
    const bounds = petViewportBounds(anchor, workArea);
    const current = window.getBounds();
    if (bounds.width !== current.width || bounds.height !== current.height) window.setBounds(bounds, false);
    else if (bounds.x !== current.x || bounds.y !== current.y) window.setPosition(bounds.x, bounds.y, false);
    const value = viewport(), serialized = JSON.stringify(value);
    if (serialized !== lastViewport) { lastViewport = serialized; window.webContents.send("jugglework:pet:viewport-changed", value); }
  };
  const rejectPending = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      if (item.submission) markUncertain(item.submission.target);
      item.reject(new Error("任务宿主已重载，操作结果待确认，请稍后核对任务状态"));
    }
    pending.clear();
  };
  const markUncertain = (target) => {
    interaction = { ...interaction, targets: { ...interaction.targets, [target.key]: target }, uncertain: { ...interaction.uncertain, [target.key]: true } };
  };
  const close = (keepPreference = false) => {
    const old = window;
    window = null;
    clearInterval(tick); tick = null;
    keyboard = false; dragging = null; passthrough = null; lastViewport = "";
    desiredVisible = false;
    if (!keepPreference) { preference.enabled = false; save(); }
    if (old && !old.isDestroyed()) old.destroy();
    publish();
  };

  const updatePointer = () => {
    if (!window || window.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    if (dragging) {
      anchor = { x: dragging.anchor.x + point.x - dragging.point.x, y: dragging.anchor.y + point.y - dragging.point.y };
      reposition();
    }
    const bounds = window.getBounds();
    const x = point.x - bounds.x, y = point.y - bounds.y;
    // TIPS: 键盘焦点不能让整块透明画布拦截桌面，否则点击外部无法触发输入框失焦。
    const interactive = dragging || layout.regions.some((r) => x >= r.x && y >= r.y && x <= r.x + r.width && y <= r.y + r.height);
    const next = !interactive;
    if (passthrough !== next) {
      passthrough = next;
      window.setIgnoreMouseEvents(next, { forward: true });
    }
  };

  /** 显示或隐藏宠物，重复开启复用同一个创建请求和窗口。 */
  async function setVisible(visible) {
    if (!visible) { close(); return state(); }
    desiredVisible = true;
    if (creating) {
      await creating;
      return desiredVisible ? setVisible(true) : state();
    }
    if (window && !window.isDestroyed()) return state();
    creating = (async () => {
      const workArea = screen.getPrimaryDisplay().workArea;
      const position = preference.position;
      anchor = position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { x: position.x, y: position.y }
        : { x: workArea.x + workArea.width - 160, y: workArea.y + workArea.height - 248 };
      const win = new BrowserWindow({
        ...petViewportBounds(anchor, area()), show: false, frame: false, transparent: true,
        backgroundColor: "#00000000", hasShadow: false, skipTaskbar: true,
        resizable: false, minimizable: false, maximizable: false, focusable: false,
        // TIPS: Electron按session+origin共享页面缩放；独立session避免主窗口缩放影响宠物尺寸和原生命中坐标。
        webPreferences: { preload: preloadPath, partition: "desktop-pet", contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
      });
      window = win;
      win.setAlwaysOnTop(true, "floating");
      win.on("closed", () => { if (window === win) close(); });
      win.webContents.on("render-process-gone", () => { if (window === win) close(); });
      win.webContents.on("context-menu", () => Menu.buildFromTemplate([
        { label: host.locale === "zh" ? "重置宠物位置" : "Reset position", click: () => { const a = screen.getPrimaryDisplay().workArea; anchor = { x: a.x + a.width - 160, y: a.y + a.height - 248 }; reposition(); preference.position = anchor; save(); } },
        { label: host.locale === "zh" ? "隐藏虚拟宠物" : "Hide pet", click: () => close() },
      ]).popup({ window: win }));
      try {
        await loadPage(win);
        // TIPS: 载入期间用户可能已经隐藏，不能在异步完成后重新冒出窗口。
        if (window !== win || win.isDestroyed() || !desiredVisible) return state();
        win.webContents.setZoomFactor(1);
        preference.enabled = true; save(); reposition(); win.showInactive();
        tick = setInterval(updatePointer, 16);
        updatePointer(); publish();
      } catch (error) {
        if (window !== win || win.isDestroyed()) return state();
        close(); throw error;
      }
      return state();
    })().finally(() => { creating = null; });
    return creating;
  }

  const focus = () => {
    if (!window || window.isDestroyed()) return;
    keyboard = true; window.setFocusable(true); window.focus(); window.webContents.focus();
    window.webContents.send("jugglework:pet:focus-controls");
    updatePointer();
  };
  const onDisplay = () => { reposition(); };
  screen.on("display-removed", onDisplay);
  screen.on("display-metrics-changed", onDisplay);

  ipcMain.handle("jugglework:pet:state", () => state());
  ipcMain.handle("jugglework:pet:viewport", () => viewport());
  ipcMain.handle("jugglework:pet:visible", (event, visible) => {
    if (!mainSender(event) && !petSender(event)) throw new Error("宠物窗口已失效");
    return setVisible(visible === true);
  });
  ipcMain.handle("jugglework:pet:focus", (event) => { if (mainSender(event)) focus(); });
  ipcMain.handle("jugglework:pet:focus-editor", (event) => {
    if (!petSender(event) || !window || window.isDestroyed()) return;
    if (!keyboard) { keyboard = true; window.setFocusable(true); }
    if (!window.isFocused()) { window.focus(); window.webContents.focus(); }
    updatePointer();
  });
  ipcMain.on("jugglework:pet:publish", (event, value) => {
    if (!mainSender(event)) return;
    if (host.contextKey !== value.contextKey) {
      rejectPending(); interaction = { drafts: {}, targets: {}, dismissed: {}, target: null };
    }
    host = { ...value }; publish();
  });
  ipcMain.on("jugglework:pet:remember", (event, payload) => {
    if (!petSender(event) || payload?.contextKey !== host.contextKey || !payload?.interaction) return;
    const value = payload.interaction;
    // TIPS: 草稿快照可能先于发送回执产生；结果待确认由主进程管理，不能被旧页面状态覆盖。
    interaction = { ...value, targets: { ...interaction.targets, ...value.targets }, uncertain: interaction.uncertain };
    publish();
  });
  ipcMain.on("jugglework:pet:layout", (event, value) => {
    if (!petSender(event) || !Array.isArray(value?.regions)) return;
    layout = {
      width: finite(value.width, 400), height: finite(value.height, 181),
      character: { x: finite(value.character?.x, 24), y: finite(value.character?.y, 0) },
      regions: value.regions.filter((r) => [r.x, r.y, r.width, r.height].every(Number.isFinite)),
    };
    updatePointer();
  });
  ipcMain.on("jugglework:pet:keyboard", (event, active) => {
    if (!petSender(event) || !window) return;
    const next = active === true;
    if (keyboard !== next) { keyboard = next; window.setFocusable(keyboard); }
    if (keyboard && !window.isFocused()) { window.focus(); window.webContents.focus(); }
    updatePointer();
  });
  ipcMain.on("jugglework:pet:drag", (event, active) => {
    if (!petSender(event)) return;
    if (active && anchor) dragging = { anchor: { ...anchor }, point: screen.getCursorScreenPoint() };
    else {
      // TIPS: 松手可能早于下一次16ms采样，必须先应用最终鼠标坐标再保存位置。
      if (dragging) updatePointer();
      dragging = null; preference.position = anchor; save();
      updatePointer();
    }
  });
  ipcMain.handle("jugglework:pet:action", (event, action) => {
    if (!petSender(event)) throw new Error("宠物窗口已失效");
    const main = getMainWindow();
    if (!main || main.isDestroyed()) throw new Error("任务宿主不可用");
    // TIPS: 人物单击立即显示主窗口；任务导航成功后再显示，避免打开失败却清掉完成提醒。
    if (action.type === "activate-app") { main.show(); main.focus(); return {}; }
    if (action.type === "confirm-send") {
      interaction = { ...interaction, uncertain: { ...interaction.uncertain, [action.key]: false } };
      publish(); return {};
    }
    if (!host.ready) throw new Error("任务宿主正在准备，请稍后重试");
    const submission = action.type === "send" ? { key: action.draftKey ?? action.target.key, text: action.text, target: action.target } : null;
    if (submission && ([...pending.values()].some((item) => item.submission?.target.key === submission.target.key) || interaction.uncertain?.[submission.target.key])) throw new Error("发送结果尚未确认，请先核对原任务");
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        if (submission) markUncertain(submission.target);
        publish(); reject(new Error("操作结果待确认，请打开原任务核对，不要重复发送"));
      }, 120_000);
      pending.set(requestId, { resolve, reject, timer, submission, openMain: ["open", "open-target", "open-app"].includes(action.type) });
      if (submission) publish();
      main.webContents.send("jugglework:pet:host-action", { requestId, action });
    });
  });
  ipcMain.on("jugglework:pet:host-reply", (event, reply) => {
    if (!mainSender(event)) return;
    const item = pending.get(reply?.requestId);
    if (!item) return;
    pending.delete(reply.requestId); clearTimeout(item.timer);
    const result = { ...reply.result };
    if (item.submission) {
      const { key, text, target } = item.submission;
      if (reply.error?.includes("结果待确认")) markUncertain(target);
      // TIPS: 确认和草稿清理由常驻主进程完成，不能依赖可能已销毁的宠物页面。
      // 仅清理同目标、同文字的原草稿，用户在请求期间继续编辑的内容必须保留。
      const currentTarget = key === "__quick__" ? interaction.target : interaction.targets[key];
      if (!reply.error && result.delivery && interaction.drafts[key] === text && currentTarget?.key === target.key) {
        interaction = { ...interaction, drafts: { ...interaction.drafts, [key]: "" } };
        result.draftCleared = true;
      }
      publish();
    }
    if (reply.error) item.reject(new Error(reply.error));
    else {
      const main = getMainWindow();
      if (item.openMain && main && !main.isDestroyed()) { main.show(); main.focus(); }
      item.resolve(result);
    }
  });

  return {
    setVisible, focus,
    /** 宠物正在取得键盘焦点时，应用激活事件不能顺带唤起主窗口。 */
    isKeyboardActive() { return keyboard; },
    /** 主任务宿主重载时失效操作回执，保留明确的未知结果。 */
    resetHost() { rejectPending(); host = { ...host, ready: false, syncing: true, editing: false, voicePhase: "idle" }; publish(); },
    /** 恢复本机显隐偏好；只有主窗口已建立时调用。 */
    restore() { return preference.enabled ? setVisible(true) : Promise.resolve(state()); },
    /** 主窗口实际销毁时同步关闭宠物，保留下次启动的显隐偏好。 */
    closeHost() { rejectPending(); close(true); },
    /** 应用确认退出后移除全局显示器监听。 */
    dispose() { rejectPending(); close(true); screen.removeListener("display-removed", onDisplay); screen.removeListener("display-metrics-changed", onDisplay); },
  };
}

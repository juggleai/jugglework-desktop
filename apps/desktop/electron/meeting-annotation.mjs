// Screen annotation for whole-screen meeting shares. A transparent, top-most
// canvas covers the shared display so the system capture records the strokes;
// a separate, content-protected toolbar drives it. Neither window loads the
// app runtime, IM or meeting media.
// Tools follow Feishu meetings: "pointer" (鼠标, the default) lets the mouse
// through to the apps below; every other tool draws on the canvas.
import { randomUUID } from 'node:crypto';
import { classifyWindowSample } from './meeting-window-tracker.mjs';
import { HIDDEN_EXTERNAL_INTERPOSER, HIDDEN_HOST_NEIGHBOR, HIDDEN_HOST_TARGET_NOT_BELOW, PLACEMENT_ORDER_UNCONFIRMED, TARGET_POSITION_STALE, TARGET_SIZE_UNCONFIRMED } from './meeting-window-placement-windows.mjs';
/** @typedef {boolean | typeof HIDDEN_EXTERNAL_INTERPOSER | typeof HIDDEN_HOST_NEIGHBOR | typeof HIDDEN_HOST_TARGET_NOT_BELOW | typeof PLACEMENT_ORDER_UNCONFIRMED | typeof TARGET_POSITION_STALE | typeof TARGET_SIZE_UNCONFIRMED} PlacementResult */

export const ANNOTATION_TOOLS = ["pointer", "laser", "pen", "highlighter", "ellipse", "rectangle", "arrow", "eraser"];
export const ANNOTATION_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#a855f7"];
const STROKE_SIZE = 4;
const ACTIONS = new Set(["undo", "clear"]);
const TOOLBAR_SIZE = { width: 600, height: 52 };
const initialState = () => ({ mode: "pointer", tool: { tool: "pointer", color: ANNOTATION_COLORS[0], size: STROKE_SIZE }, history: { canUndo: false, canClear: false } });
const modeOf = (tool) => tool === "pointer" ? "pointer" : "draw";

function validScene(scene) {
  const unit = (n) => Number.isFinite(n) && n >= 0 && n <= 1;
  const dimension = (n) => Number.isInteger(n) && n > 0 && n <= 16384;
  if (!dimension(scene?.size?.width) || !dimension(scene?.size?.height) || !Array.isArray(scene.elements) || scene.elements.length > 600 ||
      !Array.isArray(scene.lasers) || scene.lasers.length > 32) return false;
  let coordinates = 0;
  const shape = (e, laser = false) => {
    if (!e || typeof e.id !== 'string' || e.id.length > 128 || !Number.isFinite(e.size) || e.size <= 0 || e.size > 32 ||
      !(ANNOTATION_COLORS.includes(e.color) || (laser && e.color === '#ff3b30'))) return false;
    if (e.type === 'stroke') {
      if (!Array.isArray(e.points) || e.points.length < 2 || e.points.length % 2 !== 0 || typeof e.highlight !== 'boolean') return false;
      coordinates += e.points.length;
      return coordinates <= 60000 && e.points.every(unit);
    }
    return !laser && e.type === 'shape' && ['arrow', 'rectangle', 'ellipse'].includes(e.kind) && [e.x1,e.y1,e.x2,e.y2].every(unit);
  };
  return scene.elements.every(e => shape(e)) && scene.lasers.every(e => unit(e?.opacity) && shape(e.stroke, true));
}

/** Toolbar default: centered just below the top of the display's work area. */
export function annotationToolbarBounds(workArea, size = TOOLBAR_SIZE) {
  const width = Math.min(size.width, workArea.width);
  return { x: Math.round(workArea.x + (workArea.width - width) / 2), y: workArea.y + 12, width, height: size.height };
}

function validTool(value) {
  return value && ANNOTATION_TOOLS.includes(value.tool) && typeof value.color === "string" && ANNOTATION_COLORS.includes(value.color.toLowerCase());
}

/**
 * @param {{ BrowserWindow: any, screen: any, ipcMain: any, preloadPath: string,
 *   loadPage: (window: any, view: "canvas" | "toolbar") => Promise<void>,
 *   getMainWindow: () => any, getMeetingWindow: () => any,
 *   getSharedDisplayId: () => number | null, clearShared: () => void, platform?: string,
 *   getSharedWindow?: () => import('@jugglework/types/desktop-ipc').MeetingWindowShareTarget | null,
 *   watchWindow?: ReturnType<typeof import('./meeting-window-tracker.mjs').createMeetingWindowTracker>['watchWindow'],
 *   placeWindowCanvas?: (canvas: any, target: import('@jugglework/types/desktop-ipc').MeetingWindowShareTarget,
 *     request: {bounds: any, visible: boolean, checkOnly?: boolean, stage?: string}) => PlacementResult | Promise<PlacementResult>,
 *   getDisplayMatching?: (bounds: any) => any, getPlacementFailure?: () => string | undefined, traceEvent?: (event: string) => void }} options
 */
export function createMeetingAnnotation({ BrowserWindow, screen, ipcMain, preloadPath, loadPage, getMainWindow, getMeetingWindow, getSharedDisplayId, clearShared, platform = process.platform, getSharedWindow, watchWindow, placeWindowCanvas, getDisplayMatching, getPlacementFailure, traceEvent }) {
  let session = null;
  let opening = null;
  let lastExitReason;
  let lastRecoveryState;
  let state = initialState();
  let readyCaptureId = null;
  let pendingWindow = null;
  const focusableByWindow = new WeakMap();

  function setFocusable(win, value) {
    // Even repeated false calls can reorder native Windows windows. Seed this
    // cache from BrowserWindow construction, rather than writing the initial value.
    if (focusableByWindow.get(win) === value) return;
    win.setFocusable(value);
    focusableByWindow.set(win, value);
  }

  const live = (win) => win && !win.isDestroyed();
  const display = (id) => screen.getAllDisplays().find((d) => d.id === id) ?? null;
  function assertMain(event) {
    const main = getMainWindow();
    if (!live(main) || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw new Error("仅主窗口可操作标注");
  }
  function publish() {
    if (!session) return;
    for (const win of [session.canvas, session.toolbar]) if (live(win)) win.webContents.send("jugglework:annotation:state", session.target ? { ...state, windowShare: true } : state);
  }
  function applyMode() {
    const canvas = session?.canvas;
    if (!live(canvas)) return;
    if (session.target && platform === 'win32') {
      void placeWindowsLayers(session);
      return;
    }
    if (state.mode === "pointer") {
      canvas.setIgnoreMouseEvents(true, { forward: true });
      // On macOS, Electron's blur() orders the window out and back in, which
      // drops the strokes from the screen capture for a few frames. The next
      // click goes through to the app below and takes focus there anyway.
      if (platform !== "darwin") canvas.blur?.();
      setFocusable(canvas, false);
    } else {
      setFocusable(canvas, true);
      canvas.setIgnoreMouseEvents(false);
      canvas.focus();
    }
    raiseToolbar();
  }
  function orderWindowLayers(current, bestEffort = false) {
    const {canvas, target} = current;
    if (!target || current.hidden || current.geometryPending || !current.shown || !live(canvas)) return;
    if (platform === 'win32') {
      void placeWindowsLayers(current);
      return;
    }
    try {
      canvas.moveAbove(target.sourceId);
    } catch { if (!bestEffort) teardown('tracking-lost'); }
  }
  function suspendWindowsLayers(current) {
    traceEvent?.('suspend');
    current.placementReady = false;
    for (const win of [current.canvas, current.toolbar]) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.hide();
      // The hidden toolbar already cannot receive input. Toggling its
      // native focusability on every move can reorder the owned window pair.
      if (win === current.canvas) setFocusable(win, false);
    }
  }
  function suspendWindowsGeometry(current) {
    suspendWindowsLayers(current);
    if (current.geometryRecovery) return;
    current.geometryRecovery = true;
    current.geometryKey = '';
    if (current.announced) windowEvent(current, 'geometry-pending');
  }
  function waitForFreshPlacement(current) {
    current.waitingForPlacementSample = true;
    current.placementRevision++;
    suspendWindowsGeometry(current);
    // No retry against the rejected coordinates. Only the watcher may advance
    // this attempt, and repeated stale replies cannot extend the deadline.
    current.placementDeadline ??= setTimeout(() => {
      if (session === current) teardown('tracking-lost');
    }, 2500);
    return false;
  }
  function reportWindowsPlacement(current) {
    if (session !== current || !current.announced || current.hidden || current.geometryPending || !current.placementReady) return;
    // Keep the pause latched through incomplete restores, including a second
    // pending epoch. Only verified placement is allowed to resume drawing.
    if (current.minimized) {
      current.minimized = false;
      windowEvent(current, 'resumed');
    }
    current.geometryRecovery = false;
    reportSize(current);
  }
  function deferUnconfirmedOrder(current, result) {
    if (result !== PLACEMENT_ORDER_UNCONFIRMED || state.mode !== 'pointer' || !current.retriedHiddenNeighbor ||
        !current.geometryRecovery || !current.placementDeadline || current.deferredRecoveryOrder) return false;
    current.deferredRecoveryOrder = true;
    // A foreground reorder can outlast a helper call. Keep both layers
    // suspended through two additional trusted visible observer samples.
    current.recoverySamplesToSkip = 2;
    waitForFreshPlacement(current);
    return true;
  }
  function placeWindowsLayers(current) {
    if (session !== current || current.hidden || current.geometryPending || current.waitingForPlacementSample || !current.shown) return Promise.resolve(false);
    if (current.placementTask) return current.placementTask;
    // Even unchanged geometry starts a new placement epoch (e.g. tool changes),
    // invalidating stationary checks of the previously visible canvas.
    current.placementRevision++;
    suspendWindowsLayers(current);
    const place = async request => {
      const stage = request.checkOnly ? 'final' : request.visible ? 'visible' : 'hidden';
      traceEvent?.(`${stage}-start`);
      try {
        const result = await placeWindowCanvas(current.canvas, current.target, request);
        if (session === current) traceEvent?.(`${stage}-${result === true ? 'ok' : 'fail'}`);
        return result;
      }
      // Native failures must pass the same revision check as false replies.
      catch { return false; }
    };
    const task = (async () => {
      while (session === current && !current.hidden && !current.geometryPending) {
        const revision = current.placementRevision;
        const bounds = { ...current.bounds };
        const active = () => session === current && !current.hidden && !current.geometryPending && revision === current.placementRevision;
        // Both native replies must refer to the same geometry. Hidden placement
        // precedes display; visible readback precedes any drawing input.
        let placed = await place({ bounds, visible: false });
        if (!active()) continue;
        if (placed === TARGET_POSITION_STALE) return waitForFreshPlacement(current);
        if (deferUnconfirmedOrder(current, placed)) return false;
        if (placed !== true) { teardown('tracking-lost'); return false; }
        // Windows single-window ink receives mouse input without activation,
        // including pen/eraser. Keep native focusability stable across modes;
        // mouse routing is enabled only after the final strict readback below.
        const mode = state.mode;
        setFocusable(current.canvas, false);
        setFocusable(current.toolbar, true);
        current.canvas.showInactive();
        placed = await place({ bounds, visible: true });
        if (!active()) { if (session === current) suspendWindowsLayers(current); continue; }
        if (placed === TARGET_POSITION_STALE) return waitForFreshPlacement(current);
        if (deferUnconfirmedOrder(current, placed)) return false;
        if (placed !== true) { teardown('tracking-lost'); return false; }
        // Either focusable value can reorder native windows. Complete all such
        // changes before the final readonly check, while input is still gated.
        // Chromium's Windows palette must remain focusable to dispatch real
        // button clicks reliably. DOM click smoke tests cannot validate this.
        current.toolbar.showInactive();
        placed = await place({ bounds, visible: true, checkOnly: true, stage: 'tool-final' });
        if (!active()) { if (session === current) suspendWindowsLayers(current); continue; }
        if (placed === TARGET_POSITION_STALE || placed === TARGET_SIZE_UNCONFIRMED) return waitForFreshPlacement(current);
        if (placed !== true) { teardown('tracking-lost'); return false; }
        if (mode !== state.mode) { suspendWindowsLayers(current); continue; }
        current.placementReady = true;
        if (current.retriedExternalInterposer) current.externalRecoveryVerified = true;
        clearTimeout(current.placementDeadline);
        current.placementDeadline = undefined;
        // Do not focus/blur after verification: that would change the Z order.
        current.canvas.setIgnoreMouseEvents(state.mode === 'pointer', { forward: true });
        current.toolbar.setIgnoreMouseEvents(false);
        reportWindowsPlacement(current);
        return true;
      }
      return false;
    })().catch(() => {
      if (session === current) teardown('tracking-lost');
      return false;
    }).finally(() => {
      if (current.placementTask === task) {
        current.placementTask = null;
        // A trusted sample may arrive while a suspended task is draining.
        if (session === current && current.shown && !current.hidden && !current.geometryPending && !current.waitingForPlacementSample && !current.placementReady) void placeWindowsLayers(current);
      }
    });
    current.placementTask = task;
    return task;
  }
  function verifyWindowsLayers(current) {
    if (current.verificationTask || current.placementTask || !current.placementReady || current.hidden || current.geometryPending) return;
    const revision = current.placementRevision;
    traceEvent?.('stationary-start');
    const task = Promise.resolve().then(() => placeWindowCanvas(current.canvas, current.target,
      { bounds: { ...current.bounds }, visible: true, checkOnly: true, stage: 'stationary' })).then(verified => {
      if (session !== current || revision !== current.placementRevision) return;
      traceEvent?.(verified === true ? 'stationary-ok' : 'stationary-fail');
      if (verified === TARGET_POSITION_STALE || verified === TARGET_SIZE_UNCONFIRMED) waitForFreshPlacement(current);
      else if (verified === HIDDEN_EXTERNAL_INTERPOSER && !current.retriedExternalInterposer) {
        // A diagnosis never grants adjacency. Withdraw both layers and input;
        // a fresh sample must pass every native placement check again.
        current.retriedExternalInterposer = true;
        traceEvent?.('external-recovery');
        waitForFreshPlacement(current);
      }
      else if ((verified === HIDDEN_HOST_NEIGHBOR || verified === HIDDEN_HOST_TARGET_NOT_BELOW) && state.mode === 'pointer' && !current.retriedHiddenNeighbor) {
        // A diagnosis is not proof of safe order. Withdraw both layers, allow
        // just one recovery per session, and require full native placement again.
        current.retriedHiddenNeighbor = true;
        // Repeated target activation can still reorder windows after a short
        // delay. Stay passive longer before using the single recovery budget.
        if (verified === HIDDEN_HOST_TARGET_NOT_BELOW) current.recoverySamplesToSkip = 10;
        waitForFreshPlacement(current);
      } else if (verified !== true) teardown('tracking-lost');
    }).catch(() => { if (session === current && revision === current.placementRevision) teardown('tracking-lost'); }).finally(() => {
      if (current.verificationTask === task) current.verificationTask = null;
    });
    // Readback does not reorder or briefly hide a stationary canvas.
    current.verificationTask = task;
  }
  // Focusing the canvas reorders top-most windows on Windows, where the
  // relative level is ignored; keep the toolbar above it.
  function raiseToolbar() {
    if (session?.target) {
      if (session.hidden || session.geometryPending || !session.shown) return;
      if (platform === 'win32') {
        // Mouse activation is not a geometry/tool change. Do not hide the
        // newly focused canvas and flip focusability on every drawing click.
        // Owner ordering handles the palette; exact readonly checks still run.
        verifyWindowsLayers(session);
        return;
      }
      orderWindowLayers(session);
      // Windows single-window placement owns the entire ordering transaction.
      // moveTop on the owned toolbar can also reorder its canvas owner after
      // placement/readback, invalidating the very adjacency just verified.
    }
    const toolbar = session?.toolbar;
    if (live(toolbar)) toolbar.moveTop?.();
  }
  function harden(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler?.(() => false);
  }

  function windowEvent(current, kind, data = {}) {
    const main = getMainWindow();
    if (current?.target && live(main)) main.webContents.send('jugglework:meeting:window-annotation', {
      captureId: current.target.captureId, annotationId: current.annotationId, seq: ++current.seq, kind, ...data,
    });
  }

  function teardown(reason = 'manual') {
    if (session || pendingWindow) traceEvent?.('closed');
    if (session || pendingWindow) lastRecoveryState = session?.retriedExternalInterposer ?
      (session.externalRecoveryVerified ? 'recovered-then-lost' : 'recovery-not-verified') : undefined;
    if (session || pendingWindow) lastExitReason = reason === 'manual' ? undefined : reason;
    const current = session;
    session = null;
    opening = null;
    const pending = pendingWindow;
    pendingWindow = null;
    pending?.cancel();
    // A confirmed target closure must stop sharing even before layers exist.
    if (current?.shown || reason === 'target-closed') windowEvent(current ?? pending, 'closed', { reason });
    if (!current) return;
    clearTimeout(current.placementDeadline);
    current.detach();
    for (const win of [current.toolbar, current.canvas]) if (live(win)) win.destroy();
  }

  async function create(displayId, ticket = null, bounds = null, initialSize = bounds) {
    const windowTarget = ticket?.target ?? null;
    const target = windowTarget ? getDisplayMatching?.(bounds) : display(displayId);
    if (!target) throw new Error("被共享的屏幕已断开");
    const common = {
      show: false, frame: false, hasShadow: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: preloadPath, partition: "meeting-annotation", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    };
    const initialFocusable = platform !== 'win32';
    const toolbarFocusable = platform === 'win32' && windowTarget ? true : initialFocusable;
    const canvas = new BrowserWindow({ ...common, ...(bounds ?? target.bounds), transparent: true, backgroundColor: "#00000000", enableLargerThanScreen: true, focusable: initialFocusable });
    focusableByWindow.set(canvas, initialFocusable);
    // Windows ignores the relative top-most level, so a focused canvas would
    // cover the toolbar. An owned window always stays above its owner there.
    // macOS keeps the level-based ordering (child windows would follow the canvas).
    const toolbar = new BrowserWindow({ ...common, ...annotationToolbarBounds(target.workArea), ...(platform === "win32" ? { parent: canvas } : {}),
      transparent: true, backgroundColor: "#00000000", focusable: toolbarFocusable });
    focusableByWindow.set(toolbar, toolbarFocusable);
    // The canvas must stay capturable; only the toolbar is excluded.
    toolbar.setContentProtection(true);
    if (!windowTarget) canvas.setAlwaysOnTop(true, "screen-saver");
    if (!windowTarget || platform !== 'win32') toolbar.setAlwaysOnTop(true, "screen-saver", 1);
    for (const win of [canvas, toolbar]) {
      if (!windowTarget || win === toolbar) win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      harden(win);
    }
    const close = () => { if (session?.canvas === canvas) teardown(); };
    const onDisplayRemoved = (_event, removed) => { if (removed?.id === displayId) close(); };
    const onMetrics = (_event, changed) => {
      if (windowTarget) { if (session?.canvas === canvas) reportSize(session); return; }
      if (changed?.id !== displayId || !live(canvas)) return;
      canvas.setBounds(changed.bounds);
    };
    const onMainNavigate = (details) => { if (details?.isMainFrame !== false && !details?.isSameDocument) close(); };
    const main = getMainWindow(), meeting = getMeetingWindow();
    const mainContents = live(main) ? main.webContents : null;
    canvas.on("closed", close); toolbar.on("closed", close);
    canvas.on("focus", raiseToolbar);
    for (const [win, role] of [[canvas, 'canvas'], [toolbar, 'toolbar']]) {
      win.on('focus', () => traceEvent?.(`${role}-focus`));
      win.on('blur', () => traceEvent?.(`${role}-blur`));
    }
    canvas.webContents.on("render-process-gone", close); toolbar.webContents.on("render-process-gone", close);
    meeting?.on("closed", close);
    main?.on("closed", close);
    mainContents?.on("did-start-navigation", onMainNavigate);
    mainContents?.on("render-process-gone", close);
    screen.on("display-removed", onDisplayRemoved);
    screen.on("display-metrics-changed", onMetrics);
    const detach = () => {
      screen.removeListener("display-removed", onDisplayRemoved);
      screen.removeListener("display-metrics-changed", onMetrics);
      meeting?.removeListener("closed", close);
      main?.removeListener("closed", close);
      if (mainContents && !mainContents.isDestroyed()) {
        mainContents.removeListener("did-start-navigation", onMainNavigate);
        mainContents.removeListener("render-process-gone", close);
      }
    };
    const current = { canvas, toolbar, displayId: target.id, target: windowTarget, bounds, initialSize, annotationId: ticket?.annotationId, registerLayers: ticket?.registerLayers, seq: 0, geometryKey: '', hidden: false, minimized: false, shown: false, announced: false,
      geometryPending: false, geometryRecovery: false,
      waitingForPlacementSample: false, retriedHiddenNeighbor: false, deferredRecoveryOrder: false, recoverySamplesToSkip: 0,
      placementDeadline: /** @type {ReturnType<typeof setTimeout> | undefined} */ (undefined),
      placementReady: false, placementRevision: 0, placementTask: /** @type {Promise<boolean> | null} */ (null),
      verificationTask: /** @type {Promise<void> | null} */ (null), detach };
    session = current;
    // Every annotation session starts on the mouse tool with an empty canvas.
    state = initialState();
    await Promise.all([loadPage(canvas, "canvas"), loadPage(toolbar, "toolbar")]);
    // Closed while loading: never reveal stale windows.
    if (session !== current || !live(canvas) || !live(toolbar)) { if (session === current) teardown(); return; }
    current.shown = true;
    if (!current.hidden) await showLayers(current);
    if (session !== current) return;
    if (windowTarget) {
      current.announced = true;
      windowEvent(current, 'opened');
      if (current.geometryRecovery) windowEvent(current, 'geometry-pending');
      if (current.minimized) windowEvent(current, 'paused');
      if (platform === 'win32') reportWindowsPlacement(current);
      else if (!current.minimized) reportSize(current);
    }
    publish();
  }

  function showLayers(current) {
    if (current.target && platform === 'win32') return placeWindowsLayers(current);
    current.canvas.setIgnoreMouseEvents(state.mode === 'pointer', { forward: true });
    setFocusable(current.toolbar, true);
    for (const win of [current.canvas, current.toolbar]) win.showInactive();
    applyMode();
    if (platform === 'darwin' && session === current && current.registerLayers) {
      current.registerLayers([Number(/^window:(\d+):/.exec(current.canvas.getMediaSourceId())?.[1])]);
      current.registerLayers = null;
    }
  }

  function reportSize(current) {
    if (!current.shown || current.hidden || current.geometryPending || !current.bounds ||
        (platform === 'win32' && current.target && (!current.placementReady || !current.announced))) return;
    const factor = getDisplayMatching?.(current.bounds)?.scaleFactor;
    if (!(factor > 0)) return;
    const width = Math.round(current.bounds.width * factor), height = Math.round(current.bounds.height * factor);
    const key = `${width}:${height}`;
    if (current.geometryKey === key) return;
    current.geometryKey = key;
    windowEvent(current, 'geometry', { width, height });
  }

  function getReadyWindow() {
    const canPlaceCanvas = platform === 'darwin' || (platform === 'win32' && typeof placeWindowCanvas === 'function');
    const target = canPlaceCanvas && watchWindow && getSharedWindow?.();
    return target && target.captureId === readyCaptureId ? target : null;
  }

  async function openWindow(target) {
    if (session?.target?.captureId === target.captureId || pendingWindow?.target.captureId === target.captureId) return;
    teardown();
    /** @type {ReturnType<NonNullable<typeof watchWindow>> | undefined} */
    let stop;
    let rejectOpen, ticket;
    const main = getMainWindow(), meeting = getMeetingWindow();
    const mainContents = live(main) ? main.webContents : null;
    const cancel = () => { if (pendingWindow === ticket) teardown(); };
    const onNavigate = details => { if (details?.isMainFrame !== false && !details?.isSameDocument) cancel(); };
    const openingWindow = new Promise((resolve, reject) => {
      rejectOpen = reject;
      ticket = { target, annotationId: randomUUID(), seq: 0, registerLayers: ids => stop?.setOverlayWindows(ids), cancel: () => {
        stop?.();
        meeting?.removeListener('closed', cancel);
        main?.removeListener('closed', cancel);
        if (mainContents && !mainContents.isDestroyed()) {
          mainContents.removeListener('did-start-navigation', onNavigate);
          mainContents.removeListener('render-process-gone', cancel);
        }
        resolve(undefined);
      } };
      pendingWindow = ticket;
      meeting?.on('closed', cancel);
      main?.on('closed', cancel);
      mainContents?.on('did-start-navigation', onNavigate);
      mainContents?.on('render-process-gone', cancel);
      stop = watchWindow(target, sample => {
        if (pendingWindow !== ticket) return;
        if (!live(meeting) || !live(main) || getReadyWindow()?.captureId !== target.captureId) { cancel(); return; }
        try {
          const current = session;
          const nativeSizeRequired = platform === 'win32';
          const classified = classifyWindowSample(current?.initialSize ?? null, sample, nativeSizeRequired);
          const change = classified === 'pending' && !nativeSizeRequired ? 'unavailable' : classified;
          if (change === 'resize' || change === 'close' || change === 'unavailable') {
            if (!current && change === 'unavailable') reject(sample.status === 'needs-accessibility'
              ? new Error('请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许窗口跟踪后重试。')
              : new Error('无法跟踪共享窗口，窗口共享仍在继续。'));
            teardown(change === 'resize' ? 'resized' : change === 'close' ? 'target-closed' : 'tracking-lost');
            return;
          }
          if (change === 'pending') {
            // Before the first trusted visible sample there is no canvas or
            // renderer session to suspend. The identity observer bounds this wait.
            if (!current) return;
            current.geometryPending = true;
            current.placementRevision++;
            suspendWindowsGeometry(current);
            return;
          }
          if (!current) {
            if (sample.status !== 'visible') { reject(new Error('请恢复共享窗口后再开启标注。')); teardown(); return; }
            create(null, ticket, sample.bounds, nativeSizeRequired ? sample.actualSize : sample.bounds).then(resolve, reject);
            return;
          }
          const wasHidden = current.hidden;
          const wasMinimized = current.minimized;
          const wasPending = current.geometryPending;
          current.hidden = change === 'hide';
          if (current.hidden) {
            current.placementRevision++;
            // Hidden samples can be part of a Dock transition, not a restore.
            if (sample.status === 'minimized') current.minimized = true;
            if (platform === 'win32') suspendWindowsLayers(current);
            else for (const win of [current.canvas, current.toolbar]) if (live(win)) win.hide();
            if (current.shown && !wasMinimized && current.minimized) windowEvent(current, 'paused');
          } else if (sample.status === 'visible') {
            current.geometryPending = false;
            if (platform === 'win32' && current.waitingForPlacementSample && current.recoverySamplesToSkip > 0) {
              current.recoverySamplesToSkip--;
              return;
            }
            const wasWaiting = current.waitingForPlacementSample;
            current.waitingForPlacementSample = false;
            if (platform !== 'win32') current.minimized = false;
            const geometryChanged = wasHidden || wasPending || wasWaiting || ['x', 'y', 'width', 'height'].some(key => current.bounds[key] !== sample.bounds[key]);
            if (geometryChanged) {
              current.placementRevision++;
              if (platform === 'win32') suspendWindowsGeometry(current);
            }
            current.bounds = sample.bounds;
            current.displayId = getDisplayMatching?.(sample.bounds)?.id ?? current.displayId;
            if (platform !== 'win32' || geometryChanged) current.canvas.setBounds(sample.bounds);
            if (current.shown) {
              if (platform === 'win32') {
                if (!geometryChanged) { verifyWindowsLayers(current); return; }
                void placeWindowsLayers(current);
                return;
              }
              if (wasHidden) showLayers(current);
              else raiseToolbar();
              if (session === current) {
                if (wasMinimized) windowEvent(current, 'resumed');
                reportSize(current);
              }
            }
          }
        } catch (error) { reject(error); if (pendingWindow === ticket) teardown('tracking-lost'); }
      }, event => {
        const current = session;
        if (pendingWindow !== ticket || !current || current.annotationId !== ticket.annotationId) return;
        if (event !== 'edge-overlap') orderWindowLayers(current, event === 'order-interleaved');
      });
      // A synchronous terminal sample can cancel before watchWindow returns stop.
      if (pendingWindow !== ticket) stop?.();
    });
    const cancelStartup = () => { if (pendingWindow === ticket) { rejectOpen(new Error('无法开启窗口标注，窗口共享仍在继续。')); teardown(); } };
    const timer = setTimeout(cancelStartup, 3500);
    try { await openingWindow; } catch (error) { if (pendingWindow === ticket) teardown(); throw error; }
    finally { clearTimeout(timer); }
  }

  function setTool(tool) {
    traceEvent?.(modeOf(tool.tool) === 'pointer' ? 'tool-pointer' : 'tool-draw');
    const mode = modeOf(tool.tool);
    const changed = mode !== state.mode;
    state = { ...state, mode, tool: { tool: tool.tool, color: tool.color.toLowerCase(), size: STROKE_SIZE } };
    if (changed) applyMode();
    publish();
  }

  ipcMain.handle("jugglework:annotation:init", (event) => {
    if (!session || (event.sender !== session.canvas.webContents && event.sender !== session.toolbar.webContents)) throw new Error("标注已结束");
    return session.target ? { ...state, windowShare: true } : state;
  });
  ipcMain.on("jugglework:annotation:command", (event, command) => {
    if (!session) return;
    const fromToolbar = event.sender === session.toolbar.webContents;
    const fromCanvas = event.sender === session.canvas.webContents;
    if (command?.type === "exit" && fromToolbar) { teardown(); return; }
    // Esc on the canvas puts the mouse back; the strokes stay.
    if (command?.type === "escape" && fromCanvas) { setTool({ ...state.tool, tool: "pointer" }); return; }
    if (!fromToolbar) return;
    if (command?.type === "tool" && validTool(command.tool)) {
      setTool(command.tool);
    } else if (command?.type === "action" || ACTIONS.has(command?.type)) {
      const action = command.type === "action" ? command.action : command.type;
      if (ACTIONS.has(action) && live(session.canvas)) session.canvas.webContents.send("jugglework:annotation:action", action);
    } else if (command?.type === "move" && Number.isFinite(command.dx) && Number.isFinite(command.dy)) {
      const target = display(session.displayId);
      const toolbar = session.toolbar;
      if (!target || !live(toolbar)) return;
      const b = toolbar.getBounds(), area = target.bounds;
      toolbar.setBounds({ ...b,
        x: Math.round(Math.max(area.x, Math.min(b.x + command.dx, area.x + area.width - b.width))),
        y: Math.round(Math.max(area.y, Math.min(b.y + command.dy, area.y + area.height - b.height))) });
    }
  });
  ipcMain.on("jugglework:annotation:history", (event, history) => {
    if (!session || event.sender !== session.canvas.webContents) return;
    state = { ...state, history: { canUndo: history?.canUndo === true, canClear: history?.canClear === true } };
    if (live(session.toolbar)) session.toolbar.webContents.send("jugglework:annotation:state", state);
  });
  ipcMain.on('jugglework:annotation:scene', (event, scene) => {
    const current = session;
    if (!current?.target || !current.shown || event.sender !== current.canvas.webContents || event.senderFrame !== current.canvas.webContents.mainFrame) return;
    if (platform === 'win32' && (current.hidden || current.geometryPending || !current.placementReady || !current.announced)) return;
    if (!validScene(scene)) { teardown('tracking-lost'); return; }
    windowEvent(current, 'scene', { scene });
  });

  return {
    state(event) {
      assertMain(event);
      const meeting = getMeetingWindow();
      const id = getSharedDisplayId();
      return { available: Boolean(live(meeting) && ((id !== null && display(id)) || getReadyWindow())), active: Boolean(session),
        ...(lastExitReason ? { lastExitReason } : {}),
        ...(lastExitReason === 'tracking-lost' && getPlacementFailure?.() ? {
          lastExitDetail: `${getPlacementFailure()}${lastRecoveryState ? ':' + lastRecoveryState : ''}` } : {}) };
    },
    async open(event) {
      assertMain(event);
      traceEvent?.('open');
      lastExitReason = undefined;
      lastRecoveryState = undefined;
      const meeting = getMeetingWindow();
      const windowTarget = getReadyWindow();
      if (live(meeting) && windowTarget) return openWindow(windowTarget);
      const id = getSharedDisplayId();
      if (!live(meeting) || id === null || !display(id)) throw new Error("只有共享整个屏幕时才能标注");
      if (session && session.displayId === id) { applyMode(); return; }
      if (session) teardown();
      opening = create(id);
      try { await opening; } catch (error) { teardown(); throw error; }
    },
    /** shareStopped: the meeting share ended, so the screen source is gone too. */
    close(event, { shareStopped = false } = {}) {
      assertMain(event);
      teardown();
      if (shareStopped) { readyCaptureId = null; clearShared(); }
    },
    windowShareReady(event, { captureId, ready }) {
      assertMain(event);
      if (getSharedWindow?.()?.captureId !== captureId) return;
      readyCaptureId = ready === true ? captureId : null;
      if (!readyCaptureId && (session?.target?.captureId === captureId || pendingWindow?.target.captureId === captureId)) teardown();
    },
    isActive: () => Boolean(session),
  };
}

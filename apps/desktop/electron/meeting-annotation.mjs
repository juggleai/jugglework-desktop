// Screen annotation for whole-screen meeting shares. A transparent, top-most
// canvas covers the shared display so the system capture records the strokes;
// a separate, content-protected toolbar drives it. Neither window loads the
// app runtime, IM or meeting media.
// Tools follow Feishu meetings: "pointer" (鼠标, the default) lets the mouse
// through to the apps below; every other tool draws on the canvas.
import { randomUUID } from 'node:crypto';
import { classifyWindowSample } from './meeting-window-tracker.mjs';

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
 *     request: {bounds: any, visible: boolean, checkOnly?: boolean}) => boolean | Promise<boolean>,
 *   getDisplayMatching?: (bounds: any) => any }} options
 */
export function createMeetingAnnotation({ BrowserWindow, screen, ipcMain, preloadPath, loadPage, getMainWindow, getMeetingWindow, getSharedDisplayId, clearShared, platform = process.platform, getSharedWindow, watchWindow, placeWindowCanvas, getDisplayMatching }) {
  let session = null;
  let opening = null;
  let state = initialState();
  let readyCaptureId = null;
  let pendingWindow = null;

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
      canvas.setFocusable(false);
    } else {
      canvas.setFocusable(true);
      canvas.setIgnoreMouseEvents(false);
      canvas.focus();
    }
    raiseToolbar();
  }
  function orderWindowLayers(current, bestEffort = false) {
    const {canvas, target} = current;
    if (!target || current.hidden || !current.shown || !live(canvas)) return;
    if (platform === 'win32') {
      void placeWindowsLayers(current);
      return;
    }
    try {
      canvas.moveAbove(target.sourceId);
    } catch { if (!bestEffort) teardown('tracking-lost'); }
  }
  function suspendWindowsLayers(current) {
    current.placementReady = false;
    current.canvas.setIgnoreMouseEvents(true, { forward: true });
    current.canvas.setFocusable(false);
    current.canvas.hide();
    current.toolbar.hide();
  }
  function placeWindowsLayers(current) {
    if (session !== current || current.hidden || !current.shown) return Promise.resolve(false);
    if (current.placementTask) return current.placementTask;
    suspendWindowsLayers(current);
    const task = (async () => {
      while (session === current && !current.hidden) {
        const revision = current.placementRevision;
        const bounds = { ...current.bounds };
        const active = () => session === current && !current.hidden && revision === current.placementRevision;
        // Both native replies must refer to the same geometry. Hidden placement
        // precedes display; visible readback precedes any drawing input.
        let placed = await placeWindowCanvas(current.canvas, current.target, { bounds, visible: false });
        if (!active()) continue;
        if (placed !== true) { teardown('tracking-lost'); return false; }
        current.canvas.showInactive();
        placed = await placeWindowCanvas(current.canvas, current.target, { bounds, visible: true });
        if (!active()) { if (session === current) suspendWindowsLayers(current); continue; }
        if (placed !== true) { teardown('tracking-lost'); return false; }
        current.placementReady = true;
        // Do not focus/blur here: that would change the just-verified Z order.
        current.canvas.setFocusable(state.mode !== 'pointer');
        current.canvas.setIgnoreMouseEvents(state.mode === 'pointer', { forward: true });
        current.toolbar.showInactive();
        return true;
      }
      return false;
    })().catch(() => {
      if (session === current) teardown('tracking-lost');
      return false;
    }).finally(() => {
      if (current.placementTask === task) current.placementTask = null;
    });
    current.placementTask = task;
    return task;
  }
  function verifyWindowsLayers(current) {
    if (current.verificationTask || current.placementTask || !current.placementReady || current.hidden) return;
    const revision = current.placementRevision;
    const task = Promise.resolve().then(() => placeWindowCanvas(current.canvas, current.target,
      { bounds: { ...current.bounds }, visible: true, checkOnly: true })).then(verified => {
      if (session === current && revision === current.placementRevision && verified !== true) teardown('tracking-lost');
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
      if (session.hidden || !session.shown) return;
      orderWindowLayers(session);
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
    const current = session;
    session = null;
    opening = null;
    const pending = pendingWindow;
    pendingWindow = null;
    pending?.cancel();
    // A confirmed target closure must stop sharing even before layers exist.
    if (current?.shown || reason === 'target-closed') windowEvent(current ?? pending, 'closed', { reason });
    if (!current) return;
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
    const canvas = new BrowserWindow({ ...common, ...(bounds ?? target.bounds), transparent: true, backgroundColor: "#00000000", enableLargerThanScreen: true, focusable: true });
    // Windows ignores the relative top-most level, so a focused canvas would
    // cover the toolbar. An owned window always stays above its owner there.
    // macOS keeps the level-based ordering (child windows would follow the canvas).
    const toolbar = new BrowserWindow({ ...common, ...annotationToolbarBounds(target.workArea), ...(platform === "win32" ? { parent: canvas } : {}),
      transparent: true, backgroundColor: "#00000000", focusable: true });
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
      if (current.minimized) windowEvent(current, 'paused');
      else reportSize(current);
    }
    publish();
  }

  function showLayers(current) {
    if (current.target && platform === 'win32') return placeWindowsLayers(current);
    current.canvas.setIgnoreMouseEvents(state.mode === 'pointer', { forward: true });
    for (const win of [current.canvas, current.toolbar]) win.showInactive();
    applyMode();
    if (platform === 'darwin' && session === current && current.registerLayers) {
      current.registerLayers([Number(/^window:(\d+):/.exec(current.canvas.getMediaSourceId())?.[1])]);
      current.registerLayers = null;
    }
  }

  function reportSize(current) {
    if (!current.shown || current.hidden || !current.bounds ||
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
          const change = classifyWindowSample(current?.initialSize ?? null, sample, nativeSizeRequired);
          if (change === 'resize' || change === 'close' || change === 'unavailable') {
            if (!current && change === 'unavailable') reject(sample.status === 'needs-accessibility'
              ? new Error('请在 macOS「系统设置 → 隐私与安全性 → 辅助功能」中允许窗口跟踪后重试。')
              : new Error('无法跟踪共享窗口，窗口共享仍在继续。'));
            teardown(change === 'resize' ? 'resized' : change === 'close' ? 'target-closed' : 'tracking-lost');
            return;
          }
          if (!current) {
            if (sample.status !== 'visible') { reject(new Error('请恢复共享窗口后再开启标注。')); teardown(); return; }
            create(null, ticket, sample.bounds, nativeSizeRequired ? sample.actualSize : sample.bounds).then(resolve, reject);
            return;
          }
          const wasHidden = current.hidden;
          const wasMinimized = current.minimized;
          current.hidden = change === 'hide';
          if (current.hidden) {
            current.placementRevision++;
            // Hidden samples can be part of a Dock transition, not a restore.
            if (sample.status === 'minimized') current.minimized = true;
            for (const win of [current.canvas, current.toolbar]) if (live(win)) win.hide();
            if (current.shown && !wasMinimized && current.minimized) windowEvent(current, 'paused');
          } else if (sample.status === 'visible') {
            current.minimized = false;
            const geometryChanged = wasHidden || ['x', 'y', 'width', 'height'].some(key => current.bounds[key] !== sample.bounds[key]);
            if (geometryChanged) {
              current.placementRevision++;
              if (platform === 'win32') suspendWindowsLayers(current);
            }
            current.bounds = sample.bounds;
            current.displayId = getDisplayMatching?.(sample.bounds)?.id ?? current.displayId;
            current.canvas.setBounds(sample.bounds);
            if (current.shown) {
              if (platform === 'win32') {
                if (!geometryChanged) { verifyWindowsLayers(current); return; }
                void placeWindowsLayers(current).then(verified => {
                  if (!verified || session !== current || !current.announced || current.hidden) return;
                  if (wasMinimized) windowEvent(current, 'resumed');
                  reportSize(current);
                });
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
    if (platform === 'win32' && (!current.placementReady || !current.announced)) return;
    if (!validScene(scene)) { teardown('tracking-lost'); return; }
    windowEvent(current, 'scene', { scene });
  });

  return {
    state(event) {
      assertMain(event);
      const meeting = getMeetingWindow();
      const id = getSharedDisplayId();
      return { available: Boolean(live(meeting) && ((id !== null && display(id)) || getReadyWindow())), active: Boolean(session) };
    },
    async open(event) {
      assertMain(event);
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

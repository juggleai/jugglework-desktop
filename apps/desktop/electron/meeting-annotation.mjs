// Screen annotation for whole-screen meeting shares. A transparent, top-most
// canvas covers the shared display so the system capture records the strokes;
// a separate, content-protected toolbar drives it. Neither window loads the
// app runtime, IM or meeting media.
// Tools follow Feishu meetings: "pointer" (鼠标, the default) lets the mouse
// through to the apps below; every other tool draws on the canvas.

export const ANNOTATION_TOOLS = ["pointer", "laser", "pen", "highlighter", "ellipse", "rectangle", "arrow", "eraser"];
export const ANNOTATION_COLORS = ["#ef4444", "#facc15", "#22c55e", "#3b82f6", "#a855f7"];
const STROKE_SIZE = 4;
const ACTIONS = new Set(["undo", "clear"]);
const TOOLBAR_SIZE = { width: 600, height: 52 };
const initialState = () => ({ mode: "pointer", tool: { tool: "pointer", color: ANNOTATION_COLORS[0], size: STROKE_SIZE }, history: { canUndo: false, canClear: false } });
const modeOf = (tool) => tool === "pointer" ? "pointer" : "draw";

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
 *   getSharedDisplayId: () => number | null, clearShared: () => void, platform?: string }} options
 */
export function createMeetingAnnotation({ BrowserWindow, screen, ipcMain, preloadPath, loadPage, getMainWindow, getMeetingWindow, getSharedDisplayId, clearShared, platform = process.platform }) {
  let session = null;
  let opening = null;
  let state = initialState();

  const live = (win) => win && !win.isDestroyed();
  const display = (id) => screen.getAllDisplays().find((d) => d.id === id) ?? null;
  function assertMain(event) {
    const main = getMainWindow();
    if (!live(main) || event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame)
      throw new Error("仅主窗口可操作标注");
  }
  function publish() {
    if (!session) return;
    for (const win of [session.canvas, session.toolbar]) if (live(win)) win.webContents.send("jugglework:annotation:state", state);
  }
  function applyMode() {
    const canvas = session?.canvas;
    if (!live(canvas)) return;
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
  // Focusing the canvas reorders top-most windows on Windows, where the
  // relative level is ignored; keep the toolbar above it.
  function raiseToolbar() {
    const toolbar = session?.toolbar;
    if (live(toolbar)) toolbar.moveTop?.();
  }
  function harden(win) {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    win.webContents.session.setPermissionCheckHandler?.(() => false);
  }

  function teardown() {
    const current = session;
    session = null;
    opening = null;
    if (!current) return;
    current.detach();
    for (const win of [current.toolbar, current.canvas]) if (live(win)) win.destroy();
  }

  async function create(displayId) {
    const target = display(displayId);
    if (!target) throw new Error("被共享的屏幕已断开");
    const common = {
      show: false, frame: false, hasShadow: false, skipTaskbar: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: preloadPath, partition: "meeting-annotation", sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    };
    const canvas = new BrowserWindow({ ...common, ...target.bounds, transparent: true, backgroundColor: "#00000000", enableLargerThanScreen: true, focusable: true });
    // Windows ignores the relative top-most level, so a focused canvas would
    // cover the toolbar. An owned window always stays above its owner there.
    // macOS keeps the level-based ordering (child windows would follow the canvas).
    const toolbar = new BrowserWindow({ ...common, ...annotationToolbarBounds(target.workArea), ...(platform === "win32" ? { parent: canvas } : {}),
      transparent: true, backgroundColor: "#00000000", focusable: true });
    // The canvas must stay capturable; only the toolbar is excluded.
    toolbar.setContentProtection(true);
    canvas.setAlwaysOnTop(true, "screen-saver");
    toolbar.setAlwaysOnTop(true, "screen-saver", 1);
    for (const win of [canvas, toolbar]) {
      win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      harden(win);
    }
    const close = () => teardown();
    const onDisplayRemoved = (_event, removed) => { if (removed?.id === displayId) close(); };
    const onMetrics = (_event, changed) => {
      if (changed?.id !== displayId || !live(canvas)) return;
      canvas.setBounds(changed.bounds);
    };
    const onMainNavigate = (details) => { if (details?.isMainFrame !== false && !details?.isSameDocument) close(); };
    const main = getMainWindow(), meeting = getMeetingWindow();
    canvas.on("closed", close); toolbar.on("closed", close);
    canvas.on("focus", raiseToolbar);
    canvas.webContents.on("render-process-gone", close); toolbar.webContents.on("render-process-gone", close);
    meeting?.on("closed", close);
    main?.on("closed", close);
    main?.webContents.on("did-start-navigation", onMainNavigate);
    main?.webContents.on("render-process-gone", close);
    screen.on("display-removed", onDisplayRemoved);
    screen.on("display-metrics-changed", onMetrics);
    const detach = () => {
      screen.removeListener("display-removed", onDisplayRemoved);
      screen.removeListener("display-metrics-changed", onMetrics);
      meeting?.removeListener("closed", close);
      main?.removeListener("closed", close);
      main?.webContents.removeListener("did-start-navigation", onMainNavigate);
      main?.webContents.removeListener("render-process-gone", close);
    };
    const current = { canvas, toolbar, displayId, detach };
    session = current;
    // Every annotation session starts on the mouse tool with an empty canvas.
    state = initialState();
    await Promise.all([loadPage(canvas, "canvas"), loadPage(toolbar, "toolbar")]);
    // Closed while loading: never reveal stale windows.
    if (session !== current || !live(canvas) || !live(toolbar)) { if (session === current) teardown(); return; }
    canvas.showInactive();
    toolbar.showInactive();
    applyMode();
    publish();
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
    return state;
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

  return {
    state(event) {
      assertMain(event);
      const meeting = getMeetingWindow();
      const id = getSharedDisplayId();
      return { available: Boolean(live(meeting) && id !== null && display(id)), active: Boolean(session) };
    },
    async open(event) {
      assertMain(event);
      const meeting = getMeetingWindow();
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
      if (shareStopped) clearShared();
    },
    isActive: () => Boolean(session),
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { annotationToolbarBounds, createMeetingAnnotation } from "./meeting-annotation.mjs";

function fakeWindow(options) {
  /** @type {any} */
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, sent: [], isDestroyed: () => false,
    send(channel, value) { webContents.sent.push([channel, value]); },
    setWindowOpenHandler(fn) { webContents.openHandler = fn; },
    session: { setPermissionRequestHandler(fn) { webContents.permission = fn; }, setPermissionCheckHandler(fn) { webContents.permissionCheck = fn; } },
  });
  /** @type {any} */
  const win = Object.assign(new EventEmitter(), {
    options, webContents, destroyed: false, bounds: { x: options.x, y: options.y, width: options.width, height: options.height },
    ignore: null, focusable: options.focusable !== false, top: null, protected: false, workspaces: null, visible: false, focused: false,
    isDestroyed: () => win.destroyed,
    destroy() { if (win.destroyed) return; win.destroyed = true; win.emit("closed"); },
    setBounds(b) { win.bounds = b; }, getBounds: () => win.bounds,
    setAlwaysOnTop(flag, level, rel) { win.top = [flag, level, rel ?? 0]; },
    setVisibleOnAllWorkspaces(flag, opts) { win.workspaces = [flag, opts]; },
    setContentProtection(flag) { win.protected = flag; },
    setIgnoreMouseEvents(flag, opts) { win.ignore = [flag, opts?.forward === true]; },
    setFocusable(flag) { win.focusable = flag; },
    showInactive() { win.visible = true; }, show() { win.visible = true; },
    raised: 0, moveTop() { win.raised++; },
    focus() { win.focused = true; win.emit("focus"); }, blur() { win.focused = false; },
  });
  return win;
}

function fixture({ displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } },
  { id: 3, bounds: { x: -237, y: -1080, width: 1920, height: 1080 }, workArea: { x: -237, y: -1055, width: 1920, height: 1055 } }],
  shared = 1, platform = "darwin" } = {}) {
  const created = [], handlers = {}, listeners = {};
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays });
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { listeners[c] = fn; } };
  const main = fakeWindow({ x: 0, y: 0, width: 1, height: 1 }), meeting = fakeWindow({ x: 0, y: 0, width: 1, height: 1 });
  let sharedDisplay = shared;
  const annotation = createMeetingAnnotation({
    BrowserWindow: function (options) { const w = fakeWindow(options); created.push(w); return w; },
    screen, ipcMain, preloadPath: "/p.cjs",
    loadPage: async (win, view) => { win.view = view; },
    getMainWindow: () => main, getMeetingWindow: () => meeting,
    getSharedDisplayId: () => sharedDisplay, clearShared: () => { sharedDisplay = null; }, platform,
  });
  const fromMain = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  return { annotation, created, handlers, listeners, screen, main, meeting, fromMain, displays, setShared: (v) => { sharedDisplay = v; } };
}
const [canvasOf, toolbarOf] = [(f) => f.created.find((w) => w.view === "canvas"), (f) => f.created.find((w) => w.view === "toolbar")];

test("toolbar sits centered at the top of the work area", () => {
  assert.deepEqual(annotationToolbarBounds({ x: -237, y: -1055, width: 1920, height: 1055 }, { width: 720, height: 52 }),
    { x: -237 + 600, y: -1055 + 12, width: 720, height: 52 });
  // The default toolbar fits the full tool set on a 1512pt-wide laptop screen.
  const fit = annotationToolbarBounds({ x: 0, y: 25, width: 1512, height: 957 });
  assert.equal(fit.width >= 880 && fit.x + fit.width <= 1512, true);
  assert.deepEqual(annotationToolbarBounds({ x: 0, y: 25, width: 600, height: 900 }, { width: 720, height: 52 }),
    { x: 0, y: 37, width: 600, height: 52 });
});

test("state is only available while a connected whole screen is shared, for the main window only", async () => {
  const f = fixture();
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false });
  f.setShared(null);
  assert.deepEqual(f.annotation.state(f.fromMain), { available: false, active: false });
  assert.throws(() => f.annotation.state({ sender: f.meeting.webContents, senderFrame: f.meeting.webContents.mainFrame }), /主窗口/);
  await assert.rejects(f.annotation.open(f.fromMain), /整个屏幕/);
  assert.equal(f.created.length, 0);
});

test("open covers the full bounds of the shared display; toolbar is protected and above it", async () => {
  const f = fixture({ shared: 3 });
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  assert.deepEqual(canvas.bounds, { x: -237, y: -1080, width: 1920, height: 1080 });
  assert.equal(canvas.options.transparent, true);
  assert.equal(canvas.options.frame, false);
  assert.equal(canvas.options.webPreferences.sandbox, true);
  assert.equal(canvas.options.webPreferences.partition, "meeting-annotation");
  assert.deepEqual(canvas.top, [true, "screen-saver", 0]);
  assert.deepEqual(toolbar.top, [true, "screen-saver", 1]);
  assert.equal(canvas.protected, false, "the canvas must be captured");
  assert.equal(toolbar.protected, true);
  assert.equal(canvas.workspaces[0], true);
  assert.deepEqual(canvas.ignore, [false, false], "starts in draw mode");
  assert.equal(canvas.visible && toolbar.visible, true);
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: true });
  // Second open reuses the same windows.
  await f.annotation.open(f.fromMain);
  assert.equal(f.created.length, 2);
  // Windows deny popups, navigation and permissions.
  assert.deepEqual(canvas.webContents.openHandler(), { action: "deny" });
  let prevented = false; canvas.webContents.emit("will-navigate", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  let granted; canvas.webContents.permission(null, "media", (v) => { granted = v; });
  assert.equal(granted, false);
});

test("pointer mode passes the mouse through and keeps the canvas; draw mode takes it back", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  const fromToolbar = { sender: toolbar.webContents };
  f.listeners["jugglework:annotation:command"](fromToolbar, { type: "mode", mode: "pointer" });
  assert.deepEqual(canvas.ignore, [true, true]);
  assert.equal(canvas.focusable, false);
  assert.equal(canvas.destroyed, false);
  assert.ok(canvas.webContents.sent.some(([c, v]) => c === "jugglework:annotation:state" && v.mode === "pointer"));
  f.listeners["jugglework:annotation:command"](fromToolbar, { type: "mode", mode: "draw" });
  assert.deepEqual(canvas.ignore, [false, false]);
  assert.equal(canvas.focusable, true);
});

test("tool changes and commands from the toolbar reach the canvas; history goes back to the toolbar", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "arrow", color: "#ef4444", size: 6 } });
  assert.deepEqual(canvas.webContents.sent.at(-1)[1].tool, { tool: "arrow", color: "#ef4444", size: 6 });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "undo" });
  assert.deepEqual(canvas.webContents.sent.at(-1), ["jugglework:annotation:action", "undo"]);
  f.listeners["jugglework:annotation:history"]({ sender: canvas.webContents }, { canUndo: true, canRedo: false });
  assert.deepEqual(toolbar.webContents.sent.at(-1)[1].history, { canUndo: true, canRedo: false });
  // Commands from anything but the toolbar, unknown tools and actions are ignored.
  const before = canvas.webContents.sent.length;
  f.listeners["jugglework:annotation:command"]({ sender: canvas.webContents }, { type: "undo" });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "spray", color: "#000", size: 4 } });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "pen", color: "red;}", size: 4 } });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "rm -rf" });
  assert.equal(canvas.webContents.sent.length, before);
});

test("every exit path destroys both windows and becomes inactive", async () => {
  const exits = {
    toolbar: (f) => f.listeners["jugglework:annotation:command"]({ sender: toolbarOf(f).webContents }, { type: "exit" }),
    escape: (f) => f.listeners["jugglework:annotation:command"]({ sender: canvasOf(f).webContents }, { type: "exit" }),
    close: (f) => f.annotation.close(f.fromMain),
    meetingClosed: (f) => f.meeting.emit("closed"),
    mainNavigated: (f) => f.main.webContents.emit("did-start-navigation", { isSameDocument: false, isMainFrame: true }),
    displayRemoved: (f) => f.screen.emit("display-removed", {}, f.displays[0]),
    canvasGone: (f) => canvasOf(f).webContents.emit("render-process-gone"),
    toolbarClosed: (f) => toolbarOf(f).destroy(),
  };
  for (const [name, exit] of Object.entries(exits)) {
    const f = fixture();
    await f.annotation.open(f.fromMain);
    exit(f);
    assert.equal(canvasOf(f).destroyed && toolbarOf(f).destroyed, true, name);
    assert.equal(f.annotation.state(f.fromMain).active, false, name);
  }
});

test("closing from the meeting UI also forgets the shared source", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  f.annotation.close(f.fromMain, { shareStopped: true });
  assert.deepEqual(f.annotation.state(f.fromMain), { available: false, active: false });
});

test("in-page navigation and other displays do not close; metrics changes refit the canvas", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  f.main.webContents.emit("did-start-navigation", { isSameDocument: true, isMainFrame: true });
  f.screen.emit("display-removed", {}, f.displays[1]);
  assert.equal(canvasOf(f).destroyed, false);
  f.displays[0].bounds = { x: 0, y: 0, width: 1728, height: 1117 };
  f.screen.emit("display-metrics-changed", {}, f.displays[0], ["bounds"]);
  assert.deepEqual(canvasOf(f).bounds, { x: 0, y: 0, width: 1728, height: 1117 });
});

test("toolbar drag moves only the toolbar, within the shared display", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const toolbar = toolbarOf(f);
  const start = { ...toolbar.bounds };
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "move", dx: 50, dy: 100 });
  assert.deepEqual(toolbar.bounds, { ...start, x: start.x + 50, y: start.y + 100 });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "move", dx: -99999, dy: 99999 });
  assert.equal(toolbar.bounds.x, 0);
  assert.equal(toolbar.bounds.y, 982 - toolbar.bounds.height);
});

test("a load that finishes after close does not reopen the windows", async () => {
  const f = fixture();
  const releases = [];
  const slow = createMeetingAnnotation({
    BrowserWindow: function (options) { const w = fakeWindow(options); f.created.push(w); return w; },
    screen: f.screen, ipcMain: { handle() {}, on() {} }, preloadPath: "/p.cjs",
    loadPage: (win, view) => { win.view = view; return new Promise((r) => { releases.push(r); }); },
    getMainWindow: () => f.main, getMeetingWindow: () => f.meeting,
    getSharedDisplayId: () => 1, clearShared() {},
  });
  const opening = slow.open(f.fromMain);
  slow.close(f.fromMain);
  releases.forEach((r) => r());
  await opening.catch(() => {});
  assert.equal(f.created.every((w) => w.destroyed && !w.visible), true);
});

test("the toolbar stays above the focused canvas (Windows ignores the relative level)", async () => {
  const mac = fixture();
  await mac.annotation.open(mac.fromMain);
  assert.equal(toolbarOf(mac).options.parent, undefined, "macOS keeps level ordering");
  const f = fixture({ platform: "win32" });
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  assert.equal(toolbar.options.parent, canvas, "an owned window always stays above its owner");
  const before = toolbar.raised;
  canvas.focus();
  assert.equal(toolbar.raised > before, true);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "mode", mode: "pointer" });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "mode", mode: "draw" });
  assert.equal(toolbar.raised > before + 1, true);
});

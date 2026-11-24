import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { annotationToolbarBounds, createMeetingAnnotation } from "./meeting-annotation.mjs";

function fakeWindow(options) {
  /** @type {any} */
  const webContents = Object.assign(new EventEmitter(), {
    mainFrame: {}, sent: [], isDestroyed: () => win.destroyed,
    send(channel, value) { webContents.sent.push([channel, value]); },
    setWindowOpenHandler(fn) { webContents.openHandler = fn; },
    session: { setPermissionRequestHandler(fn) { webContents.permission = fn; }, setPermissionCheckHandler(fn) { webContents.permissionCheck = fn; } },
  });
  /** @type {any} */
  const win = Object.assign(new EventEmitter(), {
    options, destroyed: false, bounds: { x: options.x, y: options.y, width: options.width, height: options.height },
    ignore: null, focusable: options.focusable !== false, top: null, protected: false, workspaces: null, visible: false, focused: false,
    isDestroyed: () => win.destroyed,
    destroy() { if (win.destroyed) return; win.destroyed = true; win.emit("closed"); },
    setBounds(b) { win.bounds = b; }, getBounds: () => win.bounds,
    setAlwaysOnTop(flag, level, rel) { win.top = [flag, level, rel ?? 0]; },
    setVisibleOnAllWorkspaces(flag, opts) { win.workspaces = [flag, opts]; },
    setContentProtection(flag) { win.protected = flag; },
    setIgnoreMouseEvents(flag, opts) { win.ignore = [flag, opts?.forward === true]; },
    setFocusable(flag) { win.focusable = flag; },
    showInactive() { win.visible = true; }, show() { win.visible = true; }, hide() { win.visible = false; },
    moveAbove(id) { win.above = id; win.relativeMoves++; }, relativeMoves: 0,
    getMediaSourceId() { return `window:${win.nativeId}:0`; },
    async loadURL() {},
    raised: 0, moveTop() { win.raised++; },
    blurs: 0, focus() { win.focused = true; win.emit("focus"); }, blur() { win.focused = false; win.blurs++; },
  });
  Object.defineProperty(win, "webContents", { get() {
    if (win.destroyed) throw new Error("Object has been destroyed");
    return webContents;
  } });
  return win;
}

function fixture({ displays = [{ id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 25, width: 1512, height: 957 } },
  { id: 3, bounds: { x: -237, y: -1080, width: 1920, height: 1080 }, workArea: { x: -237, y: -1055, width: 1920, height: 1055 } }],
  shared = 1, platform = "darwin", windowShare = false, initialSample = null,
  placeWindowCanvas = /** @type {Parameters<typeof createMeetingAnnotation>[0]['placeWindowCanvas']} */ (undefined) } = {}) {
  const created = [], handlers = {}, listeners = {};
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => displays });
  const ipcMain = { handle: (c, fn) => { handlers[c] = fn; }, on: (c, fn) => { listeners[c] = fn; } };
  const main = fakeWindow({ x: 0, y: 0, width: 1, height: 1 }), meeting = fakeWindow({ x: 0, y: 0, width: 1, height: 1 });
  let sharedDisplay = shared;
  const target = windowShare ? { kind: /** @type {const} */ ("window"), sourceId: "window:73:0", windowId: 73, pid: 812, captureId: "capture-1" } : null;
  const samples = [], orderLost = [], overlayIds = [];
  let stops = 0;
  const annotation = createMeetingAnnotation({
    BrowserWindow: function (options) { const w = fakeWindow(options); w.nativeId = 100 + created.length; created.push(w); return w; },
    screen, ipcMain, preloadPath: "/p.cjs",
    loadPage: async (win, view) => { win.view = view; },
    getMainWindow: () => main, getMeetingWindow: () => meeting,
    getSharedDisplayId: () => sharedDisplay, clearShared: () => { sharedDisplay = null; }, platform,
    getSharedWindow: () => target,
    placeWindowCanvas,
    watchWindow: (_target, sample, onOrderLost = () => {}) => {
      samples.push(sample);
      orderLost.push(onOrderLost);
      if (initialSample) sample(initialSample);
      return Object.assign(() => { stops++; }, { setOverlayWindows: ids => overlayIds.push(ids) });
    },
    getDisplayMatching: () => ({ ...displays[0], scaleFactor: 2 }),
  });
  const fromMain = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
  return { annotation, created, handlers, listeners, screen, main, meeting, fromMain, displays, samples, orderLost, overlayIds, stopped: () => stops, setShared: (v) => { sharedDisplay = v; } };
}
const [canvasOf, toolbarOf] = [(f) => f.created.find((w) => w.view === "canvas"), (f) => f.created.find((w) => w.view === "toolbar")];

test("toolbar sits centered at the top of the work area", () => {
  assert.deepEqual(annotationToolbarBounds({ x: -237, y: -1055, width: 1920, height: 1055 }, { width: 720, height: 52 }),
    { x: -237 + 600, y: -1055 + 12, width: 720, height: 52 });
  // The default toolbar fits the full tool set on a 1512pt-wide laptop screen.
  const fit = annotationToolbarBounds({ x: 0, y: 25, width: 1512, height: 957 });
  assert.equal(fit.width >= 560 && fit.x + fit.width <= 1512, true);
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
  assert.deepEqual(canvas.ignore, [true, true], "starts on the mouse tool: clicks reach the apps below");
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

const tool = (name, color = "#ef4444") => ({ type: "tool", tool: { tool: name, color, size: 4 } });
const visibleWindow = { status: /** @type {const} */ ("visible"), pid: 812, bounds: { x: 120, y: -100, width: 640, height: 400 } };
const windowEvents = (f) => f.main.webContents.sent.filter(([channel]) => channel === "jugglework:meeting:window-annotation").map(([, event]) => event);

test("Windows cannot start window annotation without a platform canvas placement adapter", () => {
  const f = fixture({ shared: null, platform: "win32", windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  assert.equal(f.annotation.state(f.fromMain).available, false);
  assert.equal(f.created.length, 0);
});

test("Windows shares the borderless session lifecycle and withdraws ink when placement is unverified", async () => {
  let verified = true;
  const calls = [];
  const f = fixture({ shared: null, platform: "win32", windowShare: true,
    placeWindowCanvas: (canvas, target) => { calls.push([canvas, target]); return verified; } });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  assert.equal(f.annotation.state(f.fromMain).available, true);
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  const canvas = canvasOf(f);
  assert.deepEqual(f.created, [canvas, toolbarOf(f)]);
  assert.equal(calls[0][0], canvas);
  assert.equal(calls[0][1].captureId, "capture-1");
  assert.equal(canvas.relativeMoves, 0, "do not fall back to Electron moveAbove on Windows");
  assert.deepEqual(f.overlayIds, [], "do not use the numeric macOS overlay protocol");
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: 150 } });
  assert.equal(canvas.bounds.x, 150);
  assert.equal(f.annotation.isActive(), true);
  verified = false;
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: 151 } });
  await flushPlacement();
  assert.ok(f.created.every(win => win.destroyed));
  assert.equal(windowEvents(f).at(-1).reason, "tracking-lost");
  assert.equal(f.annotation.state(f.fromMain).available, true);
});

test("Windows compares trusted actual size separately from mapped canvas bounds", async () => {
  const f = fixture({ shared: null, platform: "win32", windowShare: true, placeWindowCanvas: () => true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  const mapped = { ...sample, bounds: { ...sample.bounds, width: 641 } };
  f.samples[0](mapped);
  assert.equal(f.annotation.isActive(), true);
  assert.equal(canvasOf(f).bounds.width, 641);
  f.samples[0]({ ...mapped, actualSize: { width: 641, height: 400 } });
  assert.equal(f.annotation.isActive(), false);
  assert.equal(windowEvents(f).at(-1).reason, "resized");
  assert.equal(f.annotation.state(f.fromMain).available, true);
});

const flushPlacement = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("Windows keeps ink hidden and passive until async placement and visible readback both succeed", async () => {
  const replies = [];
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: () => new Promise(resolve => replies.push(resolve)) });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0]({ ...visibleWindow, actualSize: { width: 640, height: 400 } });
  await flushPlacement();
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  assert.equal(canvas.visible, false);
  assert.equal(canvas.ignore[0], true);
  assert.equal(replies.length, 1);
  assert.deepEqual(windowEvents(f), []);
  replies.shift()(true);
  await flushPlacement();
  assert.equal(canvas.visible, true);
  assert.equal(canvas.ignore[0], true);
  assert.equal(toolbar.visible, false);
  assert.deepEqual(windowEvents(f), []);
  replies.shift()(true);
  await opening;
  assert.equal(toolbar.visible, true);
  assert.deepEqual(windowEvents(f).map(event => event.kind), ['opened', 'geometry']);
  assert.equal(toolbar.top, null, 'window toolbar must not create a topmost band');
  f.annotation.close(f.fromMain);
});

test("a late Windows placement success cannot resurrect a closed session", async () => {
  let complete = (_value) => {};
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: () => new Promise(resolve => { complete = resolve; }) });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0]({ ...visibleWindow, actualSize: { width: 640, height: 400 } });
  await flushPlacement();
  f.annotation.close(f.fromMain);
  complete(true);
  await opening;
  await flushPlacement();
  assert.ok(f.created.every(win => win.destroyed && !win.visible));
  assert.equal(windowEvents(f).some(event => event.kind === 'opened'), false);
});

test("unchanged Windows heartbeats do not hide and reshow the canvas", async () => {
  let placements = 0;
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: async (_canvas, _target, request) => { if (!request.checkOnly) placements++; return true; } });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  const count = placements;
  f.samples[0](sample);
  await flushPlacement();
  assert.equal(placements, count);
  assert.equal(canvasOf(f).visible, true);
  f.annotation.close(f.fromMain);
});

test("a failed stationary Windows readback closes annotation but keeps the source", async () => {
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: async (_canvas, _target, request) => !request.checkOnly });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  f.samples[0](sample);
  await flushPlacement();
  assert.ok(f.created.every(win => win.destroyed));
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
  assert.equal(f.annotation.state(f.fromMain).available, true);
});

test("Windows drawing input waits for placement verification and a rejected reply withdraws the layer", async () => {
  let fail = false, rejectPlacement = (_error) => {};
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: () => fail ? new Promise((_resolve, reject) => { rejectPlacement = reject; }) : Promise.resolve(true) });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0]({ ...visibleWindow, actualSize: { width: 640, height: 400 } });
  await opening;
  fail = true;
  f.listeners['jugglework:annotation:command']({ sender: toolbarOf(f).webContents }, tool('pen'));
  assert.equal(canvasOf(f).ignore[0], true);
  assert.equal(canvasOf(f).visible, false);
  rejectPlacement(new Error('native reply lost'));
  await flushPlacement();
  assert.ok(f.created.every(win => win.destroyed));
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
});

test("Windows drops an obsolete placement on move and waits for the latest geometry", async () => {
  const replies = [];
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: (_canvas, _target, request) => new Promise(resolve => replies.push({ resolve, request })) });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await flushPlacement();
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: 150 } });
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(canvasOf(f).visible, false);
  assert.equal(replies[0].request.bounds.x, 150);
  replies.shift().resolve(true);
  await flushPlacement();
  replies.shift().resolve(true);
  await opening;
  assert.equal(canvasOf(f).bounds.x, 150);
  assert.equal(f.annotation.isActive(), true);
  f.annotation.close(f.fromMain);
});

test("a target raised above the ink repairs the relative stack without changing geometry or focus", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opening;
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  const layers = [canvas, ...f.created.filter(win => !win.view)];
  const moves = () => layers.map(win => win.relativeMoves);
  const bounds = layers.map(win => win.bounds);
  const before = windowEvents(f);
  const toolbarRaises = toolbar.raised;

  f.orderLost[0]();

  assert.deepEqual(moves(), [2]);
  assert.deepEqual(layers.map(win => win.above), ["window:73:0"]);
  assert.deepEqual(f.overlayIds, [[100]]);
  assert.deepEqual(windowEvents(f), before);
  assert.ok(layers.every((win, i) => win.bounds === bounds[i] && !win.focused && win.top === null));
  assert.equal(toolbar.raised, toolbarRaises);
  assert.deepEqual(canvas.ignore, [true, true]);

  f.samples[0]({ status: "hidden" });
  f.orderLost[0]();
  assert.deepEqual(moves(), [2], "hidden layers must not be raised");
  f.annotation.close(f.fromMain);
  f.orderLost[0]();
  assert.deepEqual(moves(), [2], "a stopped session must not be raised");
  assert.equal(f.stopped(), 1);
});

test("exhausted order repairs close annotation without clearing the shared window", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opening;

  for (let i = 0; i < 3; i++) f.orderLost[0]();
  f.samples[0]({ status: "unavailable" });

  assert.ok(f.created.every(win => win.destroyed));
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false });
  const events = windowEvents(f);
  assert.deepEqual(events.map(event => event.kind), ["opened", "geometry", "closed"]);
  assert.equal(events.at(-1).reason, "tracking-lost");
  f.orderLost[0]();
  assert.equal(canvasOf(f).relativeMoves, 4);
});

test("a failed best-effort reorder does not close annotation", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opening;
  const canvas = canvasOf(f);
  const moveAbove = canvas.moveAbove;
  canvas.moveAbove = (id) => { moveAbove.call(canvas, id); throw new Error("relative order unavailable"); };

  f.orderLost[0]("order-interleaved");
  assert.equal(canvas.relativeMoves, 2);
  assert.equal(f.annotation.isActive(), true);
  assert.equal(windowEvents(f).some(event => event.kind === "closed"), false);
  f.orderLost[0]("order-lost");
  assert.equal(windowEvents(f).at(-1).reason, "tracking-lost");
});

test("a legacy edge notification does not change canvas input or ordering", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opening = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opening;
  const moves = canvasOf(f).relativeMoves;
  f.orderLost[0]("edge-overlap", [102]);
  assert.equal(canvasOf(f).relativeMoves, moves);
  assert.deepEqual(canvasOf(f).ignore, [true, true]);
  assert.equal(f.annotation.isActive(), true);
  f.annotation.close(f.fromMain);
});

test("window annotation creates no border blockers, follows a move and closes only annotation on resize", async () => {
  const f = fixture({ shared: null, windowShare: true });
  const sample = { status: "visible", pid: 812, bounds: { x: 120, y: -100, width: 640, height: 400 } };
  assert.equal(f.annotation.state(f.fromMain).available, false);
  f.annotation.windowShareReady?.(f.fromMain, { captureId: "capture-1", ready: true });
  assert.equal(f.annotation.state(f.fromMain).available, true);
  const opening = f.annotation.open(f.fromMain);
  f.samples[0](sample);
  await opening;
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  const geometryEvents = () => f.main.webContents.sent.filter(([, event]) => event.kind === "geometry").length;
  assert.equal(geometryEvents(), 1);
  assert.deepEqual(f.created, [canvas, toolbar]);
  assert.equal(canvas.ignore[0], true);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pen"));
  assert.equal(canvas.ignore[0], false);
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: 150 } });
  assert.equal(canvas.bounds.x, 150);
  assert.equal(f.annotation.isActive(), true);
  assert.equal(geometryEvents(), 1, "moving on the same display must not replace the approved capture size");
  f.samples[0]({ status: "hidden" });
  assert.ok(f.created.every(win => !win.visible));
  assert.ok(!f.main.webContents.sent.some(([, event]) => event.kind === "paused"));
  f.samples[0]({ status: "minimized" });
  assert.ok(f.main.webContents.sent.some(([, event]) => event.kind === "paused"));
  f.samples[0](sample);
  assert.ok(canvas.visible && toolbar.visible);
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, height: 401 } });
  assert.ok(f.created.every(win => win.destroyed));
  assert.equal(f.stopped(), 1);
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false });
  assert.ok(f.main.webContents.sent.some(([channel, event]) => channel === "jugglework:meeting:window-annotation" && event.kind === "closed" && event.reason === "resized"));
  const reopening = f.annotation.open(f.fromMain);
  f.samples[1](sample);
  await reopening;
  f.samples[0]({ status: "closed" });
  assert.equal(f.annotation.state(f.fromMain).active, true);
  f.annotation.close(f.fromMain);
});

test("a trusted scene that cannot be delivered does not leave stale ink on the shared output", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.samples[0]({ status: "visible", pid: 812, bounds: { x: 120, y: -100, width: 640, height: 400 } });
  await opened;
  const wc = canvasOf(f).webContents;
  const receive = f.listeners["jugglework:annotation:scene"];
  const scene = { size: { width: 640, height: 400 }, elements: [], lasers: [] };
  receive({ sender: wc, senderFrame: wc.mainFrame }, scene);
  assert.ok(f.main.webContents.sent.some(([, event]) => event.kind === "scene"));
  receive({ sender: wc, senderFrame: wc.mainFrame }, { ...scene, elements: Array(601).fill(null) });
  assert.ok(f.main.webContents.sent.some(([, event]) => event.kind === "closed" && event.reason === "tracking-lost"));
  assert.equal(f.annotation.state(f.fromMain).available, true);
});

test("closing the meeting before the first window sample cancels startup", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.meeting.emit("closed");
  f.samples[0]({ status: "visible", pid: 812, bounds: { x: 0, y: 0, width: 640, height: 400 } });
  await opened;
  assert.equal(f.created.length, 0);
  assert.equal(f.stopped(), 1);
});

for (const delivery of ["asynchronous", "synchronous"]) {
  test(`an initial ${delivery} target closure is delivered once without opening annotation`, async () => {
    const closed = { status: /** @type {const} */ ("closed") };
    const f = fixture({ shared: null, windowShare: true, initialSample: delivery === "synchronous" ? closed : null });
    f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
    const outcome = f.annotation.open(f.fromMain).then(() => null, error => error);

    if (delivery === "asynchronous") f.samples[0](closed);
    f.samples[0](closed);
    f.samples[0](visibleWindow);

    const events = windowEvents(f);
    assert.equal(events.length, 1);
    const [{ annotationId, ...event }] = events;
    assert.ok(annotationId);
    assert.deepEqual(event, { captureId: "capture-1", seq: 1, kind: "closed", reason: "target-closed" });
    assert.equal(f.created.length, 0);
    assert.equal(f.annotation.isActive(), false);
    assert.equal(f.stopped(), 1);
    assert.equal(await outcome, null);
  });
}

test("destroying the host window destroys the window annotation canvas and toolbar", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opened;
  assert.deepEqual(f.created, [canvasOf(f), toolbarOf(f)]);

  assert.doesNotThrow(() => f.main.destroy());

  assert.ok(f.created.every(win => win.isDestroyed()));
  assert.equal(f.annotation.isActive(), false);
  assert.equal(f.stopped(), 1);
});

test("a window resized while minimized closes annotation without resuming it", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opened;
  const before = windowEvents(f).length;

  f.samples[0]({ status: "minimized" });
  f.samples[0]({ status: "hidden" });
  f.samples[0]({ ...visibleWindow, bounds: { ...visibleWindow.bounds, width: 641 } });

  const restoreEvents = windowEvents(f).slice(before);
  assert.deepEqual(restoreEvents.map(event => event.kind), ["paused", "closed"]);
  assert.equal(restoreEvents[1].reason, "resized");
  assert.ok(f.created.every(win => win.isDestroyed()));
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false });
});

test("minimized annotation resumes once on a visible sample with unchanged size", async () => {
  const f = fixture({ shared: null, windowShare: true });
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.samples[0](visibleWindow);
  await opened;
  const before = windowEvents(f).length;
  const restoreKinds = () => windowEvents(f).slice(before).map(event => event.kind);

  f.samples[0]({ status: "minimized" });
  f.samples[0]({ status: "hidden" });
  f.samples[0]({ status: "minimized" });
  assert.deepEqual(restoreKinds(), ["paused"]);
  assert.ok(f.created.every(win => !win.visible));

  f.samples[0](visibleWindow);
  f.samples[0](visibleWindow);
  assert.deepEqual(restoreKinds(), ["paused", "resumed"]);
  assert.ok(f.created.every(win => win.visible));
  f.annotation.close(f.fromMain);
});

test("a lost window order removes all annotation layers without telling media to stop", async () => {
  const f = fixture({ shared: null, windowShare: true });
  const sample = { status: "visible", pid: 812, bounds: { x: 120, y: -100, width: 640, height: 400 } };
  f.annotation.windowShareReady(f.fromMain, { captureId: "capture-1", ready: true });
  const opened = f.annotation.open(f.fromMain);
  f.samples[0](sample);
  await opened;
  canvasOf(f).moveAbove = () => { throw new Error("source unavailable"); };
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: 150 } });
  assert.ok(f.created.every(win => win.destroyed));
  assert.ok(f.main.webContents.sent.some(([, event]) => event.reason === "tracking-lost"));
});

test("the mouse tool passes clicks through and keeps the canvas; a drawing tool takes them back", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  const fromToolbar = { sender: toolbar.webContents };
  assert.equal(canvas.focusable, false);
  f.listeners["jugglework:annotation:command"](fromToolbar, tool("pen"));
  assert.deepEqual(canvas.ignore, [false, false]);
  assert.equal(canvas.focusable, true);
  assert.ok(canvas.webContents.sent.some(([c, v]) => c === "jugglework:annotation:state" && v.mode === "draw" && v.tool.tool === "pen"));
  f.listeners["jugglework:annotation:command"](fromToolbar, tool("pointer"));
  assert.deepEqual(canvas.ignore, [true, true]);
  assert.equal(canvas.focusable, false);
  assert.equal(canvas.destroyed, false);
  // The laser draws on the canvas too.
  f.listeners["jugglework:annotation:command"](fromToolbar, tool("laser"));
  assert.deepEqual(canvas.ignore, [false, false]);
});

test("Esc on the canvas goes back to the mouse tool and keeps the annotation open", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("arrow", "#3b82f6"));
  f.listeners["jugglework:annotation:command"]({ sender: canvas.webContents }, { type: "escape" });
  const last = toolbar.webContents.sent.at(-1)[1];
  assert.deepEqual([last.mode, last.tool.tool, last.tool.color], ["pointer", "pointer", "#3b82f6"]);
  assert.deepEqual(canvas.ignore, [true, true]);
  assert.equal(canvas.destroyed || toolbar.destroyed, false);
  // Only the toolbar can close; the canvas cannot send exit.
  f.listeners["jugglework:annotation:command"]({ sender: canvas.webContents }, { type: "exit" });
  assert.equal(canvas.destroyed, false);
});

test("reopening starts on the mouse tool again", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  f.listeners["jugglework:annotation:command"]({ sender: toolbarOf(f).webContents }, tool("pen", "#22c55e"));
  f.annotation.close(f.fromMain);
  await f.annotation.open(f.fromMain);
  const reopened = f.created.filter((w) => w.view === "toolbar").at(-1);
  const state = await f.handlers["jugglework:annotation:init"]({ sender: reopened.webContents });
  assert.deepEqual([state.mode, state.tool.tool, state.history], ["pointer", "pointer", { canUndo: false, canClear: false }]);
});

test("tool changes and commands from the toolbar reach the canvas; history goes back to the toolbar", async () => {
  const f = fixture();
  await f.annotation.open(f.fromMain);
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  // One fixed stroke width: a size sent by the toolbar is ignored.
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "arrow", color: "#EF4444", size: 30 } });
  assert.deepEqual(canvas.webContents.sent.at(-1)[1].tool, { tool: "arrow", color: "#ef4444", size: 4 });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "undo" });
  assert.deepEqual(canvas.webContents.sent.at(-1), ["jugglework:annotation:action", "undo"]);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "clear" });
  assert.deepEqual(canvas.webContents.sent.at(-1), ["jugglework:annotation:action", "clear"]);
  f.listeners["jugglework:annotation:history"]({ sender: canvas.webContents }, { canUndo: true, canClear: true });
  assert.deepEqual(toolbar.webContents.sent.at(-1)[1].history, { canUndo: true, canClear: true });
  // Commands from anything but the toolbar, unknown tools and actions are ignored.
  const before = canvas.webContents.sent.length;
  f.listeners["jugglework:annotation:command"]({ sender: canvas.webContents }, { type: "undo" });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "spray", color: "#ef4444", size: 4 } });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "tool", tool: { tool: "pen", color: "red;}", size: 4 } });
  // Removed tools and colors outside the Feishu palette are rejected.
  for (const name of ["text", "line"]) f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool(name));
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pen", "#111827"));
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "redo" });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "mode", mode: "draw" });
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, { type: "rm -rf" });
  assert.equal(canvas.webContents.sent.length, before);
});

test("every exit path destroys both windows and becomes inactive", async () => {
  const exits = {
    toolbar: (f) => f.listeners["jugglework:annotation:command"]({ sender: toolbarOf(f).webContents }, { type: "exit" }),
    close: (f) => f.annotation.close(f.fromMain),
    meetingClosed: (f) => f.meeting.emit("closed"),
    mainClosed: (f) => f.main.destroy(),
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
    assert.equal(f.annotation.isActive(), false, name);
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
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pen"));
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pointer"));
  assert.equal(toolbar.raised > before + 1, true);
});

test("going back to the mouse never hides the canvas on macOS (no blur), but still blurs on Windows", async () => {
  for (const { platform, blurs } of [{ platform: "darwin", blurs: 0 }, { platform: "win32", blurs: 1 }]) {
    const f = fixture({ platform });
    await f.annotation.open(f.fromMain);
    const canvas = canvasOf(f), toolbar = toolbarOf(f);
    f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pen"));
    const before = canvas.blurs;
    f.listeners["jugglework:annotation:command"]({ sender: canvas.webContents }, { type: "escape" });
    assert.equal(canvas.blurs - before, blurs, platform);
    assert.deepEqual(canvas.ignore, [true, true], platform);
    assert.equal(canvas.focusable, false, platform);
  }
});

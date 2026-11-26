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
    focusableCalls: [], setFocusable(flag) { win.focusableCalls.push(flag); win.focusable = flag; },
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

async function pendingWindowsPlacement(t) {
  let hold = false;
  const replies = [];
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: (_canvas, _target, request) => hold
      ? new Promise((resolve, reject) => replies.push({ request, resolve, reject })) : true });
  t.after(() => f.annotation.close(f.fromMain));
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  hold = true;
  return { f, sample, replies, canvas: canvasOf(f), toolbar: toolbarOf(f), setHold: value => { hold = value; } };
}

function settleWindowsReply(reply, outcome) {
  assert.ok(reply, '必须存在待完成的原生请求');
  if (outcome === 'reject') reply.reject(new Error('模拟原生请求失败'));
  else reply.resolve(outcome === 'true');
}

async function finishWindowsPlacement(replies) {
  assert.equal(replies.length, 1);
  assert.equal(replies[0].request.visible, false);
  assert.equal(replies[0].request.checkOnly, undefined);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].request.visible, true);
  assert.equal(replies[0].request.checkOnly, undefined);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies.length, 1);
  assert.equal(replies[0].request.visible, true);
  assert.equal(replies[0].request.checkOnly, true);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies.length, 0);
}

const geometryPending = { status: 'geometry-pending' };
const sceneFixture = { size: { width: 640, height: 400 }, elements: [], lasers: [] };
function sendScene(f, canvas, scene = sceneFixture) {
  const wc = canvas.webContents;
  f.listeners['jugglework:annotation:scene']({ sender: wc, senderFrame: wc.mainFrame }, scene);
}
function assertSuspended(canvas, toolbar) {
  assert.equal(canvas.visible || toolbar.visible || canvas.focusable, false);
  assert.deepEqual(canvas.ignore, [true, true]);
  assert.deepEqual(toolbar.ignore, [true, true]);
}

test('Windows starts non-focusable without native false writes and verifies focusability before opening input', async t => {
  const replies = [];
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: (_canvas, _target, request) => new Promise(resolve => replies.push({ request, resolve })) });
  t.after(() => f.annotation.close(f.fromMain));
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await flushPlacement();
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  assert.equal(canvas.options.focusable, false);
  assert.equal(toolbar.options.focusable, true);
  assertSuspended(canvas, toolbar);
  assert.deepEqual(canvas.focusableCalls, []);
  assert.deepEqual(toolbar.focusableCalls, []);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies[0].request.visible, true);
  assert.deepEqual(canvas.focusableCalls, []);
  assert.deepEqual(toolbar.focusableCalls, []);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies[0].request.checkOnly, true);
  assert.deepEqual(canvas.focusableCalls, [], 'pointer 不重复写构造时的 false');
  assert.deepEqual(toolbar.focusableCalls, [], '工具栏从构造起保持可聚焦');
  assert.deepEqual(toolbar.ignore, [true, true]);
  assert.equal(toolbar.visible, true, 'final check must include the displayed but passive toolbar');
  sendScene(f, canvas, null);
  assert.equal(f.annotation.isActive(), true, 'final check 前不接收 scene');
  assert.deepEqual(windowEvents(f), []);
  replies.shift().resolve(true);
  await opening;
  assert.equal(toolbar.visible, true);
  assert.deepEqual(toolbar.ignore, [false, false]);
  assert.deepEqual(canvas.focusableCalls, []);
  assert.deepEqual(toolbar.focusableCalls, []);

  f.samples[0](geometryPending);
  f.samples[0](geometryPending);
  assertSuspended(canvas, toolbar);
  assert.deepEqual(canvas.focusableCalls, []);
  assert.deepEqual(toolbar.focusableCalls, [], '隐藏时不重复写工具栏焦点属性');
  f.samples[0](sample);
  await finishWindowsPlacement(replies);
  assert.deepEqual(canvas.focusableCalls, []);
  assert.deepEqual(toolbar.focusableCalls, []);
});

test('Windows pen, eraser and pointer keep canvas non-focusable and gate mouse input through final checks', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  for (const mode of ['pen', 'pointer', 'eraser', 'pointer']) {
    f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool(mode));
    assert.equal(canvas.ignore[0], true);
    assert.equal(canvas.focusable, false);
    assert.equal(toolbar.visible, false);
    replies.shift().resolve(true);
    await flushPlacement();
    assert.equal(canvas.focusable, false, '绘图也不激活画布');
    assert.equal(toolbar.focusable, true);
    replies.shift().resolve(true);
    await flushPlacement();
    assert.equal(replies[0].request.checkOnly, true);
    assert.equal(canvas.focusable, false);
    assert.equal(toolbar.focusable, true);
    assert.equal(canvas.ignore[0], true);
    assert.equal(toolbar.ignore[0], true);
    assert.equal(toolbar.visible, true);
    const calls = [canvas.focusableCalls.slice(), toolbar.focusableCalls.slice()];
    sendScene(f, canvas);
    assert.equal(windowEvents(f).some(e => e.kind === 'scene'), false);
    replies.shift().resolve(true);
    await flushPlacement();
    assert.deepEqual([canvas.focusableCalls, toolbar.focusableCalls], calls);
    assert.equal(canvas.ignore[0], mode === 'pointer');
    assert.equal(canvas.focusable, false);
    assert.equal(canvas.focused, false, '控制器不主动 focus 画布');
    assert.equal(canvas.blurs, 0, '控制器不通过 blur 改变已复核层级');
    assert.equal(toolbar.focusable, true);
    assert.equal(toolbar.ignore[0], false);
    assert.equal(toolbar.visible, true);
    f.samples[0](sample);
    await flushPlacement();
    replies.shift().resolve(true);
    await flushPlacement();
    assert.deepEqual([canvas.focusableCalls, toolbar.focusableCalls], calls, '静止检查不得重写 focusable');
  }
  assert.deepEqual(canvas.focusableCalls, []);
});

test('Windows single-window canvas focus checks order without hiding or rewriting focusability', async t => {
  const { f, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  const raised = toolbar.raised;
  const calls = [canvas.focusableCalls.slice(), toolbar.focusableCalls.slice()];
  canvas.emit('focus');
  assert.equal(toolbar.raised, raised);
  await flushPlacement();
  assert.equal(canvas.visible && toolbar.visible, true);
  assert.deepEqual([canvas.focusableCalls, toolbar.focusableCalls], calls);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].request.checkOnly, true);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(toolbar.raised, raised);
  assert.equal(f.annotation.isActive(), true);
  assert.equal(toolbar.visible, true);
});

test('Windows tool changes during final check remain gated until the new mouse mode is verified', async t => {
  const { f, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
  replies.shift().resolve(true);
  await flushPlacement();
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(replies[0].request.checkOnly, true);
  assert.equal(canvas.focusable, false);
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pointer'));
  replies.shift().resolve(true);
  await flushPlacement();
  assertSuspended(canvas, toolbar);
  await finishWindowsPlacement(replies);
  assert.equal(canvas.focusable, false);
  assert.deepEqual(canvas.ignore, [true, true]);
  assert.equal(toolbar.visible, true);
  assert.deepEqual(canvas.focusableCalls, []);
});

test('Windows repeated geometry pending preserves ink and tools, rejects scenes and revalidates same-size geometry once', async t => {
  const { f, sample, replies, canvas, toolbar, setHold } = await pendingWindowsPlacement(t);
  setHold(false);
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
  await flushPlacement();
  sendScene(f, canvas);
  const sent = canvas.webContents.sent.length;
  setHold(true);
  f.samples[0](geometryPending);
  f.samples[0](geometryPending);
  assert.equal(f.annotation.isActive(), true);
  assert.equal(f.stopped(), 0);
  assertSuspended(canvas, toolbar);
  assert.equal(canvas.webContents.sent.length, sent, 'pending 不清空画布');
  assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'scene', 'geometry-pending']);
  sendScene(f, canvas, null);
  f.orderLost[0]('order-lost');
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pointer'));
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
  await flushPlacement();
  assert.equal(replies.length, 0, 'pending 不能因工具或排序重新放置');
  f.samples[0](sample);
  f.samples[0](sample);
  assertSuspended(canvas, toolbar);
  sendScene(f, canvas);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry-pending');
  await finishWindowsPlacement(replies);
  assert.equal(canvas.visible && toolbar.visible && toolbar.focusable, true);
  assert.equal(canvas.focusable, false);
  assert.equal(canvas.ignore[0], false);
  assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'scene', 'geometry-pending', 'geometry']);
  assert.equal(windowEvents(f).at(-1).annotationId, windowEvents(f)[0].annotationId);
  sendScene(f, canvas);
  assert.equal(windowEvents(f).at(-1).kind, 'scene');
  f.samples[0](sample);
  await flushPlacement();
  assert.equal(replies[0].request.checkOnly, true);
  replies.shift().resolve(true);
  await flushPlacement();
  assert.equal(windowEvents(f).filter(e => e.kind === 'geometry').length, 2);
  f.samples[0](geometryPending);
  assert.equal(windowEvents(f).filter(e => e.kind === 'geometry-pending').length, 2, '新一轮 pending 可再次通知');
});

for (const terminal of ['resize', 'unavailable', 'closed', 'manual', 'untrusted-visible']) {
  test(`Windows pending 后 ${terminal} 只清理一次且不恢复`, async t => {
    const { f, sample, canvas, toolbar } = await pendingWindowsPlacement(t);
    f.samples[0](geometryPending);
    assert.equal(f.annotation.isActive(), true);
    if (terminal === 'manual') f.annotation.close(f.fromMain);
    else f.samples[0](terminal === 'resize' ? { ...sample, actualSize: { width: 641, height: 400 } }
      : terminal === 'untrusted-visible' ? visibleWindow : { status: terminal });
    assert.equal(canvas.destroyed && toolbar.destroyed, true);
    assert.equal(f.stopped(), 1);
    assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'geometry-pending', 'closed']);
    assert.equal(windowEvents(f).at(-1).reason, terminal === 'resize' ? 'resized' : terminal === 'closed' ? 'target-closed' : terminal === 'manual' ? 'manual' : 'tracking-lost');
    f.samples[0](sample);
    f.annotation.close(f.fromMain);
    assert.equal(f.stopped(), 1);
  });
}

for (const synchronous of [false, true]) {
  test(`Windows pending startup 等待首个可信 visible（同步=${synchronous}）`, async t => {
    const f = fixture({ shared: null, platform: 'win32', windowShare: true,
      initialSample: synchronous ? geometryPending : null, placeWindowCanvas: () => true });
    t.after(() => f.annotation.close(f.fromMain));
    f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
    let settled = false;
    const opening = f.annotation.open(f.fromMain).finally(() => { settled = true; });
    f.samples[0](geometryPending);
    await flushPlacement();
    assert.equal(settled, false);
    assert.equal(f.created.length, 0);
    assert.equal(f.stopped(), 0);
    assert.deepEqual(windowEvents(f), []);
    f.samples[0]({ ...visibleWindow, actualSize: { width: 640, height: 400 } });
    await opening;
    assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry']);
    assert.equal(f.created.length, 2);
  });
}

for (const terminal of ['unavailable', 'closed', 'manual']) {
  test(`Windows pending startup 在 ${terminal} 后停止等待且不创建窗口`, async () => {
    const f = fixture({ shared: null, platform: 'win32', windowShare: true, placeWindowCanvas: () => true });
    f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
    const opening = f.annotation.open(f.fromMain).then(() => null, error => error);
    f.samples[0](geometryPending);
    if (terminal === 'manual') f.annotation.close(f.fromMain);
    else f.samples[0]({ status: terminal });
    const result = await opening;
    assert.equal(result instanceof Error, terminal === 'unavailable');
    assert.equal(f.created.length, 0);
    assert.equal(f.stopped(), 1);
    assert.deepEqual(windowEvents(f).map(e => e.kind), terminal === 'closed' ? ['closed'] : []);
    if (terminal === 'closed') assert.equal(windowEvents(f)[0].reason, 'target-closed');
    f.samples[0]({ ...visibleWindow, actualSize: { width: 640, height: 400 } });
    assert.equal(f.created.length, 0);
    assert.equal(f.main.webContents.listenerCount('did-start-navigation'), 0);
  });
}

test('Windows pending during initial placement never announces geometry or enables drawing before recovery', async t => {
  const replies = [];
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: (_canvas, _target, request) => new Promise((resolve, reject) => replies.push({ request, resolve, reject })) });
  t.after(() => f.annotation.close(f.fromMain));
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await flushPlacement();
  const canvas = canvasOf(f), toolbar = toolbarOf(f);
  const stale = replies.shift();
  f.samples[0](geometryPending);
  f.samples[0](geometryPending);
  stale.resolve(true);
  await opening;
  assertSuspended(canvas, toolbar);
  assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry-pending']);
  sendScene(f, canvas, null);
  assert.equal(f.annotation.isActive(), true);
  f.samples[0](sample);
  await finishWindowsPlacement(replies);
  assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry-pending', 'geometry']);
});

for (const order of ['pending-minimize', 'minimize-pending', 'restore-pending']) {
  test(`Windows ${order} 交叉只发送一次 paused/resumed 与恢复 geometry`, async t => {
    const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
    if (order === 'pending-minimize') f.samples[0](geometryPending);
    f.samples[0]({ status: 'minimized' });
    if (order === 'restore-pending') {
      f.samples[0](sample);
      assert.equal(replies.length, 1);
    }
    f.samples[0](geometryPending);
    f.samples[0]({ status: 'hidden' });
    f.samples[0]({ status: 'minimized' });
    assertSuspended(canvas, toolbar);
    if (replies.length) { replies.shift().resolve(true); await flushPlacement(); }
    assert.equal(replies.length, 0);
    assert.equal(windowEvents(f).filter(e => e.kind === 'paused').length, 1);
    assert.equal(windowEvents(f).filter(e => e.kind === 'geometry-pending').length, 1);
    f.samples[0](sample);
    f.samples[0](sample);
    await finishWindowsPlacement(replies);
    assert.equal(windowEvents(f).filter(e => e.kind === 'resumed').length, 1);
    assert.equal(windowEvents(f).filter(e => e.kind === 'geometry').length, 2);
    assert.deepEqual(windowEvents(f).slice(-2).map(e => e.kind), ['resumed', 'geometry']);
  });
}

for (const stage of ['hidden', 'visible', 'final', 'check']) {
  for (const outcome of ['true', 'false', 'reject']) {
    for (const timing of ['pending', 'restoring']) {
      test(`Windows pending 使 inflight ${stage} ${outcome} 失效（${timing}）`, async t => {
        const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
        if (stage === 'check') { f.samples[0](sample); await flushPlacement(); }
        else {
          f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
          if (stage === 'visible' || stage === 'final') { replies.shift().resolve(true); await flushPlacement(); }
          if (stage === 'final') { replies.shift().resolve(true); await flushPlacement(); }
        }
        const stale = replies.shift();
        f.samples[0](geometryPending);
        assert.equal(f.annotation.isActive(), true);
        assertSuspended(canvas, toolbar);
        if (timing === 'restoring') f.samples[0](sample);
        settleWindowsReply(stale, outcome);
        await flushPlacement();
        assert.equal(f.annotation.isActive(), true);
        assert.equal(f.stopped(), 0);
        assertSuspended(canvas, toolbar);
        if (timing === 'pending') {
          assert.equal(replies.length, 0, '旧 place 循环不得用旧 bounds 在 pending 期间恢复');
          f.samples[0](sample);
        }
        await finishWindowsPlacement(replies);
        assert.equal(canvas.visible && toolbar.visible, true);
        assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'geometry-pending', 'geometry']);
      });
    }
  }
}

for (const outcome of ['true', 'false', 'reject']) {
  test(`Windows pending 前的旧检查在完整恢复后 ${outcome} 不撤层、不多发 geometry`, async t => {
    const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
    f.samples[0](sample);
    await flushPlacement();
    const stale = replies.shift();
    f.samples[0](geometryPending);
    f.samples[0](sample);
    await finishWindowsPlacement(replies);
    const before = windowEvents(f);
    settleWindowsReply(stale, outcome);
    await flushPlacement();
    assert.equal(f.annotation.isActive(), true);
    assert.equal(canvas.visible && toolbar.visible, true);
    assert.deepEqual(windowEvents(f), before);
    f.samples[0](sample);
    await flushPlacement();
    assert.equal(replies[0].request.checkOnly, true);
    replies.shift().resolve(true);
    await flushPlacement();
  });
}

for (const stage of ['hidden', 'visible']) {
  test(`Windows 恢复的 ${stage} 阶段再次 pending 仍只能用新一轮可信几何恢复`, async t => {
    const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
    f.samples[0](geometryPending);
    f.samples[0](sample);
    if (stage === 'visible') { replies.shift().resolve(true); await flushPlacement(); }
    const stale = replies.shift();
    f.samples[0](geometryPending);
    stale.resolve(true);
    await flushPlacement();
    assertSuspended(canvas, toolbar);
    assert.equal(replies.length, 0);
    assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'geometry-pending']);
    f.samples[0](sample);
    await finishWindowsPlacement(replies);
    assert.deepEqual(windowEvents(f).map(e => e.kind), ['opened', 'geometry', 'geometry-pending', 'geometry']);
  });
}

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
  await flushPlacement();
  assert.equal(canvas.ignore[0], true);
  assert.equal(toolbar.visible, true);
  assert.equal(toolbar.ignore[0], true);
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
  let fail = false;
  const f = fixture({ shared: null, platform: 'win32', windowShare: true,
    placeWindowCanvas: async (_canvas, _target, request) => !(fail && request.checkOnly) });
  f.annotation.windowShareReady(f.fromMain, { captureId: 'capture-1', ready: true });
  const opening = f.annotation.open(f.fromMain);
  const sample = { ...visibleWindow, actualSize: { width: 640, height: 400 } };
  f.samples[0](sample);
  await opening;
  fail = true;
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
  await flushPlacement();
  replies.shift().resolve(true);
  await opening;
  assert.equal(canvasOf(f).bounds.x, 150);
  assert.equal(f.annotation.isActive(), true);
  f.annotation.close(f.fromMain);
});

test('Windows stale target position keeps layers hidden until a fresh verified sample', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  const moved = { ...sample, bounds: { ...sample.bounds, x: sample.bounds.x + 10 } };
  f.samples[0](moved);
  replies.shift().resolve('target-position-stale');
  await flushPlacement();
  assert.equal(f.annotation.isActive(), true);
  assert.equal(canvas.visible || toolbar.visible || canvas.focusable, false);
  assert.equal(replies.length, 0, 'must not reissue against the rejected sample');
  assert.equal(windowEvents(f).at(-1).kind, 'geometry-pending');
  const fresh = { ...moved, bounds: { ...moved.bounds, x: moved.bounds.x + 10 } };
  f.samples[0](fresh);
  assert.equal(replies[0].request.bounds.x, fresh.bounds.x);
  await finishWindowsPlacement(replies);
  assert.equal(canvas.visible && toolbar.visible, true);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry');
  f.annotation.close(f.fromMain);
});

test('Windows pointer recovers from a hidden host neighbor only once, with strict revalidation', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-host-neighbor');
  await flushPlacement();
  assertSuspended(canvas, toolbar);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry-pending');
  assert.equal(replies.length, 0);
  f.samples[0](sample);
  await finishWindowsPlacement(replies);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry');
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-host-neighbor');
  await flushPlacement();
  assert.equal(f.annotation.isActive(), false);
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
});

test('Windows pointer target-not-below recovery stays hidden across ten trusted samples', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-host-target-not-below');
  await flushPlacement();
  for (let i = 0; i < 10; i++) {
    f.samples[0](sample);
    assertSuspended(canvas, toolbar);
    assert.equal(replies.length, 0);
  }
  f.samples[0](sample);
  await finishWindowsPlacement(replies);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry');
  assert.equal(canvas.visible && toolbar.visible, true);
});

test('Windows pointer recovery waits once more for order confirmation without reopening input', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-host-neighbor');
  await flushPlacement();
  f.samples[0](sample);
  replies.shift().resolve(true);
  await flushPlacement();
  replies.shift().resolve('placement-order-unconfirmed');
  await flushPlacement();
  assertSuspended(canvas, toolbar);
  assert.equal(replies.length, 0);
  for (let i = 0; i < 2; i++) {
    f.samples[0](sample);
    assert.equal(replies.length, 0);
    assertSuspended(canvas, toolbar);
  }
  f.samples[0](sample);
  replies.shift().resolve('placement-order-unconfirmed');
  await flushPlacement();
  assert.equal(f.annotation.isActive(), false);
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
});

test('Windows drawing does not attempt recovery from a hidden host neighbor', async t => {
  const { f, sample, replies, toolbar } = await pendingWindowsPlacement(t);
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
  await finishWindowsPlacement(replies);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-host-neighbor');
  await flushPlacement();
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
});

test('Windows repeated stale target positions cannot renew the placement deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: sample.bounds.x + 1 } });
  replies.shift().resolve('target-position-stale');
  await flushPlacement();
  t.mock.timers.tick(2400);
  f.samples[0]({ ...sample, bounds: { ...sample.bounds, x: sample.bounds.x + 2 } });
  replies.shift().resolve('target-position-stale');
  await flushPlacement();
  assert.equal(f.annotation.isActive(), true);
  t.mock.timers.tick(100);
  assert.equal(canvas.destroyed && toolbar.destroyed, true);
  assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
});

for (const refusal of ['target-position-stale', 'target-size-unconfirmed']) {
test(`Windows ${refusal} stationary readback suspends ink and a subsequent resize closes annotation`, async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.samples[0](sample);
  await flushPlacement();
  const check = replies.shift();
  assert.equal(check.request.checkOnly, true);
  check.resolve(refusal);
  await flushPlacement();
  assert.equal(canvas.visible || toolbar.visible || canvas.focusable, false);
  assert.equal(windowEvents(f).at(-1).kind, 'geometry-pending');
  assert.equal(replies.length, 0);
  f.samples[0]({ ...sample, actualSize: { ...sample.actualSize, width: sample.actualSize.width + 1 } });
  assert.equal(canvas.destroyed && toolbar.destroyed, true);
  assert.equal(windowEvents(f).at(-1).reason, 'resized');
});
}

for (const outcome of ['false', 'reject']) {
  for (const timing of ['重定位中', '重定位后']) {
    test(`Windows 旧静止检查 ${outcome} 在切工具${timing}返回不撤层`, async t => {
      const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
      f.samples[0](sample);
      await flushPlacement();
      assert.equal(replies.length, 1);
      const check = replies.shift();
      assert.equal(check.request.checkOnly, true);
      f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
      assert.equal(canvas.visible, false);
      assert.deepEqual(canvas.ignore, [true, true]);
      if (timing === '重定位后') await finishWindowsPlacement(replies);
      settleWindowsReply(check, outcome);
      await flushPlacement();
      assert.equal(f.annotation.isActive(), true, '旧检查不能撤销新一轮放置');
      assert.equal(f.stopped(), 0);
      assert.equal(windowEvents(f).some(event => event.kind === 'closed'), false);
      if (timing === '重定位中') {
        assert.equal(canvas.visible || toolbar.visible, false);
        await finishWindowsPlacement(replies);
      }
      assert.equal(canvas.visible && toolbar.visible, true);
      assert.equal(canvas.focusable, false);
      assert.deepEqual(canvas.ignore, [false, true]);
      // A new stationary check must still run after the obsolete check settles.
      f.samples[0](sample);
      await flushPlacement();
      assert.equal(replies.length, 1);
      assert.equal(replies[0].request.checkOnly, true);
      replies.shift().resolve(true);
      await flushPlacement();
      assert.equal(canvas.visible && toolbar.visible, true);
    });
  }
}

for (const outcome of ['false', 'reject']) {
  for (const stage of ['隐藏放置', '可见回读']) {
    for (const transition of ['移动', '最小化']) {
      test(`Windows ${stage}过期 ${outcome} 在${transition}后不撤层并可恢复`, async t => {
        const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
        f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
        if (stage === '可见回读') {
          replies.shift().resolve(true);
          await flushPlacement();
          assert.equal(canvas.visible, true);
        }
        assert.equal(replies.length, 1);
        const stale = replies.shift();
        assert.equal(stale.request.visible, stage === '可见回读');
        const moved = { ...sample, bounds: { ...sample.bounds, x: 150 } };
        f.samples[0](transition === '移动' ? moved : { status: 'minimized' });
        assert.equal(canvas.visible || toolbar.visible, false);
        settleWindowsReply(stale, outcome);
        await flushPlacement();
        assert.equal(f.annotation.isActive(), true, '过期失败不能清理当前会话');
        assert.equal(f.stopped(), 0);
        assert.equal(windowEvents(f).some(event => event.kind === 'closed'), false);
        assert.deepEqual(canvas.ignore, [true, true]);
        assert.equal(canvas.focusable || canvas.visible || toolbar.visible, false);
        if (transition === '最小化') {
          assert.equal(replies.length, 0, '最小化期间不能继续放置');
          assert.deepEqual(windowEvents(f).map(event => event.kind), ['opened', 'geometry', 'paused']);
          f.samples[0](sample);
          f.samples[0](sample);
        }
        assert.equal(replies.length, 1, '最新几何只启动一个放置请求');
        assert.equal(stale.request.bounds.x, sample.bounds.x);
        assert.equal(replies[0].request.bounds.x, transition === '移动' ? 150 : sample.bounds.x);
        const wc = canvas.webContents;
        const scene = { size: { width: 640, height: 400 }, elements: [], lasers: [] };
        f.listeners['jugglework:annotation:scene']({ sender: wc, senderFrame: wc.mainFrame }, scene);
        assert.equal(windowEvents(f).some(event => event.kind === 'scene'), false);
        await finishWindowsPlacement(replies);
        assert.equal(canvas.visible && toolbar.visible, true);
        assert.equal(canvas.focusable, false);
        assert.deepEqual(canvas.ignore, [false, true]);
        assert.deepEqual(windowEvents(f).map(event => event.kind), transition === '移动'
          ? ['opened', 'geometry', 'geometry-pending', 'geometry'] : ['opened', 'geometry', 'paused', 'geometry-pending', 'resumed', 'geometry']);
        f.listeners['jugglework:annotation:scene']({ sender: wc, senderFrame: wc.mainFrame }, scene);
        assert.equal(windowEvents(f).at(-1).kind, 'scene');
        f.annotation.close(f.fromMain);
        assert.equal(f.stopped(), 1);
        assert.ok(f.created.every(win => win.destroyed));
        assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
        assert.equal(f.main.webContents.listenerCount('did-start-navigation'), 0);
      });
    }
  }
}

for (const outcome of ['false', 'reject']) {
  for (const stage of ['隐藏放置', '可见回读', '最终只读检查', '静止检查']) {
    test(`Windows 当前有效${stage} ${outcome} 仍撤层且只清理一次`, async t => {
      const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
      if (stage === '静止检查') {
        f.samples[0](sample);
        await flushPlacement();
      } else {
        f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
        if (stage === '可见回读' || stage === '最终只读检查') {
          replies.shift().resolve(true);
          await flushPlacement();
        }
        if (stage === '最终只读检查') {
          replies.shift().resolve(true);
          await flushPlacement();
          assert.equal(replies[0].request.checkOnly, true);
          assert.equal(canvas.ignore[0], true);
          assert.equal(toolbar.visible, true);
          assert.equal(toolbar.ignore[0], true);
        }
      }
      assert.equal(replies.length, 1);
      settleWindowsReply(replies.shift(), outcome);
      await flushPlacement();
      assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false, lastExitReason: 'tracking-lost' });
      assert.equal(canvas.destroyed && toolbar.destroyed, true);
      assert.equal(f.stopped(), 1);
      assert.deepEqual(windowEvents(f).map(event => event.kind), ['opened', 'geometry', 'closed']);
      assert.equal(windowEvents(f).at(-1).reason, 'tracking-lost');
      f.samples[0](sample);
      f.orderLost[0]('order-lost');
      f.annotation.close(f.fromMain);
      assert.equal(f.stopped(), 1);
      assert.equal(windowEvents(f).length, 3);
      assert.equal(f.screen.listenerCount('display-removed'), 0);
      assert.equal(f.meeting.listenerCount('closed'), 0);
    });
  }
}

for (const outcome of ['true', 'false', 'reject']) {
  for (const stage of ['隐藏放置', '可见回读', '静止检查']) {
    test(`Windows 已关闭会话的${stage}迟到 ${outcome} 不影响重开会话`, async t => {
      const { f, sample, replies, canvas, toolbar, setHold } = await pendingWindowsPlacement(t);
      if (stage === '静止检查') {
        f.samples[0](sample);
        await flushPlacement();
      } else {
        f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
        if (stage === '可见回读') {
          replies.shift().resolve(true);
          await flushPlacement();
        }
      }
      assert.equal(replies.length, 1);
      const stale = replies.shift();
      f.annotation.close(f.fromMain);
      assert.equal(canvas.destroyed && toolbar.destroyed, true);
      const oldVisibility = [canvas.visible, toolbar.visible];
      setHold(false);
      const reopening = f.annotation.open(f.fromMain);
      f.samples[1](sample);
      await reopening;
      const currentCanvas = f.created.at(-2), currentToolbar = f.created.at(-1);
      const before = windowEvents(f);
      settleWindowsReply(stale, outcome);
      await flushPlacement();
      assert.equal(f.annotation.isActive(), true);
      assert.equal(currentCanvas.visible && currentToolbar.visible, true);
      assert.equal(currentCanvas.destroyed || currentToolbar.destroyed, false);
      assert.deepEqual(currentCanvas.ignore, [true, true]);
      assert.deepEqual([canvas.visible, toolbar.visible], oldVisibility, '旧窗口不能被迟到结果重新显示');
      assert.deepEqual(windowEvents(f), before);
      assert.equal(replies.length, 0);
      assert.equal(f.stopped(), 1);
      f.annotation.close(f.fromMain);
      assert.equal(f.stopped(), 2);
      assert.equal(f.main.webContents.listenerCount('did-start-navigation'), 0);
      assert.equal(f.screen.listenerCount('display-metrics-changed'), 0);
    });
  }
}

test('hidden external interposer in drawing mode permits one gated recovery only', async t => {
  const { f, sample, replies, canvas, toolbar } = await pendingWindowsPlacement(t);
  f.listeners['jugglework:annotation:command']({ sender: toolbar.webContents }, tool('pen'));
  await finishWindowsPlacement(replies);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-external-interposer');
  await flushPlacement();
  assertSuspended(canvas, toolbar);
  assert.equal(f.annotation.isActive(), true);
  f.samples[0](sample);
  await finishWindowsPlacement(replies);
  assert.equal(canvas.ignore[0], false);
  assert.equal(canvas.focusable, false);
  f.samples[0](sample);
  await flushPlacement();
  replies.shift().resolve('hidden-external-interposer');
  await flushPlacement();
  assert.equal(f.annotation.isActive(), false);
  assert.equal(canvas.destroyed && toolbar.destroyed, true);
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
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false, lastExitReason: 'tracking-lost' });
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
  assert.equal(canvas.focusable, true, 'macOS 单窗绘图仍可聚焦');
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
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false, lastExitReason: 'resized' });
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
  assert.deepEqual(f.annotation.state(f.fromMain), { available: true, active: false, lastExitReason: 'resized' });
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
  assert.equal(canvas.focusable, true, 'Windows 整屏绘图仍可聚焦');
  assert.deepEqual(canvas.ignore, [false, false]);
  f.listeners["jugglework:annotation:command"]({ sender: toolbar.webContents }, tool("pointer"));
  assert.equal(canvas.focusable, false);
  assert.deepEqual(canvas.ignore, [true, true]);
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

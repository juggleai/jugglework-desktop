import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMeetingSemanticAnnotation, semanticToolbarWidth } from './meeting-semantic-annotation.mjs';

function window(options) {
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, sent: [], isDestroyed: () => win.destroyed,
    send(channel, value) { contents.sent.push([channel, value]); }, setWindowOpenHandler() {},
    session: { setPermissionRequestHandler() {} } });
  const win = Object.assign(new EventEmitter(), { options, destroyed: false, visible: false, contentProtected: false, bounds: options,
    webContents: contents, isDestroyed: () => win.destroyed, destroy() { if (win.destroyed) return; win.destroyed = true; win.emit('closed'); }, showInactive() { win.visible = true; },
    hide() { win.visible = false; }, getBounds() { return win.bounds; }, setBounds(value) { win.bounds = value; },
    setContentProtection(value) { win.contentProtected = value; }, setAlwaysOnTop() {} });
  return win;
}

function fixture({ displays = [{ id: 1, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }] } = {}) {
  const handlers = {}, listeners = {}, created = [], samples = [], nativeInputs = [], nativeStates = [], nativeExits = [], nativeScenes = [];
  let watcherStops = 0;
  const ipcMain = { handle(channel, fn) { handlers[channel] = fn; }, on(channel, fn) { listeners[channel] = fn; } };
  const main = window({}), meeting = window({});
  const target = { kind: 'window', platform: 'win32', captureId: 'capture', sourceId: 'window:7:0', windowId: '7', pid: 8, processStartedAt: '9' };
   const nativeLasers = [];
   const native = { sessionId: 'semantic_session_123456', hello: Promise.resolve(true),
    onInput(fn) { nativeInputs.push(fn); return () => {}; }, onState(fn) { nativeStates.push(fn); return () => {}; }, onExit(fn) { nativeExits.push(fn); return () => {}; },
     setMode: async () => ({ ok: true }), setScene: async scene => { nativeScenes.push(scene); return { ok: true }; },
      setPreview: async () => ({ ok: true }), setLasers: async value => { nativeLasers.push(value); return { ok: true }; }, abort: async () => ({ ok: true }), close: async () => ({ ok: true }), async dispose() { return { exited: true }; } };
  const controller = createMeetingSemanticAnnotation({
    BrowserWindow: function (options) { const result = window(options); created.push(result); return result; },
    screen: { getAllDisplays: () => displays }, ipcMain, preloadPath: 'semantic.cjs', loadPage: async win => { win.loaded = true; },
    getMainWindow: () => main, getMeetingWindow: () => meeting, getSharedWindow: () => target,
    watchWindow: (_target, callback) => { samples.push(callback); return () => { watcherStops++; }; }, openNative: async () => native,
    clearShared() {}, enabled: true,
  });
  const event = { sender: main.webContents, senderFrame: main.webContents.mainFrame };
    return { controller, handlers, listeners, created, samples, nativeInputs, nativeStates, nativeExits, nativeScenes, nativeLasers, native,
     get watcherStops() { return watcherStops; }, main, event, target };
}

test('semantic single-window session requires trusted mapping and creates only a protected toolbar', async () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  assert.equal(f.controller.state(f.event).available, false);
  f.samples[0]({ status: 'visible', bounds: { x: 1, y: 2, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } });
  assert.equal(f.controller.state(f.event).available, true);
  await f.controller.open(f.event);
  assert.equal(f.created.length, 1);
  assert.equal(f.created[0].contentProtected, true);
  assert.equal(f.created[0].options.parent, undefined);
  assert.equal(f.created[0].options.width, semanticToolbarWidth(8));
  assert.deepEqual((await f.handlers['jugglework:semantic-annotation:init']({ sender: f.created[0].webContents,
    senderFrame: f.created[0].webContents.mainFrame })).capabilities, { backend: 'windows-semantic', selected: true,
      tools: ['pointer', 'laser', 'pen', 'highlighter', 'ellipse', 'rectangle', 'arrow', 'eraser'], history: ['undo', 'clear'] });
});

test('toolbar rejects extra tool keys and accepts all three shape capabilities', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } }); await f.controller.open(f.event);
  const toolbarEvent = { sender: f.created[0].webContents, senderFrame: f.created[0].webContents.mainFrame };
  const before = f.main.webContents.sent.length;
  f.listeners['jugglework:semantic-annotation:command'](toolbarEvent, { type: 'tool', tool: { tool: 'rectangle', color: '#ef4444', size: 4, extra: true } });
  assert.equal(f.main.webContents.sent.length, before);
  for (const tool of ['rectangle', 'ellipse', 'arrow']) f.listeners['jugglework:semantic-annotation:command'](toolbarEvent, { type: 'tool', tool: { tool, color: '#ef4444', size: 4 } });
  assert.equal(f.main.webContents.sent.filter(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'toolbar').length, 3);
});

test('readiness accepts a scaled capture independently from DWM and outer window sizes', () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 1280, height: 844 } });
  f.samples[0]({ status: 'visible', bounds: { x: 87, y: 80, width: 626, height: 413 }, actualSize: { width: 640, height: 420 } });
  assert.equal(f.controller.state(f.event).available, true);
});

test('old session writes and non-main senders are rejected while resize only closes annotation', async () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } });
  await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'abort' }), { ok: true });
  assert.deepEqual(await f.controller.write(f.event, { ...key, generation: opened.generation - 1, command: 'abort' }), { ok: false, reason: 'stale-session' });
  await assert.rejects(f.controller.write({ sender: f.created[0].webContents, senderFrame: f.created[0].webContents.mainFrame }, { ...key, command: 'abort' }), /主窗口/);
  f.samples[1]({ status: 'visible', bounds: { x: 0, y: 0, width: 700, height: 400 }, actualSize: { width: 700, height: 400 } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.controller.state(f.event).active, false);
  assert.equal(f.controller.state(f.event).lastExitReason, 'resized');
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && value.kind === 'closed' && value.reason === 'resized'), true);
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'closed' && value.reason === 'resized'), true);
});

test('unknown and minimized state hide the toolbar; helper exit fails closed', async () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } });
  await f.controller.open(f.event);
  f.nativeStates[0]({ state: 'unknown', epoch: 2, input: false, visible: false });
  assert.equal(f.created[0].visible, false);
  f.nativeStates[0]({ state: 'active', epoch: 3, input: true, visible: true });
  assert.equal(f.created[0].visible, true);
  f.nativeExits[0]('helper-exit');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(f.controller.state(f.event).active, false);
  assert.equal(f.controller.state(f.event).lastExitReason, 'tracking-lost');
});

test('apply-scene publishes compositor and history only after native ACK and rejects old revisions', async () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 654, height: 407 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  const scene = { size: { width: 640, height: 400 }, elements: [{ type: 'stroke', id: 'one', color: '#ef4444', size: 4,
    highlight: false, points: [.1, .1, .2, .2] }], lasers: [] };
  const result = await f.controller.write(f.event, { ...key, command: 'apply-scene', sceneRevision: 1, scene, history: { canUndo: true, canClear: true } });
  assert.deepEqual(result, { ok: true }); assert.equal(f.nativeScenes.length, 1);
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && value.kind === 'scene' && value.sceneRevision === 1), true);
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-scene', sceneRevision: 1, scene, history: { canUndo: true, canClear: true } }),
    { ok: false, reason: 'stale-scene-revision' });
});

test('eraser preview hides retained ids without history and commit ACK clears it authoritatively', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  const element = { type: 'stroke', id: 'one', color: '#ef4444', size: 4, highlight: false, points: [.1, .1, .9, .1] };
  const full = { size: { width: 640, height: 400 }, elements: [element], lasers: [] }, empty = { ...full, elements: [] };
  await f.controller.write(f.event, { ...key, command: 'apply-scene', sceneRevision: 1, scene: full, history: { canUndo: true, canClear: true } });
  f.nativeStates[0]({ state: 'active', epoch: 3, input: true, visible: true });
  const historyMessages = f.created[0].webContents.sent.length;
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-preview', previewRevision: 1, epoch: 3, hiddenElementIds: ['one'], scene: empty }), { ok: true });
  assert.equal(f.created[0].webContents.sent.length, historyMessages);
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && value.kind === 'scene' && value.committed === false && value.scene.elements.length === 0), true);
  await f.controller.write(f.event, { ...key, command: 'apply-scene', sceneRevision: 2, scene: empty, history: { canUndo: true, canClear: false } });
  assert.deepEqual(f.nativeScenes.at(-1), { elements: [] });
});

test('preview rejects duplicate ids, old revision/session/epoch and unknown restores committed compositor scene', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  const scene = { size: { width: 640, height: 400 }, elements: [], lasers: [] };
  f.nativeStates[0]({ state: 'active', epoch: 4, input: true, visible: true });
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-preview', previewRevision: 1, epoch: 3, hiddenElementIds: [], scene }), { ok: false, reason: 'stale-preview' });
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-preview', previewRevision: 1, epoch: 4, hiddenElementIds: ['x', 'x'], scene }), { ok: false, reason: 'stale-preview' });
  assert.deepEqual(await f.controller.write(f.event, { ...key, generation: key.generation - 1, command: 'apply-preview', previewRevision: 1, epoch: 4, hiddenElementIds: [], scene }), { ok: false, reason: 'stale-session' });
  f.nativeStates[0]({ state: 'unknown', epoch: 5, input: false, visible: false });
  const events = f.main.webContents.sent.filter(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && ['scene', 'geometry-pending'].includes(value.kind)).slice(-2).map(([, value]) => value.kind);
  assert.deepEqual(events, ['scene', 'geometry-pending']);
});

test('laser transient revisions are independent, bounded and publish only after native ACK', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  f.nativeStates[0]({ state: 'active', epoch: 3, input: true, visible: true });
  const stroke = { type: 'stroke', id: 'laser_1', color: '#ef4444', size: 4, highlight: false, points: [.1, .2, .3, .4] };
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-lasers', laserRevision: 1, epoch: 3, lasers: [{ stroke, opacity: .5 }] }), { ok: true });
  assert.equal(f.nativeLasers.length, 1);
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && value.laserRevision === 1 && value.scene.lasers[0].opacity === .5), true);
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-lasers', laserRevision: 1, epoch: 3, lasers: [] }), { ok: false, reason: 'stale-laser' });
  assert.deepEqual(await f.controller.write(f.event, { ...key, command: 'apply-lasers', laserRevision: 2, epoch: 2, lasers: [] }), { ok: false, reason: 'stale-laser' });
});

test('shape scene is exact, unique, bounded and retained by id through native ACK', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 640, height: 400 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  const key = { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation };
  const shape = { type: 'shape', id: 'rectangle_1', kind: 'rectangle', color: '#3b82f6', size: 4, x1: .1, y1: .2, x2: .7, y2: .8 };
  const write = scene => f.controller.write(f.event, { ...key, command: 'apply-scene', sceneRevision: f.nativeScenes.length + 1,
    scene: { size: { width: 640, height: 400 }, elements: scene, lasers: [] }, history: { canUndo: true, canClear: true } });
  assert.deepEqual(await write([shape]), { ok: true });
  assert.deepEqual(f.nativeScenes[0], { elements: [shape] });
  assert.deepEqual(await write([shape, { ...shape }]), { ok: false, reason: 'invalid-scene' });
  assert.deepEqual(await write([{ ...shape, extra: true }]), { ok: false, reason: 'invalid-scene' });
  assert.deepEqual(await write([{ ...shape, x1: -0.01 }]), { ok: false, reason: 'invalid-scene' });
  assert.deepEqual(await write(Array.from({ length: 129 }, (_, index) => ({ ...shape, id: `shape_${index}` }))), { ok: false, reason: 'invalid-scene' });
});

test('native scene failure, toolbar close, toolbar crash and main renderer loss tear down the owned session', async () => {
  for (const failure of ['native', 'toolbar-close', 'toolbar-crash', 'main-gone']) {
    const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
    f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 654, height: 407 } }); await f.controller.open(f.event);
    if (failure === 'native') {
      f.native.setScene = async () => ({ ok: false, reason: 'injected' });
      const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
      await f.controller.write(f.event, { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation, command: 'apply-scene', sceneRevision: 1,
        scene: { size: { width: 640, height: 400 }, elements: [], lasers: [] }, history: { canUndo: false, canClear: false } });
    } else if (failure === 'toolbar-close') f.created[0].emit('closed');
    else if (failure === 'toolbar-crash') f.created[0].webContents.emit('render-process-gone');
    else f.main.webContents.emit('render-process-gone');
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(f.controller.state(f.event).active, false, failure);
  }
});

test('share stop while readiness is opening cancels the watcher immediately', async () => {
  const f = fixture();
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  // The fixture watcher stop callback is replaced here to observe cancellation before any sample arrives.
  f.controller.windowShareReady(f.event, { captureId: 'capture', ready: false });
  await f.controller.close(f.event, { shareStopped: true });
  assert.equal(f.controller.state(f.event).available, false); assert.equal(f.watcherStops, 1);
});

test('a late native scene ACK cannot publish after teardown or into a replacement session', async () => {
  const f = fixture(); f.controller.windowShareReady(f.event, { captureId: 'capture', ready: true, pixelSize: { width: 640, height: 400 } });
  f.samples[0]({ status: 'visible', bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 654, height: 407 } }); await f.controller.open(f.event);
  const opened = f.main.webContents.sent.find(([channel, value]) => channel === 'jugglework:meeting:semantic-annotation' && value.kind === 'opened')[1];
  let resolveScene; f.native.setScene = () => new Promise(resolve => { resolveScene = resolve; });
  const pending = f.controller.write(f.event, { captureId: opened.captureId, annotationId: opened.annotationId, nativeSessionId: opened.nativeSessionId, generation: opened.generation, command: 'apply-scene', sceneRevision: 1,
    scene: { size: { width: 640, height: 400 }, elements: [], lasers: [] }, history: { canUndo: false, canClear: false } });
  await new Promise(resolve => setTimeout(resolve, 0));
  await f.controller.close(f.event); assert.equal(typeof resolveScene, 'function');
  /** @type {(value: {ok: boolean}) => void} */ (resolveScene)({ ok: true });
  assert.deepEqual(await pending, { ok: false, reason: 'stale-session' });
  assert.equal(f.main.webContents.sent.some(([channel, value]) => channel === 'jugglework:meeting:window-annotation' && value.kind === 'scene'), false);
});

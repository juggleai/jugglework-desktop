const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Run the actual entry point without Electron or WinForms. Process/pipe events
// are controlled at the OS boundary; real Node readline handles the protocol.
const source = readFileSync(join(__dirname, 'meeting-window-p0.cjs'), 'utf8');
async function start(t, argv = ['--native-only'], { loadURL } = {}) {
  const app = new EventEmitter(), children = [], records = [];
  const timers = new Map(), intervals = new Map();
  app.whenReady = async () => {};
  app.exit = (code) => app.emit('test-exit', code);
  function spawn(_, args, options) {
    const child = new EventEmitter();
    child.pid = 1234 + children.length;
    child.exitCode = child.signalCode = null;
    child.stdout = new PassThrough();
    child.stdin = options.stdio[0] === 'pipe' ? new PassThrough() : null;
    child.stops = [];
    child.stdin?.on('finish', () => child.stops.push('eof'));
    child.kill = () => { child.stops.push('kill'); return true; };
    child.send = (value) => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.stop = (code) => {
      child.exitCode = code;
      child.stdout.end();
      child.emit('close', code);
    };
    children.push(child);
    return child;
  }
  const schedule = (map) => (callback) => {
    const token = Symbol();
    map.set(token, callback);
    return token;
  };
  const exit = once(app, 'test-exit');
  const windows = [];
  class Window {
    constructor(options) {
      this.options = options; this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async () => ({ clicks: 0, drags: 0 });
      windows.push(this);
    }
    setIgnoreMouseEvents(v) { this.ignored = v; }
    setBounds(v) { this.bounds = v; }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(100 + windows.indexOf(this))); return b; }
    getMediaSourceId() { return `window:${100 + windows.indexOf(this)}:0`; }
    async loadURL() { await loadURL?.(); }
    showInactive() {}
    moveAbove() {}
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const screen = {
    screenToDipRect: (_, b) => ({ ...b }), dipToScreenRect: (_, b) => ({ ...b }),
    getDisplayMatching: () => ({ id: 1, scaleFactor: 1.25, bounds: { x: -1000, y: -1000, width: 2000, height: 2000 } }),
  };
  runInNewContext(source, {
    require: (id) => id === 'electron' ? { app, BrowserWindow: Window, screen } : id === 'node:child_process' ? { spawn } : require(id),
    URL, __dirname, process: { platform: 'win32', argv, pid: 999, env: { SystemRoot: 'C:\\Windows' }, versions: {},
      on() {}, removeListener() {} },
    console: { log: (line) => records.push(JSON.parse(line)) },
    setTimeout: schedule(timers), clearTimeout: (token) => timers.delete(token),
    setInterval: schedule(intervals), clearInterval: (token) => intervals.delete(token),
  });
  t.after(() => { for (const child of children) { child.stdout.destroy(); child.stdin?.destroy(); } });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  await tick();
  const [fixture] = children;
  const identify = () => {
    fixture.send({ type: 'identity', hwnd: '55', title: `Meeting Window P0 ${'a'.repeat(32)}` });
    return children[1];
  };
  const sample = {
    status: 'available', hwnd: '55', pid: fixture.pid, processCreated: '133800000000000001', dpi: 120,
    state: 'normal', outerPx: { x: 0, y: 0, width: 200, height: 200 }, dwmPx: { x: 0, y: 0, width: 199, height: 199 },
  };
  const fireTimers = () => {
    for (const [token, callback] of [...timers]) if (timers.delete(token)) callback();
  };
  return { app, records, fixture, identify, sample, timers, intervals, exit, fireTimers, tick, windows };
}

test('close intent stops requests and ignores a pending reply until clean fixture exit', async (t) => {
  const { fixture, identify, sample, records, intervals, exit, tick } = await start(t);
  const observer = identify();
  observer.send(sample);
  for (const request of intervals.values()) request();
  fixture.send({ type: 'closed' });
  observer.send({ ...sample, state: 'minimized', outerPx: null, dwmPx: null });
  assert.equal(intervals.size, 0);
  assert.deepEqual(records.filter((r) => r.type === 'native').map((r) => r.change), ['baseline']);
  assert.equal(records.some((r) => r.type === 'closed'), false);
  fixture.stop(0);
  await tick();
  assert.deepEqual(observer.stops, ['eof']);
  observer.stop(0);
  assert.deepEqual(await exit, [0]);
  assert.equal(records.filter((r) => r.type === 'closed').length, 1);
});

test('close intent followed by nonzero exit is a fixture failure', async (t) => {
  const { fixture, records, exit } = await start(t);
  fixture.send({ type: 'closed' });
  fixture.stop(7);
  assert.deepEqual(await exit, [1]);
  assert.deepEqual(records.slice(1).map((r) => r.stage), ['fixture-exit']);
});

test('fixture exit timeout shuts down both owned children by EOF before bounded kill fallback', async (t) => {
  const { fixture, identify, records, exit, fireTimers, tick } = await start(t);
  const observer = identify();
  fixture.send({ type: 'closed' });
  fireTimers();
  await tick();
  assert.deepEqual(fixture.stops, ['eof']);
  assert.deepEqual(observer.stops, ['eof']);
  observer.stop(0);
  fireTimers();
  assert.deepEqual(fixture.stops, ['eof', 'kill']);
  assert.deepEqual(observer.stops, ['eof']);
  fireTimers(); // even a missing close after the kill cannot hang the launcher
  assert.deepEqual(await exit, [1]);
  assert.deepEqual(records.slice(1).map((r) => r.stage), ['fixture-exit-timeout', 'cleanup-timeout']);
});

test('null fixture record is a protocol error and the child gets EOF', async (t) => {
  const { fixture, records, exit, tick } = await start(t);
  fixture.send(null);
  await tick();
  assert.deepEqual(fixture.stops, ['eof']);
  fixture.stop(0);
  assert.deepEqual(await exit, [1]);
  assert.deepEqual(records.slice(1).map((r) => r.stage), ['fixture-protocol']);
});

test('null native reply is a protocol error and cleans up both children', async (t) => {
  const { fixture, identify, records, exit, tick } = await start(t);
  const observer = identify();
  observer.send(null);
  await tick();
  assert.deepEqual(observer.stops, ['eof']);
  assert.deepEqual(fixture.stops, ['eof']);
  fixture.stop(0);
  observer.stop(0);
  assert.deepEqual(await exit, [1]);
  assert.deepEqual(records.slice(1).map((r) => r.stage), ['native-protocol']);
});

test('--overlay starts native observation without capture, sends only own layers and clears them on malformed evidence', async (t) => {
  const { fixture, identify, sample, records, intervals, tick, windows, exit } = await start(t, ['--overlay']);
  const observer = identify();
  assert.ok(observer);
  assert.equal(JSON.parse(observer.stdin.read().toString().split('\n')[0]).overlayPid, 999);
  const overlay = { clientPx: { x: 8, y: 30, width: 184, height: 162 }, borderPx: { x: 8, y: 8 }, layers: [] };
  observer.send({ ...sample, overlay });
  await tick();
  assert.equal(windows.length, 5);
  assert.ok(windows.every((w) => w.ignored));
  for (const request of intervals.values()) request();
  const request = JSON.parse(observer.stdin.read().toString());
  assert.deepEqual(request.layers.map((l) => l.hwnd), ['100', '101', '102', '103', '104']);
  fixture.send({ type: 'mode', mode: 'draw' });
  observer.send({ ...sample, overlay: { ...overlay, layers: null } });
  await tick();
  assert.ok(windows.every((w) => w.destroyed && w.ignored));
  assert.ok(records.some((r) => r.stage === 'native-protocol'));
  fixture.stop(0); observer.stop(0);
  assert.deepEqual(await exit, [1]);
});

test('--overlay close before native layer verification is a failure even after a target baseline', async (t) => {
  const { fixture, identify, sample, tick, windows, exit, records } = await start(t, ['--overlay']);
  const observer = identify();
  observer.send({ ...sample, overlay: { clientPx: { x: 8, y: 30, width: 184, height: 162 }, borderPx: { x: 8, y: 8 }, layers: [] } });
  await tick();
  fixture.send({ type: 'closed' }); fixture.stop(0);
  await tick(); observer.stop(0);
  assert.deepEqual(await exit, [1]);
  assert.ok(windows.every((w) => w.destroyed));
  assert.ok(records.some((r) => r.stage === 'closed-before-overlay-verification'));
});

test('--overlay first verification timeout removes fully created but unverified layers', async (t) => {
  const { fixture, identify, sample, tick, windows, exit, records, fireTimers } = await start(t, ['--overlay']);
  const observer = identify();
  observer.send({ ...sample, overlay: { clientPx: { x: 8, y: 30, width: 184, height: 162 }, borderPx: { x: 8, y: 8 }, layers: [] } });
  await tick();
  assert.equal(windows.length, 5);
  fireTimers();
  await tick();
  assert.ok(windows.every((w) => w.destroyed));
  assert.ok(records.some((r) => r.stage === 'first-overlay-timeout'));
  fixture.stop(0); observer.stop(0);
  assert.deepEqual(await exit, [1]);
});

test('--overlay hung loadURL processing timeout cleans up partial creation and ignores late completion', async (t) => {
  let completeLoad;
  const load = new Promise((resolve) => { completeLoad = resolve; });
  const { fixture, identify, sample, tick, windows, exit, records, timers } = await start(t, ['--overlay'], { loadURL: () => load });
  const observer = identify();
  observer.send({ ...sample, overlay: { clientPx: { x: 8, y: 30, width: 184, height: 162 }, borderPx: { x: 8, y: 8 }, layers: [] } });
  await tick();
  assert.equal(windows.length, 1);
  assert.equal(windows[0].ignored, true);
  // Identity's first-verification deadline is distinct from the in-flight observe deadline.
  const [token, processingDeadline] = [...timers].at(-1);
  timers.delete(token); processingDeadline();
  await tick();
  assert.ok(windows.every((w) => w.destroyed && w.ignored));
  assert.ok(records.some((r) => r.stage === 'overlay-processing-timeout'));
  completeLoad();
  await tick();
  assert.equal(windows.length, 1);
  assert.equal(records.some((r) => r.stage === 'awaiting-native-layers'), false);
  fixture.stop(0); observer.stop(0);
  assert.deepEqual(await exit, [1]);
});

test('--overlay stalled counters do not block native polling or move input suspension', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { fixture, identify, sample, tick, windows, exit, records, intervals } = await start(t, ['--overlay']);
  const observer = identify();
  const evidence = { clientPx: { x: 8, y: 30, width: 184, height: 162 }, borderPx: { x: 8, y: 8 }, layers: [] };
  observer.send({ ...sample, overlay: evidence });
  await tick();
  const layers = windows.map((w, i) => ({ role: ['ink', 'top', 'bottom', 'left', 'right'][i], hwnd: String(100 + i),
    dpi: 120, outerPx: w.bounds, visible: true, topmost: false, adjacent: true }));
  let reads = 0;
  windows[0].webContents.executeJavaScript = () => { reads++; return new Promise(() => {}); };
  observer.stdin.read();
  for (const request of intervals.values()) request();
  observer.send({ ...sample, overlay: { ...evidence, layers } });
  await tick();
  t.mock.timers.tick(500);
  assert.equal(reads, 1);
  assert.equal(windows[1].ignored, false);
  observer.stdin.read();
  for (const request of intervals.values()) request();
  assert.ok(observer.stdin.read(), 'native request continues while counters are pending');
  const moved = { ...sample, outerPx: { ...sample.outerPx, x: 10 }, dwmPx: { ...sample.dwmPx, x: 10 } };
  observer.send({ ...moved, overlay: { ...evidence, clientPx: { ...evidence.clientPx, x: 18 }, layers } });
  await tick();
  assert.ok(windows.every((w) => w.ignored && !w.destroyed));
  assert.equal(windows[0].bounds.x, 18);
  assert.ok(records.some((r) => r.stage === 'following-awaiting-readback'));
  for (const request of intervals.values()) request();
  assert.ok(observer.stdin.read());
  observer.send({ ...moved, overlay: { ...evidence, clientPx: { ...evidence.clientPx, x: 18 },
    layers: layers.map((layer, i) => ({ ...layer, outerPx: windows[i].bounds })) } });
  await tick();
  assert.equal(windows[1].ignored, false, 'new native readback permits input without awaiting counters');
  t.mock.timers.tick(500);
  assert.equal(reads, 1, 'another telemetry tick cannot overlap the pending request');
  t.mock.timers.tick(5000);
  await tick();
  assert.ok(windows.every((w) => w.destroyed && w.ignored));
  assert.equal(reads, 1, 'telemetry stays single flight');
  assert.ok(records.some((r) => r.stage === 'overlay-telemetry-timeout'));
  fixture.stop(0); observer.stop(0);
  assert.deepEqual(await exit, [1]);
});

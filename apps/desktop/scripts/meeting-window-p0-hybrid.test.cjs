const test = require('node:test');
const assert = require('node:assert/strict');
const { matchFixtureSource, composeAndVerify, cleanupVerdict } = require('./meeting-window-p0-hybrid.cjs');
const { inkPlan, inkVerdict, a4Verdict, mappingVerdict, stripInputVerdict } = require('./meeting-window-p0-hybrid-ink.cjs');

test('passive ink requires stable identity, normal state and exact geometry and order', () => {
  const rect = { x: 20, y: 40, width: 640, height: 400 };
  const screen = { getAllDisplays: () => [{ scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 } }],
    screenToDipRect: (_, b) => b, dipToScreenRect: (_, b) => b };
  const sample = { status: 'available', state: 'normal', dpi: 96, hwnd: '2', pid: 10, processCreated: '200',
    outerPx: rect, dwmPx: rect, overlay: { clientPx: rect } };
  const plan = inkPlan(sample, screen);
  assert.deepEqual(plan.px, rect);
  for (const [change, error] of [[{ state: 'minimized' }, /ink-target-state/], [{ dpi: 120 }, /ink-dpi/],
    [{ processCreated: '201' }, /ink-identity/], [{ dwmPx: { ...rect, x: 21 } }, /ink-geometry/]]) {
    assert.throws(() => inkPlan({ ...sample, ...change }, screen, sample), error);
  }
  const layer = { role: 'ink', hwnd: '3', dpi: 96, outerPx: rect, topmost: false, visible: true, adjacent: true };
  assert.equal(inkVerdict([layer], '3', plan), null);
  for (const [change, error] of [[{ adjacent: false }, 'ink-order'], [{ topmost: true }, 'ink-geometry'],
    [{ visible: false }, 'ink-geometry'], [{ hwnd: '4' }, 'ink-identity'], [{ dpi: 120 }, 'ink-dpi'],
    [{ outerPx: { ...rect, width: 641 } }, 'ink-geometry']]) {
    assert.equal(inkVerdict([{ ...layer, ...change }], '3', plan), error);
  }
});

const DARK = { b: 45, g: 30, r: 22, a: 255 };
function bitmap(width, height, fill = DARK) {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4] = fill.b; buf[i * 4 + 1] = fill.g; buf[i * 4 + 2] = fill.r; buf[i * 4 + 3] = fill.a;
  }
  return buf;
}

const identity = { hwnd: '9007199254740993', title: `Meeting Window P0 ${'a'.repeat(32)}` };
test('source matching requires exact lossless HWND string and private title', () => {
  const sources = [{ name: identity.title, id: 'window:1:0' }, { name: identity.title, id: `window:${identity.hwnd}:0` }];
  assert.equal(matchFixtureSource(sources, identity), sources[1]);
  assert.equal(matchFixtureSource(sources, { ...identity, hwnd: Number(identity.hwnd) }), null);
  assert.equal(matchFixtureSource([], identity), null);
  assert.equal(matchFixtureSource(null, identity), null);
  assert.equal(matchFixtureSource([{ ...sources[1], name: 'Other' }], identity), null);
  assert.equal(matchFixtureSource([sources[1], sources[1]], identity), null);
  assert.equal(matchFixtureSource([{ name: identity.title, id: `screen:${identity.hwnd}:0` }], identity), null);
});

test('composeAndVerify checks only deterministic bitmap consistency', () => {
  const size = { width: 64, height: 40 };
  const raw = bitmap(size.width, size.height);
  const strokes = [{ x0: 8, y0: 8, x1: 40, y1: 8 }];
  const result = composeAndVerify(raw, size, strokes, 3);
  assert.ok(result);
  assert.equal(result.width, 64);
  assert.equal(result.height, 40);
  assert.equal(result.inkRegionDiffers, true);
  assert.equal(result.rawCleanAtInk, true);
  assert.equal(result.nonInkIdentical, true);
});

test('cleanup requires closed message and normal child exit without forced termination', () => {
  const clean = { closed: true, code: 0, signal: null, forced: false };
  assert.equal(cleanupVerdict(clean), 'confirmed');
  for (const change of [{ closed: false }, { code: 1 }, { signal: 'SIGINT' }, { forced: true }]) {
    assert.equal(cleanupVerdict({ ...clean, ...change }), 'unconfirmed');
  }
});

test('composeAndVerify rejects bad input', () => {
  assert.equal(composeAndVerify(Buffer.alloc(4), { width: 64, height: 40 }, [{ x0: 0, y0: 0, x1: 1, y1: 1 }]), null);
  assert.equal(composeAndVerify(bitmap(64, 40), { width: 64, height: 40 }, []), null);
});

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');

// Execute the actual entry point. Only OS/Electron boundaries are substituted;
// real Node readline parses bytes sent through the fake child's stdout.
const hybridSource = readFileSync(join(__dirname, 'meeting-window-p0-hybrid.cjs'), 'utf8');
const markerSample = {
  displaySurface: 'window', frames: 3, width: 64, height: 40, inkColorPixels: 0,
  markers: ['TL', 'TR', 'BL', 'BR'].map((role) => ({ role, count: 4, x: 8, y: 8 })),
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function startHybrid(t, {
  electron = true, whenReady = async () => {}, getSources, argv = [],
  readback = async () => markerSample,
} = {}) {
  const app = new EventEmitter(), fakeProcess = new EventEmitter();
  const children = [], windows = [], records = [], exits = [], timers = new Map();
  const sourceRequests = [], mediaReplies = [], required = [], kills = [], processKills = [];
  let now = 0, readyCalls = 0, readbacks = 0;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const selectedSource = { id: `window:${identity.hwnd}:0`, name: identity.title };
  const sources = [selectedSource, { id: 'window:77:0', name: 'PRIVATE unrelated window title' }];
  app.whenReady = () => { readyCalls++; return whenReady(); };
  app.exit = (code) => exits.push(code);
  Object.assign(fakeProcess, {
    platform: 'win32', argv: ['electron', 'meeting-window-p0-hybrid.cjs', ...argv], pid: 999,
    env: { SystemRoot: 'C:\\Windows' }, versions: electron ? { electron: 'test' } : {},
    kill: (...args) => { processKills.push(args); throw new Error('process-wide kill is forbidden'); },
  });
  function spawn(command, args, options) {
    const child = new EventEmitter();
    Object.assign(child, { command, args: [...args], options, pid: 1234 + children.length,
      exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), stops: [] });
    child.stdin.on('finish', () => child.stops.push('eof'));
    child.kill = function () {
      assert.equal(this, child);
      kills.push(child); child.stops.push('kill'); return true;
    };
    child.send = (record) => child.stdout.write(`${JSON.stringify(record)}\n`);
    child.stop = (code = 0, signal = null) => {
      child.exitCode = code; child.signalCode = signal;
      child.stdout.end(); child.stderr.end(); child.emit('close', code, signal);
    };
    children.push(child);
    return child;
  }
  const ses = {
    protocol: { handle: () => {} },
    setDisplayMediaRequestHandler(handler, options) { this.handler = handler; this.options = options; },
  };
  class Window {
    constructor(options) {
      this.options = options;
      this.webContents = { mainFrame: {}, executeJavaScript: async () => {
        readbacks++;
        // Emulate the renderer's media request so both metadata enumerations run.
        const reply = await new Promise((resolve) => ses.handler({
          frame: this.webContents.mainFrame, securityOrigin: 'https://meeting-window-hybrid.invalid',
          videoRequested: true, audioRequested: false,
        }, resolve));
        mediaReplies.push(reply);
        if (!reply.video) throw new Error('synthetic renderer media request denied');
        return readback();
      } };
      this.webContents.on = () => {};
      this.webContents.capturePage = async () => {
        const width = 640, height = 400, bitmap = Buffer.alloc(width * height * 4);
        for (let i = 0; i < width * height; i++) { bitmap[i * 4] = 200; bitmap[i * 4 + 1] = 53; bitmap[i * 4 + 2] = 255; bitmap[i * 4 + 3] = 255; }
        return { getSize: () => ({ width, height }), toBitmap: () => bitmap };
      };
      windows.push(this);
    }
    async loadURL(url) { this.url = url; }
    isDestroyed() { return !!this.destroyed; }
    destroy() { this.destroyed = true; }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    getNativeWindowHandle() { return Buffer.from([3, 0, 0, 0]); }
    showInactive() { this.shownInactive = true; }
  }
  const fakeElectron = {
    app, BrowserWindow: Window, session: { fromPartition: () => ses },
    screen: { getAllDisplays: () => [{ scaleFactor: 1, bounds: { x: 0, y: 0, width: 1920, height: 1200 } }],
      screenToDipRect: (_, rect) => rect, dipToScreenRect: (_, rect) => rect },
    desktopCapturer: { getSources: async (options) => {
      sourceRequests.push(JSON.parse(JSON.stringify(options)));
      return getSources ? getSources(sourceRequests.length, sources) : sources;
    } },
  };
  const entryModule = { exports: {} };
  function vmRequire(id) {
    required.push(id);
    if (id === 'electron') return fakeElectron;
    if (id === 'node:child_process') return { spawn };
    assert.ok(['node:path', 'node:readline', './meeting-window-p0-compositor.cjs', './meeting-window-p0-native.cjs',
      './meeting-window-p0-hybrid-ink.cjs'].includes(id), `unexpected require: ${id}`);
    return require(id);
  }
  // Electron's default-app loader has a different main module from this entry.
  vmRequire.main = { exports: {} };
  class ClockDate extends Date { static now() { return now; } }
  runInNewContext(hybridSource, {
    require: vmRequire, module: entryModule, exports: entryModule.exports, __dirname,
    process: fakeProcess, Buffer, Date: ClockDate,
    console: { log: (line) => records.push(JSON.parse(line)) },
    setTimeout: (callback, delay) => {
      const token = Symbol(); timers.set(token, { callback, delay, at: now + delay }); return token;
    },
    clearTimeout: (token) => timers.delete(token),
  }, { filename: join(__dirname, 'meeting-window-p0-hybrid.cjs') });
  t.after(() => {
    for (const child of children) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
  await tick();
  const fireTimer = async (delay) => {
    const matches = [...timers].filter(([, timer]) => timer.delay === delay);
    assert.equal(matches.length, 1, `expected exactly one ${delay}ms timer`);
    const [token, timer] = matches[0];
    timers.delete(token); now = timer.at; timer.callback(); await tick();
  };
  const identify = () => {
    const [child] = children;
    child.send({ type: 'identity', ...identity });
    child.send({ type: 'geometry', visible: true, state: 'normal', dpi: 120,
      outerPx: { x: 0, y: 0, width: 64, height: 40 },
      dwmPx: { x: 0, y: 0, width: 64, height: 40 } });
  };
  return { app, fakeProcess, children, windows, records, exits, timers, sourceRequests,
    mediaReplies, required, kills, processKills, entryModule, loaderMain: vmRequire.main,
    readyCalls, get readbacks() { return readbacks; }, tick, fireTimer, identify };
}

function assertNoSuccess(h) {
  assert.equal(h.exits.includes(0), false);
  assert.equal(h.records.some((r) => r.stage === 'stream-observed' || r.valid === true), false);
}

async function closeHybrid(h, code = 0, { closed = true } = {}) {
  const [child] = h.children;
  if (closed) child.send({ type: 'closed' });
  child.stop(code);
  await h.tick();
  assert.equal(h.timers.size, 0);
}

test('VM: Electron default loader starts even when require.main is not module', async (t) => {
  const h = await startHybrid(t);
  assert.notEqual(h.loaderMain, h.entryModule);
  assert.equal(h.readyCalls, 1);
  assert.equal(h.children.length, 1);
  assert.deepEqual(h.children[0].args.slice(-2), ['-Probe', '-Animate']);
  assert.equal(h.records[0].stage, 'waiting-for-ready');
  assert.equal(typeof h.entryModule.exports.matchFixtureSource, 'function');
  h.fakeProcess.emit('SIGTERM');
  await h.tick();
  assert.deepEqual(h.children[0].stops, ['eof']);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
});

test('VM: plain Node import only exports pure helpers without startup side effects', async (t) => {
  const h = await startHybrid(t, { electron: false });
  assert.deepEqual(Object.keys(h.entryModule.exports).sort(), ['cleanupVerdict', 'composeAndVerify', 'matchFixtureSource']);
  assert.deepEqual(h.required, ['./meeting-window-p0-compositor.cjs']);
  assert.equal(h.readyCalls, 0);
  for (const values of [h.children, h.windows, h.records, h.exits, h.sourceRequests]) assert.equal(values.length, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.fakeProcess.eventNames().length, 0);
});

test('VM: stalled whenReady times out without spawning and ignores late readiness', async (t) => {
  const ready = deferred();
  const h = await startHybrid(t, { whenReady: () => ready.promise });
  assert.equal(h.children.length, 0);
  await h.fireTimer(10000);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.records.at(-1), { type: 'hybrid', inputEnabled: false, stage: 'ready-timeout', cleanup: 'not-started' });
  ready.resolve(); await h.tick();
  assert.equal(h.children.length, 0);
  assert.equal(h.windows.length, 0);
  assert.equal(h.sourceRequests.length, 0);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.exits, [1]);
});

test('VM: successful readback closes stdin and requires closed message plus exit 0 for confirmed cleanup', async (t) => {
  const h = await startHybrid(t);
  h.identify(); await h.tick();
  const [child] = h.children;
  assert.equal(h.readbacks, 1);
  assert.equal(h.records.at(-1).stage, 'stream-observed');
  assert.deepEqual(child.stops, ['eof']);
  assert.ok(h.windows.length === 1 && h.windows[0].destroyed);
  assert.deepEqual(h.exits, []);
  child.send({ type: 'closed' }); await h.tick();
  assert.deepEqual(h.exits, [], 'closed message alone does not prove process removal');
  await closeHybrid(h, 0, { closed: false });
  assert.deepEqual(h.exits, [0]);
  assert.deepEqual(h.records.at(-1), { type: 'hybrid', inputEnabled: false, stage: 'cleanup',
    cleanup: 'confirmed', closedMessage: true, normalExit: true, forced: false, elapsedMs: 0 });
  assert.deepEqual(h.kills, []);
});

test('VM: exit 0 without a closed message cannot confirm cleanup', async (t) => {
  const h = await startHybrid(t);
  h.identify(); await h.tick();
  await closeHybrid(h, 0, { closed: false });
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.records.at(-1).cleanup, 'unconfirmed');
  assert.equal(h.records.at(-1).closedMessage, false);
});

test('VM: a closed message followed by nonzero exit cannot confirm cleanup', async (t) => {
  const h = await startHybrid(t);
  h.identify(); await h.tick();
  await closeHybrid(h, 7);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.records.at(-1).closedMessage, true);
  assert.equal(h.records.at(-1).normalExit, false);
  assert.equal(h.records.at(-1).cleanup, 'unconfirmed');
});

test('VM: observation timeout sends EOF, kills only this child after grace, and bounds stuck cleanup', async (t) => {
  const h = await startHybrid(t);
  const [child] = h.children;
  await h.fireTimer(30000);
  assert.deepEqual(child.stops, ['eof']);
  assert.equal(h.records.at(-1).stage, 'observation-timeout');
  assert.deepEqual(h.kills, []);
  assert.deepEqual(h.exits, []);
  child.send({ type: 'closed' }); await h.tick();
  await h.fireTimer(5000);
  assert.deepEqual(child.stops, ['eof', 'kill']);
  assert.deepEqual(h.kills, [child]);
  assert.deepEqual(h.processKills, []);
  assert.equal(h.children.length, 1);
  assert.ok(child.args.includes('-Probe'));
  assert.deepEqual(h.exits, []);
  await h.fireTimer(1500);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.records.map((r) => r.stage),
    ['waiting-for-ready', 'observation-timeout', 'forced-cleanup', 'cleanup-timeout']);
  assert.equal(h.records.at(-1).cleanup, 'unconfirmed');
  assert.equal(h.timers.size, 0);
  assertNoSuccess(h);
});

test('VM: static-target control leaves animation disabled', async (t) => {
  const h = await startHybrid(t, { argv: ['--static-target'] });
  assert.equal(h.children[0].args.at(-1), '-Probe');
  assert.equal(h.children[0].args.includes('-Animate'), false);
  h.fakeProcess.emit('SIGTERM');
  await closeHybrid(h);
});

test('VM: native-target selects the dedicated script and suppresses the host console', async (t) => {
  const h = await startHybrid(t, { argv: ['--native-target'] });
  assert.deepEqual(h.children[0].args.slice(-2), ['-File', join(__dirname, 'meeting-window-p0-hybrid.ps1')]);
  assert.equal(h.children[0].options.windowsHide, true);
  h.fakeProcess.emit('SIGTERM');
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.records.at(-1).cleanup, 'confirmed');
});

test('VM: WinForms target never hides its GUI window by default', async (t) => {
  const h = await startHybrid(t);
  assert.equal(h.children[0].args.includes('-Probe'), true);
  assert.equal(h.children[0].options.windowsHide, false);
  h.fakeProcess.emit('SIGTERM');
  await closeHybrid(h);
});

test('VM: passive ink stays click-through, rejects interleaving and requires observer EOF', async (t) => {
  const h = await startHybrid(t, { argv: ['--passive-ink'] });
  h.identify(); await h.tick();
  const [fixture, observer] = h.children;
  const rect = { x: 20, y: 40, width: 640, height: 400 };
  const sample = { status: 'available', state: 'normal', dpi: 96, hwnd: identity.hwnd, pid: fixture.pid,
    processCreated: '200', outerPx: rect, dwmPx: rect,
    overlay: { clientPx: rect, borderPx: { x: 8, y: 8 }, layers: [] } };
  observer.send(sample); await h.tick();
  const [ink] = h.windows;
  assert.equal(ink.ignored, true);
  assert.equal(ink.options.focusable, false);
  assert.equal(ink.options.alwaysOnTop, false);
  assert.equal(ink.shownInactive, true);
  const placer = h.children[2];
  assert.match(placer.args.at(-1), /meeting-window-p0-hybrid-place\.ps1$/);
  assert.deepEqual(JSON.parse(placer.stdin.read().toString()), { ink: '3', target: identity.hwnd });
  placer.send({ placed: true, adjacent: false }); await h.tick();
  assert.deepEqual(h.records.find((r) => r.stage === 'ink-placement'), { type: 'hybrid', inputEnabled: false,
    stage: 'ink-placement', placed: true, adjacent: false });
  observer.send({ ...sample, overlay: { ...sample.overlay, layers: [{ role: 'ink', hwnd: '3', dpi: 96,
    outerPx: rect, visible: true, topmost: false, adjacent: false, targetRelative: 'below', nextOwner: 'target-process',
    nextOwnedByTarget: false, nextVisible: false, nextOverlapsInk: false, nextHasArea: 'not-a-boolean', nextRole: 'raw-class' }] } });
  await h.tick();
  assert.equal(ink.destroyed, true);
  assert.equal(h.readbacks, 0);
  assert.equal(h.records.at(-1).stage, 'ink-order');
  const diagnostic = h.records.find((r) => r.stage === 'ink-readback-rejected');
  assert.equal(diagnostic.nextOwnedByTarget, false);
  assert.equal(diagnostic.nextVisible, false);
  assert.equal(diagnostic.nextOverlapsInk, false);
  assert.equal(diagnostic.nextHasArea, null);
  assert.equal(diagnostic.nextRole, 'unknown');
  assert.deepEqual(fixture.stops, ['eof']);
  assert.deepEqual(observer.stops, ['eof']);
  fixture.send({ type: 'closed' }); fixture.stop(); await h.tick();
  assert.deepEqual(h.exits, []);
  observer.send({ type: 'observer-eof' }); observer.stop(); await h.tick();
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.records.at(-1).cleanup, 'confirmed');
  assert.equal(h.records.at(-1).inkDestroyed, true);
  assert.equal(h.timers.size, 0);
});

test('VM: verified ink proves own-layer pixels, clean target stream and confirmed cleanup', async (t) => {
  const h = await startHybrid(t, { argv: ['--passive-ink'] });
  h.identify(); await h.tick();
  const [fixture, observer] = h.children;
  const rect = { x: 20, y: 40, width: 640, height: 400 };
  const sample = { status: 'available', state: 'normal', dpi: 96, hwnd: identity.hwnd, pid: fixture.pid,
    processCreated: '200', outerPx: rect, dwmPx: rect,
    overlay: { clientPx: rect, borderPx: { x: 8, y: 8 }, layers: [] } };
  observer.send(sample); await h.tick();
  h.children[2].send({ placed: true, adjacent: true }); await h.tick();
  observer.send({ ...sample, overlay: { ...sample.overlay, layers: [{ role: 'ink', hwnd: '3', dpi: 96,
    outerPx: rect, visible: true, topmost: false, adjacent: true }] } });
  for (let i = 0; i < 12 && !h.records.some((r) => r.stage === 'stream-observed'); i++) await h.tick();
  const presented = h.records.find((r) => r.stage === 'ink-presented');
  assert.equal(presented.presented, true);
  assert.ok(presented.inkPixels > 0);
  assert.ok(h.records.some((r) => r.stage === 'ink-native-verified'));
  const stream = h.records.find((r) => r.stage === 'stream-sample');
  assert.equal(stream.valid, true, JSON.stringify(h.records.map((r) => r.stage)));
  assert.equal(stream.inkColorPixels, 0);
  assert.ok(h.records.some((r) => r.stage === 'stream-observed'));
  assert.deepEqual(fixture.stops, ['eof']);
  assert.deepEqual(observer.stops, ['eof']);
  fixture.send({ type: 'closed' }); fixture.stop(0); await h.tick();
  observer.send({ type: 'observer-eof' }); observer.stop(0); await h.tick();
  assert.deepEqual(h.exits, [0]);
  assert.equal(h.records.at(-1).cleanup, 'confirmed');
  assert.equal(h.records.at(-1).observerEof, true);
  assert.equal(h.records.at(-1).inkDestroyed, true);
  assert.equal(h.timers.size, 0);
});

test('VM: forced termination stays unconfirmed even with closed message and exit 0', async (t) => {
  const h = await startHybrid(t);
  h.identify(); await h.tick();
  await h.fireTimer(5000);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.records.at(-1).forced, true);
  assert.equal(h.records.at(-1).cleanup, 'unconfirmed');
});

test('VM: real readline rejects protocol null and cleans up via EOF', async (t) => {
  const h = await startHybrid(t);
  const [child] = h.children;
  child.stdout.write('nu');
  await h.tick();
  assert.deepEqual(child.stops, [], 'partial JSON is not a complete protocol record');
  child.stdout.write('ll\n');
  await h.tick();
  assert.deepEqual(child.stops, ['eof']);
  assert.equal(h.records.at(-1).stage, 'fixture-protocol');
  assert.equal(h.sourceRequests.length, 0);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assert.deepEqual(h.kills, []);
  assertNoSuccess(h);
});

test('VM: rejected renderer readback destroys viewer and cleans up the child', async (t) => {
  const h = await startHybrid(t, { readback: async () => { throw new Error('synthetic readback failure'); } });
  h.identify(); await h.tick();
  assert.equal(h.records.at(-1).stage, 'capture-error');
  assert.deepEqual(h.children[0].stops, ['eof']);
  assert.ok(h.windows.length === 1 && h.windows[0].destroyed);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assertNoSuccess(h);
});

test('VM: null renderer readback fails safely and cleans up the child', async (t) => {
  const h = await startHybrid(t, { readback: async () => null });
  h.identify(); await h.tick();
  assert.equal(h.records.at(-1).stage, 'capture-error');
  assert.deepEqual(h.children[0].stops, ['eof']);
  assert.ok(h.windows.length === 1 && h.windows[0].destroyed);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assertNoSuccess(h);
});

test('VM: insufficient marker readback is rejected and cannot become success after clean exit', async (t) => {
  const h = await startHybrid(t, { readback: async () => ({ ...markerSample, frames: 2 }) });
  h.identify(); await h.tick();
  assert.equal(h.records.at(-1).stage, 'stream-rejected');
  assert.equal(h.records.find((r) => r.stage === 'stream-sample').valid, false);
  assert.deepEqual(h.children[0].stops, ['eof']);
  assert.equal(h.windows[0].destroyed, true);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [1]);
  assertNoSuccess(h);
});

test('VM: finite renderer failure is reported without raw exception text and never passes', async (t) => {
  const h = await startHybrid(t, { readback: async () => ({ failure: 'frame-wait', frames: 0,
    width: 642, height: 432, displaySurface: 'window', markers: [] }) });
  h.identify(); await h.tick();
  assert.equal(h.records.find((r) => r.stage === 'stream-sample').failure, 'frame-wait');
  assert.equal(h.records.at(-1).stage, 'stream-rejected');
  await closeHybrid(h);
  assertNoSuccess(h);
});

test('VM: getSources completing after observation timeout cannot create viewer or report success', async (t) => {
  const pending = deferred();
  let capturedSources;
  const h = await startHybrid(t, { getSources: (_, sources) => { capturedSources = sources; return pending.promise; } });
  h.identify(); await h.tick();
  assert.equal(h.sourceRequests.length, 1);
  assert.equal(h.windows.length, 0);
  await h.fireTimer(30000);
  assert.deepEqual(h.children[0].stops, ['eof']);
  await closeHybrid(h);
  pending.resolve(capturedSources); await h.tick();
  assert.equal(h.windows.length, 0);
  assert.equal(h.readbacks, 0);
  assert.equal(h.sourceRequests.length, 1);
  assert.equal(h.records.some((r) => r.stage === 'source'), false);
  assert.deepEqual(h.exits, [1]);
  assert.equal(h.timers.size, 0);
  assertNoSuccess(h);
});

test('VM: late media-request enumeration denies capture and cannot report stream success', async (t) => {
  const pending = deferred();
  let capturedSources;
  const h = await startHybrid(t, { getSources: (call, sources) => {
    capturedSources = sources;
    return call === 1 ? sources : pending.promise;
  } });
  h.identify(); await h.tick();
  assert.equal(h.sourceRequests.length, 2);
  assert.equal(h.windows.length, 1);
  await h.fireTimer(30000);
  assert.equal(h.windows[0].destroyed, true);
  await closeHybrid(h);
  pending.resolve(capturedSources); await h.tick();
  assert.equal(h.mediaReplies.length, 1);
  assert.deepEqual(Object.keys(h.mediaReplies[0]), []);
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.exits, [1]);
  assertNoSuccess(h);
});

test('VM: getSources completing after child exit cannot create viewer or report success', async (t) => {
  const pending = deferred();
  let capturedSources;
  const h = await startHybrid(t, { getSources: (_, sources) => { capturedSources = sources; return pending.promise; } });
  h.identify(); await h.tick();
  assert.equal(h.sourceRequests.length, 1);
  assert.equal(h.windows.length, 0);
  await closeHybrid(h, 1, { closed: false });
  assert.deepEqual(h.exits, [1]);
  pending.resolve(capturedSources); await h.tick();
  assert.deepEqual({
    viewers: h.windows.length,
    sourceReported: h.records.some((r) => r.stage === 'source'),
    successReported: h.records.some((r) => r.stage === 'stream-observed' || r.valid === true),
    pendingTimers: h.timers.size,
    exits: h.exits,
  }, { viewers: 0, sourceReported: false, successReported: false, pendingTimers: 0, exits: [1] });
});

test('VM: both source enumerations request zero-size metadata and never output window titles', async (t) => {
  const h = await startHybrid(t);
  h.identify(); await h.tick();
  assert.equal(h.sourceRequests.length, 2);
  for (const request of h.sourceRequests) {
    assert.deepEqual(request.types, ['window']);
    assert.deepEqual(request.thumbnailSize, { width: 0, height: 0 });
  }
  assert.equal(h.sourceRequests[0].fetchWindowIcons, false);
  assert.equal(h.mediaReplies[0].video.id, `window:${identity.hwnd}:0`);
  await closeHybrid(h);
  assert.deepEqual(h.exits, [0]);
  const output = JSON.stringify(h.records);
  assert.equal(output.includes(identity.title), false);
  assert.equal(output.includes('PRIVATE unrelated window title'), false);
  assert.equal(/"(?:title|name)"\s*:/.test(output), false);
  assert.ok(h.records.every((r) => r.type === 'hybrid' && r.inputEnabled === false));
});

test('manual A4 verdicts require real edge drags through the layer and no stealing', () => {
  const zero = { clicks: 0, drags: 0 };
  const edge = { clicks: 10, drags: 8 };
  assert.deepEqual(a4Verdict('passive', zero, edge), { pass: true, reason: 'click-through' });
  assert.equal(a4Verdict('passive', zero, { clicks: 10, drags: 7 }).reason, 'edge-drags-missing');
  assert.equal(a4Verdict('passive', { clicks: 1, drags: 0 }, edge).reason, 'ink-stole-input');
  assert.deepEqual(a4Verdict('draw', { clicks: 6, drags: 3 }, zero), { pass: true, reason: 'ink-owned-input' });
  assert.equal(a4Verdict('draw', { clicks: 2, drags: 2 }, zero).reason, 'draw-drags-missing');
  assert.equal(a4Verdict('draw', { clicks: 6, drags: 3 }, { clicks: 1, drags: 0 }).reason, 'target-received-input');
  for (const bad of [null, { clicks: -1, drags: 0 }, { clicks: 1.5, drags: 0 }]) {
    assert.equal(a4Verdict('passive', bad, edge).reason, 'counts');
  }
  assert.equal(a4Verdict('other', { clicks: 0, drags: 0 }, edge).reason, 'counts');
});
test('100% mapping check accepts matching frame size and marker spacing only', () => {
  const markers = [['TL', 25, 55], ['TR', 617, 55], ['BL', 25, 407], ['BR', 617, 407]]
    .map(([role, x, y]) => ({ role, x, y, count: 208 }));
  const ok = mappingVerdict(markers, { width: 642, height: 432 }, { width: 642, height: 432 },
    { width: 640, height: 400 });
  assert.equal(ok.ok, true);
  assert.equal(ok.spacingX, 592);
  assert.equal(ok.spacingY, 352);
  assert.equal(mappingVerdict(markers, { width: 642, height: 432 }, { width: 645, height: 432 },
    { width: 640, height: 400 }).ok, false);
  assert.equal(mappingVerdict(markers, { width: 642, height: 432 }, { width: 642, height: 432 },
    { width: 1280, height: 400 }).ok, false);
  assert.equal(mappingVerdict([], { width: 1, height: 1 }, { width: 1, height: 1 }, { width: 1, height: 1 }).reason, 'markers');
});
test('occluded A4 verdict needs real clicks on the fixture occluder and none on the target', () => {
  const zero = { clicks: 0, drags: 0 };
  assert.deepEqual(a4Verdict('occluded', zero, { clicks: 0, drags: 0, occluderClicks: 5 }),
    { pass: true, reason: 'occluder-owned-input' });
  assert.equal(a4Verdict('occluded', zero, { clicks: 0, drags: 0, occluderClicks: 2 }).reason, 'occluder-clicks-missing');
  assert.equal(a4Verdict('occluded', zero, { clicks: 1, drags: 0, occluderClicks: 5 }).reason, 'target-received-occluded-click');
});
test('edge strip hot zones accept only strip-owned clicks', () => {
  const zero = { clicks: 0, drags: 0 };
  const strips = { top: 2, bottom: 2, left: 2, right: 2 };
  assert.deepEqual(stripInputVerdict(strips, zero, zero), { pass: true, reason: 'strips-owned-input', total: 8 });
  assert.equal(stripInputVerdict({ top: 1 }, zero, zero).reason, 'strip-clicks-missing');
  assert.equal(stripInputVerdict(strips, zero, { clicks: 1, drags: 0 }).reason, 'target-received-edge-click');
  assert.equal(stripInputVerdict(strips, { clicks: 1, drags: 0 }, zero).reason, 'ink-stole-edge-input');
  assert.equal(stripInputVerdict(null, zero, zero).reason, 'counts');
  assert.equal(stripInputVerdict({ top: -1, bottom: 9 }, zero, zero).reason, 'counts');
});
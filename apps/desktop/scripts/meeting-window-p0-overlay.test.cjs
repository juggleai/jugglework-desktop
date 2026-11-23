const { test } = require('node:test');
const assert = require('node:assert/strict');
const { overlayPlan, checkLayers, createFixtureOverlay } = require('./meeting-window-p0-overlay.cjs');
const sample = {
  status: 'available', hwnd: '9007199254740993', pid: 1234, processCreated: '133800000000000001',
  state: 'normal', dpi: 96,
  outerPx: { x: -100, y: 20, width: 640, height: 480 },
  dwmPx: { x: -93, y: 20, width: 626, height: 473 },
};
const evidence = { clientPx: { x: -92, y: 51, width: 624, height: 441 }, borderPx: { x: 8, y: 8 }, layers: [] };
const display = { id: 7, scaleFactor: 1, bounds: { x: -1000, y: 0, width: 2000, height: 1000 } };
const screen = {
  screenToDipRect: (_, box) => ({ ...box }), dipToScreenRect: (_, box) => ({ ...box }),
  getDisplayMatching: () => display,
};

test('physical layout leaves fixture controls and title accessible, covers all four outer corners', () => {
  const plan = overlayPlan(sample, evidence, screen);
  assert.deepEqual(plan.px, [
    { x: -92, y: 131, width: 624, height: 361 },
    { x: -100, y: 20, width: 640, height: 8 },
    { x: -100, y: 492, width: 640, height: 8 },
    { x: -100, y: 28, width: 8, height: 464 },
    { x: 532, y: 28, width: 8, height: 464 },
  ]);
});

test('rejects a normal-looking sample with non-string HWND or missing lifetime before creating own windows', () => {
  assert.throws(() => overlayPlan({ ...sample, hwnd: 9007199254740992 }, evidence, screen), /identity/);
  assert.throws(() => overlayPlan({ ...sample, processCreated: undefined }, evidence, screen), /identity/);
});

test('DPI changes are terminal even when state changes simultaneously', () => {
  const baseline = overlayPlan(sample, evidence, screen);
  assert.throws(() => overlayPlan({ ...sample, dpi: 144, state: 'maximized' }, evidence, screen, baseline), /dpi-change/);
});

test('only same-size translation on the same display and process lifetime is supported', () => {
  const baseline = overlayPlan(sample, evidence, screen);
  assert.throws(() => overlayPlan({ ...sample, processCreated: '133800000000000002' }, evidence, screen, baseline), /identity/);
  assert.throws(() => overlayPlan({ ...sample, outerPx: { ...sample.outerPx, width: 641 } }, evidence, screen, baseline), /resize/);
  assert.throws(() => overlayPlan({ ...sample, state: 'minimized', outerPx: null, dwmPx: null }, evidence, screen, baseline), /state/);
  assert.throws(() => overlayPlan(sample, evidence, { ...screen, getDisplayMatching: () => ({ ...display, id: 8 }) }, baseline), /display/);
});

test('rejects fractional mapping, straddling displays, and malformed client or edge geometry', () => {
  assert.throws(() => overlayPlan(sample, evidence, { ...screen,
    dipToScreenRect: (_, box) => ({ ...box, width: box.width + 1 }) }), /mapping/);
  assert.throws(() => overlayPlan(sample, evidence, { ...screen,
    getDisplayMatching: () => ({ ...display, bounds: { x: 0, y: 0, width: 1000, height: 1000 } }) }), /display/);
  assert.throws(() => overlayPlan(sample, { ...evidence, clientPx: { ...evidence.clientPx, x: -101 } }, screen), /geometry/);
  assert.throws(() => overlayPlan(sample, { ...evidence, borderPx: { x: 0, y: 8 } }, screen), /geometry/);
});

function observed(plan, own) {
  return own.map((layer, i) => ({ ...layer, dpi: 96, outerPx: plan.px[i], topmost: false, visible: true, adjacent: true }));
}

test('native layer verification requires exact own HWND strings, geometry and non-topmost adjacency', () => {
  const plan = overlayPlan(sample, evidence, screen);
  const own = ['ink', 'top', 'bottom', 'left', 'right'].map((role, i) => ({ role, hwnd: String(9007199254740993n + BigInt(i)) }));
  const layers = observed(plan, own);
  assert.equal(checkLayers(layers, own, plan), 'ok');
  assert.equal(checkLayers(layers.slice(1), own, plan), 'identity');
  assert.equal(checkLayers([{ ...layers[0], hwnd: 9007199254740992 }, ...layers.slice(1)], own, plan), 'identity');
  for (const [change, want] of [[{ topmost: true }, 'topmost'], [{ dpi: 144 }, 'dpi'],
    [{ visible: false }, 'visibility'], [{ adjacent: false }, 'order'],
    [{ outerPx: { ...layers[0].outerPx, width: 625 } }, 'geometry']]) {
    assert.equal(checkLayers([{ ...layers[0], ...change }, ...layers.slice(1)], own, plan), want);
  }
});

function runtime(t, testScreen = screen) {
  const windows = [], records = [], failures = [];
  class Window {
    constructor(options) {
      this.options = options; this.ignored = true; this.destroyed = false;
      this.webContents = new (require('node:events').EventEmitter)();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.executeJavaScript = async () => ({ clicks: 0, drags: 0 });
      windows.push(this);
    }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    setBounds(box) { this.box = box; }
    getNativeWindowHandle() { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(100 + windows.indexOf(this))); return b; }
    getMediaSourceId() { return `window:${100 + windows.indexOf(this)}:0`; }
    async loadURL() {}
    showInactive() { this.shown = true; }
    moveAbove(id) { this.above = id; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const overlay = createFixtureOverlay({ BrowserWindow: Window, screen: testScreen, title: `Meeting Window P0 ${'a'.repeat(32)}`,
    emit: (r) => records.push(r), fail: (reason) => failures.push(reason) });
  t.after(() => overlay.dispose());
  return { overlay, windows, records, failures };
}

test('fractional mapping reports each mismatched rectangle and stops before creating layers', async (t) => {
  // Stand-in for integer DIP conversion, not a model of Electron rounding.
  const largeDisplay = { ...display, scaleFactor: 1.25 };
  const scale = (rect, factor) => Object.fromEntries(Object.entries(rect).map(([key, n]) => [key, Math.round(n * factor)]));
  const { overlay, windows, records, failures } = runtime(t, {
    getDisplayMatching: () => largeDisplay,
    screenToDipRect: (_, rect) => scale(rect, 0.8),
    dipToScreenRect: (_, rect) => scale(rect, 1.25),
  });
  const outerPx = { x: 101, y: 106, width: 658, height: 447 };
  await overlay.observe({ ...sample, dpi: 120, outerPx, dwmPx: { x: 109, y: 106, width: 642, height: 439 } }, {
    clientPx: { x: 110, y: 144, width: 640, height: 400 }, borderPx: { x: 9, y: 9 }, layers: [],
  });
  assert.deepEqual(failures, ['overlay-mapping']);
  assert.equal(windows.length, 0);
  assert.deepEqual(records, [{ type: 'overlay', stage: 'mapping-mismatch', dpi: 120, scaleFactor: 1.25,
    mismatches: [
      { role: 'outer', px: outerPx, dip: { x: 81, y: 85, width: 526, height: 358 }, roundTripPx: { x: 101, y: 106, width: 658, height: 448 } },
    ] }]);
});

test('passive layers await native readback and are removed on the first lost-order sample', async (t) => {
  const { overlay, windows, failures } = runtime(t);
  await overlay.observe(sample, evidence);
  assert.equal(windows.length, 5);
  assert.ok(windows.every((w) => w.ignored && w.options.alwaysOnTop === false && w.options.focusable === false));
  assert.ok(windows.every((w) => w.shown && w.above === undefined));
  const layers = observed(overlayPlan(sample, evidence, screen), overlay.identities());
  await overlay.observe(sample, { ...evidence, layers });
  assert.deepEqual(windows.map((w) => w.ignored), [true, false, false, false, false]);
  overlay.setMode('draw');
  assert.deepEqual(windows.map((w) => w.ignored), [false, false, false, false, false]);
  await overlay.observe(sample, { ...evidence, layers: layers.map((l) => ({ ...l, adjacent: false })) });
  assert.ok(windows.every((w) => w.ignored));
  assert.deepEqual(failures, ['overlay-order']);
  assert.ok(windows.every((w) => w.destroyed && w.above === undefined));
});

test('bad geometry, topmost, unavailable observations and DPI changes remove all own inputs', async (t) => {
  for (const kind of ['geometry', 'topmost', 'unavailable', 'dpi']) {
    const { overlay, windows, failures } = runtime(t);
    await overlay.observe(sample, evidence);
    const layers = observed(overlayPlan(sample, evidence, screen), overlay.identities());
    if (kind === 'geometry') layers[0].outerPx = { ...layers[0].outerPx, width: 1 };
    if (kind === 'topmost') layers[0].topmost = true;
    await overlay.observe(kind === 'unavailable' ? { status: 'unavailable' } : kind === 'dpi' ? { ...sample, dpi: 144 } : sample,
      { ...evidence, layers });
    assert.equal(failures.length, 1, kind);
    assert.ok(windows.every((w) => w.ignored && w.destroyed), kind);
  }
});

test('same-DPI movement suspends inputs until the newly positioned layers are observed', async (t) => {
  const { overlay, windows } = runtime(t);
  await overlay.observe(sample, evidence);
  await overlay.observe(sample, { ...evidence, layers: observed(overlayPlan(sample, evidence, screen), overlay.identities()) });
  const moved = { ...sample, outerPx: { ...sample.outerPx, x: -90 }, dwmPx: { ...sample.dwmPx, x: -83 } };
  const nextEvidence = { ...evidence, clientPx: { ...evidence.clientPx, x: -82 } };
  await overlay.observe(moved, { ...nextEvidence, layers: observedLayers(overlay) });
  assert.ok(windows.every((w) => w.ignored));
  assert.ok(windows.every((w) => w.above === undefined));
  assert.equal(windows[0].box.x, -82);
  await overlay.observe(moved, { ...nextEvidence, layers: observed(overlayPlan(moved, nextEvidence, screen), overlay.identities()) });
  assert.equal(windows[1].ignored, false);
});

test('a movement sample with lost order removes layers without repositioning them', async (t) => {
  const { overlay, windows, failures } = runtime(t);
  await overlay.observe(sample, evidence);
  const layers = observedLayers(overlay);
  await overlay.observe(sample, { ...evidence, layers });
  const moved = { ...sample, outerPx: { ...sample.outerPx, x: -90 }, dwmPx: { ...sample.dwmPx, x: -83 } };
  await overlay.observe(moved, { ...evidence, clientPx: { ...evidence.clientPx, x: -82 },
    layers: layers.map((layer) => ({ ...layer, adjacent: false })) });
  assert.deepEqual(failures, ['overlay-order']);
  assert.ok(windows.every((w) => w.ignored && w.destroyed));
  assert.equal(windows[0].box.x, evidence.clientPx.x);
});

test('show errors destroy own windows without enabling input', async (t) => {
  const { overlay, windows, failures } = runtime(t);
  // A throwing OS API remains a failure; do not mistake JS call completion for native ordering evidence.
  const starting = overlay.observe(sample, evidence);
  await Promise.resolve();
  windows[0].showInactive = () => { throw new Error('OS rejected'); };
  await starting;
  assert.deepEqual(failures, ['overlay-runtime']);
  assert.ok(windows.every((w) => w.ignored && w.destroyed));
});

test('dispose cancels pending telemetry deadlines and polling, ignores late results or rejection', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const rejectLate of [false, true]) {
    const { overlay, windows, records, failures } = runtime(t);
    await overlay.observe(sample, evidence);
    let settle, reads = 0;
    windows[0].webContents.executeJavaScript = () => {
      reads++;
      return new Promise((resolve, reject) => { settle = rejectLate ? reject : resolve; });
    };
    let observed = false;
    const verifying = overlay.observe(sample, { ...evidence, layers: observedLayers(overlay) }).then(() => { observed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(observed, true, 'observe must not await telemetry');
    await verifying;
    t.mock.timers.tick(500);
    assert.equal(reads, 1);
    overlay.dispose();
    const count = records.length;
    t.mock.timers.tick(10_000);
    assert.deepEqual(failures, [], 'dispose clears the pending telemetry deadline before it can fail');
    settle(rejectLate ? new Error('late') : { clicks: 9, drags: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(10_000);
    assert.equal(records.length, count);
    assert.deepEqual(failures, []);
    assert.equal(reads, 1);
    assert.ok(windows.every((w) => w.destroyed && w.ignored));
  }
});

function observedLayers(overlay) { return observed(overlayPlan(sample, evidence, screen), overlay.identities()); }

test('telemetry rejection or malformed counts removes enabled inputs and reports failure', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  for (const result of ['reject', 'malformed']) {
    const { overlay, windows, failures } = runtime(t);
    await overlay.observe(sample, evidence);
    windows[0].webContents.executeJavaScript = async () => {
      if (result === 'reject') throw new Error('renderer failed');
      return { clicks: -1, drags: 0 };
    };
    await overlay.observe(sample, { ...evidence, layers: observedLayers(overlay) });
    t.mock.timers.tick(500);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(failures.length, 1);
    assert.match(failures[0], /^overlay-(telemetry|counters)/);
    assert.ok(windows.every((w) => w.destroyed && w.ignored));
  }
});

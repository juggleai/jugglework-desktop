const assert = require('node:assert/strict');
const test = require('node:test');
const { probeEdgeSizes } = require('./meeting-window-p0-edge-size.cjs');

test('Electron browser loader starts the probe even without require.main and times out waiting for ready', async () => {
  const source = require('node:fs').readFileSync(require.resolve('./meeting-window-p0-edge-size.cjs'), 'utf8');
  const records = [], exits = [];
  let deadline;
  const app = { on() {}, whenReady: () => new Promise(() => {}), exit: (code) => exits.push(code) };
  require('node:vm').runInNewContext(source, {
    require: (name) => name === 'electron' ? { app } : require(name), module: { exports: {} },
    process: { platform: 'win32', type: 'browser', versions: { electron: '44.0.0' } },
    console: { log: (line) => records.push(JSON.parse(line)) },
    setTimeout: (fn) => { deadline = fn; }, clearTimeout() {},
  });
  assert.equal(records.at(-1)?.stage, 'waiting-for-ready');
  deadline();
  await new Promise(setImmediate);
  assert.equal(records.at(-1)?.stage, 'ready-timeout');
  assert.deepEqual(exits, [1]);
});

const primary = { scaleFactor: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } };

test('measures all four cases before and after inactive, click-through display', async () => {
  const records = [];
  let live = 0;
  let shown = 0;
  let settled = false;
  class BrowserWindow {
    constructor(options) {
      assert.equal(live++, 0);
      for (const flag of ['show', 'frame', 'focusable', 'alwaysOnTop', 'thickFrame']) {
        assert.equal(options[flag], false, flag);
      }
      this.options = options;
    }
    setIgnoreMouseEvents(ignore) { assert.equal(ignore, true); this.ignored = true; }
    async loadURL() {}
    setBounds(bounds) { this.bounds = bounds; }
    getBounds() {
      if (!this.visible) return { ...this.bounds };
      assert.equal(settled, true);
      const axis = this.bounds.width === 8 ? 'width' : 'height';
      return { ...this.bounds, [axis]: this.options.resizable ? 8 : 39 };
    }
    showInactive() {
      assert.equal(this.ignored, true);
      assert.equal(records[shown]?.beforeShowDip.width, this.bounds.width);
      assert.equal(this.bounds.width, this.options.width);
      assert.equal(this.bounds.height, this.options.height);
      shown++;
      this.visible = true;
      settled = false;
    }
    destroy() { live--; }
  }

  await probeEdgeSizes({
    BrowserWindow,
    screen: { getPrimaryDisplay: () => primary },
    emit: (record) => {
      if (record.type !== 'edge-size') return;
      if ('beforeShowDip' in record) records.push(record);
      else Object.assign(records.at(-1), record);
    },
    settle: async () => { settled = true; },
  });
  assert.equal(live, 0);
  assert.equal(shown, 4);
  assert.deepEqual(records.map(({ resizable, orientation, requestedDip, beforeShowDip, afterShowDip }) => {
    assert.deepEqual(beforeShowDip, requestedDip);
    assert.ok(requestedDip.x >= 0 && requestedDip.x + afterShowDip.width <= 1000);
    assert.ok(requestedDip.y >= 0 && requestedDip.y + afterShowDip.height <= 800);
    return [resizable, orientation, requestedDip.width, requestedDip.height, afterShowDip.width, afterShowDip.height];
  }), [
    [false, 'horizontal', 240, 8, 240, 39],
    [false, 'vertical', 8, 240, 39, 240],
    [true, 'horizontal', 240, 8, 240, 8],
    [true, 'vertical', 8, 240, 8, 240],
  ]);
});

test('rejects scaled or undersized primary displays before creating windows', async () => {
  for (const display of [{ ...primary, scaleFactor: 1.25 }, { ...primary, workArea: { ...primary.workArea, width: 100 } }]) {
    await assert.rejects(probeEdgeSizes({
      BrowserWindow: class { constructor() { assert.fail('unexpected window'); } },
      screen: { getPrimaryDisplay: () => display },
    }), /primary-display/);
  }
});

test('destroys the owned window if showing it fails', async () => {
  let destroyed = false;
  await assert.rejects(probeEdgeSizes({
    BrowserWindow: class {
      setIgnoreMouseEvents() {}
      async loadURL() {}
      setBounds(bounds) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
      showInactive() { throw new Error('show failed'); }
      destroy() { destroyed = true; }
    },
    screen: { getPrimaryDisplay: () => primary },
    emit() {},
  }), /show failed/);
  assert.equal(destroyed, true);
});

test('logs a pending page load and destroys the window when it times out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const records = [];
  let destroyed = false;
  const run = probeEdgeSizes({
    BrowserWindow: class {
      setIgnoreMouseEvents() {}
      loadURL() { return new Promise(() => {}); }
      destroy() { destroyed = true; }
    },
    screen: { getPrimaryDisplay: () => primary }, emit: (record) => records.push(record),
  });
  const rejected = assert.rejects(run, /window-load-timeout/);
  assert.equal(records.at(-1)?.stage, 'window-loading');
  t.mock.timers.tick(10_000);
  await rejected;
  assert.equal(destroyed, true);
});

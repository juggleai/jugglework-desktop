const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { observeVisibleEdges } = require('./meeting-window-p0-edge-visible-native.cjs');

function sample() {
  return { type: 'sample', windows: [
    ['target', 64, 64, 240, 240], ['top', 64, 64, 240, 8], ['bottom', 64, 296, 240, 8],
    ['left', 64, 72, 8, 224], ['right', 296, 72, 8, 224],
  ].map(([role, x, y, width, height]) => ({
    role, px: { x, y, width, height }, dpi: 96, pmv2: true, visible: true,
    topmost: false, passive: true, adjacent: role === 'target' ? null : true,
  })) };
}

function fixture({ exitsOnEof = true, exitsOnKill = true, ...overrides } = {}) {
  const records = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
  const closed = new Promise(resolve => child.stdin.once('finish', resolve));
  const close = (code = 0) => { child.stdout.end(); child.emit('close', code); };
  if (exitsOnEof) closed.then(() => close());
  let kills = 0;
  child.kill = () => { kills++; if (exitsOnKill) queueMicrotask(() => close(null)); };
  const result = observeVisibleEdges({ child, emit: record => records.push(record),
    durationMs: 10, startupMs: 200, sampleMs: 200, cleanupMs: 20, killMs: 20, ...overrides });
  return { result, closed, records, close, kills: () => kills, send: value => child.stdout.write(`${JSON.stringify(value)}\n`) };
}

test('exact passive observation is time-bounded and waits for EOF cleanup', async () => {
  const run = fixture({ exitsOnEof: false, cleanupMs: 200 });
  run.send(sample());
  await run.closed;
  assert.deepEqual(run.records.map(r => r.stage), ['visible-sample']);
  run.close();
  assert.equal(await run.result, 0);
  assert.deepEqual(run.records.map(r => r.stage), ['visible-sample', 'removed']);
  assert.ok(run.records.every(r => r.inputEnabled === false));
});

for (const [label, patch, stage] of [
  ['one-pixel discrepancy', { px: { x: 296, y: 72, width: 9, height: 224 } }, 'geometry'],
  ['topmost edge', { topmost: true }, 'topmost'],
  ['unexpected layer between edges', { adjacent: false }, 'order'],
  ['edge not passive', { passive: false }, 'visibility-style'],
  ['unexpected DPI', { dpi: 120 }, 'dpi'],
  ['missing evidence', { visible: undefined }, 'protocol'],
]) {
  test(`${label} prevents a visible observation and closes stdin`, async () => {
    const run = fixture();
    const data = sample();
    Object.assign(data.windows[4], patch);
    run.send(data);
    assert.equal(await run.result, 1);
    await run.closed;
    assert.deepEqual(run.records.map(r => r.stage), [stage]);
    assert.equal(run.kills(), 0);
  });
}

test('losing verified order later terminates instead of waiting out the observation', async () => {
  const run = fixture({ durationMs: 5_000 });
  run.send(sample());
  const data = sample();
  data.windows[1].adjacent = false;
  run.send(data);
  assert.equal(await run.result, 1);
  await run.closed;
  assert.deepEqual(run.records.map(r => r.stage), ['visible-sample', 'order']);
});

test('no further readback fails closed and a stuck helper is terminated', async () => {
  const run = fixture({ durationMs: 5_000, sampleMs: 10, exitsOnEof: false });
  run.send(sample());
  assert.equal(await run.result, 1);
  assert.equal(run.kills(), 1);
  assert.deepEqual(run.records.map(r => r.stage), ['visible-sample', 'sample-timeout', 'forced-cleanup']);
});

test('native cleanup failure after EOF is not reported as removal', async () => {
  const run = fixture({ exitsOnEof: false, cleanupMs: 200 });
  run.send(sample());
  await run.closed;
  run.close(1);
  assert.equal(await run.result, 1);
  assert.deepEqual(run.records.map(r => r.stage), ['visible-sample', 'helper-exit']);
});

test('unconfirmed helper termination is reported without claiming removal', async () => {
  const run = fixture({ exitsOnEof: false, exitsOnKill: false, startupMs: 10 });
  assert.equal(await run.result, 1);
  assert.equal(run.kills(), 1);
  assert.deepEqual(run.records.map(r => r.stage), ['startup-timeout', 'forced-cleanup', 'cleanup-timeout']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { classifyWindowSample, createMeetingWindowTracker } from './meeting-window-tracker.mjs';

const initial = { x: 20, y: -80, width: 640, height: 400 };
const visible = (bounds = initial) => ({ status: /** @type {const} */ ('visible'), pid: 812, bounds });

test('movement, resize, visibility and target loss are distinct', () => {
  assert.equal(classifyWindowSample(initial, visible({ ...initial, x: 91 })), 'follow');
  assert.equal(classifyWindowSample(initial, visible({ ...initial, height: 401 })), 'resize');
  assert.equal(classifyWindowSample(initial, visible({ ...initial, width: 641 })), 'resize');
  assert.equal(classifyWindowSample(initial, { status: 'hidden' }), 'hide');
  assert.equal(classifyWindowSample(initial, { status: 'closed' }), 'close');
  assert.equal(classifyWindowSample(initial, visible({ ...initial, width: 0 })), 'unavailable');
});

test('geometry pending is independent from visibility and requires a later trusted actual size', () => {
  assert.equal(classifyWindowSample(initial, { status: 'geometry-pending' }, true), 'pending');
  assert.equal(classifyWindowSample(null, { status: 'geometry-pending' }, true), 'pending');
  assert.equal(classifyWindowSample(initial, { status: 'minimized' }, true), 'hide');
  assert.equal(classifyWindowSample(initial, visible(), true), 'unavailable');
  assert.equal(classifyWindowSample(initial, { ...visible(), actualSize: initial }, true), 'follow');
  assert.equal(classifyWindowSample(initial, { ...visible(), actualSize: { width: 641, height: 400 } }, true), 'resize');
});

test('the macOS helper cannot introduce a Windows geometry-pending sample', () => {
  const { tracker, child } = fixture();
  const samples = [];
  tracker.watchWindow({ windowId: 2, pid: 812 }, state => samples.push(state));
  child.stdout.write('{"status":"geometry-pending"}\n');
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
  assert.equal(child.killed, true);
});

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  const tracker = createMeetingWindowTracker({ helperPath: '/fixture', spawnHelper: () => child });
  return { tracker, child };
}

test('watch decodes split messages and ignores everything after stop', () => {
  const { tracker, child } = fixture();
  const samples = [];
  const stop = tracker.watchWindow({ windowId: 2, pid: 812 }, state => samples.push(state));
  const line = JSON.stringify(visible());
  child.stdout.write(line.slice(0, 8));
  assert.deepEqual(samples, []);
  child.stdout.write(line.slice(8) + '\n');
  assert.deepEqual(samples, [visible()]);
  stop();
  child.stdout.write('{"status":"closed"}\n');
  child.emit('close', 0);
  assert.deepEqual(samples, [visible()]);
  assert.equal(child.killed, true);
});

test('watch registers only the scoped layers and delivers order loss separately until stopped', () => {
  const { tracker, child } = fixture();
  const samples = [], orders = [], commands = [];
  child.stdin.setEncoding('utf8').on('data', data => commands.push(JSON.parse(data)));
  const stop = tracker.watchWindow({ windowId: 2, pid: 812 }, state => samples.push(state), () => orders.push('lost'));
  child.stdout.write(`${JSON.stringify(visible())}\n`);
  const lost = '{"event":"order-lost"}\n';
  child.stdout.write(lost);
  assert.deepEqual(orders, [], 'no overlay is registered yet');
  for (const invalid of [[], [2], [0], [7, 8, 9, 10, 11]]) stop.setOverlayWindows(invalid);
  assert.deepEqual(commands, []);
  stop.setOverlayWindows([7]);
  child.stdout.write(lost);
  stop();
  stop.setOverlayWindows([12]);
  child.stdout.write(lost);
  child.emit('close', 0);
  assert.deepEqual(orders, ['lost']);
  assert.deepEqual(commands, [{ overlayWindowIds: [7] }]);
  assert.deepEqual(samples, [visible()]);
});

test('an unexpected exit is not interpreted as the target closing', () => {
  const { tracker, child } = fixture();
  const samples = [];
  tracker.watchWindow({ windowId: 2, pid: 812 }, state => samples.push(state));
  child.emit('close', 1);
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
});

test('an ambiguous interleaving is delivered as a best-effort repair, not tracking loss', () => {
  const { tracker, child } = fixture();
  const samples = [], orders = [];
  const stop = tracker.watchWindow({ windowId: 2, pid: 812 }, sample => samples.push(sample), event => orders.push(event));
  child.stdout.write(`${JSON.stringify(visible())}\n`);
  child.stdout.write('{"event":"order-interleaved"}\n');
  assert.deepEqual(orders, [], 'unregistered annotation cannot be reordered');
  stop.setOverlayWindows([7]);
  child.stdout.write('{"event":"order-interleaved"}\n');
  child.stdout.write('{"event":"order-lost"}\n');
  assert.deepEqual(orders, ['order-interleaved', 'order-lost']);
  assert.deepEqual(samples, [visible()]);
  stop();
});

test('legacy edge overlap updates neither reorder nor stop a canvas-only session', () => {
  const { tracker, child } = fixture();
  const samples = [], orders = [];
  const stop = tracker.watchWindow({ windowId: 2, pid: 812 }, s => samples.push(s), (...event) => orders.push(event));
  const overlap = ids => child.stdout.write(`${JSON.stringify({ event: 'edge-overlap', edgeIds: ids })}\n`);
  child.stdout.write(`${JSON.stringify(visible())}\n`);
  overlap([8]);
  stop.setOverlayWindows([7]);
  overlap([7]);
  child.stdout.write('{"event":"order-lost"}\n');
  stop();
  assert.deepEqual(samples, [visible()]);
  assert.deepEqual(orders, [['order-lost']]);
});

test('inspect waits for successful completion and does not trust an invalid PID', async () => {
  for (const [pid, code, expected] of [[812, 0, { pid: 812 }], [812, 1, null], [0, 0, null]]) {
    const { tracker, child } = fixture();
    const resolving = tracker.resolveWindowIdentity(2);
    child.stdout.end(`${JSON.stringify({ pid })}\n`);
    child.emit('close', code);
    assert.deepEqual(await resolving, expected);
  }
});

test('a mismatched owner cannot be reported as a live target', () => {
  const { tracker, child } = fixture();
  const samples = [];
  tracker.watchWindow({ windowId: 2, pid: 812 }, state => samples.push(state));
  child.stdout.write(`${JSON.stringify({ ...visible(), pid: 813 })}\n`);
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
});

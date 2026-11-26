const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { holdApp, trackChild, waitForClose, finishChild, motionVerdict, expectedRejection } = require('./meeting-window-validation-lifetime.cjs');

test('last window closure cannot quit before fixture cleanup finishes', () => {
  const app = new EventEmitter(); const release = holdApp(app);
  assert.equal(app.listenerCount('window-all-closed'), 1);
  app.emit('window-all-closed');
  let prevented = false;
  app.emit('before-quit', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  release();
  assert.equal(app.listenerCount('window-all-closed'), 0);
  assert.equal(app.listenerCount('before-quit'), 0);
});

test('normal EOF cleanup requires an actual close with exit zero', async () => {
  const child = new EventEmitter(); const record = trackChild(child, 'target');
  const result = await finishChild(record, () => queueMicrotask(() => child.emit('close', 0, null)), 20);
  assert.equal(result.graceful, true);
  assert.equal(result.closed, true);
});

test('stop request alone is not evidence of process exit', async () => {
  const child = new EventEmitter(); child.kill = () => true;
  const record = trackChild(child, 'helper');
  const result = await finishChild(record, () => {}, 5);
  assert.equal(result.closed, false);
  assert.equal(result.graceful, false);
  assert.equal(result.forced, true);
});

test('timeout kill followed by close stays forced, not graceful', async () => {
  const child = new EventEmitter(); child.kill = () => { queueMicrotask(() => child.emit('close', 1, null)); return true; };
  const result = await finishChild(trackChild(child, 'helper'), () => {}, 5);
  assert.equal(result.closed, true);
  assert.equal(result.forced, true);
  assert.equal(result.graceful, false);
});

test('spawn error and late close cannot be treated as successful EOF', async () => {
  const child = new EventEmitter(); const record = trackChild(child, 'helper');
  child.emit('error', new Error('synthetic'));
  child.emit('close', -1, null);
  assert.equal(await waitForClose(record, 10), true);
  assert.equal((await finishChild(record, () => {}, 10)).graceful, false);
});

test('explicit cancellation waits for real close and retains termination status', async () => {
  const child = new EventEmitter(); const record = trackChild(child, 'watch');
  child.emit('close', null, 'SIGTERM');
  const result = await finishChild(record, () => {}, 10);
  assert.equal(result.closed, true);
  assert.equal(result.graceful, false);
  assert.equal(result.signal, 'SIGTERM');
});

test('motion aggregation cannot hide an unavailable sample or missing evidence', () => {
  const size = { width: 704, height: 471 };
  const sample = { status: 'visible', actualSize: size };
  assert.equal(motionVerdict([sample], size).pass, true);
  assert.equal(motionVerdict([sample, { status: 'unavailable' }], size).pass, false);
  for (const status of ['closed', 'hidden', 'minimized']) assert.equal(motionVerdict([sample, { status }], size).pass, false);
  assert.equal(motionVerdict([], size).pass, false);
  assert.equal(motionVerdict([{ ...sample, actualSize: { ...size, width: 705 } }], size).pass, false);
});

test('only a normal native refusal qualifies as a negative control', () => {
  const child = new EventEmitter(); child.kill = () => true;
  const record = trackChild(child, 'helper');
  child.emit('exit', 1, null);
  assert.equal(record.exited, true);
  assert.equal(record.closed, false);
  assert.equal(expectedRejection(record), false);
  child.emit('close', 1, null);
  assert.equal(expectedRejection(record), true);
  child.kill();
  assert.equal(record.killRequests, 1);
  assert.equal(expectedRejection(record), false);
});

test('spawn errors never count as a clean native refusal', () => {
  const child = new EventEmitter(); const record = trackChild(child, 'helper');
  child.emit('error', new Error('synthetic')); child.emit('close', 1, null);
  assert.equal(expectedRejection(record), false);
});

test('pending motion requires a trusted recovery, never passes a terminal or unmatched transient', () => {
  const size = { width: 704, height: 471 }, visible = { status: 'visible', actualSize: size }, pending = { status: 'geometry-pending' };
  assert.equal(motionVerdict([visible, pending], size, true).pass, false);
  assert.equal(motionVerdict([visible, pending, visible], size, true).pass, true);
  assert.equal(motionVerdict([visible, pending, visible], size).pass, false);
  assert.equal(motionVerdict([pending, { status: 'unavailable' }], size, true).pass, false);
  assert.equal(motionVerdict([pending, { ...visible, actualSize: { ...size, height: 472 } }], size, true).pass, false);
});

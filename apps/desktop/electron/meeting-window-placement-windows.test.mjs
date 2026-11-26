import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsCanvasPlacement, TARGET_POSITION_STALE, TARGET_SIZE_UNCONFIRMED } from './meeting-window-placement-windows.mjs';

const target = { kind: 'window', platform: 'win32', windowId: '9007199254740993', pid: 812,
  processStartedAt: '134000000000000001', sourceId: 'window:9007199254740993:0', captureId: 'capture-1' };
const request = { bounds: { x: 20, y: -40, width: 642, height: 432 }, visible: false };
function fixture(options = {}) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), killed: false, kill() { this.killed = true; return true; } });
  const calls = [];
  const native = Buffer.alloc(8); native.writeBigUInt64LE(9007199254740995n);
  const canvas = { isDestroyed: () => false, getNativeWindowHandle: () => native };
  const place = createWindowsCanvasPlacement({ helperPath: '/fixture.exe', ownerPid: 900, timeoutMs: 100,
    spawnHelper: (path, args, opts) => { calls.push({ path, args, opts }); return child; }, ...options });
  return { child, calls, canvas, place };
}
const reply = { placed: true, hwnd: target.windowId, pid: 812, processStartedAt: target.processStartedAt,
  ink: '9007199254740995', ownerPid: 900, bounds: request.bounds, visible: false };

test('read-only size refusal waits for native actual-size evidence; mutating placement still refuses', async () => {
  for (const checkOnly of [true, false]) {
    const f = fixture();
    const result = f.place(f.canvas, target, { ...request, visible: true, checkOnly });
    f.child.stdout.write('{"refusal":"target-size"}');
    f.child.emit('close', 1);
    assert.equal(await result, checkOnly ? TARGET_SIZE_UNCONFIRMED : false);
  }
});

test('only the hidden host neighbor readback produces a distinct refusal', async () => {
  for (const [checkOnly, refusal, expected] of [
    [true, 'order-check-own-hidden', 'hidden-host-neighbor'],
    [false, 'order-check-own-hidden', false],
    [true, 'order-check-own-visible', false],
    [true, 'order-check-own-hidden-target-not-below', 'hidden-host-target-not-below'],
    [true, 'order-check-own-hidden-target-not-below:ime-class', 'hidden-host-target-not-below'],
    [true, 'order-check-own-hidden:chromium-canvas-owned', 'hidden-host-neighbor'],
    [true, 'order-check-own-hidden:unrecognized', false],
    [true, 'order-check-neighbor-raced', false],
    [true, 'order-check-other', false],
  ]) {
    const f = fixture();
    const result = f.place(f.canvas, target, { ...request, visible: true, checkOnly });
    f.child.stdout.write(JSON.stringify({ refusal }));
    f.child.emit('close', 1);
    assert.equal(await result, expected);
  }
});

test('readback stage diagnostics never grant success', async () => {
  for (const reason of ['order-readback-unchanged-anchor', 'order-readback-visible', 'order-readback-retry-exhausted',
    'order-readback-first-verification', 'order-readback-final-verification']) {
    const seen = [];
    const f = fixture();
    const result = f.place(f.canvas, target, { ...request, onDiagnostic: value => seen.push(value) });
    f.child.stdout.write(JSON.stringify({ refusal: reason }));
    f.child.emit('close', 1);
    assert.equal(await result, reason === 'order-readback-unchanged-anchor' ? 'placement-order-unconfirmed' : false);
    assert.deepEqual(seen, [reason]);
  }
});

test('hidden neighbor roles are allowlisted diagnostics and never verify placement', async () => {
  for (const role of ['canvas-default-ime', 'ime-class', 'render-class', 'ole-class', 'chromium-canvas-owned', 'chromium-unowned', 'chromium-other-owner', 'unknown', 'other-class',
    'other-class-empty-unowned', 'other-class-empty-canvas-owned', 'other-class-empty-other-owner', 'private-unknown']) {
    const reason = `order-readback-unchanged-anchor-own-hidden-${role}`;
    for (const visible of [false, true]) {
      const f = fixture(), seen = [];
      const result = f.place(f.canvas, target, { ...request, visible, onDiagnostic: code => seen.push(code) });
      f.child.stdout.write(JSON.stringify({ refusal: reason }));
      f.child.emit('close', 1);
      const known = role !== 'private-unknown';
      assert.deepEqual(seen, known ? [reason] : []);
      assert.equal(await result, known && !visible ? 'placement-order-unconfirmed' : false);
    }
  }
});

test('coarse order context is only diagnostic and arbitrary values are not emitted', async () => {
  for (const [context, valid] of [['topmost-anchor:target-above', true], ['ordinary-anchor:not-in-range', true], ['ordinary-anchor:private', false]]) {
    const f = fixture(), seen = [];
    const result = f.place(f.canvas, target, { ...request, onOrderContext: value => seen.push(value) });
    f.child.stdout.write(JSON.stringify({ refusal: 'order-readback-unchanged-anchor-own-hidden-other-class', orderContext: context }));
    f.child.emit('close', 1);
    assert.equal(await result, 'placement-order-unconfirmed');
    assert.deepEqual(seen, valid ? [context] : []);
  }
});

test('external neighbor context never grants placement and rejects arbitrary context', async () => {
  for (const context of ['target-above:visible-other', 'target-below:hidden-other', 'unknown:none', 'private-data']) {
    const f = fixture(), seen = [];
    const result = f.place(f.canvas, target, { ...request, visible: true, checkOnly: true, onCheckContext: value => seen.push(value) });
    f.child.stdout.write(JSON.stringify({ refusal: 'order-check-other', checkContext: context }));
    f.child.emit('close', 1);
    assert.equal(await result, context === 'target-below:hidden-other' ? 'hidden-external-interposer' : false);
    assert.deepEqual(seen, context === 'private-data' ? [] : [context]);
  }
});

test('immediate boundary observations do not override a refusal', async () => {
  for (const value of ['both', 'one', 'neither', 'unrecognized']) {
    const f = fixture(), seen = [];
    const result = f.place(f.canvas, target, { ...request, onBoundaryReadback: value => seen.push(value) });
    f.child.stdout.write(JSON.stringify({ refusal: 'order-readback-final-verification', firstBoundaryReadback: value }));
    f.child.emit('close', 1);
    assert.equal(await result, false);
    assert.deepEqual(seen, value === 'unrecognized' ? [] : [value]);
  }
});

test('boundary write is reported only for verified hidden placement', async () => {
  for (const { patch, expected } of [{ patch: {}, expected: true }, { patch: { hwnd: '2' }, expected: false }, { patch: { bounds: {} }, expected: false }]) {
    const f = fixture(); let seen = 0;
    const result = f.place(f.canvas, target, { ...request, onBoundaryWrite: () => seen++ });
    f.child.stdout.write(JSON.stringify({ ...reply, ...patch, boundaryWrite: true }));
    f.child.emit('close', 0);
    assert.equal(await result, expected);
    assert.equal(seen, Number(expected));
  }
});

test('placement sends exact native handles and binds the reply to geometry and visibility', async () => {
  const f = fixture();
  const result = f.place(f.canvas, target, request);
  assert.deepEqual(f.calls[0].args, ['place', target.windowId, '812', target.processStartedAt,
    '9007199254740995', '900', '20', '-40', '642', '432', 'hidden']);
  assert.equal(f.calls[0].opts.windowsHide, true);
  f.child.stdout.write(JSON.stringify(reply));
  f.child.emit('close', 0);
  assert.equal(await result, true);
});
for (const patch of [{ placed: false }, { hwnd: '2' }, { ink: '3' }, { ownerPid: 901 }, { visible: true },
  { bounds: { ...request.bounds, x: 21 } }, { processStartedAt: '123' }]) {
  test(`placement rejects stale or incomplete evidence ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    const result = f.place(f.canvas, target, request);
    f.child.stdout.write(JSON.stringify({ ...reply, ...patch })); f.child.emit('close', 0);
    assert.equal(await result, false);
  });
}
test('destroyed canvas and non-Windows target never cause native mutation', async () => {
  const f = fixture();
  assert.equal(await f.place({ ...f.canvas, isDestroyed: () => true }, target, request), false);
  assert.equal(await f.place(f.canvas, { ...target, platform: 'darwin' }, request), false);
  assert.equal(await f.place(f.canvas, target, { ...request, bounds: { ...request.bounds, x: 0.5 } }), false);
  assert.deepEqual(f.calls, []);
});
test('a timeout or oversized output fails closed without waiting on the main thread', async () => {
  const f = fixture({ timeoutMs: 10 });
  assert.equal(await f.place(f.canvas, target, request), false);
  assert.equal(f.child.killed, true);
  const large = fixture();
  const result = large.place(large.canvas, target, request);
  large.child.stdout.write('x'.repeat(2049));
  assert.equal(await result, false);
  assert.equal(large.child.killed, true);
});

test('stationary layer verification requests readback without native reordering', async () => {
  const f = fixture();
  const result = f.place(f.canvas, target, { ...request, visible: true, checkOnly: true });
  assert.equal(f.calls[0].args[0], 'check');
  f.child.stdout.write(JSON.stringify({ ...reply, visible: true }));
  f.child.emit('close', 0);
  assert.equal(await result, true);
});

test('only explicit native refusals receive distinct non-success results', async () => {
  for (const [refusal, exit, expected, diagnostic] of [
    ['target-position', 1, TARGET_POSITION_STALE, 'target-position'],
    ['target-position', 0, false, undefined],
    ['target-size', 1, false, 'target-size'],
    ['order-topmost', 1, false, 'order-topmost'],
    ['order-topmost-fixture-process', 1, false, 'order-topmost-fixture-process'],
    ['order-topmost-other-process', 1, 'placement-order-unconfirmed', 'order-topmost-other-process'],
    ['order-readback', 1, false, 'order-readback'],
    ['identity-or-state', 1, false, 'identity-or-state'],
    ['unrecognized-private-value', 1, false, undefined],
  ]) {
    const reasons = [];
    const f = fixture({ onDiagnostic: reason => reasons.push(reason) });
    const result = f.place(f.canvas, target, request);
    f.child.stdout.write(JSON.stringify({ refusal })); f.child.emit('close', exit);
    assert.equal(await result, expected);
    assert.deepEqual(reasons, diagnostic ? [diagnostic] : []);
  }
});

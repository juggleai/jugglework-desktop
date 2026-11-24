import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsCanvasPlacement } from './meeting-window-placement-windows.mjs';

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

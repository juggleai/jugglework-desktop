import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsWindowIdentity } from './meeting-window-identity-windows.mjs';

function fixture(options = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), killed: false, kill() { this.killed = true; return true; },
  });
  const calls = [];
  const identity = createWindowsWindowIdentity({ helperPath: '/fixture/MeetingWindowTracker.exe',
    timeoutMs: 100, spawnHelper: (path, args, opts) => { calls.push({ path, args, opts }); return child; }, ...options });
  return { child, calls, identity };
}
const hwnd = '9007199254740993';
const record = { hwnd, pid: 812, processStartedAt: '134000000000000001' };

test('identity keeps native handles and process creation FILETIME exact and waits for exit', async () => {
  const f = fixture();
  const pending = f.identity.resolveWindowsIdentity(hwnd);
  f.child.stdout.write(JSON.stringify(record).slice(0, 12));
  f.child.stdout.write(JSON.stringify(record).slice(12));
  assert.deepEqual(f.calls, [{ path: '/fixture/MeetingWindowTracker.exe', args: ['inspect', hwnd],
    opts: { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true } }]);
  f.child.emit('close', 0);
  assert.deepEqual(await pending, { pid: 812, processStartedAt: '134000000000000001' });
});

/** @type {Array<[string, Record<string, unknown>, number]>} */
const invalidIdentities = [
  ['different target', { hwnd: '2' }, 0],
  ['failed native inspection', {}, 1],
  ['numeric FILETIME', { processStartedAt: 123 }, 0],
  ['out of range FILETIME', { processStartedAt: '18446744073709551616' }, 0],
  ['invalid pid', { pid: -1 }, 0],
];
for (const [name, patch, code] of invalidIdentities) test(`identity rejects ${name}`, async () => {
  const f = fixture();
  const pending = f.identity.resolveWindowsIdentity(hwnd);
  f.child.stdout.write(JSON.stringify({ ...record, ...patch }));
  f.child.emit('close', code);
  assert.equal(await pending, null);
});

test('invalid HWND never starts a native child', async () => {
  const f = fixture();
  for (const invalid of ['0', '01', '-1', '0x12', '18446744073709551616', 123, '1'.repeat(2000)])
    assert.equal(await f.identity.resolveWindowsIdentity(/** @type {string} */ (invalid)), null);
  assert.deepEqual(f.calls, []);
});

test('oversized native output is killed and rejected even if a valid reply arrives later', async () => {
  const f = fixture();
  const pending = f.identity.resolveWindowsIdentity(hwnd);
  f.child.stdout.write(' '.repeat(2049));
  assert.equal(await pending, null);
  assert.equal(f.child.killed, true);
  f.child.stdout.write(JSON.stringify(record));
  f.child.emit('close', 0);
});

test('a hung or failed helper cannot hold the picker open', async () => {
  const f = fixture({ timeoutMs: 10 });
  const pending = f.identity.resolveWindowsIdentity(hwnd);
  assert.equal(await pending, null);
  assert.equal(f.child.killed, true);
  const failed = fixture({ spawnHelper: () => { throw new Error('helper missing'); } });
  assert.equal(await failed.identity.resolveWindowsIdentity(hwnd), null);
});

test('native errors and malformed output reject authentication', async () => {
  for (const event of ['error', 'malformed']) {
    const f = fixture();
    const pending = f.identity.resolveWindowsIdentity(hwnd);
    if (event === 'error') f.child.emit('error', new Error('spawn failed'));
    else { f.child.stdout.write('null'); f.child.emit('close', 0); }
    assert.equal(await pending, null);
  }
});

test('watching validates the scoped process lifetime and distinguishes mapping from actual size', () => {
  const f = fixture();
  const samples = [];
  const target = { windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt };
  const stop = f.identity.watchWindow(target, s => samples.push(s));
  assert.deepEqual(f.calls[0].args, ['watch', hwnd, '812', record.processStartedAt]);
  const sample = { status: 'visible', pid: 812, hwnd, processStartedAt: record.processStartedAt,
    bounds: { x: 12, y: -40, width: 642, height: 432 }, actualSize: { width: 656, height: 439 }, dpi: 96 };
  f.child.stdout.write(JSON.stringify(sample) + '\n');
  f.child.stdout.write(JSON.stringify({ ...sample, bounds: { ...sample.bounds, x: 20 } }) + '\n');
  assert.deepEqual(samples, [
    { status: 'visible', pid: 812, bounds: sample.bounds, actualSize: sample.actualSize },
    { status: 'visible', pid: 812, bounds: { ...sample.bounds, x: 20 }, actualSize: sample.actualSize },
  ]);
  f.child.emit('close', 1);
  assert.deepEqual(samples.at(-1), { status: 'unavailable' });
  stop();
  f.child.stdout.write(JSON.stringify({ status: 'closed' }) + '\n');
  assert.equal(samples.length, 3);
});

test('watch rejects wrong identity, unsupported DPI and missing trustworthy actual size', () => {
  for (const patch of [{ hwnd: '2' }, { processStartedAt: '123' }, { pid: 813 }, { dpi: 120 }, { actualSize: null }]) {
    const f = fixture();
    const samples = [];
    f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
    f.child.stdout.write(JSON.stringify({ status: 'visible', hwnd, pid: 812, processStartedAt: record.processStartedAt,
      bounds: { x: 0, y: 0, width: 642, height: 432 }, actualSize: { width: 656, height: 439 }, dpi: 96, ...patch }) + '\n');
    assert.deepEqual(samples, [{ status: 'unavailable' }]);
    assert.equal(f.child.killed, true);
  }
});

test('watch only accepts closure from a matching native identity, not EOF', () => {
  for (const matching of [true, false]) {
    const f = fixture();
    const samples = [];
    f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
    f.child.stdout.write(JSON.stringify({ status: 'closed', hwnd, pid: 812,
      processStartedAt: matching ? record.processStartedAt : '123' }) + '\n');
    assert.deepEqual(samples, [{ status: matching ? 'closed' : 'unavailable' }]);
  }
});

test('watch terminates on a stalled helper, bounded lines, cancellation and invalid target', async () => {
  const f = fixture({ timeoutMs: 10 });
  const samples = [];
  const stop = f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
  stop();
  const oversized = fixture();
  const rejected = [];
  oversized.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => rejected.push(s));
  oversized.child.stdout.write('x'.repeat(2049));
  assert.deepEqual(rejected, [{ status: 'unavailable' }]);
  const cancelled = fixture();
  const late = [];
  const cancel = cancelled.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => late.push(s));
  cancel();
  cancelled.child.emit('close', 0);
  assert.deepEqual(late, []);
  const invalid = fixture();
  invalid.identity.watchWindow({ windowId: '0', pid: 812, processStartedAt: '123' }, s => late.push(s));
  assert.deepEqual(invalid.calls, []);
  await Promise.resolve();
  assert.deepEqual(late, [{ status: 'unavailable' }]);
});

test('minimized and hidden heartbeats carry no geometry and restore revalidates it', () => {
  const f = fixture();
  const samples = [];
  const target = { windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt };
  const stop = f.identity.watchWindow(target, s => samples.push(s));
  const line = JSON.stringify({ ...record, status: 'minimized' }) + '\n';
  f.child.stdout.write(line.slice(0, 5));
  assert.deepEqual(samples, []);
  f.child.stdout.write(line.slice(5) + JSON.stringify({ ...record, status: 'hidden' }) + '\n');
  assert.deepEqual(samples, [{ status: 'minimized' }, { status: 'hidden' }]);
  f.child.stdout.write(JSON.stringify({ ...record, status: 'visible', dpi: 96, bounds: null }) + '\n');
  assert.deepEqual(samples.at(-1), { status: 'unavailable' });
  stop();
});

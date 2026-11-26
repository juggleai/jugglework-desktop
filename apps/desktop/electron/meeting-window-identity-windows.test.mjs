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

test('foreground command carries exact identity and requires an authenticated positive reply', async () => {
  for (const patch of [{}, { activated: false }, { hwnd: '2' }, { pid: 813 }, { processStartedAt: '123' }]) {
    const f = fixture();
    const pending = f.identity.activateWindow({ windowId: hwnd, pid: record.pid, processStartedAt: record.processStartedAt });
    assert.deepEqual(f.calls[0].args, ['activate', hwnd, '812', record.processStartedAt]);
    f.child.stdout.write(JSON.stringify({ ...record, activated: true, ...patch }));
    f.child.emit('close', 0);
    assert.equal(await pending, Object.keys(patch).length === 0);
    assert.equal(f.calls.length, 1);
  }
});

test('foreground adapter rejects invalid identities and contains spawn/timeout failures without retry', async () => {
  const f = fixture();
  for (const patch of [{ windowId: '0' }, { pid: 0 }, { processStartedAt: '01' }])
    assert.equal(await f.identity.activateWindow({ windowId: hwnd, pid: record.pid, processStartedAt: record.processStartedAt, ...patch }), false);
  assert.equal(f.calls.length, 0);
  const failed = fixture({ spawnHelper: () => { throw Error('unavailable'); } });
  assert.equal(await failed.identity.activateWindow({ windowId: hwnd, ...record }), false);
  const timed = fixture({ timeoutMs: 5 });
  assert.equal(await timed.identity.activateWindow({ windowId: hwnd, ...record }), false);
  assert.equal(timed.calls.length, 1);
  assert.equal(timed.child.killed, true);
});

test('geometry pending preserves the scoped watcher but carries no untrusted geometry', () => {
  const f = fixture(); const samples = [], reasons = [];
  const stop = f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s), r => reasons.push(r));
  f.child.stdout.write(JSON.stringify({ ...record, status: 'geometry-pending', reason: 'outer-changed', bounds: { x: 999 } }) + '\n');
  assert.deepEqual(samples, [{ status: 'geometry-pending' }]);
  assert.deepEqual(reasons, ['outer-changed']);
  assert.equal(f.child.killed, false);
  f.child.stdout.write(JSON.stringify({ ...record, status: 'visible', dpi: 96, bounds: { x: 1, y: 2, width: 640, height: 400 }, actualSize: { width: 656, height: 439 } }) + '\n');
  assert.equal(samples.at(-1).status, 'visible'); stop();
});

test('geometry pending cannot be granted for other reasons or wrong identities', () => {
  for (const patch of [{ reason: 'topmost' }, { reason: 'secret-value' }, { hwnd: '2' }]) {
    const f = fixture(); const samples = [];
    f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
    f.child.stdout.write(JSON.stringify({ ...record, status: 'geometry-pending', reason: 'dwm-changed', ...patch }) + '\n');
    assert.deepEqual(samples, [{ status: 'unavailable' }]); assert.equal(f.child.killed, true);
  }
});

test('repeated pending heartbeats do not extend the original watchdog', async () => {
  const f = fixture({ timeoutMs: 30 }); const samples = [];
  f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
  const line = JSON.stringify({ ...record, status: 'geometry-pending', reason: 'dwm-changed' }) + '\n';
  f.child.stdout.write(line); await new Promise(resolve => setTimeout(resolve, 20)); f.child.stdout.write(line);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(samples.at(-1).status, 'unavailable'); assert.equal(f.child.killed, true);
});

test('pending reason count is bounded and a trusted sample resets the budget', () => {
  const line = JSON.stringify({ ...record, status: 'geometry-pending', reason: 'outer-changed' }) + '\n';
  const f = fixture(); const samples = [];
  f.identity.watchWindow({ windowId: hwnd, pid: 812, processStartedAt: record.processStartedAt }, s => samples.push(s));
  for (let i = 0; i < 10; i++) f.child.stdout.write(line);
  assert.equal(f.child.killed, false);
  f.child.stdout.write(JSON.stringify({ ...record, status: 'visible', dpi: 96, bounds: { x: 0, y: 0, width: 640, height: 400 }, actualSize: { width: 656, height: 439 } }) + '\n');
  f.child.stdout.write(line); assert.equal(samples.at(-1).status, 'geometry-pending');
  for (let i = 0; i < 10; i++) f.child.stdout.write(line);
  assert.equal(samples.at(-1).status, 'unavailable'); assert.equal(f.child.killed, true);
});

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

const watchTarget = { windowId: hwnd, pid: record.pid, processStartedAt: record.processStartedAt };
const nativeReasons = [
  'process-wait', 'window-identity', 'unsupported-dpi', 'topmost', 'outer-read', 'dwm-read',
  'outer-recheck', 'dwm-recheck', 'outer-changed', 'dwm-changed', 'state-changed',
  'identity-changed', 'process-changed', 'dpi-context',
];

for (const reason of nativeReasons) test(`authenticated native diagnostic ${reason} is terminal and leaves sample shape unchanged`, () => {
  const f = fixture();
  const samples = [], diagnostics = [];
  f.identity.watchWindow(watchTarget, sample => samples.push(sample), (...args) => diagnostics.push(args));
  f.child.stdout.write(JSON.stringify({ ...record, status: 'unavailable', reason, secret: 'native-private-data' }) + '\n');
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
  assert.deepEqual(diagnostics, [[reason]]);
  assert.equal(f.child.killed, true);
  f.child.emit('close', 1);
  f.child.stdout.write(JSON.stringify({ ...record, status: 'hidden' }) + '\n');
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
  assert.deepEqual(diagnostics, [[reason]]);
  assert.equal(f.calls.length, 1);
});

test('unknown native reasons never escape the whitelist or prevent terminal unavailability', () => {
  for (const reason of ['secret path C:\\private\\target.exe', '__proto__', 'constructor', 'adapter-timeout',
    'outer-read\nprivate-data', { reason: 'outer-read', secret: record }, ['outer-read'], 42, null, undefined]) {
    const f = fixture();
    const samples = [], diagnostics = [];
    f.identity.watchWindow(watchTarget, sample => samples.push(sample), (...args) => diagnostics.push(args));
    f.child.stdout.write(JSON.stringify({ ...record, status: 'unavailable', reason }) + '\n');
    assert.deepEqual(samples, [{ status: 'unavailable' }]);
    assert.deepEqual(diagnostics, [['adapter-unknown-reason']]);
    assert.equal(f.child.killed, true);
  }
});

test('native unavailability authenticates every identity field before trusting any reason', () => {
  for (const patch of [{ hwnd: '2' }, { pid: 813 }, { processStartedAt: '123' },
    { hwnd: Number(hwnd) }, { pid: '812' }, { processStartedAt: Number(record.processStartedAt) }]) {
    for (const reason of ['outer-read', 'private-data']) {
      const f = fixture();
      const samples = [], diagnostics = [];
      f.identity.watchWindow(watchTarget, sample => samples.push(sample), (...args) => diagnostics.push(args));
      f.child.stdout.write(JSON.stringify({ ...record, ...patch, status: 'unavailable', reason }) + '\n');
      assert.deepEqual(samples, [{ status: 'unavailable' }]);
      assert.deepEqual(diagnostics, [['adapter-identity-mismatch']]);
      assert.equal(f.child.killed, true);
    }
  }
});

test('diagnostic callback failures cannot prevent terminal sample delivery or helper termination', () => {
  for (const trigger of ['native', 'error', 'eof']) {
    const f = fixture();
    const events = [];
    f.child.kill = () => { events.push('kill'); f.child.killed = true; throw new Error('private kill error'); };
    f.identity.watchWindow(watchTarget, sample => events.push(sample), reason => {
      assert.equal(typeof reason, 'string');
      events.push('diagnostic');
      throw new Error('private callback error');
    });
    assert.doesNotThrow(() => {
      if (trigger === 'native') f.child.stdout.write(JSON.stringify({ ...record, status: 'unavailable', reason: 'topmost' }) + '\n');
      else if (trigger === 'error') f.child.emit('error', new Error('private helper error'));
      else f.child.emit('close', 1);
    });
    assert.deepEqual(events, ['kill', { status: 'unavailable' }, 'diagnostic']);
    f.child.emit('close', 1);
    assert.equal(events.length, 3);
  }
});

test('adapter failures return only fixed reason strings, never native output, identity or errors', async () => {
  const cases = [
    { reason: 'adapter-invalid-json', send: f => f.child.stdout.write('private malformed output\n') },
    { reason: 'adapter-output-too-large', send: f => f.child.stdout.write('private-data'.repeat(200)) },
    { reason: 'adapter-output-too-large', send: f => f.child.stdout.write('private-data'.repeat(200) + '\n') },
    { reason: 'adapter-helper-error', send: f => f.child.emit('error', new Error('private helper error')) },
    { reason: 'adapter-invalid-sample', send: f => f.child.stdout.write(JSON.stringify({ ...record, status: 'private status', reason: 'outer-read' }) + '\n') },
    { reason: 'adapter-identity-mismatch', send: f => f.child.stdout.write('null\n') },
  ];
  for (const { reason, send } of cases) {
    const f = fixture();
    const samples = [], diagnostics = [];
    f.identity.watchWindow(watchTarget, sample => samples.push(sample), (...args) => diagnostics.push(args));
    send(f);
    assert.deepEqual(samples, [{ status: 'unavailable' }]);
    assert.deepEqual(diagnostics, [[reason]]);
    assert.equal(f.child.killed, true);
  }
  for (const invalidTarget of [false, true]) {
    const f = fixture({ spawnHelper: () => { throw new Error('private spawn error'); } });
    const samples = [], diagnostics = [];
    f.identity.watchWindow(invalidTarget ? { ...watchTarget, windowId: '0' } : watchTarget,
      sample => samples.push(sample), (...args) => diagnostics.push(args));
    await Promise.resolve();
    assert.deepEqual(samples, [{ status: 'unavailable' }]);
    assert.deepEqual(diagnostics, [[invalidTarget ? 'adapter-invalid-target' : 'adapter-spawn-failed']]);
  }
});

test('diagnostics preserve fail-closed geometry and DPI validation', () => {
  const visible = { ...record, status: 'visible', dpi: 96,
    bounds: { x: 0, y: 0, width: 640, height: 480 }, actualSize: { width: 656, height: 519 } };
  for (const patch of [{ dpi: 120 }, { bounds: null }, { actualSize: null },
    { bounds: { ...visible.bounds, width: 0 } }, { actualSize: { width: 0, height: 519 } }]) {
    const f = fixture();
    const samples = [], diagnostics = [];
    f.identity.watchWindow(watchTarget, sample => samples.push(sample), reason => diagnostics.push(reason));
    f.child.stdout.write(JSON.stringify({ ...visible, ...patch, reason: 'outer-read' }) + '\n');
    assert.deepEqual(samples, [{ status: 'unavailable' }]);
    assert.deepEqual(diagnostics, ['adapter-invalid-sample']);
    assert.equal(f.child.killed, true);
  }
});

test('timeout and EOF have distinct diagnostics and no late exit can replace them', async () => {
  const timed = fixture({ timeoutMs: 10 });
  const samples = [], diagnostics = [];
  timed.identity.watchWindow(watchTarget, sample => samples.push(sample), reason => diagnostics.push(reason));
  await new Promise(resolve => setTimeout(resolve, 30));
  timed.child.emit('close', 1);
  assert.deepEqual(samples, [{ status: 'unavailable' }]);
  assert.deepEqual(diagnostics, ['adapter-timeout']);
  assert.equal(timed.child.killed, true);

  for (const trigger of ['close', 'end', 'partial-end']) {
    const f = fixture();
    const ended = [], reasons = [];
    f.identity.watchWindow(watchTarget, sample => ended.push(sample), (...args) => reasons.push(args));
    if (trigger === 'close') f.child.emit('close', 0);
    else {
      if (trigger === 'partial-end') f.child.stdout.write('{"private":"incomplete');
      f.child.stdout.end();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(ended, [{ status: 'unavailable' }]);
    assert.deepEqual(reasons, [['adapter-eof']]);
    assert.equal(f.child.killed, true);
    f.child.emit('close', 1);
    assert.equal(reasons.length, 1);
  }
});

test('healthy samples, authenticated closure and cancellation do not emit failure diagnostics', () => {
  for (const finish of ['closed', 'cancel']) {
    const f = fixture();
    const samples = [], diagnostics = [];
    const stop = f.identity.watchWindow(watchTarget, sample => samples.push(sample), reason => diagnostics.push(reason));
    const visible = { ...record, status: 'visible', dpi: 96, reason: 'private ignored field',
      bounds: { x: 0, y: 0, width: 640, height: 480 }, actualSize: { width: 656, height: 519 } };
    f.child.stdout.write(JSON.stringify(visible) + '\n');
    f.child.stdout.write(JSON.stringify({ ...record, status: 'hidden', reason: 'outer-read' }) + '\n');
    if (finish === 'closed') f.child.stdout.write(JSON.stringify({ ...record, status: 'closed', reason: 'outer-read' }) + '\n');
    else stop();
    f.child.emit('close', 1);
    assert.deepEqual(samples, [
      { status: 'visible', pid: record.pid, bounds: visible.bounds, actualSize: visible.actualSize },
      { status: 'hidden' }, ...(finish === 'closed' ? [{ status: 'closed' }] : []),
    ]);
    assert.deepEqual(diagnostics, []);
  }
});

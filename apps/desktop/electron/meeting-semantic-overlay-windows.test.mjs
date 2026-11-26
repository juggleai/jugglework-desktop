import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createWindowsSemanticOverlay, semanticOverlayHelperPath } from './meeting-semantic-overlay-windows.mjs';

const started = '134000000000000001';
const target = { windowId: '9007199254740993', pid: 812, processStartedAt: started };
function fixture(options = {}) {
  const children = [], calls = [];
  const spawnHelper = (path, args, opts) => {
    const emitter = new EventEmitter();
    const child = Object.assign(emitter, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), killed: false,
      kill: () => { child.killed = true; queueMicrotask(() => emitter.emit('close', null)); return true; } });
    child.stdin.setEncoding('utf8'); children.push(child); calls.push({ path, args, opts }); return child;
  };
  const adapter = createWindowsSemanticOverlay({ desktopRoot: 'C:\\repo\\apps\\desktop', parentProcessStartedAt: started,
    timeoutMs: 50, createSessionId: () => `session_${children.length + 1}_123456789`, spawnHelper, ...options });
  return { adapter, children, calls };
}
function hello(handle, child, patch = {}) { child.stdout.write(JSON.stringify({ type: 'hello', version: 1, sessionId: handle.sessionId,
  epoch: 1, capabilities: ['mode', 'scene', 'preview', 'lasers', 'pointer', 'state', 'abort', 'close'], ...patch }) + '\n'); }
async function request(handle, child, method, response) {
  const lines = []; child.stdin.on('data', chunk => lines.push(chunk)); const pending = method(); await Promise.resolve();
  const sent = JSON.parse(lines.join('').trim().split(/\n/).at(-1)); child.stdout.write(JSON.stringify({ version: 1, sessionId: handle.sessionId,
    seq: sent.seq, epoch: response.epoch ?? sent.expectedEpoch, ...response }) + '\n'); return pending;
}

test('uses only the fixed dev helper path and binds target, parent and session identities', async () => {
  const f = fixture(); const handle = await f.adapter.open(target);
  assert.equal(f.adapter.helperPath, semanticOverlayHelperPath('C:\\repo\\apps\\desktop'));
  assert.deepEqual(f.calls[0], { path: f.adapter.helperPath,
    args: ['overlay', target.windowId, '812', started, String(process.pid), started, handle.sessionId],
    opts: { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true } });
});

test('accepts only the hello and reply whitelist and sends sequenced epoch-bound commands', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); assert.equal(await handle.hello, true);
  const result = await request(handle, child, () => handle.setMode('draw', { tool: 'rectangle', color: '#ef4444', size: 4, highlight: false }), { type: 'ack', command: 'mode', epoch: 2 });
  assert.equal(result.ok, true);
  const state = await request(handle, child, () => handle.query(), { type: 'state', state: 'active', mode: 'draw', input: true,
    visible: true, strokeCount: 0, pointCount: 0, epoch: 2 });
  assert.equal(state.ok, true);
});

test('rejects malformed output, helper crashes, timeout and late replies', async () => {
  for (const kind of ['malformed', 'crash', 'timeout']) {
    const f = fixture({ timeoutMs: 10 }); const handle = await f.adapter.open(target); const child = f.children[0];
    if (kind === 'malformed') child.stdout.write('{private\n');
    if (kind === 'crash') child.emit('close', 9);
    assert.equal(await handle.hello, false); assert.equal(child.killed, true);
    hello(handle, child); assert.equal(await handle.query().then(value => value.ok), false);
  }
});

test('a replacement generation ignores old messages and keeps a distinct session', async () => {
  const f = fixture(); const first = await f.adapter.open(target); const second = await f.adapter.open(target);
  assert.notEqual(first.sessionId, second.sessionId); hello(first, f.children[0]); hello(second, f.children[1]);
  assert.equal(await second.hello, true); assert.equal(await first.hello, false);
  f.children[0].stdout.write(JSON.stringify({ type: 'hello', version: 1, sessionId: second.sessionId, epoch: 99, capabilities: ['mode', 'scene', 'preview', 'lasers', 'pointer', 'state', 'abort', 'close'] }) + '\n');
  assert.equal(f.children[1].killed, false);
});

test('validates full scene limits before writing without granting mode', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  assert.deepEqual(await handle.setScene({ elements: [{ type: 'stroke', id: 'one', color: '#ef4444', size: 4, highlight: false, points: [[0, 0], [1.1, 1]] }] }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handle.setScene({ elements: Array.from({ length: 129 }, (_, index) => ({ type: 'shape', id: `s${index}`, kind: 'ellipse', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 })) }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handle.setScene({ elements: [{ type: 'shape', id: 'same', kind: 'rectangle', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 }, { type: 'shape', id: 'same', kind: 'arrow', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 }] }), { ok: false, reason: 'invalid-request' });
  const cleared = await request(handle, child, () => handle.setScene({ elements: [] }), { type: 'ack', command: 'scene' });
  assert.equal(cleared.ok, true);
});

test('accepts only monotonic epoch-bound pointer batches and dispatches normalized points', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  const batches = []; handle.onInput(batch => batches.push(batch));
  child.stdout.write(JSON.stringify({ type: 'pointer', version: 1, sessionId: handle.sessionId, epoch: 1, inputSeq: 1,
    phase: 'down', points: [[.25, .5]] }) + '\n');
  assert.deepEqual(batches, [{ sessionId: handle.sessionId, epoch: 1, inputSeq: 1, phase: 'down', points: [{ x: .25, y: .5 }] }]);
  child.stdout.write(JSON.stringify({ type: 'pointer', version: 1, sessionId: handle.sessionId, epoch: 1, inputSeq: 1,
    phase: 'move', points: [[.5, .5]] }) + '\n');
  assert.equal(child.killed, true);
});

test('accepts autonomous epoch state, isolates listeners and recovers from wrong-epoch', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  const states = []; handle.onState(() => { throw Error('observer'); }); handle.onState(value => states.push(value));
  child.stdout.write(JSON.stringify({ type: 'state', version: 1, sessionId: handle.sessionId, eventSeq: 1, epoch: 2,
    state: 'unknown', mode: 'pointer', input: false, visible: false, strokeCount: 0, pointCount: 0 }) + '\n');
  assert.equal(states.length, 1);
  const wrong = await request(handle, child, () => handle.query(), { type: 'error', code: 'wrong-epoch', epoch: 3 });
  assert.deepEqual(wrong, { ok: false, reason: 'wrong-epoch', retryable: true });
  const result = await request(handle, child, () => handle.query(), { type: 'state', state: 'active', mode: 'pointer', input: false,
    visible: true, strokeCount: 0, pointCount: 0, epoch: 3 });
  assert.equal(result.ok, true);
});

test('validates UTF-8 bytes and exposes abort/style without writing invalid requests', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  assert.deepEqual(await handle.setMode('draw'), { ok: false, reason: 'invalid-request' });
  const aborted = await request(handle, child, () => handle.abort(), { type: 'ack', command: 'abort' });
  assert.equal(aborted.ok, true);
  child.stdout.write(`{"${'你'.repeat(22000)}":1}\n`);
  assert.equal(child.killed, true);
});

test('preview is revisioned, epoch-bound, unique and uses an independent protocol command', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  assert.deepEqual(await handle.setPreview({ previewRevision: 1, epoch: 2, hiddenElementIds: [] }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handle.setPreview({ previewRevision: 1, epoch: 1, hiddenElementIds: ['same', 'same'] }), { ok: false, reason: 'invalid-request' });
  const result = await request(handle, child, () => handle.setPreview({ previewRevision: 1, epoch: 1, hiddenElementIds: ['stroke_1'] }), { type: 'ack', command: 'preview' });
  assert.equal(result.ok, true);
});

test('lasers are bounded, revisioned, epoch-bound transient state', async () => {
  const f = fixture(); const handle = await f.adapter.open(target); const child = f.children[0]; hello(handle, child); await handle.hello;
  const stroke = { id: 'laser_1', color: '#ef4444', size: 4, highlight: false, points: [[.1, .2], [.3, .4]] };
  assert.deepEqual(await handle.setLasers({ laserRevision: 1, epoch: 2, lasers: [] }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handle.setLasers({ laserRevision: 1, epoch: 1, lasers: [{ stroke, opacity: 1.1 }] }), { ok: false, reason: 'invalid-request' });
  assert.deepEqual(await handle.setLasers({ laserRevision: 1, epoch: 1, lasers: Array.from({ length: 33 }, (_, index) => ({ stroke: { ...stroke, id: `l_${index}` }, opacity: 1 })) }), { ok: false, reason: 'invalid-request' });
  const result = await request(handle, child, () => handle.setLasers({ laserRevision: 1, epoch: 1, lasers: [{ stroke, opacity: .5 }] }), { type: 'ack', command: 'lasers' });
  assert.equal(result.ok, true);
});

test('dispose and replacement wait for hung helpers with a bounded kill result', async () => {
  const f = fixture({ timeoutMs: 10 }); const first = await f.adapter.open(target); const child = f.children[0]; hello(first, child); await first.hello;
  const result = await first.dispose();
  assert.deepEqual(result, { exited: true, killed: true, timedOut: true });
  const second = await f.adapter.open(target); assert.equal(f.children.length, 2); await second.dispose();
});

'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const exeAt = process.argv.indexOf('--exe');
const exe = exeAt >= 0 ? path.resolve(process.argv[exeAt + 1] || '') : '';
if (process.platform !== 'win32' || !path.isAbsolute(exe)) process.exit(1);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 5000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); } throw Error('timeout'); }
function start(args, env = process.env) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false, env });
  const record = { child, lines: [], closed: false, code: null }; child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch { record.lines.push({ malformed: true }); } });
  child.on('close', code => { record.closed = true; record.code = code; }); return record;
}
async function output(record, type, mark = 0) { return until(() => record.lines.slice(mark).find(line => line.type === type) || (record.closed && { type: 'closed' })); }
function parentIdentity(pid = process.pid) {
  const result = spawnSync(exe, ['process-fixture', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw Error('parent-identity'); return JSON.parse(result.stdout.trim());
}
async function send(record, value, type) {
  const mark = record.lines.length; record.child.stdin.write(JSON.stringify(value) + '\n');
  return until(() => record.lines.slice(mark).find(line => line.type === type && line.seq === value.seq) || (record.closed && { type: 'closed' }));
}

(async () => {
  const children = []; let failed = false, stage = 'target';
  try {
    const target = start(['target', '100', '100', '640', '420']); children.push(target);
    const targetId = await output(target, 'ready'); stage = 'parent'; const parent = parentIdentity(); const sessionId = 'protocol_session_123456789';
    stage = 'startup-dpi-simulation';
    const refused = start(['overlay', targetId.hwnd, targetId.pid, targetId.started, parent.pid, parent.started, 'dpi_refused_session_123456'],
      { ...process.env, MEETING_SEMANTIC_OVERLAY_FIXTURE_INJECTION: '1', MEETING_SEMANTIC_OVERLAY_FIXTURE_TARGET_DPI: '120' });
    children.push(refused); await until(() => refused.closed);
    if (refused.code === 0 || refused.lines.some(line => line.type === 'hello')) throw Error('startup-dpi-not-refused');
    const overlay = start(['overlay', targetId.hwnd, targetId.pid, targetId.started, parent.pid, parent.started, sessionId]); children.push(overlay);
    stage = 'hello'; const hello = await output(overlay, 'hello'); if (hello.version !== 1 || hello.sessionId !== sessionId || 'hwnd' in hello || 'pid' in hello || 'started' in hello) throw Error('hello');
    let seq = 1, epoch = hello.epoch;
    const command = (patch = {}) => ({ version: 1, sessionId, seq: seq++, expectedEpoch: epoch, command: 'state', ...patch });
    stage = 'version'; let reply = await send(overlay, command({ version: 2 }), 'error'); if (reply.code !== 'invalid-envelope') throw Error('version');
    stage = 'session'; reply = await send(overlay, command({ sessionId: 'wrong_session_123456' }), 'error'); if (reply.code !== 'wrong-session') throw Error('session');
    stage = 'epoch'; reply = await send(overlay, command({ expectedEpoch: 2147483647 }), 'error'); if (reply.code !== 'wrong-epoch') throw Error('epoch'); epoch = reply.epoch;
    stage = 'state'; reply = await send(overlay, command(), 'state'); const acceptedSeq = reply.seq; epoch = reply.epoch;
    stage = 'stale'; reply = await send(overlay, { version: 1, sessionId, seq: acceptedSeq, expectedEpoch: epoch, command: 'state' }, 'error'); if (reply.code !== 'stale-seq') throw Error('seq');
    stage = 'before'; const before = await send(overlay, command(), 'state'); epoch = before.epoch;
    stage = 'scene-limit'; reply = await send(overlay, command({ command: 'scene', elements: [{ type: 'stroke', id: 'too_many', color: '#ef4444', size: 4, highlight: false, points: Array.from({ length: 257 }, () => [0.5, 0.5]) }] }), 'error');
    if (reply.code !== 'invalid-command') throw Error('scene-limit');
    stage = 'scene-duplicate'; reply = await send(overlay, command({ command: 'scene', elements: [
      { type: 'shape', id: 'duplicate', kind: 'rectangle', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 },
      { type: 'shape', id: 'duplicate', kind: 'ellipse', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 },
    ] }), 'error'); if (reply.code !== 'invalid-command') throw Error('scene-duplicate');
    stage = 'scene-exact'; reply = await send(overlay, command({ command: 'scene', elements: [{ type: 'shape', id: 'extra_key', kind: 'arrow', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1, extra: true }] }), 'error');
    if (reply.code !== 'invalid-command') throw Error('scene-exact');
    stage = 'line-bytes'; const lineMark = overlay.lines.length; overlay.child.stdin.write(`{"padding":"${'你'.repeat(22000)}"}\n`);
    reply = await until(() => overlay.lines.slice(lineMark).find(line => line.type === 'error'));
    if (reply.code !== 'line-too-large') throw Error('line-bytes');
    stage = 'after-limit'; const after = await send(overlay, command(), 'state'); epoch = after.epoch;
    if (after.strokeCount !== before.strokeCount || after.pointCount !== before.pointCount || after.input !== before.input) throw Error('scene-mutated');
    stage = 'scene'; reply = await send(overlay, command({ command: 'scene', elements: [{ type: 'shape', id: 'rectangle_one', kind: 'rectangle', color: '#ef4444', size: 4, x1: 0, y1: 0, x2: 1, y2: 1 }] }), 'ack'); epoch = reply.epoch;
    stage = 'scene-state'; const sceneState = await send(overlay, command(), 'state'); epoch = sceneState.epoch;
    if (sceneState.strokeCount !== 1 || sceneState.pointCount !== 2 || sceneState.input) throw Error('scene-input');
    stage = 'laser'; reply = await send(overlay, command({ command: 'lasers', laserRevision: 1, epoch, lasers: [{ opacity: .5,
      stroke: { id: 'laser_one', color: '#ef4444', size: 4, highlight: false, points: [[.1, .2], [.8, .7]] } }] }), 'ack'); epoch = reply.epoch;
    stage = 'laser-old-revision'; reply = await send(overlay, command({ command: 'lasers', laserRevision: 1, epoch, lasers: [] }), 'error');
    if (reply.code !== 'stale-laser-revision') throw Error('laser-old-revision');
    stage = 'laser-clear'; reply = await send(overlay, command({ command: 'lasers', laserRevision: 2, epoch, lasers: [] }), 'ack'); epoch = reply.epoch;
    stage = 'draw'; reply = await send(overlay, command({ command: 'mode', mode: 'draw', tool: 'arrow', color: '#facc15', size: 4, highlight: false }), 'ack'); epoch = reply.epoch;
    stage = 'os-input'; const overlayProcess = parentIdentity(overlay.child.pid);
    const probe = spawnSync(exe, ['probe', '420', '300', 'click', 'target', targetId.hwnd, targetId.pid, targetId.started,
      'overlay', 'hit', overlayProcess.pid, overlayProcess.started], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (probe.status !== 0) throw Error('os-input');
    const pointerStart = await output(overlay, 'pointer');
    const pointerEnd = await until(() => overlay.lines.find(line => line.type === 'pointer' && line.inputSeq > pointerStart.inputSeq && line.phase === 'up'));
    if (pointerStart.phase !== 'down' || pointerStart.epoch !== epoch || pointerStart.points.length !== 1 || pointerEnd.epoch !== epoch) throw Error('pointer-batch');
    stage = 'authoritative-scene'; reply = await send(overlay, command({ command: 'scene', elements: [{ type: 'shape', id: 'arrow_authoritative', kind: 'arrow', color: '#22c55e', size: 4,
      x1: pointerStart.points[0][0], y1: pointerStart.points[0][1], x2: pointerEnd.points[0][0], y2: pointerEnd.points[0][1] }] }), 'ack'); epoch = reply.epoch;
    stage = 'lifetime'; await delay(47000);
    const alive = await send(overlay, command(), 'state'); epoch = alive.epoch;
    if (alive.state === 'closed') throw Error('lifetime');
    const allowed = new Set(['hello', 'ack', 'state', 'error', 'pointer']);
    if (overlay.lines.some(line => !allowed.has(line.type))) throw Error('stdout-whitelist');
    stage = 'eof'; overlay.child.stdin.end(); await until(() => overlay.closed); if (overlay.code !== 0) throw Error('eof-cleanup');
    stage = 'runtime-dpi-simulation';
    const dpiTarget = start(['target', '760', '100', '640', '420']); children.push(dpiTarget); const dpiTargetId = await output(dpiTarget, 'ready');
    const dpiOverlay = start(['overlay', dpiTargetId.hwnd, dpiTargetId.pid, dpiTargetId.started, parent.pid, parent.started, 'dpi_runtime_session_123456'],
      { ...process.env, MEETING_SEMANTIC_OVERLAY_FIXTURE_INJECTION: '1' });
    children.push(dpiOverlay); await output(dpiOverlay, 'hello'); dpiOverlay.child.stdin.write('fixture-dpi-change\n');
    const dpiState = await until(() => dpiOverlay.lines.find(line => line.type === 'state' && line.state === 'unsupported-dpi'), 5000)
      .catch(() => { throw Error(`runtime-dpi-state:${JSON.stringify({ closed: dpiOverlay.closed, code: dpiOverlay.code, lines: dpiOverlay.lines })}`); });
    await until(() => dpiOverlay.closed).catch(() => { throw Error('runtime-dpi-close'); });
    if (dpiState.state !== 'unsupported-dpi' || dpiState.input || dpiState.visible || dpiOverlay.code !== 0) throw Error('runtime-dpi-not-terminal');
    dpiTarget.child.stdin.end('exit\n'); await until(() => dpiTarget.closed);
    target.child.stdin.end('exit\n'); await until(() => target.closed);
    console.log(JSON.stringify({ stage: 'protocol', pass: true }));
  } catch (error) { failed = true; console.log(JSON.stringify({ stage: 'protocol', pass: false, at: stage, reason: error.message })); }
  finally {
    for (const record of children) if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    await delay(500); for (const record of children) if (!record.closed) record.child.kill();
    process.exitCode = failed ? 1 : 0;
  }
})();

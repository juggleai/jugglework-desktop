'use strict';
// Fixture-only: all SendInput destinations are authenticated helper-owned windows.
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(1);
const desktopRoot = path.resolve(__dirname, '..');
const exe = path.join(desktopRoot, '.dev-helpers', 'semantic-overlay', 'MeetingSemanticOverlayWindows.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); } throw Error('timeout'); }
function start(args, read = true) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { child, lines: [], closed: false, exited: false, code: null, forced: false };
  child.stdin.on('error', () => {});
  const consume = line => { try { record.lines.push(JSON.parse(line)); } catch {} };
  if (read) record.reader = createInterface({ input: child.stdout }).on('line', consume);
  record.resumeOutput = () => { if (!record.reader) record.reader = createInterface({ input: child.stdout }).on('line', consume); };
  child.on('exit', code => { record.exited = true; record.code = code; });
  child.on('close', () => { record.closed = true; });
  return record;
}
function run(args, timeout = 5000) {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout });
  let value; try { value = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch {}
  return { status: result.status, value };
}
function identity(role, value) { return [role, value.hwnd, value.pid, value.started]; }
function parentIdentity() {
  const result = run(['process-fixture', String(process.pid)]);
  if (result.status !== 0) throw Error('parent-identity');
  return result.value;
}
async function output(record, type) { return until(() => record.lines.find(line => line.type === type) || (record.exited && { type: 'closed' }), 8000); }
async function targetCounts(target) {
  const mark = target.lines.length; target.child.stdin.write('query\n');
  return until(() => target.lines.slice(mark).find(line => line.type === 'counts'));
}

(async () => {
  const children = []; let failed = false, stage = 'target';
  try {
    const target = start(['target', '100', '100', '640', '420']); children.push(target);
    const targetId = await output(target, 'ready');
    const parent = parentIdentity(); const sessionId = 'backpressure_session_123456';
    stage = 'overlay'; const overlay = start(['overlay', targetId.hwnd, targetId.pid, targetId.started,
      parent.pid, parent.started, sessionId]); children.push(overlay);
    const hello = await output(overlay, 'hello'); let seq = 1, epoch = hello.epoch;
    const send = async (command, fields = {}) => {
      const mark = overlay.lines.length;
      overlay.child.stdin.write(JSON.stringify({ version: 1, sessionId, seq: seq++, expectedEpoch: epoch, command, ...fields }) + '\n');
      const reply = await until(() => overlay.lines.slice(mark).find(line => line.seq === seq - 1)); epoch = reply.epoch; return reply;
    };
    stage = 'draw'; const draw = await send('mode', { mode: 'draw', tool: 'pen', color: '#ef4444', size: 4, highlight: false });
    if (draw.type !== 'ack') throw Error(`draw-${draw.type}-${draw.code ?? 'unknown'}`);
    const overlayProcess = run(['process-fixture', String(overlay.child.pid)]).value;
    const ids = [...identity('target', targetId), ...identity('overlay', { hwnd: 'hit', pid: overlayProcess.pid, started: overlayProcess.started })];
    const targetOnly = identity('target', targetId);
    overlay.reader.close(); overlay.reader = null; overlay.child.stdout.pause();
    stage = 'bounded-burst'; let burstEvents = 0, withdrawn = null;
    for (let attempt = 0; attempt < 8 && !withdrawn; attempt++) {
      const burst = run(['probe', '420', '300', 'burst', '256', ...ids], 8000);
      if (burst.status === 2) {
        withdrawn = { role: 'withdrawn' }; break;
      }
      if (burst.status !== 0 || burst.value?.count !== 512 || burst.value?.released !== true)
        throw Error(`burst-${burst.status}-${burst.value?.count ?? 'none'}-${burst.value?.role ?? 'none'}`);
      burstEvents += 512;
      const hit = run(['probe', '420', '300', 'hit', ...targetOnly]);
      if (hit.status === 0 && hit.value?.role === 'target') withdrawn = hit.value;
    }
    stage = 'window-thread';
    withdrawn ||= await until(() => {
      const hit = run(['probe', '420', '300', 'hit', ...targetOnly]);
      return hit.status === 0 && hit.value?.role === 'target' ? hit.value : null;
    }, 2000);
    if (!withdrawn) throw Error('blocked');
    const moveMark = target.lines.length; target.child.stdin.write('move\n');
    await until(() => target.lines.slice(moveMark).find(line => line.type === 'ack' && line.action === 'move' && line.ok));
    const movedHit = run(['probe', '760', '300', 'hit', ...targetOnly]);
    if (movedHit.status !== 0 || movedHit.value?.role !== 'target') throw Error(`target-hit-${movedHit.status}-${movedHit.value?.role ?? 'none'}`);
    const before = await targetCounts(target);
    const click = run(['probe', '760', '300', 'click', ...identity('target', targetId)]);
    const after = await until(async () => { const value = await targetCounts(target); return value.clicks === before.clicks + 1 ? value : null; });
    if (click.status !== 0 || click.value?.released !== true || !after) throw Error('capture');
    stage = 'cancel'; overlay.resumeOutput(); overlay.child.stdout.resume();
    await until(() => overlay.lines.some(line => line.type === 'pointer' && line.phase === 'cancel') &&
      overlay.lines.some(line => line.type === 'state' && line.state === 'unknown' && !line.input && !line.visible), 6000);
    stage = 'eof'; const started = Date.now(); overlay.child.stdin.end(); await until(() => overlay.exited, 2500);
    if (overlay.code !== 0 || Date.now() - started > 2500) throw Error('eof-exit');
    target.child.stdin.end('exit\n'); await until(() => target.exited);
    console.log(JSON.stringify({ stage: 'backpressure', pass: true, burstEvents, boundedExitMs: Date.now() - started,
      targetHit: true, captureReleased: true, cancelObserved: true }));
  } catch (error) {
    failed = true; console.log(JSON.stringify({ stage: 'backpressure', pass: false, at: stage, reason: error.message }));
  } finally {
    for (const record of children) if (!record.exited) { try { record.child.stdin.end('exit\n'); } catch {} }
    const end = Date.now() + 3000; while (children.some(record => !record.exited) && Date.now() < end) await delay(20);
    for (const record of children) if (!record.exited) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.exited && !record.forced);
    console.log(JSON.stringify({ stage: 'cleanup', pass: clean, forced: children.filter(record => record.forced).length }));
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

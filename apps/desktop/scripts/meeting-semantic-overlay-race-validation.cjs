// Fixture-only deterministic snapshot/commit race validation.
'use strict';
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => console.log(JSON.stringify(value));
function check(value, stage, detail = {}) { emit({ stage, pass: Boolean(value), ...detail }); if (!value) throw new Error(stage); }
async function until(fn, timeout = 6000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(10); }
  throw new Error('timeout');
}

const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1] || '') : '';
if (process.platform !== 'win32' || !path.isAbsolute(exe)) process.exit(1);
const children = [];
function start(role, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { role, child, lines: [], closed: false, code: null, forced: false };
  children.push(record); child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('close', code => { record.closed = true; record.code = code; });
  return record;
}
async function ready(record) { return until(() => record.lines.find(line => line.type === 'ready' && line.role === record.role), 8000); }
async function command(record, action, type = 'ack') {
  const mark = record.lines.length; record.child.stdin.write(action + '\n');
  return until(() => record.lines.slice(mark).find(line => line.type === type && (type !== 'ack' || line.action === action)));
}
async function state(record) { await command(record, 'query'); return record.lines.findLast(line => line.type === 'state'); }
async function barrier(overlay, action) {
  const mark = overlay.lines.length; overlay.child.stdin.write(action + '\n');
  return until(() => overlay.lines.slice(mark).find(line => line.type === 'race-barrier'));
}
async function stop(record) { if (!record.closed) { await command(record, 'exit'); await until(() => record.closed); } }

(async () => {
  let failed = false;
  try {
    const target = start('target', ['target', '100', '100', '640', '420']); const targetId = await ready(target);
    const overlay = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started]); await ready(overlay);
    check((await command(overlay, 'draw')).ok && (await state(overlay)).input, 'race-draw-enabled');

    await barrier(overlay, 'race-target');
    check((await command(target, 'move')).ok, 'race-target-moved-after-enumerate');
    overlay.child.stdin.write('race-commit\n');
    const targetRace = await until(async () => { const value = await state(overlay); return value.state === 'unknown' ? value : null; });
    check(!targetRace.input && !targetRace.visible, 'race-target-fails-closed');

    check((await command(overlay, 'draw')).ok, 'race-recover-command');
    await until(async () => { const value = await state(overlay); return value.state === 'active' && value.input ? value : null; });
    const occluder = start('occluder', ['occluder', '260', '210', '220', '150']); await ready(occluder);
    await until(async () => { const value = await state(overlay); return value.state === 'active' && value.occluders === 1 ? value : null; });
    await barrier(overlay, 'race-occluder');
    check((await command(occluder, 'move-any')).ok, 'race-occluder-moved-after-enumerate');
    overlay.child.stdin.write('race-commit\n');
    const occluderRace = await until(async () => { const value = await state(overlay); return value.state === 'unknown' ? value : null; });
    check(!occluderRace.input && !occluderRace.visible, 'race-occluder-fails-closed');
    await stop(occluder);

    await until(async () => { const value = await state(overlay); return value.state === 'active' ? value : null; });
    const closingOccluder = start('occluder', ['occluder-plain', '260', '210', '220', '150', targetId.hwnd, targetId.pid, targetId.started]); await ready(closingOccluder);
    await until(async () => { const value = await state(overlay); return value.state === 'active' && value.occluders === 1 ? value : null; });
    await barrier(overlay, 'race-occluder');
    check((await command(closingOccluder, 'close')).ok, 'race-occluder-closed-after-enumerate');
    await until(() => closingOccluder.closed);
    overlay.child.stdin.write('race-commit\n');
    const closeRace = await until(async () => { const value = await state(overlay); return value.state === 'unknown' ? value : null; });
    check(!closeRace.input && !closeRace.visible, 'race-occluder-close-fails-closed');

    await until(async () => { const value = await state(overlay); return value.state === 'active' ? value : null; });
    await barrier(overlay, 'race-target');
    const oldHwnd = targetId.hwnd;
    const mark = target.lines.length; target.child.stdin.write('recreate\n');
    const replacement = await until(() => target.lines.slice(mark).find(line => line.type === 'ready'));
    await until(() => target.lines.slice(mark).find(line => line.type === 'ack' && line.action === 'recreate'));
    overlay.child.stdin.write('race-commit\n');
    await until(() => overlay.closed);
    check(replacement.hwnd !== oldHwnd && overlay.code === 0 && overlay.lines.some(line => line.type === 'cleanup' && line.destroyed),
      'destroy-latch-terminal-on-recreate', { handleReused: replacement.hwnd === oldHwnd });
    await stop(target);
  } catch (error) {
    failed = true; emit({ stage: 'failed', pass: false, reason: /^[a-z0-9-]+$/i.test(error.message) ? error.message : 'runtime-error' });
  } finally {
    for (const record of children) if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    const deadline = performance.now() + 4000;
    while (children.some(record => !record.closed) && performance.now() < deadline) await delay(20);
    for (const record of children) if (!record.closed) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.closed && !record.forced && record.lines.some(line => line.type === 'cleanup' && line.destroyed));
    emit({ stage: 'cleanup', pass: clean, processes: children.length, forced: children.filter(record => record.forced).length });
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

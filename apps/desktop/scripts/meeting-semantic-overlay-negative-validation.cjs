// Fixture-only negative Windows validation. OS input is restricted to re-authenticated child windows.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => console.log(JSON.stringify(value));
function check(value, stage, detail = {}) { emit({ stage, pass: Boolean(value), ...detail }); if (!value) throw new Error(stage); }
async function until(fn, timeout = 5000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(10); }
  throw new Error('timeout');
}

if (process.platform !== 'win32') process.exit(1);
const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1] || '') : '';
if (!path.isAbsolute(exe)) process.exit(1);

const children = [];
function start(role, args, expectedCrash = false, outputRole = role) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { role, outputRole, child, lines: [], closed: false, code: null, forced: false, expectedCrash, id: null };
  children.push(record); child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('close', code => { record.closed = true; record.code = code; });
  return record;
}
async function ready(record, allowUnsupported = false) {
  const result = await until(() => record.lines.find(line => line.type === 'ready' || (allowUnsupported && line.type === 'unsupported')) || (record.closed ? { type: 'closed' } : null), 8000);
  if (result.type === 'ready') record.id = result;
  return result;
}
async function command(record, action, type = 'ack') {
  const mark = record.lines.length; record.child.stdin.write(action + '\n');
  return until(() => record.lines.slice(mark).find(line => line.type === type && (type !== 'ack' || line.action === action)), 5000);
}
async function state(record) { await command(record, 'query'); return record.lines.findLast(line => line.type === 'state'); }
async function counts(record) { await command(record, 'query'); return record.lines.findLast(line => line.type === 'counts'); }
function identity(role, value) { return [role, value.hwnd, value.pid, value.started]; }
function probe(point, identities) {
  const result = spawnSync(exe, ['probe', String(point.x), String(point.y), 'click', ...identities.flat()], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let line; try { line = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch {}
  return { ok: result.status === 0, role: line?.role, sent: line?.sent === true, released: line?.released === true };
}
function gone(id) {
  const result = spawnSync(exe, ['gone', id.hwnd, id.pid, id.started], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let line; try { line = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch {}
  return result.status === 0 && line?.window === true && line?.process === true;
}
async function stop(record) {
  if (record.closed) return;
  await command(record, 'exit');
  await until(() => record.closed, 5000);
}
async function startPair() {
  const target = start('target', ['target', '100', '100', '640', '420']);
  const targetId = await ready(target);
  const overlay = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started]);
  const overlayId = await ready(overlay);
  return { target, targetId, overlay, overlayId };
}

async function activationScenario() {
  const { target, targetId, overlay, overlayId } = await startPair();
  const initial = await state(overlay);
  const hit = probe({ x: 420, y: 300 }, [identity('target', targetId), identity('overlay', overlayId)]);
  check(hit.ok && hit.role === 'target' && hit.released, 'activation-os-click-released', { observed: hit.role, released: hit.released });
  const targetCounts = await until(async () => { const value = await counts(target); return value.clicks === 1 && value.active ? value : null; }, 5000);
  check(targetCounts.active, 'activation-target-foreground');
  const rebuilt = await until(async () => { const value = await state(overlay); return value.state === 'active' && value.epoch > initial.epoch ? value : null; }, 6000);
  check(!rebuilt.input && rebuilt.visible, 'activation-rebuilt-epoch', { before: initial.epoch, after: rebuilt.epoch });
  check((await command(overlay, 'draw')).ok, 'activation-draw-command');
  const drawing = await state(overlay);
  const drawHit = probe({ x: 420, y: 300 }, [identity('target', targetId), identity('overlay', overlayId)]);
  const after = await state(overlay);
  check(drawHit.ok && drawHit.role === 'overlay' && drawHit.released && after.strokes === drawing.strokes + 1,
    'activation-draw-after-rebuild', { observed: drawHit.role, strokeDelta: after.strokes - drawing.strokes });
  await stop(overlay); await stop(target);
}

async function occluderScenario(kind) {
  const { target, targetId, overlay, overlayId } = await startPair();
  check((await command(overlay, 'draw')).ok, `${kind}-draw-command`);
  const before = await state(overlay);
  const fixtureArgs = [`occluder-${kind}`, '260', '210', '220', '150', targetId.hwnd, targetId.pid, targetId.started];
  const occluder = start(`occluder-${kind}`, fixtureArgs, false, 'occluder');
  const occluderId = await ready(occluder, kind === 'cloaked');
  if (occluderId.type === 'unsupported') {
    check(kind === 'cloaked' && occluder.closed && occluder.code === 2 && occluder.lines.some(line => line.type === 'cleanup' && line.destroyed),
      'cloaked-explicit-skip', { reason: occluderId.reason });
    await stop(overlay); await stop(target); return;
  }
  check(occluderId.type === 'ready', `${kind}-fixture-ready`);
  const unknown = await until(async () => { const value = await state(overlay); return value.state === 'unknown' ? value : null; }, 6000);
  check(!unknown.input && !unknown.visible && unknown.strokes === before.strokes, `${kind}-unknown-withdrawn`,
    { input: unknown.input, visible: unknown.visible, strokeDelta: unknown.strokes - before.strokes });
  await stop(occluder);
  check(gone(occluderId), `${kind}-occluder-pid-cleanup`);
  const recovered = await until(async () => { const value = await state(overlay); return value.state === 'active' && value.epoch > before.epoch ? value : null; }, 6000);
  check(recovered.input && recovered.visible, `${kind}-new-epoch-recovered`, { before: before.epoch, after: recovered.epoch });
  const hit = probe({ x: 420, y: 300 }, [identity('target', targetId), identity('overlay', overlayId)]);
  const after = await state(overlay);
  check(hit.ok && hit.role === 'overlay' && hit.released && after.strokes === recovered.strokes + 1, `${kind}-stroke-after-recovery`);
  await stop(overlay); await stop(target);
}

async function crashScenarios() {
  let pair = await startPair();
  pair.target.expectedCrash = true;
  pair.target.child.stdin.write('crash\n');
  await until(() => pair.target.closed, 5000);
  await until(() => pair.overlay.closed, 6000);
  check(pair.target.code !== 0 && gone(pair.targetId), 'target-crash-os-cleanup');
  check(pair.overlay.code === 0 && pair.overlay.lines.some(line => line.type === 'cleanup' && line.destroyed) && gone(pair.overlayId), 'target-crash-overlay-cleanup');

  pair = await startPair();
  pair.overlay.expectedCrash = true;
  pair.overlay.child.stdin.write('crash\n');
  await until(() => pair.overlay.closed, 5000);
  check(pair.overlay.code !== 0 && gone(pair.overlayId), 'helper-crash-os-cleanup');
  const targetState = await counts(pair.target);
  check(targetState.clicks === 0, 'helper-crash-target-survives');
  await stop(pair.target);
}

(async () => {
  let failed = false;
  try {
    await activationScenario();
    for (const kind of ['topmost', 'layered', 'region', 'cloaked']) await occluderScenario(kind);
    await crashScenarios();
  } catch (error) {
    failed = true; emit({ stage: 'failed', pass: false, reason: /^[a-z0-9-]+$/i.test(error.message) ? error.message : 'runtime-error' });
  } finally {
    for (const record of children) if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    const deadline = performance.now() + 4000;
    while (children.some(record => !record.closed) && performance.now() < deadline) await delay(20);
    for (const record of children) if (!record.closed) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.closed && !record.forced && (record.expectedCrash
      ? record.code !== 0 && record.id && gone(record.id)
      : record.lines.some(line => line.type === 'cleanup' && line.role === record.outputRole && line.destroyed)));
    emit({ stage: 'cleanup', pass: clean, processes: children.length, forced: children.filter(record => record.forced).length,
      expectedCrashes: children.filter(record => record.expectedCrash).length });
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

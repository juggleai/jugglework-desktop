// Fixture-only Windows validation. SendInput is restricted to authenticated child windows.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emit = value => console.log(JSON.stringify(value));
function check(value, stage, detail = {}) { emit({ stage, pass: Boolean(value), ...detail }); if (!value) throw new Error(stage); }
async function until(fn, timeout = 4000) {
  const start = performance.now();
  while (performance.now() - start < timeout) { const value = await fn(); if (value) return value; await delay(10); }
  throw new Error('timeout');
}

if (process.platform !== 'win32') process.exit(1);
const exeIndex = process.argv.indexOf('--exe');
const exe = exeIndex >= 0 ? path.resolve(process.argv[exeIndex + 1] || '') : '';
if (!path.isAbsolute(exe)) process.exit(1);

const children = [];
function start(role, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { role, child, lines: [], closed: false, code: null, forced: false };
  children.push(record); child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('close', code => { record.closed = true; record.code = code; });
  return record;
}
async function ready(record) {
  const result = await until(() => record.lines.find(line => line.type === 'ready' && line.role === record.role) || (record.closed ? { type: 'closed' } : null), 8000);
  if (result.type === 'closed') throw new Error(record.lines.findLast(line => line.type === 'refused')?.stage || record.lines.findLast(line => line.type === 'startup-refused')?.reason || 'startup-closed');
  return result;
}
async function command(record, action, type = 'ack') {
  const mark = record.lines.length; record.child.stdin.write(action + '\n');
  return until(() => record.lines.slice(mark).find(line => line.type === type && (type !== 'ack' || line.action === action)), 5000);
}
async function state(overlay) { await command(overlay, 'query'); return overlay.lines.at(-2).type === 'state' ? overlay.lines.at(-2) : overlay.lines.findLast(line => line.type === 'state'); }
async function counts(record) { await command(record, 'query'); return record.lines.findLast(line => line.type === 'counts'); }
function identity(role, value) { return [role, value.hwnd, value.pid, value.started]; }
function probe(point, identities) {
  const result = spawnSync(exe, ['probe', String(point.x), String(point.y), 'click', ...identities.flat()], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  let line; try { line = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch {}
  return { ok: result.status === 0, role: line?.role, sent: line?.sent === true, released: line?.released === true };
}
async function clickAndObserve(point, identities, expectedRole, records) {
  const before = Object.fromEntries(await Promise.all(records.map(async record => [record.role, (await counts(record)).clicks])));
  const observed = probe(point, identities); await delay(120);
  const after = Object.fromEntries(await Promise.all(records.map(async record => [record.role, (await counts(record)).clicks])));
  const delta = Object.fromEntries(records.map(record => [record.role, after[record.role] - before[record.role]]));
  return { pass: observed.ok && observed.role === expectedRole && delta[expectedRole] === 1 && Object.entries(delta).every(([role, value]) => role === expectedRole || value === 0), observed: observed.role, delta };
}

(async () => {
  let failed = false;
  try {
    const target = start('target', ['target', '100', '100', '640', '420']);
    const targetId = await ready(target);
    const overlay = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started]);
    const overlayId = await ready(overlay);
    const ids = [identity('target', targetId), identity('overlay', overlayId)];
    let snapshot = await state(overlay);
    check(snapshot.state === 'active' && snapshot.mode === 'pointer' && !snapshot.input && snapshot.visible && snapshot.epoch > 0,
      'initial-pointer', { state: snapshot.state, epoch: snapshot.epoch, input: snapshot.input });

    let result = await clickAndObserve({ x: 420, y: 300 }, ids, 'target', [target]);
    check(result.pass, 'pointer-through', { observed: result.observed, targetDelta: result.delta.target });

    snapshot = await until(async () => { const value = await state(overlay); return value.state === 'active' && value.epoch > 1 ? value : null; }, 6000);
    check(!snapshot.input && snapshot.visible, 'activation-new-epoch', { epoch: snapshot.epoch });

    check((await command(overlay, 'draw')).ok, 'draw-command');
    snapshot = await state(overlay);
    check(snapshot.state === 'active' && snapshot.mode === 'draw' && snapshot.input, 'draw-enabled', { epoch: snapshot.epoch,
      hitRole: snapshot.hitRole, transparentStyle: snapshot.transparentStyle, noActivate: snapshot.noActivate, topmost: snapshot.topmost });
    let strokes = snapshot.strokes;
    const drawProbe = probe({ x: 420, y: 300 }, ids); await delay(120); snapshot = await state(overlay);
    check(drawProbe.ok && drawProbe.role === 'overlay' && snapshot.strokes === strokes + 1, 'draw-hit', { observed: drawProbe.role, strokeDelta: snapshot.strokes - strokes });

    const occluder = start('occluder', ['occluder', '260', '210', '220', '150']);
    const occluderId = await ready(occluder); ids.push(identity('occluder', occluderId));
    check((await command(occluder, 'elevate')).ok, 'occluder-elevate');
    const elevated = await until(async () => { const value = await state(overlay); return value.state === 'unknown' && !value.input && !value.visible ? value : null; }, 6000);
    check(!elevated.input && !elevated.visible, 'occluder-elevated-withdrawn');
    const activateOccluder = probe({ x: 340, y: 280 }, ids);
    check(activateOccluder.ok && activateOccluder.role === 'occluder' && activateOccluder.released, 'occluder-activate');
    check((await command(occluder, 'lower')).ok, 'occluder-lower-normal');
    snapshot = await until(async () => { const value = await state(overlay); return value.state === 'active' && value.occluders === 1 && value.input ? value : null; }, 6000);
    check(snapshot.occluders === 1 && snapshot.input, 'occlusion-periodic-update', { occluders: snapshot.occluders, epoch: snapshot.epoch });
    strokes = snapshot.strokes;
    result = await clickAndObserve({ x: 340, y: 280 }, ids, 'occluder', [target, occluder]); snapshot = await state(overlay);
    check(result.pass && snapshot.strokes === strokes, 'occluded-click', { observed: result.observed, occluderDelta: result.delta.occluder, strokeDelta: snapshot.strokes - strokes });

    const beforeMove = snapshot;
    check((await command(target, 'move')).ok, 'target-move-command');
    snapshot = await until(async () => { const value = await state(overlay); return value.bounds.x === beforeMove.bounds.x + 40 && value.bounds.y === beforeMove.bounds.y + 30 ? value : null; }, 6000);
    check(snapshot.epoch > beforeMove.epoch && snapshot.input, 'target-move-follow', { epochAdvanced: snapshot.epoch > beforeMove.epoch, bounds: snapshot.bounds });

    check((await command(target, 'resize')).ok, 'target-resize-command');
    snapshot = await until(async () => { const value = await state(overlay); return value.state === 'resized' ? value : null; }, 6000);
    check(!snapshot.input && !snapshot.visible, 'resize-fail-closed', { state: snapshot.state, input: snapshot.input });
    check((await command(overlay, 'draw')).ok, 'resize-reenable-command'); snapshot = await state(overlay);
    check(snapshot.state === 'resized' && !snapshot.input && !snapshot.visible, 'resize-terminal', { state: snapshot.state });

    await command(overlay, 'exit'); await until(() => overlay.closed, 5000);
    check(overlay.code === 0 && overlay.lines.some(line => line.type === 'cleanup' && line.destroyed), 'first-overlay-cleanup');
    check((await command(occluder, 'exit')).ok, 'occluder-exit'); await until(() => occluder.closed, 5000);

    let replacement = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started]);
    let replacementId = await ready(replacement); let replacementIds = [identity('target', targetId), identity('overlay', replacementId)];
    let replacementState = await state(replacement);
    check(replacementState.epoch > 0 && replacementState.mode === 'pointer', 'replacement-epoch', { epoch: replacementState.epoch });
    check((await command(target, 'minimize')).ok, 'minimize-command');
    replacementState = await until(async () => { const value = await state(replacement); return value.state === 'minimized' ? value : null; }, 6000);
    check(!replacementState.visible && !replacementState.input, 'minimize-hidden');
    check((await command(target, 'restore')).ok, 'restore-command');
    const minimizedEpoch = replacementState.epoch;
    let recoveryRestart = false;
    const recoveryDeadline = performance.now() + 1500;
    while (performance.now() < recoveryDeadline) {
      replacementState = await state(replacement);
      if (replacementState.state === 'active') break;
      await delay(50);
    }
    if (replacementState.state !== 'active') {
      recoveryRestart = true;
      await command(replacement, 'exit'); await until(() => replacement.closed, 5000);
      check(replacement.code === 0 && replacement.lines.some(line => line.type === 'cleanup' && line.destroyed), 'stale-epoch-cleanup');
      replacement = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started]);
      replacementId = await ready(replacement); replacementIds = [identity('target', targetId), identity('overlay', replacementId)];
      replacementState = await state(replacement);
    }
    check(replacementState.state === 'active' && (recoveryRestart ? replacementState.epoch > 0 : replacementState.epoch > minimizedEpoch) && !replacementState.input,
      'restore-new-epoch', { recoveryRestart, epochAdvanced: recoveryRestart ? replacementState.epoch > 0 : replacementState.epoch > minimizedEpoch });
    result = await clickAndObserve({ x: 460, y: 330 }, replacementIds, 'target', [target]);
    check(result.pass, 'restored-pointer-through', { observed: result.observed });

    check((await command(target, 'close')).ok, 'target-close'); await until(() => target.closed, 5000);
    await until(() => replacement.closed, 6000);
    check(replacement.code === 0 && replacement.lines.some(line => line.type === 'cleanup' && line.destroyed), 'target-close-overlay-cleanup');
  } catch (error) {
    failed = true; emit({ stage: 'failed', pass: false, reason: /^[a-z0-9-]+$/i.test(error.message) ? error.message : 'runtime-error' });
  } finally {
    for (const record of children) {
      if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    }
    const deadline = performance.now() + 4000;
    while (children.some(record => !record.closed) && performance.now() < deadline) await delay(20);
    for (const record of children) if (!record.closed) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.closed && !record.forced && record.lines.some(line => line.type === 'cleanup' && line.role === record.role && line.destroyed));
    emit({ stage: 'cleanup', pass: clean, roles: Object.fromEntries(children.map(record => [record.role === 'overlay' ? `overlay-${children.filter(item => item.role === 'overlay').indexOf(record) + 1}` : record.role,
      { closed: record.closed, code: record.code, forced: record.forced, destroyed: record.lines.some(line => line.type === 'cleanup' && line.destroyed) }])) });
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

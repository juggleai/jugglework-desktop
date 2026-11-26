import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWindowsSemanticOverlay } from '../electron/meeting-semantic-overlay-windows.mjs';

if (process.platform !== 'win32') process.exit(1);
const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function until(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); } throw Error('timeout'); }
function processIdentity(exe, pid) {
  const result = spawnSync(exe, ['process-fixture', String(pid)], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  if (result.status !== 0) throw Error('process-identity');
  return JSON.parse(result.stdout.trim());
}
function startFixture(exe, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { child, lines: [], exited: false, forced: false }; child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('exit', () => { record.exited = true; }); return record;
}
async function ready(record) { return until(() => record.lines.find(line => line.type === 'ready') || (record.exited && { type: 'closed' }), 8000); }
async function stop(record) { if (record.exited) return; record.child.stdin.end('exit\n'); await until(() => record.exited); }

const children = []; let handle, failed = false, stage = 'adapter';
try {
  const bootstrap = createWindowsSemanticOverlay({ desktopRoot, parentProcessStartedAt: '1' });
  const exe = bootstrap.helperPath;
  const parent = processIdentity(exe, process.pid);
  const spawnHelper = (helperPath, args, options) => {
    if (helperPath !== exe) throw Error('helper-path');
    const child = spawn(helperPath, args, options);
    const record = { child, lines: [], exited: false, forced: false };
    child.on('exit', () => { record.exited = true; }); children.push(record); return child;
  };
  const adapter = createWindowsSemanticOverlay({ desktopRoot, parentProcessStartedAt: parent.started, timeoutMs: 3000, spawnHelper });
  if (adapter.helperPath !== exe) throw Error('fixed-path');
  stage = 'target'; const target = startFixture(exe, ['target', '100', '100', '640', '420']); children.push(target);
  const targetId = await ready(target); if (targetId.type !== 'ready') throw Error('target');
  handle = await adapter.open({ windowId: targetId.hwnd, pid: Number(targetId.pid), processStartedAt: targetId.started });
  if (!handle || !await handle.hello) throw Error('hello');
  const draw = await handle.setMode('draw', { tool: 'pen', color: '#ef4444', size: 4, highlight: false });
  if (!draw.ok) throw Error('draw');
  const states = []; handle.onState(value => states.push(value));
  stage = 'occluder'; const occluder = startFixture(exe, ['occluder-topmost', '260', '210', '220', '150',
    targetId.hwnd, targetId.pid, targetId.started]); children.push(occluder);
  if ((await ready(occluder)).type !== 'ready') throw Error('occluder');
  const unknown = await until(() => states.find(value => value.state === 'unknown'));
  if (unknown.input || unknown.visible) throw Error('not-withdrawn');
  stage = 'remove'; occluder.child.stdin.end('exit\n');
  const first = await handle.query();
  if (!first.ok && (first.reason !== 'wrong-epoch' || first.retryable !== true)) throw Error('unexpected-query');
  const recovered = await until(() => states.find(value => value.state === 'active' && value.epoch > unknown.epoch));
  const final = first.ok && first.value.epoch >= recovered.epoch ? first : await handle.query();
  if (!final.ok || final.value.state !== 'active' || final.value.epoch < recovered.epoch || !final.value.input || !final.value.visible) throw Error('wrong-epoch-stuck');
  await until(() => occluder.exited); await handle.close(); handle = null; await stop(target);
  console.log(JSON.stringify({ stage: 'adapter-state', pass: true, unknownEpoch: unknown.epoch, recoveredEpoch: recovered.epoch,
    unsolicitedStates: states.length, firstQuery: first.ok ? 'ok' : first.reason, fixedHelperPath: true }));
} catch (error) {
  failed = true; console.log(JSON.stringify({ stage: 'adapter-state', pass: false, at: stage, reason: error.message }));
} finally {
  handle?.dispose();
  for (const record of children) if (!record.exited) { try { record.child.stdin.end('exit\n'); } catch {} }
  const end = Date.now() + 3000; while (children.some(record => !record.exited) && Date.now() < end) await delay(20);
  for (const record of children) if (!record.exited) { record.forced = true; record.child.kill(); }
  const clean = children.every(record => record.exited && !record.forced);
  console.log(JSON.stringify({ stage: 'cleanup', pass: clean, forced: children.filter(record => record.forced).length }));
  process.exitCode = failed || !clean ? 1 : 0;
}

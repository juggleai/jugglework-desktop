'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');

const at = process.argv.indexOf('--exe');
const exe = at >= 0 ? path.resolve(process.argv[at + 1] || '') : '';
if (process.platform !== 'win32' || !path.isAbsolute(exe)) process.exit(1);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = fn(); if (value) return value; await delay(10); } throw Error('timeout'); }
async function queryUntil(record, fn, timeout = 6000) { const end = Date.now() + timeout; while (Date.now() < end) { await command(record, 'query'); const value = record.lines.findLast(line => line.type === 'state'); if (fn(value)) return value; await delay(20); } throw Error('timeout'); }
function check(value, stage, detail = {}) { console.log(JSON.stringify({ stage, pass: Boolean(value), ...detail })); if (!value) throw Error(stage); }
const children = [];
function start(role, args) {
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  const record = { role, child, lines: [], closed: false, forced: false };
  children.push(record);
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => { try { record.lines.push(JSON.parse(line)); } catch {} });
  child.on('close', () => { record.closed = true; });
  return record;
}
async function ready(record) { return until(() => record.lines.find(line => line.type === 'ready')); }
function frame(identity) {
  const result = spawnSync(exe, ['frame', identity.hwnd, identity.pid, identity.started], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw Error(`frame-${result.status}`);
  return JSON.parse(result.stdout.trim());
}
function processIdentity(pid) {
  const result = spawnSync(exe, ['process-fixture', String(pid)], { encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw Error(`identity-${result.status}`);
  return JSON.parse(result.stdout.trim());
}
async function command(record, action) {
  record.child.stdin.write(`${action}\n`);
  return until(() => record.lines.findLast(line => line.type === 'ack' && line.action === action));
}

(async () => {
  let failed = false;
  try {
    const fixtures = [
      start('pmv2', ['target', '80', '80', '640', '420']),
      start('system', ['target-system', '760', '80', '640', '420']),
      start('unaware', ['target-unaware', '80', '560', '640', '420']),
    ];
    const identities = await Promise.all(fixtures.map(ready));
    const frames = identities.map(frame);
    for (let index = 0; index < frames.length; index++) {
      const value = frames[index];
      check(value.dpi === 96, `${fixtures[index].role}-dpi96`, { dpi: value.dpi });
      check(value.dwm.width > 0 && value.dwm.height > 0 && value.outer.width > 0 && value.outer.height > 0,
        `${fixtures[index].role}-physical-frame`, value);
    }

    const target = fixtures[0];
    const targetId = identities[0];
    const overlay = start('overlay', ['overlay-fixture', targetId.hwnd, targetId.pid, targetId.started, '12000']);
    await ready(overlay);
    const layers = await until(() => overlay.lines.find(line => line.type === 'fixture-layers'));
    const overlayProcess = processIdentity(overlay.child.pid);
    const visualFrame = frame({ hwnd: layers.visualHwnd, pid: overlayProcess.pid, started: overlayProcess.started });
    const inputFrame = frame({ hwnd: layers.inputHwnd, pid: overlayProcess.pid, started: overlayProcess.started });
    await command(overlay, 'query');
    const state = overlay.lines.findLast(line => line.type === 'state');
    check(state.bounds.x === frames[0].dwm.x && state.bounds.y === frames[0].dwm.y &&
      state.bounds.width === frames[0].dwm.width && state.bounds.height === frames[0].dwm.height,
      'pmv2-target-overlay-physical-dwm-frame', { target: frames[0].dwm, overlay: state.bounds });
    check(JSON.stringify(visualFrame.dwm) === JSON.stringify(frames[0].dwm) && JSON.stringify(inputFrame.dwm) === JSON.stringify(frames[0].dwm),
      'target-visual-input-physical-dwm-frames-identical', { target: frames[0].dwm, visual: visualFrame.dwm, input: inputFrame.dwm });
    check(layers.visualHwnd !== layers.inputHwnd, 'dual-hwnd-distinct');

    await command(target, 'move');
    const moved = await queryUntil(overlay, value => value && value.state === 'active' && value.bounds.x === frames[0].dwm.x + 40 && value.bounds.y === frames[0].dwm.y + 30);
    check(!moved.input && moved.visible && moved.bounds.width === frames[0].dwm.width && moved.bounds.height === frames[0].dwm.height && moved.epoch > state.epoch,
      'same-dpi-move-new-epoch', { before: state, after: moved });
    await command(overlay, 'exit');
    for (const fixture of fixtures) await command(fixture, 'exit');
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ stage: 'failed', pass: false, reason: error.message }));
  } finally {
    for (const record of children) if (!record.closed) { try { record.child.stdin.end('exit\n'); } catch {} }
    const end = Date.now() + 4000;
    while (children.some(record => !record.closed) && Date.now() < end) await delay(20);
    for (const record of children) if (!record.closed) { record.forced = true; record.child.kill(); }
    const clean = children.every(record => record.closed && !record.forced);
    console.log(JSON.stringify({ stage: 'cleanup', pass: clean, forced: children.filter(record => record.forced).length }));
    process.exitCode = failed || !clean ? 1 : 0;
  }
})();

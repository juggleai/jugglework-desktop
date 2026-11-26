'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const exeAt = process.argv.indexOf('--exe'); const exe = exeAt >= 0 ? path.resolve(process.argv[exeAt + 1] || '') : '';
const launcherPath = path.resolve(__dirname, 'meeting-semantic-overlay-parent-launcher.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) { return spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout.includes(`"${pid}"`); }
(async () => {
  const launcher = spawn(process.execPath, [launcherPath, exe], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let ready; createInterface({ input: launcher.stdout }).on('line', line => { try { ready = JSON.parse(line); } catch {} });
  const deadline = Date.now() + 8000; while (!ready && Date.now() < deadline) await delay(20); if (!ready) throw Error('launcher-timeout');
  spawnSync('taskkill.exe', ['/PID', String(launcher.pid), '/F'], { windowsHide: true });
  const cleanupDeadline = Date.now() + 2000; while (alive(ready.overlayPid) && Date.now() < cleanupDeadline) await delay(20);
  const pass = !alive(ready.overlayPid); console.log(JSON.stringify({ stage: 'parent-kill', pass }));
  if (alive(ready.targetPid)) spawnSync('taskkill.exe', ['/PID', String(ready.targetPid), '/F'], { windowsHide: true });
  if (!pass) { spawnSync('taskkill.exe', ['/PID', String(ready.overlayPid), '/F'], { windowsHide: true }); process.exitCode = 1; }
})().catch(error => { console.log(JSON.stringify({ stage: 'parent-kill', pass: false, reason: error.message })); process.exitCode = 1; });

'use strict';
const { spawn, spawnSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const exe = process.argv[2];
const parent = JSON.parse(spawnSync(exe, ['process-fixture', String(process.pid)], { encoding: 'utf8', windowsHide: true }).stdout.trim());
const target = spawn(exe, ['target', '180', '160', '520', '340'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
createInterface({ input: target.stdout }).on('line', line => {
  let value; try { value = JSON.parse(line); } catch { return; }
  if (value.type !== 'ready') return;
  const overlay = spawn(exe, ['overlay', value.hwnd, value.pid, value.started, parent.pid, parent.started, 'parent_kill_session_123456'],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: false });
  createInterface({ input: overlay.stdout }).on('line', output => {
    let hello; try { hello = JSON.parse(output); } catch { return; }
    if (hello.type === 'hello') console.log(JSON.stringify({ type: 'ready', launcherPid: process.pid, targetPid: target.pid, overlayPid: overlay.pid }));
  });
});
setInterval(() => {}, 1000);

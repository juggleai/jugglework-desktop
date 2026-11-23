// Standalone, passive Win32 experiment; no Electron or product startup.
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const plan = [
  ['target', 64, 64, 240, 240], ['top', 64, 64, 240, 8], ['bottom', 64, 296, 240, 8],
  ['left', 64, 72, 8, 224], ['right', 296, 72, 8, 224],
];
const helperStages = new Set(['compile', 'pmv2', 'work-area', 'create', 'show', 'readback', 'native-timeout', 'cleanup']);

function verify(record) {
  if (record?.type === 'error' && helperStages.has(record.stage)) return { stage: record.stage };
  if (record?.type !== 'sample' || !Array.isArray(record.windows) || record.windows.length !== plan.length) {
    return { stage: 'protocol' };
  }
  const windows = [];
  for (const [i, [role, ...expected]] of plan.entries()) {
    const sample = record.windows[i];
    if (sample?.role !== role || !Number.isInteger(sample.dpi) ||
        !['pmv2', 'visible', 'topmost', 'passive'].every(key => typeof sample[key] === 'boolean') ||
        (i === 0 ? sample.adjacent !== null : typeof sample.adjacent !== 'boolean')) return { stage: 'protocol' };
    const actual = ['x', 'y', 'width', 'height'].map(key => sample.px?.[key]);
    if (!actual.every(Number.isSafeInteger)) return { stage: 'protocol' };
    const [x, y, width, height] = actual;
    const px = { x, y, width, height };
    if (actual.some((n, j) => n !== expected[j])) return { stage: 'geometry', role, px };
    if (sample.dpi !== 96 || !sample.pmv2) return { stage: 'dpi', role, dpi: sample.dpi };
    if (!sample.visible || !sample.passive) return { stage: 'visibility-style', role };
    if (sample.topmost) return { stage: 'topmost', role };
    if (i > 0 && !sample.adjacent) return { stage: 'order', role };
    windows.push({ role, px, dpi: sample.dpi, pmv2: true, visible: true, topmost: false, passive: true, adjacent: sample.adjacent });
  }
  return { windows };
}

function observeVisibleEdges({ child, emit, signals, durationMs = 12_000, startupMs = 20_000,
  sampleMs = 2_000, cleanupMs = 2_000, killMs = 1_000 }) {
  return new Promise(resolve => {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let seen = false, stopping = false, failed = false, settled = false;
    let watchdog = setTimeout(() => stop('startup-timeout'), startupMs);
    let duration, cleanup;
    const output = (stage, evidence = {}) => emit({ type: 'edge-visible-native', stage, inputEnabled: false, ...evidence });
    const interrupt = () => stop('interrupted');
    function complete() {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      clearTimeout(duration);
      clearTimeout(cleanup);
      lines.close();
      signals?.off('SIGINT', interrupt);
      signals?.off('SIGTERM', interrupt);
      resolve(failed ? 1 : 0);
    }
    function stop(stage, evidence) {
      if (settled) return;
      if (stage && !failed) {
        failed = true;
        output(stage, evidence);
      }
      if (stopping) return;
      stopping = true;
      clearTimeout(watchdog);
      clearTimeout(duration);
      cleanup = setTimeout(() => {
        failed = true;
        output('forced-cleanup');
        cleanup = setTimeout(() => { output('cleanup-timeout'); complete(); }, killMs);
        try { child.kill(); } catch { /* wait for close or report cleanup-timeout */ }
      }, cleanupMs);
      child.stdin.end();
    }
    child.on('error', () => stop('helper-process'));
    child.stdin.on('error', () => { if (!stopping) stop('helper-pipe'); });
    child.stdout.on('error', () => stop('helper-pipe'));
    child.on('close', (code) => {
      if (settled) return;
      if (code !== 0 || !stopping || !seen) {
        if (!failed) output('helper-exit');
        failed = true;
      } else if (!failed) {
        output('removed');
      }
      complete();
    });
    signals?.on('SIGINT', interrupt);
    signals?.on('SIGTERM', interrupt);
    lines.on('line', line => {
      if (settled) return;
      let record;
      try { record = JSON.parse(line); } catch { if (!stopping) stop('protocol'); return; }
      const { stage, windows, ...evidence } = verify(record);
      if (stage === 'cleanup' && failed) { output(stage); return; }
      if (stage) return stop(stage, evidence);
      if (stopping) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => stop('sample-timeout'), sampleMs);
      if (!seen) {
        seen = true;
        output('visible-sample', { windows });
        duration = setTimeout(() => stop(), durationMs);
      }
    });
  });
}

if (require.main === module) {
  const emit = record => console.log(JSON.stringify(record));
  if (process.platform !== 'win32' || !process.env.SystemRoot) {
    emit({ type: 'edge-visible-native', stage: 'windows-required', inputEnabled: false });
    process.exitCode = 1;
  } else {
    const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-File', join(__dirname, 'meeting-window-p0-edge-visible-native.ps1')], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    observeVisibleEdges({ child, emit, signals: process }).then(code => {
      // On the exceptional cleanup-timeout path, inherited pipes may never close.
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
      process.exitCode = code;
    });
  }
}

module.exports = { observeVisibleEdges };

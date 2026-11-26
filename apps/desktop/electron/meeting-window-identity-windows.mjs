import { spawn } from 'node:child_process';

const uint64 = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const validPID = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const dimensions = value => value && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && value.width > 0 && value.height > 0;
const bounds = value => dimensions(value) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);

/** @typedef {'process-wait' | 'window-identity' | 'unsupported-dpi' | 'topmost' | 'outer-read' | 'dwm-read' | 'outer-recheck' | 'dwm-recheck' | 'outer-changed' | 'dwm-changed' | 'state-changed' | 'identity-changed' | 'process-changed' | 'dpi-context'} NativeDiagnostic */
/** @typedef {'adapter-invalid-target' | 'adapter-spawn-failed' | 'adapter-timeout' | 'adapter-output-too-large' | 'adapter-invalid-json' | 'adapter-identity-mismatch' | 'adapter-unknown-reason' | 'adapter-invalid-sample' | 'adapter-helper-error' | 'adapter-eof'} AdapterDiagnostic */
/** @typedef {NativeDiagnostic | AdapterDiagnostic} Diagnostic */
/** @type {ReadonlySet<NativeDiagnostic>} */
const nativeDiagnostics = new Set([
  'process-wait', 'window-identity', 'unsupported-dpi', 'topmost', 'outer-read', 'dwm-read',
  'outer-recheck', 'dwm-recheck', 'outer-changed', 'dwm-changed', 'state-changed',
  'identity-changed', 'process-changed', 'dpi-context',
]);

/**
 * Experimental observer and one-shot foreground request. No annotation entry is enabled here.
 * @param {{ helperPath: string, timeoutMs?: number,
 *   spawnHelper?: (path: string, args: string[], options: {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: boolean}) => {
 *     stdout: import('node:stream').Readable | null,
 *     once: (event: string, listener: (...args: any[]) => void) => unknown,
 *     kill: () => boolean
 *   } }} options
 */
export function createWindowsWindowIdentity({ helperPath, timeoutMs = 1000, spawnHelper = spawn }) {
  function resolveProcessStartedAt(requestedPid) {
    if (!validPID(requestedPid)) return Promise.resolve(null);
    return run(['process', String(requestedPid)], value => value?.pid === requestedPid && uint64(value.processStartedAt) ? value.processStartedAt : null);
  }
  function run(args, accept) {
    return new Promise(resolve => {
      let child;
      try { child = spawnHelper(helperPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
      catch { resolve(null); return; }
      let settled = false, output = '';
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      function finish(value, terminate = false) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (terminate) { try { child.kill(); } catch {} }
        resolve(value);
      }
      child.stdout?.setEncoding('utf8').on('data', chunk => { output += chunk; if (output.length > 2048) finish(null, true); });
      child.once('error', () => finish(null, true));
      child.once('close', code => {
        if (settled) return;
        try { finish(code === 0 ? accept(JSON.parse(output)) : null); } catch { finish(null); }
      });
    });
  }
  /** @param {string} hwnd
   * @param {{pid: number, processStartedAt: string} | null} [activationTarget]
   * @returns {Promise<{pid: number, processStartedAt: string} | null>} */
  function resolveWindowsIdentity(hwnd, activationTarget = null) {
    if (!uint64(hwnd)) return Promise.resolve(null);
    if (activationTarget && (!validPID(activationTarget.pid) || !uint64(activationTarget.processStartedAt))) return Promise.resolve(null);
    return new Promise(resolve => {
      let child;
      const args = activationTarget ? ['activate', hwnd, String(activationTarget.pid), activationTarget.processStartedAt] : ['inspect', hwnd];
      try { child = spawnHelper(helperPath, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
      catch { resolve(null); return; }
      let settled = false, output = '';
      const timer = setTimeout(() => finish(null, true), timeoutMs);
      function finish(value, terminate = false) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (terminate) { try { child.kill(); } catch { /* inspection is already rejected */ } }
        resolve(value);
      }
      child.stdout?.setEncoding('utf8').on('data', chunk => {
        if (settled) return;
        output += chunk;
        if (output.length > 2048) finish(null, true);
      });
      child.once('error', () => finish(null, true));
      child.once('close', code => {
        if (settled) return;
        try {
          const value = JSON.parse(output);
          finish(code === 0 && value?.hwnd === hwnd && validPID(value.pid) &&
            uint64(value.processStartedAt) && (!activationTarget || (value.pid === activationTarget.pid &&
              value.processStartedAt === activationTarget.processStartedAt && value.activated === true))
            ? { pid: value.pid, processStartedAt: value.processStartedAt } : null);
        } catch { finish(null); }
      });
    });
  }

  /** @param {{windowId: string, pid: number, processStartedAt: string}} target
   * @param {(sample: import('./meeting-window-tracker.mjs').Sample) => void} onSample
   * @param {(reason: Diagnostic) => void} [onDiagnostic] Receives only a whitelisted reason code, never native data. */
  function watchWindow(target, onSample, onDiagnostic) {
    let stopped = false, child, timer, buffer = '', pendingCount = 0;
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* no windows or writable target state are owned by this helper */ }
    }
    /** @param {'closed' | 'unavailable'} status @param {Diagnostic} [reason] */
    function terminal(status, reason) {
      if (stopped) return;
      stop();
      try { onSample({ status }); }
      finally {
        // Diagnostics must never interfere with terminal sample delivery or helper cleanup.
        if (reason) { try { onDiagnostic?.(reason); } catch { /* observer-only callback */ } }
      }
    }
    const stoppedHandle = Object.assign(stop, { setOverlayWindows() {} });
    if (!uint64(target.windowId) || !validPID(target.pid) || !uint64(target.processStartedAt)) {
      queueMicrotask(() => terminal('unavailable', 'adapter-invalid-target'));
      return stoppedHandle;
    }
    try { child = spawnHelper(helperPath, ['watch', target.windowId, String(target.pid), target.processStartedAt],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { queueMicrotask(() => terminal('unavailable', 'adapter-spawn-failed')); return stoppedHandle; }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => terminal('unavailable', 'adapter-timeout'), timeoutMs);
    }
    arm();
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      if (stopped) return;
      buffer += chunk;
      while (!stopped) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        if (end > 2048) { terminal('unavailable', 'adapter-output-too-large'); return; }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { terminal('unavailable', 'adapter-invalid-json'); return; }
        if (value?.hwnd !== target.windowId || value.pid !== target.pid || value.processStartedAt !== target.processStartedAt) {
          terminal('unavailable', 'adapter-identity-mismatch'); return;
        }
        if (value.status === 'unavailable') {
          terminal('unavailable', typeof value.reason === 'string' && nativeDiagnostics.has(value.reason)
            ? value.reason : 'adapter-unknown-reason');
          return;
        }
        if (value.status === 'geometry-pending') {
          if (!['outer-changed', 'dwm-changed'].includes(value.reason) || ++pendingCount > 10) {
            terminal('unavailable', 'adapter-invalid-sample'); return;
          }
          // Never refresh the watchdog for untrusted geometry; only a complete
          // visible/hidden/minimized sample may establish a fresh deadline.
          onSample({ status: 'geometry-pending' });
          try { onDiagnostic?.(value.reason); } catch { /* diagnostic only */ }
          continue;
        }
        if (value.status === 'closed') { terminal('closed'); return; }
        if (value.status === 'hidden' || value.status === 'minimized') {
          pendingCount = 0;
          arm(); onSample({ status: value.status });
        } else if (value.status === 'visible' && value.dpi === 96 && bounds(value.bounds) && dimensions(value.actualSize)) {
          pendingCount = 0;
          arm(); onSample({ status: 'visible', pid: target.pid, bounds: value.bounds, actualSize: value.actualSize });
        } else { terminal('unavailable', 'adapter-invalid-sample'); return; }
      }
      if (!stopped && buffer.length > 2048) terminal('unavailable', 'adapter-output-too-large');
    });
    child.stdout?.once('end', () => terminal('unavailable', 'adapter-eof'));
    child.once('error', () => terminal('unavailable', 'adapter-helper-error'));
    child.once('close', () => terminal('unavailable', 'adapter-eof'));
    return stoppedHandle;
  }
  return { resolveWindowsIdentity, resolveProcessStartedAt, watchWindow,
    activateWindow: async target => Boolean(await resolveWindowsIdentity(target.windowId, target)) };
}

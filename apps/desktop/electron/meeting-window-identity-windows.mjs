import { spawn } from 'node:child_process';

const uint64 = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const validPID = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const dimensions = value => value && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height) && value.width > 0 && value.height > 0;
const bounds = value => dimensions(value) && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y);

/**
 * Read-only experimental observer. No sharing or annotation entry is enabled by this adapter.
 * @param {{ helperPath: string, timeoutMs?: number,
 *   spawnHelper?: (path: string, args: string[], options: {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: boolean}) => {
 *     stdout: import('node:stream').Readable | null,
 *     once: (event: string, listener: (...args: any[]) => void) => unknown,
 *     kill: () => boolean
 *   } }} options
 */
export function createWindowsWindowIdentity({ helperPath, timeoutMs = 1000, spawnHelper = spawn }) {
  /** @param {string} hwnd @returns {Promise<{pid: number, processStartedAt: string} | null>} */
  function resolveWindowsIdentity(hwnd) {
    if (!uint64(hwnd)) return Promise.resolve(null);
    return new Promise(resolve => {
      let child;
      try { child = spawnHelper(helperPath, ['inspect', hwnd], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
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
            uint64(value.processStartedAt) ? { pid: value.pid, processStartedAt: value.processStartedAt } : null);
        } catch { finish(null); }
      });
    });
  }

  /** @param {{windowId: string, pid: number, processStartedAt: string}} target
   * @param {(sample: import('./meeting-window-tracker.mjs').Sample) => void} onSample */
  function watchWindow(target, onSample) {
    let stopped = false, child, timer, buffer = '';
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* no windows or writable target state are owned by this helper */ }
    }
    /** @param {'closed' | 'unavailable'} status */
    function terminal(status) {
      if (stopped) return;
      stop();
      onSample({ status });
    }
    const stoppedHandle = Object.assign(stop, { setOverlayWindows() {} });
    if (!uint64(target.windowId) || !validPID(target.pid) || !uint64(target.processStartedAt)) {
      queueMicrotask(() => terminal('unavailable'));
      return stoppedHandle;
    }
    try { child = spawnHelper(helperPath, ['watch', target.windowId, String(target.pid), target.processStartedAt],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
    catch { queueMicrotask(() => terminal('unavailable')); return stoppedHandle; }
    function arm() {
      clearTimeout(timer);
      timer = setTimeout(() => terminal('unavailable'), timeoutMs);
    }
    arm();
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      if (stopped) return;
      buffer += chunk;
      while (!stopped) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        if (end > 2048) { terminal('unavailable'); return; }
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let value;
        try { value = JSON.parse(line); } catch { terminal('unavailable'); return; }
        if (value?.hwnd !== target.windowId || value.pid !== target.pid || value.processStartedAt !== target.processStartedAt) {
          terminal('unavailable'); return;
        }
        if (value.status === 'closed') { terminal('closed'); return; }
        if (value.status === 'hidden' || value.status === 'minimized') {
          arm(); onSample({ status: value.status });
        } else if (value.status === 'visible' && value.dpi === 96 && bounds(value.bounds) && dimensions(value.actualSize)) {
          arm(); onSample({ status: 'visible', pid: target.pid, bounds: value.bounds, actualSize: value.actualSize });
        } else { terminal('unavailable'); return; }
      }
      if (!stopped && buffer.length > 2048) terminal('unavailable');
    });
    child.once('error', () => terminal('unavailable'));
    child.once('close', () => terminal('unavailable'));
    return stoppedHandle;
  }
  return { resolveWindowsIdentity, watchWindow };
}

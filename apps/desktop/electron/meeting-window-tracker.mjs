import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/** @typedef {{ x: number, y: number, width: number, height: number }} Bounds */
/** @typedef {{ status: 'visible', pid: number, bounds: Bounds } | { status: 'hidden' | 'minimized' | 'closed' | 'needs-accessibility' | 'unavailable' }} Sample */
/** @typedef {'order-lost' | 'order-interleaved' | 'edge-overlap'} OrderEvent */

/** @param {Bounds | null} initial @param {Sample} sample */
export function classifyWindowSample(initial, sample) {
  if (sample.status === 'hidden' || sample.status === 'minimized') return 'hide';
  if (sample.status === 'closed') return 'close';
  if (sample.status !== 'visible' || !validBounds(sample.bounds)) return 'unavailable';
  return initial && (initial.width !== sample.bounds.width || initial.height !== sample.bounds.height) ? 'resize' : 'follow';
}

/** @param {Bounds | undefined} bounds */
const validBounds = bounds => bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
/** @param {number} pid */
const validPID = pid => Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff;

/** @typedef {{ stdin: import('node:stream').Writable | null, stdout: import('node:stream').Readable | null, once: (event: string, listener: (...args: any[]) => void) => unknown, kill: () => boolean }} HelperProcess */
/** @typedef {(() => void) & {setOverlayWindows: (ids: number[]) => void}} StopWatching */
/** @param {{helperPath: string, spawnHelper?: (path: string, args: string[], options: {stdio: ['ignore' | 'pipe', 'pipe', 'ignore']}) => HelperProcess}} options */
export function createMeetingWindowTracker({ helperPath, spawnHelper = spawn }) {
  /** @param {number} windowId @returns {Promise<{pid: number} | null>} */
  function resolveWindowIdentity(windowId) {
    return new Promise(resolve => {
      let child;
      try { child = spawnHelper(helperPath, ['inspect', String(windowId)], { stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { resolve(null); return; }
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolve(null); }, 1000);
      child.stdout?.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        if (output.length > 1024) { child.kill(); resolve(null); }
      });
      child.once('error', () => { clearTimeout(timer); resolve(null); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          const { pid } = JSON.parse(output);
          resolve(code === 0 && validPID(pid) ? { pid } : null);
        } catch { resolve(null); }
      });
    });
  }

  /** @param {{windowId: number, pid: number}} target @param {(sample: Sample) => void} onSample @param {(event: OrderEvent, edgeIds?: number[]) => void} [onOrderEvent] @returns {StopWatching} */
  function watchWindow({ windowId, pid }, onSample, onOrderEvent) {
    let child;
    let stopped = false;
    /** @type {Set<number> | null} */
    let registeredEdges = null;
    try { child = spawnHelper(helperPath, ['watch', String(windowId), String(pid)], { stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch {
      queueMicrotask(() => { if (!stopped) onSample({ status: 'unavailable' }); });
      return Object.assign(() => { stopped = true; }, { setOverlayWindows() {} });
    }
    const lines = child.stdout && createInterface({ input: child.stdout });
    const timer = setTimeout(() => terminal('unavailable'), 2000);
    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      lines?.close();
      child.stdin?.destroy();
      child.kill();
    }
    /** @param {'closed' | 'needs-accessibility' | 'unavailable'} status */
    function terminal(status) {
      if (stopped) return;
      stop();
      onSample({ status });
    }
    lines?.on('line', line => {
      if (stopped) return;
      let sample;
      try { sample = JSON.parse(line); }
      catch { terminal('unavailable'); return; }
      if (sample?.event === 'order-lost' || sample?.event === 'order-interleaved') {
        if (registeredEdges) onOrderEvent?.(sample.event);
      } else if (sample?.event === 'edge-overlap') {
        const edgeIds = sample.edgeIds;
        if (registeredEdges && Array.isArray(edgeIds) && edgeIds.length <= 4 && new Set(edgeIds).size === edgeIds.length &&
            edgeIds.every(id => registeredEdges?.has(id))) onOrderEvent?.('edge-overlap', edgeIds);
      } else if (sample?.status === 'visible' && sample.pid === pid && validBounds(sample.bounds)) {
        clearTimeout(timer);
        onSample(sample);
      } else if (sample?.status === 'hidden' || sample?.status === 'minimized') {
        clearTimeout(timer);
        onSample({ status: sample.status });
      } else terminal(sample?.status === 'closed' || sample?.status === 'needs-accessibility' ? sample.status : 'unavailable');
    });
    child.stdin?.on('error', () => terminal('unavailable'));
    child.once('error', () => terminal('unavailable'));
    child.once('close', () => terminal('unavailable'));
    return Object.assign(stop, {
      /** @param {number[]} ids */
      setOverlayWindows(ids) {
        if (stopped || registeredEdges || !child.stdin || ids.length !== 5 || new Set(ids).size !== ids.length ||
            ids.some(id => !Number.isInteger(id) || id <= 0 || id > 0xffffffff || id === windowId)) return;
        registeredEdges = new Set(ids.slice(1));
        child.stdin.write(`${JSON.stringify({ overlayWindowIds: ids })}\n`);
      },
    });
  }

  return { resolveWindowIdentity, watchWindow };
}

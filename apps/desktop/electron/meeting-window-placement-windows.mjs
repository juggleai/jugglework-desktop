import { spawn } from 'node:child_process';

export const TARGET_POSITION_STALE = 'target-position-stale';
export const TARGET_SIZE_UNCONFIRMED = 'target-size-unconfirmed';
export const HIDDEN_HOST_NEIGHBOR = 'hidden-host-neighbor';
export const HIDDEN_EXTERNAL_INTERPOSER = 'hidden-external-interposer';
export const HIDDEN_HOST_TARGET_NOT_BELOW = 'hidden-host-target-not-below';
export const PLACEMENT_ORDER_UNCONFIRMED = 'placement-order-unconfirmed';

const uint64 = v => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const pid = v => Number.isInteger(v) && v > 0 && v <= 0x7fffffff;
const rectangle = b => b && [b.x, b.y, b.width, b.height].every(Number.isInteger) &&
  [b.x, b.y].every(n => n >= -0x80000000 && n <= 0x7fffffff) && b.width > 0 && b.width <= 16384 && b.height > 0 && b.height <= 16384;
const hiddenRoles = ['unknown', 'canvas-default-ime', 'ime-class', 'render-class', 'ole-class', 'chromium-canvas-owned', 'chromium-unowned', 'chromium-other-owner', 'other-class',
  'other-class-empty-unowned', 'other-class-empty-canvas-owned', 'other-class-empty-other-owner'];
const refusals = new Set(['identity-or-state', 'target-read', 'target-position', 'target-size', 'canvas-geometry', 'order-check', 'order-check-neighbor-raced',
  'order-check-own-visible', 'order-check-own-hidden', 'order-check-own-hidden-target-not-below', 'order-check-other',
  'order-topmost', 'order-topmost-fixture-process', 'order-topmost-other-process', 'order-anchor-changed', 'order-write', 'order-readback',
  'order-readback-unchanged-anchor', 'order-readback-visible', 'order-readback-retry-exhausted',
  'order-readback-first-verification', 'order-readback-final-verification', 'order-readback-unchanged-anchor-raced',
  'order-readback-unchanged-anchor-no-neighbor', 'order-readback-unchanged-anchor-other',
  'order-readback-unchanged-anchor-own-visible', 'order-readback-unchanged-anchor-own-hidden',
  ...hiddenRoles.flatMap(role => [`order-readback-unchanged-anchor-own-hidden-${role}`, `order-check-own-hidden:${role}`, `order-check-own-hidden-target-not-below:${role}`])]);

/** @param {{helperPath: string, ownerPid?: number, timeoutMs?: number,
 * spawnHelper?: (path: string, args: string[], options: {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: boolean}) => {
 * stdout: import('node:stream').Readable | null, once: (event: string, listener: (...args: any[]) => void) => unknown, kill: () => boolean
 * }, onDiagnostic?: (reason: string) => void } } options */
export function createWindowsCanvasPlacement({ helperPath, ownerPid = process.pid, timeoutMs = 1000, spawnHelper = spawn, onDiagnostic }) {
  return async function place(canvas, target, request) {
    if (canvas.isDestroyed() || target.platform !== 'win32' || !uint64(target.windowId) || !pid(target.pid) ||
        !uint64(target.processStartedAt) || !pid(ownerPid) || !rectangle(request.bounds) || typeof request.visible !== 'boolean') return false;
    let ink;
    try {
      const buffer = canvas.getNativeWindowHandle();
      ink = buffer.length === 8 ? buffer.readBigUInt64LE().toString() : buffer.length === 4 ? String(buffer.readUInt32LE()) : null;
      if (!uint64(ink) || ink === target.windowId) return false;
    } catch { return false; }
    const { bounds, visible } = request;
    return new Promise(resolve => {
      let child;
      try { child = spawnHelper(helperPath, [request.checkOnly ? 'check' : 'place', target.windowId, String(target.pid), target.processStartedAt, ink, String(ownerPid),
        String(bounds.x), String(bounds.y), String(bounds.width), String(bounds.height), visible ? 'visible' : 'hidden'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }); }
      catch { resolve(false); return; }
      let settled = false, output = '';
      const timer = setTimeout(() => finish(false, true), timeoutMs);
      function finish(value, kill = false) {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (kill) { try { child.kill(); } catch { /* rejected */ } }
        resolve(value);
      }
      child.stdout?.setEncoding('utf8').on('data', chunk => {
        if (settled) return;
        output += chunk;
        if (output.length > 2048) finish(false, true);
      });
      child.once('error', () => finish(false, true));
      child.once('close', code => {
        try {
           const v = JSON.parse(output);
           const reportReadback = () => {
             if (!settled && !visible && !request.checkOnly && ['both', 'one', 'neither'].includes(v?.firstBoundaryReadback)) {
               try { request.onBoundaryReadback?.(v.firstBoundaryReadback); } catch { /* diagnostic only */ }
             }
           };
           if (!settled && code === 1 && refusals.has(v?.refusal)) {
             if (v.refusal.startsWith('order-readback-')) reportReadback();
             if (v.refusal === 'order-check-other' && typeof v.checkContext === 'string' &&
                 /^(?:target-above|target-below|unknown):(?:target|none|visible-other|hidden-other)$/.test(v.checkContext)) {
               try { request.onCheckContext?.(v.checkContext); } catch { /* diagnostic only */ }
             }
           try { onDiagnostic?.(v.refusal); } catch { /* diagnostic only */ }
            try { request.onDiagnostic?.(v.refusal); } catch { /* diagnostic only */ }
            if (v.refusal.startsWith('order-readback-unchanged-anchor-own-hidden-') && typeof v.orderContext === 'string' &&
              /^(?:no-anchor|topmost-anchor|ordinary-anchor):(?:target-above|target-below|not-in-range)$/.test(v.orderContext)) {
              try { request.onOrderContext?.(v.orderContext); } catch { /* diagnostic only */ }
            }
            if (v.refusal === 'target-position' && !canvas.isDestroyed()) { finish(TARGET_POSITION_STALE); return; }
            // DWM frame size is not the observer's actual window size. A
            // read-only check may see a resize before the watcher classifies it.
            if (v.refusal === 'target-size' && request.checkOnly && !canvas.isDestroyed()) { finish(TARGET_SIZE_UNCONFIRMED); return; }
             const [reason] = v.refusal.split(':', 1);
             if (reason === 'order-check-other' && v.checkContext === 'target-below:hidden-other' && request.checkOnly && request.visible && !canvas.isDestroyed()) { finish(HIDDEN_EXTERNAL_INTERPOSER); return; }
            if (reason === 'order-check-own-hidden' && request.checkOnly && !canvas.isDestroyed()) { finish(HIDDEN_HOST_NEIGHBOR); return; }
            if (reason === 'order-check-own-hidden-target-not-below' && request.checkOnly && !canvas.isDestroyed()) { finish(HIDDEN_HOST_TARGET_NOT_BELOW); return; }
            if (!request.checkOnly && !canvas.isDestroyed() && ((v.refusal.startsWith('order-readback-unchanged-anchor') && !request.visible) ||
              v.refusal === 'order-topmost-other-process')) { finish(PLACEMENT_ORDER_UNCONFIRMED); return; }
          }
           const verified = code === 0 && !canvas.isDestroyed() && v?.placed === true && v.hwnd === target.windowId &&
             v.pid === target.pid && v.processStartedAt === target.processStartedAt && v.ink === ink && v.ownerPid === ownerPid &&
             v.visible === visible && ['x', 'y', 'width', 'height'].every(k => v.bounds?.[k] === bounds[k]);
           if (!settled && verified && !visible && !request.checkOnly && v.boundaryWrite === true) {
             reportReadback();
             try { request.onBoundaryWrite?.(); } catch { /* diagnostic only */ }
           }
           finish(verified);
        } catch { finish(false); }
      });
    });
  };
}

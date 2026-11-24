import { spawn } from 'node:child_process';

const uint64 = v => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 0xffffffffffffffffn;
const pid = v => Number.isInteger(v) && v > 0 && v <= 0x7fffffff;
const rectangle = b => b && [b.x, b.y, b.width, b.height].every(Number.isInteger) &&
  [b.x, b.y].every(n => n >= -0x80000000 && n <= 0x7fffffff) && b.width > 0 && b.width <= 16384 && b.height > 0 && b.height <= 16384;

/** @param {{helperPath: string, ownerPid?: number, timeoutMs?: number,
 * spawnHelper?: (path: string, args: string[], options: {stdio: ['ignore', 'pipe', 'ignore'], windowsHide: boolean}) => {
 * stdout: import('node:stream').Readable | null, once: (event: string, listener: (...args: any[]) => void) => unknown, kill: () => boolean
 * }}} options */
export function createWindowsCanvasPlacement({ helperPath, ownerPid = process.pid, timeoutMs = 1000, spawnHelper = spawn }) {
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
          finish(code === 0 && !canvas.isDestroyed() && v?.placed === true && v.hwnd === target.windowId &&
            v.pid === target.pid && v.processStartedAt === target.processStartedAt && v.ink === ink && v.ownerPid === ownerPid &&
            v.visible === visible && ['x', 'y', 'width', 'height'].every(k => v.bounds?.[k] === bounds[k]));
        } catch { finish(false); }
      });
    });
  };
}

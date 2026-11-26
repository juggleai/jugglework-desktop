import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const SEMANTIC_OVERLAY_PROTOCOL_VERSION = 1;
export const semanticOverlayHelperPath = desktopRoot => resolve(desktopRoot, '.dev-helpers', 'semantic-overlay', 'MeetingSemanticOverlayWindows.exe');

const uint64 = value => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const pid = value => Number.isInteger(value) && value > 0 && value <= 0x7fffffff;
const session = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const utf8Bytes = value => Buffer.byteLength(value, 'utf8');
const point = value => Array.isArray(value) && value.length === 2 && value.every(number => Number.isFinite(number) && number >= 0 && number <= 1);
const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
const stroke = value => exact(value, ['color', 'size', 'highlight', 'points']) && color(value.color) && Number.isFinite(value.size) &&
  value.size > 0 && value.size <= 32 && typeof value.highlight === 'boolean' && Array.isArray(value.points) && value.points.length >= 1 &&
  value.points.length <= 256 && value.points.every(point);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const laser = value => exact(value, ['stroke', 'opacity']) && exact(value.stroke, ['id', 'color', 'size', 'highlight', 'points']) && id(value.stroke.id) &&
  stroke({ color: value.stroke.color, size: value.stroke.size, highlight: value.stroke.highlight, points: value.stroke.points }) &&
  value.stroke.highlight === false && Number.isFinite(value.opacity) && value.opacity >= 0 && value.opacity <= 1;
const element = value => value?.type === 'stroke'
  ? exact(value, ['type', 'id', 'color', 'size', 'highlight', 'points']) && id(value.id) && stroke({ color: value.color, size: value.size, highlight: value.highlight, points: value.points })
  : value?.type === 'shape' && exact(value, ['type', 'id', 'kind', 'color', 'size', 'x1', 'y1', 'x2', 'y2']) && id(value.id) &&
    ['rectangle', 'ellipse', 'arrow'].includes(value.kind) && color(value.color) && Number.isFinite(value.size) && value.size > 0 && value.size <= 32 &&
    [value.x1, value.y1, value.x2, value.y2].every(number => Number.isFinite(number) && number >= 0 && number <= 1);
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/**
 * Protocol-only adapter. The executable path is derived from the desktop root and cannot be supplied by a renderer request.
 * @param {{desktopRoot: string, parentProcessStartedAt: string, timeoutMs?: number,
 * spawnHelper?: (path: string, args: string[], options: {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: boolean}) => {
 *   stdin: import('node:stream').Writable | null, stdout: import('node:stream').Readable | null, stderr?: import('node:stream').Readable | null,
 *   once: (event: string, listener: (...args: any[]) => void) => unknown, kill: () => boolean
 * }, createSessionId?: () => string}} options
 */
export function createWindowsSemanticOverlay({ desktopRoot, parentProcessStartedAt, timeoutMs = 1000,
  spawnHelper = spawn, createSessionId = () => randomBytes(18).toString('base64url') }) {
  const helperPath = semanticOverlayHelperPath(desktopRoot);
  let generation = 0;
  let disposeCurrent = null;

  /** @param {{windowId: string, pid: number, processStartedAt: string}} target */
  async function open(target) {
    if (disposeCurrent) await disposeCurrent();
    const currentGeneration = ++generation;
    const sessionId = createSessionId();
    if (!uint64(target?.windowId) || !pid(target?.pid) || !uint64(target?.processStartedAt) ||
        !pid(process.pid) || !uint64(parentProcessStartedAt) || !session(sessionId)) return null;
    let child;
    try {
      child = spawnHelper(helperPath, ['overlay', target.windowId, String(target.pid), target.processStartedAt,
        String(process.pid), parentProcessStartedAt, sessionId], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch { return null; }
    let active = true, ready = false, epoch = 0, seq = 0, inputSeq = 0, eventSeq = 0, buffer = '', pending = null, childClosed = false;
    let startupDiagnostic, stderrBuffer = '';
    let closeResolve; const childClose = new Promise(resolveClose => { closeResolve = resolveClose; });
    const inputListeners = new Set(), stateListeners = new Set(), exitListeners = new Set();
    let helloResolve;
    const hello = new Promise(resolveHello => { helloResolve = resolveHello; });
    const helloTimer = setTimeout(() => fail('timeout'), timeoutMs);

    function current() { return active && generation === currentGeneration; }
    function finishPending(value) { if (!pending) return; clearTimeout(pending.timer); const resolvePending = pending.resolve; pending = null; resolvePending(value); }
    function fail(reason) {
      if (!active) return;
      active = false; clearTimeout(helloTimer); helloResolve?.(false); helloResolve = null; finishPending({ ok: false, reason });
      for (const listener of exitListeners) { try { listener(reason); } catch {} }
      inputListeners.clear(); stateListeners.clear(); exitListeners.clear();
      try { child.stdin?.end(); } catch { /* already failed */ }
      try { child.kill(); } catch { /* already failed */ }
    }
    function accept(value) {
      if (!current()) return;
      if (!ready) {
        if (!exact(value, ['type', 'version', 'sessionId', 'epoch', 'capabilities']) || value.type !== 'hello' ||
            value.version !== 1 || value.sessionId !== sessionId || !integer(value.epoch) ||
             !Array.isArray(value.capabilities) || value.capabilities.join(',') !== 'mode,scene,preview,lasers,pointer,state,abort,close') { fail('invalid-hello'); return; }
        ready = true; epoch = value.epoch; clearTimeout(helloTimer); helloResolve?.(true); helloResolve = null; return;
      }
      if (value?.type === 'pointer') {
        const valid = exact(value, ['type', 'version', 'sessionId', 'epoch', 'inputSeq', 'phase', 'points']) && value.version === 1 &&
          value.sessionId === sessionId && integer(value.epoch) && Number.isSafeInteger(value.inputSeq) && value.inputSeq === inputSeq + 1 &&
          ['down', 'move', 'up', 'cancel'].includes(value.phase) && Array.isArray(value.points) && value.points.length <= 64 &&
          value.points.every(point) && (value.phase === 'cancel' ? value.points.length === 0 : value.points.length > 0) && value.epoch >= epoch;
        if (!valid) { fail('invalid-pointer'); return; }
        inputSeq = value.inputSeq; epoch = value.epoch;
        const batch = { sessionId, epoch, inputSeq, phase: value.phase, points: value.points.map(([x, y]) => ({ x, y })) };
        for (const listener of inputListeners) { try { listener(batch); } catch { /* listener isolation */ } }
        return;
      }
      if (value?.type === 'state' && Object.hasOwn(value, 'eventSeq')) {
        const valid = exact(value, ['type', 'version', 'sessionId', 'eventSeq', 'epoch', 'state', 'mode', 'input', 'visible', 'strokeCount', 'pointCount']) &&
          value.version === 1 && value.sessionId === sessionId && Number.isSafeInteger(value.eventSeq) && value.eventSeq === eventSeq + 1 &&
          integer(value.epoch) && value.epoch >= epoch && ['active', 'minimized', 'resized', 'unknown', 'closed', 'unsupported-dpi'].includes(value.state) &&
          ['pointer', 'draw'].includes(value.mode) && typeof value.input === 'boolean' && typeof value.visible === 'boolean' &&
          integer(value.strokeCount) && integer(value.pointCount);
        if (!valid) { fail('invalid-state-event'); return; }
        eventSeq = value.eventSeq; epoch = value.epoch;
        for (const listener of stateListeners) { try { listener(value); } catch { /* listener isolation */ } }
        return;
      }
      if (!pending || value?.version !== 1 || value?.sessionId !== sessionId || value?.seq !== pending.seq || !integer(value.epoch)) {
        fail('unexpected-output'); return;
      }
      if (value.type === 'error' && exact(value, ['type', 'version', 'sessionId', 'seq', 'epoch', 'code']) &&
          ['invalid-json', 'line-too-large', 'invalid-envelope', 'wrong-session', 'stale-seq', 'wrong-epoch', 'stale-laser-revision', 'invalid-command'].includes(value.code)) {
        if (value.epoch < epoch) { fail('epoch-regression'); return; }
        epoch = value.epoch;
        finishPending({ ok: false, reason: value.code, retryable: value.code === 'wrong-epoch' }); return;
      }
      const ack = value.type === 'ack' && exact(value, ['type', 'version', 'sessionId', 'seq', 'epoch', 'command']) && value.command === pending.command;
      const state = value.type === 'state' && exact(value, ['type', 'version', 'sessionId', 'seq', 'epoch', 'state', 'mode', 'input', 'visible', 'strokeCount', 'pointCount']) &&
         ['active', 'minimized', 'resized', 'unknown', 'closed', 'unsupported-dpi'].includes(value.state) && ['pointer', 'draw'].includes(value.mode) &&
        typeof value.input === 'boolean' && typeof value.visible === 'boolean' && integer(value.strokeCount) && integer(value.pointCount);
      if (!ack && !state) { fail('invalid-output'); return; }
      if (value.epoch < epoch) { fail('epoch-regression'); return; }
      epoch = value.epoch; finishPending({ ok: true, value });
      if (ack && value.command === 'close') active = false;
    }
    child.stdout?.setEncoding('utf8').on('data', chunk => {
      if (!current()) return;
      buffer += chunk;
      while (current()) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        if (utf8Bytes(buffer.slice(0, end)) > 65536) { fail('output-too-large'); return; }
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let value; try { value = JSON.parse(line); } catch { fail('invalid-json'); return; }
        accept(value);
      }
      if (utf8Bytes(buffer) > 65536) fail('output-too-large');
    });
    child.stderr?.setEncoding('utf8').on('data', chunk => {
      if (ready || stderrBuffer.length > 256) return;
      stderrBuffer += chunk;
      const match = stderrBuffer.match(/startup-refused:(target-dpi|unsupported-dpi|target-identity|target-frame|parent-identity|window-create|surface-create)/);
      if (match) startupDiagnostic = match[1];
    });
    child.once('error', () => fail('helper-error'));
    child.once('close', () => { childClosed = true; closeResolve(); fail(startupDiagnostic ? `startup-${startupDiagnostic}` : 'helper-exit'); });

    function send(command, fields = {}) {
      if (!current() || !ready || pending) return Promise.resolve({ ok: false, reason: 'unavailable' });
      const requestSeq = ++seq;
      return new Promise(resolveRequest => {
        const timer = setTimeout(() => fail('timeout'), timeoutMs);
        pending = { seq: requestSeq, command, timer, resolve: resolveRequest };
        const line = JSON.stringify({ version: 1, sessionId, seq: requestSeq, expectedEpoch: epoch, command, ...fields });
        if (utf8Bytes(line) > 65536) { clearTimeout(timer); pending = null; resolveRequest({ ok: false, reason: 'line-too-large' }); return; }
        try { child.stdin.write(`${line}\n`); }
        catch { fail('helper-error'); }
      });
    }
    const handle = {
      generation: currentGeneration, sessionId, hello,
      getFailureReason: () => startupDiagnostic ? `startup-${startupDiagnostic}` : undefined,
      setMode: (mode, style) => mode === 'pointer' && style === undefined ? send('mode', { mode }) : mode === 'draw' &&
        exact(style, ['tool', 'color', 'size', 'highlight']) && ['laser', 'pen', 'highlighter', 'rectangle', 'ellipse', 'arrow', 'eraser'].includes(style.tool) &&
        color(style.color) && Number.isFinite(style.size) && style.size > 0 && style.size <= 32 && typeof style.highlight === 'boolean' &&
        style.highlight === (style.tool === 'highlighter') ? send('mode', { mode, ...style }) : Promise.resolve({ ok: false, reason: 'invalid-request' }),
      setScene: scene => exact(scene, ['elements']) && Array.isArray(scene.elements) && scene.elements.length <= 128 && scene.elements.every(element) &&
        new Set(scene.elements.map(item => item.id)).size === scene.elements.length &&
        scene.elements.reduce((count, item) => count + (item.type === 'stroke' ? item.points.length : 2), 0) <= 4096
        ? send('scene', scene) : Promise.resolve({ ok: false, reason: 'invalid-request' }),
      setPreview: value => exact(value, ['previewRevision', 'epoch', 'hiddenElementIds']) && Number.isSafeInteger(value.previewRevision) && value.previewRevision > 0 &&
        Number.isSafeInteger(value.epoch) && value.epoch === epoch && Array.isArray(value.hiddenElementIds) && value.hiddenElementIds.length <= 128 &&
        value.hiddenElementIds.every(id) && new Set(value.hiddenElementIds).size === value.hiddenElementIds.length
        ? send('preview', value) : Promise.resolve({ ok: false, reason: 'invalid-request' }),
      setLasers: value => exact(value, ['laserRevision', 'epoch', 'lasers']) && Number.isSafeInteger(value.laserRevision) && value.laserRevision > 0 &&
        Number.isSafeInteger(value.epoch) && value.epoch === epoch && Array.isArray(value.lasers) && value.lasers.length <= 32 && value.lasers.every(laser) &&
        new Set(value.lasers.map(item => item.stroke.id)).size === value.lasers.length && value.lasers.reduce((count, item) => count + item.stroke.points.length, 0) <= 4096
        ? send('lasers', value) : Promise.resolve({ ok: false, reason: 'invalid-request' }),
      onInput(listener) { if (typeof listener !== 'function' || !active) return () => {}; inputListeners.add(listener); return () => inputListeners.delete(listener); },
      onState(listener) { if (typeof listener !== 'function' || !active) return () => {}; stateListeners.add(listener); return () => stateListeners.delete(listener); },
      onExit(listener) { if (typeof listener !== 'function' || !active) return () => {}; exitListeners.add(listener); return () => exitListeners.delete(listener); },
      abort: () => send('abort'),
      query: () => send('state'),
      async close() {
        const result = await send('close');
        if (!result.ok) fail(result.reason ?? 'close-failed');
        return result;
      },
      async dispose() {
        if (handle.disposeResult) return handle.disposeResult;
        active = false; inputListeners.clear(); stateListeners.clear(); exitListeners.clear(); clearTimeout(helloTimer); helloResolve?.(false); helloResolve = null;
        finishPending({ ok: false, reason: 'disposed' });
        try { child.stdout?.resume?.(); } catch {}
        try { child.stdin?.end(); } catch {}
        const exited = await Promise.race([childClose.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), timeoutMs))]);
        if (exited || childClosed) return (handle.disposeResult = { exited: true, killed: false, timedOut: false });
        let killed = false; try { killed = child.kill() !== false; } catch {}
        const killedExit = await Promise.race([childClose.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), Math.min(timeoutMs, 250)))]);
        return (handle.disposeResult = { exited: killedExit || childClosed, killed, timedOut: true });
      },
    };
    disposeCurrent = handle.dispose;
    return handle;
  }
  return { helperPath, open };
}

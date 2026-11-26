// Dedicated Windows fixture. No product gate, real input, desktop capture or external HWND.
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { holdApp, trackChild, waitForClose, finishChild, motionVerdict, expectedRejection } = require('./meeting-window-validation-lifetime.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const out = value => console.log(JSON.stringify(value));

async function until(fn, ms = 3000) {
  const start = performance.now();
  while (performance.now() - start < ms) { const value = fn(); if (value) return value; await delay(10); }
  throw new Error('condition-timeout');
}
function assert(ok, stage, detail = {}) {
  out({ stage, pass: Boolean(ok), ...detail });
  if (!ok) throw new Error(stage);
}

async function run(app, BrowserWindow, screen, helperPath) {
  const release = holdApp(app); // Installed before any BrowserWindow can be destroyed.
  const records = []; const stops = new Set(); const windows = new Set();
  let failed = false, cleanupConfirmed = true;
  const start = performance.now();
  const trackedSpawn = (p, args, options) => {
    const child = spawn(p, args, options);
    const record = trackChild(child, p === helperPath ? 'helper' : 'target');
    record.operation = p === helperPath ? args[0] : 'target';
    records.push(record); return child;
  };
  const recordOf = child => records.find(record => record.child === child);
  try {
    const { createWindowsWindowIdentity } = await import(pathToFileURL(path.resolve(__dirname, '../electron/meeting-window-identity-windows.mjs')));
    const { createWindowsCanvasPlacement } = await import(pathToFileURL(path.resolve(__dirname, '../electron/meeting-window-placement-windows.mjs')));
    out({ stage: 'environment', electron: process.versions.electron, chromium: process.versions.chrome,
      displays: screen.getAllDisplays().map(display => ({ bounds: display.bounds, scaleFactor: display.scaleFactor })) });
    const identityAdapter = createWindowsWindowIdentity({ helperPath, spawnHelper: trackedSpawn });
    const placement = createWindowsCanvasPlacement({ helperPath, spawnHelper: trackedSpawn,
      onDiagnostic: reason => out({ stage: 'placement-diagnostic', reason }) });
    async function rejectPlacement(canvas, target, request, stage) {
      const before = records.length;
      const accepted = await placement(canvas, target, request);
      const record = records[before];
      assert(!accepted && record && records.length === before + 1 && expectedRejection(record), stage,
        { nativeRefusal: Boolean(record && expectedRejection(record)) });
    }
    for (const mode of ['window-close', 'process-exit']) {
      const messages = [];
      const child = trackedSpawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'meeting-window-validation-target.ps1')],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.stdin.on('error', () => {});
      recordOf(child).messages = messages;
      createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)); } catch { /* reject by bounded wait */ } });
      const ready = await until(() => messages.find(value => value.type === 'ready'), 10000);
      async function targetAck(action) {
        const mark = messages.length;
        child.stdin.write(action + '\n');
        return (await until(() => messages.slice(mark).find(value => value.type === 'ack' && value.action === action))).ok === true;
      }
      async function boundaryState() {
        const mark = messages.length;
        child.stdin.write('boundary-check\n');
        const { topmostAbove, sentinelAbove } = await until(() => messages.slice(mark).find(value => value.type === 'boundary-state'));
        return { topmostAbove: topmostAbove === true, sentinelAbove: sentinelAbove === true };
      }
      let at = performance.now();
      const identity = await identityAdapter.resolveWindowsIdentity(ready.hwnd);
      assert(identity, 'inspect', { mode, latencyMs: Math.round(performance.now() - at) });
      const target = { platform: 'win32', windowId: ready.hwnd, ...identity };
      let samples, stop, watchRecord, diagnostics;
      function watch() {
        samples = []; diagnostics = [];
        stop = identityAdapter.watchWindow(target, sample => samples.push({ ...sample, time: performance.now() }), reason => {
          diagnostics.push(reason); out({ stage: 'watch-diagnostic', mode, reason });
        });
        stops.add(stop); watchRecord = records.at(-1);
      }
      async function stopWatch() {
        stop(); stops.delete(stop);
        assert(await waitForClose(watchRecord), 'watch-stop-confirmed', { mode, code: watchRecord.code, signal: watchRecord.signal });
      }
      async function command(action, predicate) {
        const sampleIndex = samples.length, messageIndex = messages.length, at = performance.now();
        child.stdin.write(action + '\n');
        await until(() => messages.slice(messageIndex).find(value => value.action === action && value.ok));
        const sample = await until(() => samples.slice(sampleIndex).find(predicate));
        out({ stage: action, mode, pass: true, latencyMs: Math.round(performance.now() - at), status: sample.status,
          ...(sample.bounds ? { bounds: sample.bounds, actualSize: sample.actualSize } : {}) });
        return sample;
      }
      watch();
      let current = await until(() => samples.find(sample => sample.status === 'visible'));
      assert(current.actualSize.width === 656 && current.actualSize.height === 439, 'initial-visible', { mode, bounds: current.bounds, actualSize: current.actualSize });
      if (mode === 'window-close') {
        const initial = current;
        current = await command('move', sample => sample.status === 'visible' && sample.bounds.x === initial.bounds.x + 24 && sample.actualSize.width === 656 && sample.actualSize.height === 439);
        current = await command('width', sample => sample.status === 'visible' && sample.actualSize.width === 704 && sample.actualSize.height === 439);
        current = await command('height', sample => sample.status === 'visible' && sample.actualSize.width === 704 && sample.actualSize.height === 471);
        const canvas = new BrowserWindow({ ...current.bounds, show: false, frame: false, transparent: true, focusable: false,
          skipTaskbar: true, resizable: false, hasShadow: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        windows.add(canvas); canvas.setIgnoreMouseEvents(true);
        for (let n = 0; n < 3; n++) {
          canvas.hide(); canvas.setBounds(current.bounds);
          at = performance.now();
          assert((await placement(canvas, target, { bounds: current.bounds, visible: false })) === true, 'place-hidden', { iteration: n + 1, latencyMs: Math.round(performance.now() - at) });
          canvas.showInactive(); at = performance.now();
          assert((await placement(canvas, target, { bounds: current.bounds, visible: true })) === true, 'place-visible', { iteration: n + 1, latencyMs: Math.round(performance.now() - at) });
          at = performance.now();
          assert((await placement(canvas, target, { bounds: current.bounds, visible: true, checkOnly: true })) === true, 'check-visible', { iteration: n + 1, latencyMs: Math.round(performance.now() - at) });
        }
        await rejectPlacement(canvas, { ...target, pid: identity.pid + 1 }, { bounds: current.bounds, visible: true }, 'reject-wrong-pid');
        await rejectPlacement(canvas, target, { bounds: { ...current.bounds, width: current.bounds.width + 1 }, visible: true }, 'reject-wrong-geometry');
        canvas.hide();
        if (process.argv.includes('--sync-sample-control')) {
          const mark = messages.length;
          assert(await targetAck('sync-sample'), 'sync-sample-cleanup');
          const { knownBelow, belowNeither, adjacent, both, one, neither, unchanged, noWriteMessages, displaced, displacedNeither,
            suppressedCall, suppressedStillBelow, suppressedChanging, suppressedChanged, bypassAdjacent, bypassChanging, bypassBoth } =
            await until(() => messages.slice(mark).find(value => value.type === 'sync-sample-result'));
          assert(knownBelow && belowNeither > 0 && adjacent && both > 0 && unchanged && noWriteMessages === 0 && displaced && displacedNeither > 0,
            'sync-sample-control', { knownBelow, belowNeither, adjacent, both, one, neither, unchanged, noWriteMessages, displaced, displacedNeither });
          assert(suppressedCall && suppressedStillBelow && suppressedChanging === 1 && suppressedChanged === 0,
            'sync-sample-noop', { suppressedCall, suppressedStillBelow, suppressedChanging, suppressedChanged });
          assert(bypassAdjacent && bypassChanging === 0 && bypassBoth > 0,
            'sync-sample-noop-contrast', { bypassAdjacent, bypassChanging, bypassBoth });
        }
        if (process.argv.includes('--boundary-control')) {
          assert(await targetAck('boundary-start'), 'boundary-start');
          try {
            const positionMessages = { changing: 0, changed: 0 };
            canvas.hookWindowMessage(0x0046, () => { positionMessages.changing++; });
            canvas.hookWindowMessage(0x0047, () => { positionMessages.changed++; });
            const delta = before => ({ changing: positionMessages.changing - before.changing, changed: positionMessages.changed - before.changed });
            const boundaryBefore = await boundaryState();
            let reason, orderContext, firstBoundaryReadback, boundaryWrite = false;
            const beforeWrite = { ...positionMessages };
            const placed = boundaryBefore.topmostAbove && await placement(canvas, target, { bounds: current.bounds, visible: false,
              onDiagnostic: value => { reason = value; }, onOrderContext: value => { orderContext = value; },
              onBoundaryReadback: value => { firstBoundaryReadback = value; },
              onBoundaryWrite: () => { boundaryWrite = true; } });
            const writeMessages = delta(beforeWrite);
            const boundaryAfter = await boundaryState();
            let visibleVerified = false;
            let noWriteVerified = false, noWriteMessages;
            if (placed === true) {
              const beforeNoWrite = { ...positionMessages };
              let unexpectedBoundaryWrite = false;
              noWriteVerified = await placement(canvas, target, { bounds: current.bounds, visible: false,
                onBoundaryWrite: () => { unexpectedBoundaryWrite = true; } }) === true && !unexpectedBoundaryWrite;
              noWriteMessages = delta(beforeNoWrite);
              canvas.showInactive();
              visibleVerified = await placement(canvas, target, { bounds: current.bounds, visible: true, checkOnly: true }) === true;
            }
            out({ stage: 'boundary-control', boundaryBefore, boundaryAfter, boundaryWrite, hiddenVerified: placed === true, visibleVerified, reason, orderContext, firstBoundaryReadback,
              writeMessages, noWriteVerified, noWriteMessages });
            if (!boundaryBefore.topmostAbove || !boundaryWrite || placed !== true || !noWriteVerified || !visibleVerified) failed = true;
          } finally {
            canvas.unhookWindowMessage(0x0046);
            canvas.unhookWindowMessage(0x0047);
            canvas.hide();
            assert(await targetAck('boundary-stop'), 'boundary-stop');
          }
        }
        if (process.argv.includes('--check-context-control')) {
          const index = process.argv.indexOf('--fixture-adjacency-koffi');
          if (index < 0 || !path.isAbsolute(process.argv[index + 1])) throw new Error('fixture-ffi-required');
          const k = require(process.argv[index + 1]);
          const u = k.load('user32.dll');
          const get = u.func('uintptr_t GetWindow(uintptr_t hwnd, uint32_t cmd)');
          const pidOf = u.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
          const pos = u.func('int32_t SetWindowPos(uintptr_t hwnd, uintptr_t after, int32_t x, int32_t y, int32_t w, int32_t h, uint32_t flags)');
          const ink = canvas.getNativeWindowHandle().readBigUInt64LE(), handle = BigInt(target.windowId);
          async function rejectContext(expected) {
            let reason, context;
            const accepted = await placement(canvas, target, { bounds: current.bounds, visible: true, checkOnly: true,
              onDiagnostic: value => { reason = value; }, onCheckContext: value => { context = value; } });
            assert(accepted === false && reason === 'order-check-other' && context === expected,
              'check-context-control', { expected, reason, context, refused: accepted === false });
          }
          canvas.showInactive();
          assert(await targetAck('cover-start'), 'context-cover-start');
          try {
            const mark = messages.length;
            assert(await targetAck('cover-identity'), 'context-cover-identity');
            const cover = BigInt((await until(() => messages.slice(mark).find(v => v.type === 'cover-identity'))).hwnd);
            const owner = [0]; pidOf(cover, owner);
            assert(cover !== ink && owner[0] === target.pid, 'context-owned-anchor');
            // Reorder only the three fixture-owned windows into two known
            // ordinary-band stacks. No application window is moved.
            assert(Boolean(pos(cover, 0, 0, 0, 0, 0, 0x0213)) && Boolean(pos(handle, cover, 0, 0, 0, 0, 0x0213)) &&
              Boolean(pos(ink, 0, 0, 0, 0, 0, 0x0213)) && BigInt(get(ink, 2)) === cover && BigInt(get(cover, 2)) === handle,
              'context-interposer-setup');
            await rejectContext('target-below:visible-other');
            assert(Boolean(pos(handle, 0, 0, 0, 0, 0, 0x0213)), 'context-target-activate');
            assert(BigInt(get(handle, 2)) === ink && BigInt(get(ink, 2)) === cover, 'context-target-above-setup');
            await rejectContext('target-above:visible-other');
          } finally { assert(await targetAck('cover-stop'), 'context-cover-stop'); canvas.hide(); }
        }
        await command('minimize', sample => sample.status === 'minimized');
        await rejectPlacement(canvas, target, { bounds: current.bounds, visible: false }, 'reject-minimized');
        current = await command('restore', sample => sample.status === 'visible' && sample.actualSize.width === 704 && sample.actualSize.height === 471);
        canvas.destroy(); windows.delete(canvas);
        let motionSize = { width: 704, height: 471 };
        if (process.argv.includes('--dynamic-follow')) {
          await stopWatch();
          const { validateFollow } = require('./meeting-window-validation-follow.cjs');
          const manual = process.argv.includes('--follow-manual');
          const manualSmoke = process.argv.includes('--follow-manual-smoke');
          const activationControl = manualSmoke && process.argv.includes('--follow-activation-control');
          const boundaryActivation = activationControl && process.argv.includes('--follow-boundary-activation');
          const preactivationControl = (manual || manualSmoke) && process.argv.includes('--follow-preactivated-pointer');
          const activationObservation = (manual || manualSmoke) && process.argv.includes('--follow-observe-activation');
          const ffiIndex = process.argv.indexOf('--fixture-adjacency-koffi');
          const hostWrite = process.argv.includes('--fixture-host-boundary-write');
          if (hostWrite && ffiIndex < 0) throw new Error('fixture-ffi-required');
          if (hostWrite && (!(manual || manualSmoke) || !process.argv.includes('--follow-pointer-only'))) throw new Error('fixture-pointer-mode-required');
          let sampleAdjacency, writeHostBoundary;
          if (ffiIndex >= 0) {
            const modulePath = process.argv[ffiIndex + 1];
            if (process.arch !== 'x64' || !modulePath || !path.isAbsolute(modulePath)) throw new Error('invalid-fixture-ffi-path');
            const koffi = require(modulePath);
            const user32 = koffi.load('user32.dll');
            const getWindow = user32.func('uintptr_t GetWindow(uintptr_t hwnd, uint32_t cmd)');
            // Scope is the runner's child-created target and its own canvas.
            const targetHandle = BigInt(target.windowId);
            sampleAdjacency = canvas => {
              const next = BigInt(getWindow(canvas, 2)) === targetHandle;
              const previous = BigInt(getWindow(targetHandle, 3)) === canvas;
              return next && previous ? 'both' : next || previous ? 'one' : 'neither';
            };
            if (hostWrite) {
              const style = user32.func('int32_t GetWindowLongW(uintptr_t hwnd, int32_t index)');
              const visibility = user32.func('int32_t IsWindowVisible(uintptr_t hwnd)');
              const iconic = user32.func('int32_t IsIconic(uintptr_t hwnd)');
              const dpi = user32.func('uint32_t GetDpiForWindow(uintptr_t hwnd)');
              const root = user32.func('uintptr_t GetAncestor(uintptr_t hwnd, uint32_t flags)');
              const thread = user32.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
              const currentThread = koffi.load('kernel32.dll').func('uint32_t GetCurrentThreadId()');
              const rect = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
              const getRect = user32.func('GetWindowRect', 'int32_t', ['uintptr_t', koffi.out(koffi.pointer(rect))]);
              const getFrame = koffi.load('dwmapi.dll').func('DwmGetWindowAttribute', 'int32_t',
                ['uintptr_t', 'uint32_t', koffi.out(koffi.pointer(rect)), 'uint32_t']);
              const setPos = user32.func('int32_t SetWindowPos(uintptr_t hwnd, uintptr_t after, int32_t x, int32_t y, int32_t cx, int32_t cy, uint32_t flags)');
              writeHostBoundary = (win, bounds) => {
                if (win.isDestroyed() || !windows.has(win) || recordOf(child).exited) return 'refused';
                const ink = win.getNativeWindowHandle().readBigUInt64LE();
                const canvasPid = [0], targetPid = [0];
                const canvasRect = {}, targetRect = {};
                const exact = r => r.left === bounds.x && r.top === bounds.y && r.right === bounds.x + bounds.width && r.bottom === bounds.y + bounds.height;
                if (ink === targetHandle || thread(ink, canvasPid) !== currentThread() || canvasPid[0] !== process.pid ||
                    !thread(targetHandle, targetPid) || targetPid[0] !== target.pid ||
                    BigInt(root(ink, 2)) !== ink || BigInt(root(targetHandle, 2)) !== targetHandle ||
                    visibility(ink) || !visibility(targetHandle) || iconic(targetHandle) ||
                    dpi(ink) !== 96 || dpi(targetHandle) !== 96 || (style(ink, -20) & 8) || (style(targetHandle, -20) & 8) ||
                    !getRect(ink, canvasRect) || getFrame(targetHandle, 9, targetRect, 16) !== 0 || !exact(canvasRect) || !exact(targetRect)) return 'refused';
                const above = BigInt(getWindow(targetHandle, 3));
                if (!above || !(style(above, -20) & 8)) return 'not-boundary';
                if (BigInt(getWindow(targetHandle, 3)) !== above) return 'refused';
                // Move only the runner's hidden canvas. No notification flags changed.
                return setPos(ink, 0, 0, 0, 0, 0, 0x0213) ? 'written' : 'refused';
              };
            }
          }
          if (activationControl && preactivationControl) throw new Error('conflicting-activation-controls');
          const inputWindowSeconds = manualSmoke && !process.argv.includes('--follow-full-window') ? 1 : 8;
          const coverControl = process.argv.includes('--follow-cover-control');
          const corner = process.argv.includes('--follow-bottom-right-resize');
          if (corner && process.argv.includes('--follow-right-edge-resize')) throw new Error('conflicting-resize-axes');
          const edgeResize = corner || process.argv.includes('--follow-right-edge-resize');
          const reopen = process.argv.includes('--follow-resize-reopen');
          if (reopen && !edgeResize) throw new Error('fixture-resize-required');
          if (edgeResize && (!preactivationControl || coverControl || !process.argv.includes('--follow-pointer-only'))) throw new Error('fixture-preactivated-edge-required');
          if (coverControl && (!(manualSmoke || manual) || activationControl || preactivationControl || !process.argv.includes('--follow-pointer-only'))) throw new Error('fixture-cover-mode-required');
          async function activateTarget() {
            const activated = await targetAck(boundaryActivation ? 'boundary-start' : 'activate');
            out({ stage: 'activation-control', activated, ...(boundaryActivation ? await boundaryState() : {}) });
            if (!activated) throw new Error('activation-control-refused');
          }
          const result = await validateFollow({ BrowserWindow, screen, target, watchWindow: identityAdapter.watchWindow, place: placement, writeHostBoundary, until, windows,
            detachedToolbar: process.argv.includes('--follow-detached-toolbar'),
            stableFocusable: process.argv.includes('--follow-stable-focusable'),
            injectHiddenNeighbor: process.argv.includes('--follow-hidden-neighbor'),
            observeCanvasPlacement: process.argv.includes('--follow-observe-canvas-placement'),
            sampleAdjacency,
            inspectTools: process.argv.includes('--follow-tools') || manual || manualSmoke,
            focusToolbarBeforeTool: process.argv.includes('--follow-toolbar-focus'),
            manualInput: (manual || manualSmoke) ? {
               interactive: manual && !manualSmoke, activationControl, manualSmoke,
               reopen,
               corner,
               edgeResize: edgeResize ? async () => {
                 if (!await targetAck(manualSmoke ? 'resize-observe' : corner ? 'corner-guide' : 'resize-guide')) throw new Error('edge-guide-refused');
                 if (manualSmoke) {
                   if (!await targetAck(corner ? 'both-axes' : 'width')) throw new Error('edge-self-resize-refused');
                 } else {
                   out({ stage: 'edge-input', seconds: 8, action: corner ? 'drag-bottom-right-outward' : 'drag-right-edge-outward' });
                   await delay(8000);
                 }
                 const mark = messages.length;
                 if (!await targetAck('resize-state')) throw new Error('edge-state-refused');
                 const { enter, exit, right, bottomRight, width, height } = await until(() => messages.slice(mark).find(value => value.type === 'resize-state'));
                 if (![enter, exit, right, bottomRight, width, height].every(v => Number.isSafeInteger(v) && v >= 0) || !width || !height) throw new Error('invalid-edge-state');
                 motionSize = { width, height };
                 return { enter, exit, right, bottomRight, width, height };
               } : undefined,
               coverControl: coverControl ? {
                 command: targetAck,
                 async wait() {
                   out({ stage: 'cover-input', seconds: manualSmoke ? 1 : 8, action: manualSmoke ? 'no-input' : 'click-cover-three-times' });
                   if (!manualSmoke && !await targetAck('cover-guide')) throw new Error('cover-guide-refused');
                   await delay(manualSmoke ? 1000 : 8000);
                 },
                 async state() {
                   const mark = messages.length;
                   if (!await targetAck('cover-check')) throw new Error('cover-state-refused');
                   const { ordinary, coveredHitsCover, coveredHitsTarget, clearHitsTarget, coverClicks, targetClicks } =
                     await until(() => messages.slice(mark).find(value => value.type === 'cover-state'));
                   return { ordinary, coveredHitsCover, coveredHitsTarget, clearHitsTarget, coverClicks, targetClicks };
                 },
               } : undefined,
              preactivate: preactivationControl ? activateTarget : undefined,
              observeActivation: activationObservation ? {
                async start() {
                  const start = messages.length;
                  child.stdin.write('activation-observe-start\n');
                  await until(() => messages.slice(start).some(value => value.type === 'ack' && value.action === 'activation-observe-start' && value.ok));
                },
                async stop() {
                  const start = messages.length;
                  child.stdin.write('activation-observe-stop\n');
                  const { mouseActivate, active, clickActive, inactive, zOrder } = await until(() => messages.slice(start).find(value => value.type === 'activation-observed'));
                  const counts = { mouseActivate, active, clickActive, inactive, zOrder };
                  if (!Object.values(counts).every(value => Number.isSafeInteger(value) && value >= 0) || clickActive > active) throw new Error('invalid-activation-counts');
                  return counts;
                },
              } : undefined,
              async targetIsForeground() {
                const start = messages.length;
                child.stdin.write('foreground-check\n');
                return (await until(() => messages.slice(start).find(value => value.type === 'ack' && value.action === 'foreground-check'))).ok === true;
              },
              focusControl: activationControl && process.argv.includes('--follow-pen-focus-control'),
              pointerOnly: process.argv.includes('--follow-pointer-only'),
              async countTarget() {
                const start = messages.length;
                child.stdin.write('input-count\n');
                return (await until(() => messages.slice(start).find(value => value.type === 'input-count'))).clicks;
              },
              async prompt(tool) {
                out({ stage: 'manual-input', tool, seconds: inputWindowSeconds, action: manualSmoke ? 'no-input' : 'click-marker-three-times' });
                if (activationControl) {
                  await activateTarget();
                  const staggered = process.argv.includes('--follow-staggered-raise');
                  if (staggered || process.argv.includes('--follow-raise-burst')) {
                    for (const [step, interval] of (staggered ? [35, 115, 250, 500] : [50, 50, 50]).entries()) {
                      await delay(interval);
                      const mark = messages.length;
                      child.stdin.write('raise-own\n');
                      const raised = await until(() => messages.slice(mark).find(value => value.type === 'ack' && value.action === 'raise-own'));
                      out({ stage: 'raise-control', step: step + 1, raised: raised.ok });
                      if (!raised.ok) throw new Error('raise-control-refused');
                    }
                  }
                }
                await delay(inputWindowSeconds * 1000);
              },
              async showTargetGuide(visible) {
                const start = messages.length;
                const action = !visible ? 'clear-guide' : manualSmoke ? 'no-input-guide' : 'pointer-guide';
                child.stdin.write(action + '\n');
                await until(() => messages.slice(start).some(value => value.type === 'ack' && value.action === action && value.ok));
              },
            } : undefined,
            resizeTarget: async () => {
              const start = messages.length;
              child.stdin.write('width\n');
              await until(() => messages.slice(start).some(value => value.action === 'width' && value.ok));
            },
            runMotion: async () => {
              const start = messages.length;
              if (process.argv.includes('--follow-discrete')) {
                child.stdin.write('move\n');
                await until(() => messages.slice(start).some(value => value.action === 'move' && value.ok));
                return { x: 24, y: 16 };
              }
              child.stdin.write('motion\n');
              await until(() => messages.slice(start).some(value => value.type === 'motion-done'), 10000);
              return { x: 50, y: 0 };
            } });
          out({ stage: 'dynamic-follow', ...result });
          if (boundaryActivation) assert(await targetAck('boundary-stop'), 'boundary-stop');
          if (!result.pass) failed = true;
          if (result.resizeApplied) motionSize = { width: 752, height: 471 };
          watch(); await until(() => samples.find(sample => sample.status === 'visible'));
        }
        // Stress mode is synthetic high-frequency self-motion, never real input.
        const stress = process.argv.includes('--motion-stress');
        for (let iteration = 0; iteration < (stress ? 5 : 1); iteration++) {
          if (iteration > 0) { watch(); await until(() => samples.find(sample => sample.status === 'visible')); }
          const motionStart = samples.length, messageStart = messages.length;
          child.stdin.write(stress ? 'motion-fast\n' : 'motion\n');
          await until(() => messages.slice(messageStart).find(value => value.type === 'motion-done'), 10000);
          const completedAt = performance.now();
          await until(() => samples.some(sample => sample.time > completedAt && ['visible', 'unavailable'].includes(sample.status)));
          const motion = samples.slice(motionStart);
          const verdict = motionVerdict(motion, motionSize, true);
          if (!verdict.pass) failed = true;
          out({ stage: 'motion', iteration: iteration + 1, stress, ...verdict, reasons: [...diagnostics] });
          await stopWatch();
        }
        // Explicit parent-side cancellation is expected termination, not graceful native EOF.
        watch(); await until(() => samples.find(sample => sample.status === 'visible')); await stopWatch();
        // Inject only a fault into this runner's own read-only helper.
        watch(); await until(() => samples.find(sample => sample.status === 'visible'));
        watchRecord.child.kill();
        await until(() => samples.find(sample => sample.status === 'unavailable'));
        assert(await waitForClose(watchRecord), 'helper-fault-exit-confirmed');
        stop(); stops.delete(stop);
        watch(); await until(() => samples.find(sample => sample.status === 'visible'));
        await command('close-window', sample => sample.status === 'unavailable');
        const pingIndex = messages.length;
        child.stdin.write('ping\n');
        await until(() => messages.slice(pingIndex).find(value => value.action === 'ping' && value.ok));
        assert(!recordOf(child).exited, 'window-close-process-alive', { pingAcknowledged: true });
        await stopWatch();
        child.stdin.end();
      } else {
        await command('process-exit', sample => ['closed', 'unavailable'].includes(sample.status));
        // Native may conservatively lose the HWND before the process handle signals.
        // Report that race, never upgrade an unavailable sample to confirmed closed.
        out({ stage: 'process-exit-classification', observed: samples.some(sample => sample.status === 'closed') ? 'closed' : 'unavailable',
          closedObserved: samples.some(sample => sample.status === 'closed') });
        await stopWatch();
      }
      const targetExit = await finishChild(recordOf(child), () => child.stdin.end());
      assert(targetExit.graceful && messages.some(value => value.type === 'cleanup' && value.destroyed), 'target-cleanup', { mode, ...targetExit });
    }
  } catch (error) {
    failed = true;
    out({ stage: 'failed', reason: /^[\w-]+$/.test(error.message) ? error.message : 'runtime-error' });
  } finally {
    for (const stop of stops) stop();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
    for (const record of records) {
      const result = await finishChild(record, () => { if (record.role === 'target') record.child.stdin.end(); });
      if (!result.closed || result.forced || record.spawnError ||
        (record.operation !== 'watch' && record.killRequests > 0) ||
        (record.role === 'target' && (!result.graceful || !record.messages?.some(value => value.type === 'cleanup' && value.destroyed)))) cleanupConfirmed = false;
    }
    out({ stage: 'cleanup', confirmed: cleanupConfirmed, forced: records.some(record => record.forced), childrenRemaining: records.filter(record => !record.closed).length,
      elapsedMs: Math.round(performance.now() - start), watchTerminations: records.filter(record => record.operation === 'watch').map(record =>
        ({ code: record.code, signal: record.signal, killRequests: record.killRequests })) });
    release(); app.exit(failed || !cleanupConfirmed ? 1 : 0);
  }
}

if (process.versions.electron) {
  const { app, BrowserWindow, screen } = require('electron');
  const index = process.argv.indexOf('--helper');
  if (process.platform !== 'win32' || index < 0 || !path.isAbsolute(process.argv[index + 1] || '')) app.exit(1);
  else app.whenReady().then(() => run(app, BrowserWindow, screen, process.argv[index + 1]));
}

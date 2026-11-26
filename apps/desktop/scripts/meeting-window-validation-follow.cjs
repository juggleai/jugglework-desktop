// Isolated real windows and native adapters; no product IPC, capture or input.
const { EventEmitter } = require('node:events');
const { performance } = require('node:perf_hooks');

async function validateFollow({ BrowserWindow, screen, target, watchWindow, place, writeHostBoundary, runMotion, resizeTarget, until, windows, detachedToolbar = false, stableFocusable = false, inspectTools = false, focusToolbarBeforeTool = false, injectHiddenNeighbor = false, observeCanvasPlacement = false, sampleAdjacency, manualInput }) {
  const { createMeetingAnnotation } = await import('../electron/meeting-annotation.mjs');
  const counts = { shown: 0, hidden: 0, pending: 0, geometryPauses: 0, placementStale: 0, unsafePending: 0, placementFailures: 0, unsafeCanvasInput: 0, recoveryBoundaryWrites: 0 };
  const durations = [], failedPhases = [], phaseResults = [], layers = [], operations = new Set();
  const canvasMessages = { changing: 0, changed: 0, both: 0, one: 0, neither: 0 };
  let armedCanvasSamples = 0;
  let lastVisible, closeReason = null, opened = false;
  const epochs = [], scenes = [], geometries = [];
  let armedRefusal = false, injectedRefusal = false, pausedAfterRefusal = false, recoveredGeometry = false;
  const handlers = new Map(), requestedInput = new Map();
  const contents = Object.assign(new EventEmitter(), { mainFrame: {}, isDestroyed: () => false, send(channel, event) {
    if (channel !== 'jugglework:meeting:window-annotation') return;
    if (event.kind === 'closed') closeReason = event.reason;
    if (event.kind === 'opened') opened = true;
    if (manualInput?.reopen && event.captureId === 'isolated-follow') {
      if (event.kind === 'opened') epochs.push(event.annotationId);
      if (event.kind === 'scene') scenes.push({ epoch: event.annotationId, elements: event.scene.elements.length });
      if (event.kind === 'geometry') geometries.push({ epoch: event.annotationId, width: event.width, height: event.height });
    }
    if (event.kind === 'geometry-pending') {
      counts.geometryPauses++;
      if (layers.some(win => !win.isDestroyed() && win.isVisible())) counts.unsafePending++;
      if (injectedRefusal) pausedAfterRefusal = true;
    }
    if (event.kind === 'geometry' && pausedAfterRefusal) recoveredGeometry = true;
  } });
  const endpoint = () => Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
  const main = endpoint(), meeting = endpoint();
  const sender = { sender: contents, senderFrame: contents.mainFrame };
  const captureId = 'isolated-follow';
  const realToolbar = process.argv.includes('--follow-real-toolbar');
  const nativeIpc = realToolbar ? require('electron').ipcMain : null;
  const path = require('node:path');
  const controller = createMeetingAnnotation({
    BrowserWindow: function (options) {
      const canvas = layers.length % 2 === 0;
      const win = new BrowserWindow({ ...options, ...(detachedToolbar && !canvas ? { parent: undefined } : {}), focusable: false,
        webPreferences: { ...(realToolbar ? { preload: path.resolve(__dirname, '../electron/annotation-preload.cjs') } : {}), sandbox: true, nodeIntegration: false, contextIsolation: true } });
      layers.push(win); windows.add(win);
      win.once('closed', () => windows.delete(win));
      const ignore = win.setIgnoreMouseEvents.bind(win), focusable = win.setFocusable.bind(win);
      ignore(true);
      // Never accept physical mouse input. Tool preflight exercises the real
      // focusability writes without requesting focus or synthesizing input.
      win.setIgnoreMouseEvents = (value, options) => {
        requestedInput.set(win, !value);
        if (canvas && !value && !inspectTools) counts.unsafeCanvasInput++;
        ignore(realToolbar && !canvas ? value : manualInput?.interactive && canvas ? value : true, options);
      };
      win.setFocusable = value => { if (!stableFocusable) focusable(inspectTools ? value : false); };
      if (canvas) {
        if (observeCanvasPlacement || sampleAdjacency) {
          // Electron routes these only for this fixture's BrowserWindow. Do not
          // inspect the callback buffers: LPARAM contains a native pointer.
          win.hookWindowMessage(0x0046, () => { canvasMessages.changing++; });
          const handle = sampleAdjacency ? win.getNativeWindowHandle().readBigUInt64LE() : null;
          win.hookWindowMessage(0x0047, () => {
            canvasMessages.changed++;
            if (armedCanvasSamples && sampleAdjacency) canvasMessages[sampleAdjacency(handle)]++;
          });
        }
        win.on('show', () => counts.shown++);
        win.on('hide', () => counts.hidden++);
      }
      return win;
    },
    screen, platform: 'win32', ipcMain: { handle(name, listener) { nativeIpc?.handle(name, listener); }, on(name, listener) { handlers.set(name, listener); nativeIpc?.on(name, listener); } }, preloadPath: '',
    loadPage: (win, view) => realToolbar ? win.loadURL(`http://localhost:5173/annotation.html?view=${view}`) : win.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:0;background:transparent">' +
      (view === 'canvas' ? '<div style="margin:32px;width:64px;height:8px;background:#d536ff"></div>' +
        '<script>globalThis.fixtureClicks=0;addEventListener("pointerdown",e=>{if(e.isTrusted&&e.button===0)fixtureClicks++})</script>' : '') + '</body>')),
    getMainWindow: () => main, getMeetingWindow: () => meeting, getSharedDisplayId: () => null, clearShared() {},
    getSharedWindow: () => ({ ...target, captureId }), getDisplayMatching: bounds => screen.getDisplayMatching(bounds),
    watchWindow: (scoped, consume) => watchWindow(scoped, sample => {
      if (sample.status === 'visible') lastVisible = sample;
      consume(sample);
      if (sample.status === 'geometry-pending') {
        counts.pending++;
        if (layers.some(win => !win.isDestroyed() && win.isVisible())) counts.unsafePending++;
      }
    }),
    placeWindowCanvas: (win, scoped, request) => {
      const at = performance.now();
      const phase = request.checkOnly ? 'check-visible' : request.visible ? 'place-visible' : 'place-hidden';
      const inject = armedRefusal && !injectedRefusal && request.checkOnly;
      if (inject) injectedRefusal = true;
      let reason, orderContext, firstBoundaryReadback;
      const afterPause = counts.geometryPauses > 0;
      const observe = (observeCanvasPlacement || sampleAdjacency) && !request.visible && !request.checkOnly;
      const before = observe ? { ...canvasMessages } : null;
      if (observe) armedCanvasSamples++;
      const task = (async () => {
        if (inject) return 'hidden-host-neighbor';
        if (writeHostBoundary && afterPause && !request.visible && !request.checkOnly) {
          const result = writeHostBoundary(win, request.bounds);
          if (result !== 'not-boundary') {
            orderContext = `fixture-host-${result}`;
            if (result !== 'written') return false;
            firstBoundaryReadback = sampleAdjacency(win.getNativeWindowHandle().readBigUInt64LE());
            // Never authorize from the in-process write or diagnostic reads.
            const verified = await place(win, scoped, { ...request, checkOnly: true, onDiagnostic: code => { reason = code; } });
            return verified === true ? true : reason?.startsWith('order-check-') ? 'placement-order-unconfirmed' : false;
          }
        }
        return place(win, scoped, { ...request,
        onDiagnostic: code => { reason = code; }, onOrderContext: context => { orderContext = context; },
        onBoundaryReadback: value => { firstBoundaryReadback = value; },
        onBoundaryWrite: () => { if (afterPause) counts.recoveryBoundaryWrites++; } });
      })().then(ok => {
        durations.push(Math.round(performance.now() - at));
        const keys = sampleAdjacency ? Object.keys(canvasMessages) : ['changing', 'changed'];
        const canvasPositionMessages = before ? Object.fromEntries(keys.map(key => [key, canvasMessages[key] - before[key]])) : undefined;
        phaseResults.push({ phase, result: ok === true ? 'verified' : ok === 'target-position-stale' ? 'stale' : ok === 'target-size-unconfirmed' ? 'size-unconfirmed' : typeof ok === 'string' ? ok : 'refused', reason, orderContext, firstBoundaryReadback, canvasPositionMessages });
        if (ok === 'target-position-stale') counts.placementStale++;
        else if (ok !== true && ok !== 'target-size-unconfirmed') {
          counts.placementFailures++;
          failedPhases.push(request.checkOnly ? 'check-visible' : request.visible ? 'place-visible' : 'place-hidden');
        }
        return ok;
      }).finally(() => { if (observe) armedCanvasSamples--; });
      operations.add(task); task.then(() => operations.delete(task), () => operations.delete(task));
      return task;
    },
  });
  let finalVerified = false, settledMs = null, moving = null;
  try {
    controller.windowShareReady(sender, { captureId, ready: true });
    await controller.open(sender);
    if (!opened || !controller.isActive()) throw new Error('follow-open');
    const initial = lastVisible.bounds;
    // Independent read-only check after both owned windows have been shown.
    const startupCheck = (await place(layers[0], target, { bounds: initial, visible: true, checkOnly: true })) === true;
    if (!startupCheck || !controller.isActive()) return { pass: false, startupCheck, closeReason, phaseResults, ...counts };
    if (injectHiddenNeighbor) {
      // Inject one adapter refusal, not a Z-order write. All recovery requests
      // must go through the unmodified native helper and strict readback.
      armedRefusal = true;
      try { await until(() => recoveredGeometry || !controller.isActive()); }
      catch (error) { if (error.message !== 'condition-timeout') throw error; }
      const finalCheck = recoveredGeometry && controller.isActive() &&
        (await place(layers[0], target, { bounds: initial, visible: true, checkOnly: true })) === true;
      const refusal = phaseResults.some(row => row.result === 'hidden-host-neighbor');
      return { pass: injectedRefusal && refusal && finalCheck && !counts.unsafePending && !counts.unsafeCanvasInput,
        startupCheck, injectedRefusal, refusal, pausedAfterRefusal, finalCheck, closeReason, phaseResults, ...counts };
    }
    if (inspectTools) {
      const [canvas, toolbar] = layers;
      const modes = [];
      const requestedTools = ['pen', 'pointer'];
      for (const tool of requestedTools) {
        if (focusToolbarBeforeTool) {
          toolbar.focus();
          try { await until(() => toolbar.isFocused() || !controller.isActive()); }
          catch (error) { if (error.message !== 'condition-timeout') throw error; }
          if (!controller.isActive() || !toolbar.isFocused()) return { pass: false, toolbarFocusConfirmed: false, closeReason, phaseResults, ...counts };
        }
        const start = phaseResults.length;
        if (realToolbar) {
          const deadline = Date.now() + 10000;
          while (await toolbar.webContents.executeJavaScript('document.querySelectorAll("button").length') === 0) {
            if (Date.now() >= deadline) throw new Error('toolbar-render-timeout');
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          await toolbar.webContents.executeJavaScript(`document.querySelector('button[aria-label="${tool === 'pen' ? '笔' : '鼠标'}"]').click()`);
        } else handlers.get('jugglework:annotation:command')({ sender: toolbar.webContents }, { type: 'tool', tool: { tool, color: '#ef4444' } });
        try {
          await until(() => !controller.isActive() || (phaseResults.length >= start + 3 && !operations.size &&
            canvas.isVisible() && toolbar.isVisible() && requestedInput.get(canvas) === (tool === 'pen') && requestedInput.get(toolbar)));
        } catch (error) { if (error.message !== 'condition-timeout') throw error; }
        const verified = controller.isActive() && requestedInput.get(canvas) === (tool === 'pen') && requestedInput.get(toolbar) &&
          (await place(canvas, target, { bounds: initial, visible: true, checkOnly: true })) === true;
        let input = null, interruptedTargetClicks, endVerified, foregroundBefore, foregroundAfter, activationMessages;
        if (tool === 'pen' && verified && manualInput?.focusControl) {
          // Only focus the fixture's own pen window; do not synthesize clicks.
          canvas.focus();
          try { await until(() => !controller.isActive() || (!operations.size && canvas.isFocused() && canvas.isVisible() && toolbar.isVisible())); }
          catch (error) { if (error.message !== 'condition-timeout') throw error; }
          if (!controller.isActive() || !canvas.isFocused()) return { pass: false, focusControlConfirmed: false, closeReason, phaseResults, ...counts };
        }
        if (manualInput && verified && (!manualInput.pointerOnly || tool === 'pointer')) {
          if (manualInput.coverControl && tool === 'pointer') {
            const cover = manualInput.coverControl;
            if (!await cover.command('cover-start')) throw new Error('cover-start-refused');
            try {
              const snapshots = [];
              const canvasClicks = () => canvas.webContents.executeJavaScript('globalThis.fixtureClicks');
              const beforeCanvas = await canvasClicks();
              for (const [i, visible] of [true, true, false].entries()) {
                if (i === 1) await cover.wait();
                if (!visible && !await cover.command('cover-hide')) throw new Error('cover-hide-refused');
                const state = await cover.state();
                const strict = controller.isActive() && canvas.isVisible() && toolbar.isVisible() &&
                  (await place(canvas, target, { bounds: initial, visible: true, checkOnly: true })) === true;
                snapshots.push({ visible, strict, ...state });
                if (!(strict && state.ordinary && state.clearHitsTarget && state.coveredHitsCover === visible && state.coveredHitsTarget === !visible)) break;
              }
              const clicks = snapshots.length === 3 && controller.isActive() ? { canvas: (await canvasClicks()) - beforeCanvas,
                target: snapshots[1].targetClicks - snapshots[0].targetClicks, cover: snapshots[1].coverClicks - snapshots[0].coverClicks } : null;
              const pass = snapshots.length === 3 && snapshots.every(s => s.strict && s.ordinary && s.clearHitsTarget &&
                s.coveredHitsCover === s.visible && s.coveredHitsTarget === !s.visible) && clicks?.canvas === 0 && clicks.target === 0 &&
                (manualInput.interactive ? clicks.cover >= 3 : clicks.cover === 0);
              return { pass: Boolean(pass && controller.isActive() && !counts.unsafePending), coverControl: true, startupCheck, snapshots, clicks, closeReason, ...counts };
            } finally { if (!await cover.command('cover-stop')) throw new Error('cover-stop-refused'); }
          }
          if (tool === 'pointer' && manualInput.preactivate) {
            // Diagnostic contrast only: finish the activation/recovery before
            // requesting physical clicks, unlike the standard manual case.
            const start = counts.geometryPauses;
            await manualInput.preactivate();
            try {
              await until(() => !controller.isActive() || (counts.geometryPauses > start && !operations.size &&
                canvas.isVisible() && toolbar.isVisible() && requestedInput.get(canvas) === false));
            } catch (error) {
              if (error.message !== 'condition-timeout') throw error;
              return { pass: false, preactivatedPointer: true, preactivationVerified: false, closeReason, phaseResults, ...counts };
            }
            if (!controller.isActive() ||
                await place(canvas, target, { bounds: initial, visible: true, checkOnly: true }) !== true)
              return { pass: false, preactivatedPointer: true, preactivationVerified: false, closeReason, phaseResults, ...counts };
          }
          const canvasCount = () => canvas.webContents.executeJavaScript('globalThis.fixtureClicks');
          if (manualInput.edgeResize && tool === 'pointer') {
            if (!await manualInput.targetIsForeground()) return { pass: false, edgeResize: true, foregroundBefore: false, closeReason, ...counts };
            const before = { ...lastVisible.actualSize };
            const oldSource = { sender: canvas.webContents, senderFrame: canvas.webContents.mainFrame };
            const scene = { size: { width: initial.width, height: initial.height }, elements: [{ type: 'stroke', id: 'fixture', size: 3, color: '#ef4444', highlight: false, points: [0.2, 0.3, 0.4, 0.5] }], lasers: [] };
            const dispatchScene = handlers.get('jugglework:annotation:scene');
            if (manualInput.reopen) dispatchScene(oldSource, scene);
            const observation = await manualInput.edgeResize();
            try { await until(() => !controller.isActive()); } catch (error) { if (error.message !== 'condition-timeout') throw error; }
            const resized = observation.width > before.width && (manualInput.corner ? observation.height > before.height : observation.height === before.height);
            const systemDrag = observation.enter > 0 && (manualInput.corner ? observation.bottomRight : observation.right) > 0 && observation.exit > 0;
            const layersRemoved = layers.every(win => win.isDestroyed());
            let pass = resized && closeReason === 'resized' && layersRemoved && !counts.unsafePending &&
              (manualInput.interactive ? systemDrag : observation.enter === 0 && observation.right === 0 && observation.bottomRight === 0 && observation.exit === 0);
            const resizeCloseReason = closeReason;
            let reopen;
            if (pass && manualInput.reopen) {
              await controller.open(sender); // Same capture; no new ready event.
              const [nextCanvas, nextToolbar] = layers.slice(2);
              const freshEpoch = epochs.length === 2 && Boolean(epochs[0] && epochs[1]) && epochs[0] !== epochs[1];
              const g = geometries.at(-1), b = lastVisible.bounds;
              const freshGeometry = g?.epoch === epochs[1] && g.width === b.width && g.height === b.height &&
                lastVisible.actualSize.width === observation.width && lastVisible.actualSize.height === observation.height;
              const verified = layers.length === 4 && controller.isActive() && nextCanvas.isVisible() && nextToolbar.isVisible() &&
                requestedInput.get(nextCanvas) === false && (await place(nextCanvas, target, { bounds: b, visible: true, checkOnly: true })) === true;
              const priorScene = scenes.length === 1 && scenes[0].epoch === epochs[0] && scenes[0].elements === 1;
              dispatchScene(oldSource, scene); // Retained sender/frame of destroyed fixture canvas.
              const staleIgnored = priorScene && scenes.length === 1;
              if (verified) dispatchScene({ sender: nextCanvas.webContents, senderFrame: nextCanvas.webContents.mainFrame },
                { size: { width: b.width, height: b.height }, elements: [], lasers: [] });
              const newSceneAccepted = scenes.length === 2 && scenes[1].epoch === epochs[1] && scenes[1].elements === 0;
              reopen = { freshEpoch, freshGeometry, verified, priorScene, staleIgnored, newSceneAccepted };
              pass = Object.values(reopen).every(value => value === true);
            }
            return { pass, edgeResize: true, systemDrag, startupCheck, before, observation, layersRemoved, closeReason: resizeCloseReason, reopen, ...counts };
          }
          await canvas.webContents.executeJavaScript(tool === 'pointer' ? "document.querySelector('div').style.display='none'" :
            "document.querySelector('div').textContent='画笔：点这里 3 次';Object.assign(document.querySelector('div').style,{width:'160px',height:'32px',color:'#111',lineHeight:'32px',textAlign:'center'})");
          const before = await Promise.all([canvasCount(), manualInput.countTarget()]);
          const observeActivation = tool === 'pointer' && manualInput.observeActivation;
          if (tool === 'pointer' && (manualInput.preactivate || observeActivation)) {
            foregroundBefore = await manualInput.targetIsForeground();
            if (manualInput.preactivate && !foregroundBefore) return { pass: false, preactivatedPointer: true, foregroundBefore, closeReason, phaseResults, ...counts };
          }
          if (observeActivation) await observeActivation.start();
          try {
            if (tool === 'pointer') await manualInput.showTargetGuide(true);
            await manualInput.prompt(tool);
          } finally {
            try { if (tool === 'pointer') await manualInput.showTargetGuide(false); }
            finally { if (observeActivation) activationMessages = await observeActivation.stop(); }
          }
          if (foregroundBefore !== undefined) foregroundAfter = await manualInput.targetIsForeground();
          if (controller.isActive()) {
            const after = await Promise.all([canvasCount().catch(() => null), manualInput.countTarget()]);
            if (Number.isSafeInteger(after[0]) && controller.isActive()) {
              input = { canvas: after[0] - before[0], target: after[1] - before[1] };
              endVerified = canvas.isVisible() && toolbar.isVisible() &&
                (await place(canvas, target, { bounds: initial, visible: true, checkOnly: true })) === true && controller.isActive();
            } else interruptedTargetClicks = after[1] - before[1];
          } else {
            // Preserve the surviving target's count for diagnosis only. The
            // canvas was destroyed, so the interrupted phase cannot pass.
            interruptedTargetClicks = (await manualInput.countTarget()) - before[1];
          }
        }
        modes.push({ tool, verified: Boolean(verified), ...(manualInput ? { input, interruptedTargetClicks, endVerified, foregroundBefore, foregroundAfter, activationMessages } : {}) });
        if (!verified || (manualInput && !controller.isActive())) break;
      }
      if (manualInput) {
        if (manualInput.manualSmoke && manualInput.preactivate) {
          const pointer = modes.find(mode => mode.tool === 'pointer');
          return { pass: Boolean(pointer?.verified && pointer.endVerified && pointer.foregroundBefore && pointer.foregroundAfter &&
            pointer.input?.canvas === 0 && pointer.input.target === 0 && !counts.unsafePending),
          startupCheck, preactivatedPointer: true, zeroInputControl: true, modes, closeReason,
             refusedPhases: phaseResults.filter(row => row.result !== 'verified').slice(-12),
             boundaryReadbacks: phaseResults.filter(row => row.firstBoundaryReadback).slice(-4), ...counts };
        }
        if (manualInput.activationControl) {
          const [canvas, toolbar] = layers;
          const finalCheck = controller.isActive() && canvas.isVisible() && toolbar.isVisible() &&
            (await place(canvas, target, { bounds: initial, visible: true, checkOnly: true })) === true;
          const recoveryObserved = phaseResults.some(row => ['hidden-host-neighbor', 'hidden-host-target-not-below'].includes(row.result)) && counts.geometryPauses === 1;
          const pointer = modes.find(mode => mode.tool === 'pointer');
          return { pass: Boolean(finalCheck && pointer?.endVerified && recoveryObserved && !counts.unsafePending && pointer.input?.canvas === 0 && pointer.input.target === 0),
            startupCheck, activationControl: true, focusControlConfirmed: Boolean(manualInput.focusControl), finalCheck, recoveryObserved, modes, closeReason,
             refusedPhases: phaseResults.filter(row => row.result !== 'verified').slice(-12),
             boundaryReadbacks: phaseResults.filter(row => row.firstBoundaryReadback).slice(-4), ...counts };
        }
        const accepted = modes.length === requestedTools.length && modes.every(({ tool, verified, input, endVerified, foregroundBefore, foregroundAfter }) => verified &&
          (manualInput.pointerOnly && tool === 'pen' || endVerified && input &&
          (tool === 'pen' ? input.canvas >= 3 && input.target === 0 : input.target >= 3 && input.canvas === 0 &&
            (!manualInput.preactivate || foregroundBefore && foregroundAfter))));
        return { pass: accepted && !counts.unsafePending, preactivatedPointer: Boolean(manualInput.preactivate), startupCheck, modes, closeReason,
          refusedPhases: phaseResults.filter(row => row.result !== 'verified').slice(-12), lastPhases: phaseResults.slice(-12), ...counts };
      }
      let resizeVerified = false, resizeApplied = false;
      if (modes.length === 2 && modes.every(mode => mode.verified)) {
        await resizeTarget();
        resizeApplied = true;
        await until(() => !controller.isActive());
        resizeVerified = closeReason === 'resized' && layers.every(win => win.isDestroyed());
      }
      return { pass: resizeVerified && !counts.unsafePending, startupCheck, modes, resizeApplied, resizeVerified, closeReason, phaseResults, ...counts };
    }
    moving = { shown: counts.shown, hidden: counts.hidden };
    const delta = await runMotion();
    const done = performance.now();
    try {
      await until(() => !controller.isActive() || (!operations.size && lastVisible?.bounds.x === initial.x + delta.x && lastVisible.bounds.y === initial.y + delta.y && layers.every(win => !win.isDestroyed() && win.isVisible())));
    } catch (error) { if (error.message !== 'condition-timeout') throw error; }
    const [canvas] = layers;
    if (controller.isActive() && !canvas.isDestroyed() && lastVisible.bounds.x === initial.x + delta.x && lastVisible.bounds.y === initial.y + delta.y && canvas.isVisible()) {
      finalVerified = (await place(canvas, target, { bounds: lastVisible.bounds, visible: true, checkOnly: true })) === true;
      if (finalVerified) settledMs = Math.round(performance.now() - done);
    }
    return { pass: finalVerified && !counts.unsafePending && !counts.unsafeCanvasInput, detachedToolbar, startupCheck, finalVerified, closeReason, settledMs,
      ...counts, shownDuringMotionAndRecovery: counts.shown - moving.shown, hiddenDuringMotionAndRecovery: counts.hidden - moving.hidden,
      placementCalls: durations.length, failedPhases, phaseResults, placementMs: durations.length ? [Math.min(...durations), Math.max(...durations)] : [] };
  } finally { controller.close(sender); }
}

module.exports = { validateFollow };

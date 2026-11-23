// Preliminary source/stream diagnostic for the future A3 hybrid fixture.
// Optional passive ink slice; no native edge windows or full A3 acceptance.
const { strokeOffsets, compositeInk, verifySingleOverlay } = require('./meeting-window-p0-compositor.cjs');

function matchFixtureSource(sources, identity) {
  if (!Array.isArray(sources) || !identity || typeof identity.hwnd !== 'string' ||
      !/^[1-9]\d{0,19}$/.test(identity.hwnd) ||
      !/^Meeting Window P0 [a-f0-9]{32}$/.test(identity.title || '')) return null;
  const candidates = sources.filter((source) => /^window:([1-9]\d*):\d+$/.exec(source?.id)?.[1] === identity.hwnd);
  return candidates.length === 1 && candidates[0].name === identity.title ? candidates[0] : null;
}

function composeAndVerify(bitmap, size, strokes, thickness = 3) {
  const offsets = strokeOffsets(size, strokes, thickness);
  if (!offsets?.length) return null;
  const composite = compositeInk(bitmap, size, offsets);
  if (!composite) return null;
  const result = verifySingleOverlay(bitmap, composite, size, offsets);
  return result && { width: size.width, height: size.height, offsets: offsets.length, ...result };
}

// A closed-form message alone is not enough; require the exact child to exit
// normally as well. Forced cleanup is never reported as a successful removal.
function cleanupVerdict({ closed, code, signal, forced }) {
  return !forced && closed && code === 0 && !signal ? 'confirmed' : 'unconfirmed';
}

async function runElectron() {
  const { app, desktopCapturer, BrowserWindow, session, screen } = require('electron');
  const { spawn } = require('node:child_process');
  const { join } = require('node:path');
  const { createInterface } = require('node:readline');
  const emit = (record) => console.log(JSON.stringify({ type: 'hybrid', inputEnabled: false, ...record }));
  if (process.platform !== 'win32') { emit({ stage: 'windows-required' }); return app.exit(1); }
  emit({ stage: 'waiting-for-ready' });
  let readyExpired = false;
  const readyTimer = setTimeout(() => {
    readyExpired = true;
    emit({ stage: 'ready-timeout', cleanup: 'not-started' });
    app.exit(1);
  }, 10000);
  await app.whenReady();
  clearTimeout(readyTimer);
  if (readyExpired) return;
  app.on('window-all-closed', () => {});
  let viewer, child, ink, observer, inkPoll, inkVerified = false, observerDone, stopObserver, occlusionSeen = false, targetMouse = null, inkWidth = 0, inkHeight = 0;
  let finishing = false, closed = false, forced = false, passed = false;
  let cleanupTimer, finalTimer, observationTimer, identity, geometry, capturing = false;
  const started = Date.now();
  function disposeInk() {
    clearTimeout(inkPoll);
    if (ink && !ink.isDestroyed()) ink.destroy();
    stopObserver?.();
  }
  function finish(ok, stage) {
    if (finishing) return;
    finishing = true;
    passed = ok;
    clearTimeout(observationTimer);
    disposeInk();
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    emit({ stage, elapsedMs: Date.now() - started });
    if (!child) return app.exit(1);
    child.stdin.end();
    cleanupTimer = setTimeout(() => {
      forced = true;
      emit({ stage: 'forced-cleanup', cleanup: 'unconfirmed' });
      child.kill(); // this launch's child only; never a normal cleanup proof
      finalTimer = setTimeout(() => { emit({ stage: 'cleanup-timeout', cleanup: 'unconfirmed' }); app.exit(1); }, 1500);
    }, 5000);
  }
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const nativeTarget = process.argv.includes('--native-target');
  // Fixture-only target actions, used by the lifecycle/occlusion checks.
  const actionArg = (flag, ms) => process.argv.includes(flag) && nativeTarget ? ['-' + ms[0], ms[1]] : [];
  const perfMode = process.argv.includes('--perf');
  const perfInk = process.argv.includes('--perf-ink');
  const perfToggle = process.argv.includes('--perf-toggle');
  const perfMs = Number(process.argv[process.argv.indexOf('--perf-ms') + 1]) || 12000;
  const a4Mode = process.argv.includes('--a4-passive') ? 'passive' : process.argv.includes('--a4-draw') ? 'draw' : process.argv.includes('--a4-occluded') ? 'occluded' : null;
  const targetArgs = [...actionArg('--minimize-after', ['MinimizeMs', '1800']),
    ...actionArg('--resize-after', ['ResizeMs', '1800']),
    ...actionArg('--occlude-after', ['OccludeMs', '1800']),
    ...(perfMode ? ['-Width', '1916', '-Height', '1119', '-Motion'] : []),
    ...(a4Mode ? ['-Fixed'] : []),
    ...(a4Mode === 'occluded' ? ['-OccludeMs', '1800'] : [])];
  const occludeRequested = targetArgs.includes('-OccludeMs');
  const a4Ms = Math.min(180000, Math.max(5000, Number(process.argv[process.argv.indexOf('--a4-ms') + 1]) || 75000));
  child = spawn(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
    join(__dirname, nativeTarget ? 'meeting-window-p0-hybrid.ps1' : 'meeting-window-p0.ps1'),
    ...(nativeTarget ? targetArgs : ['-Probe', ...(process.argv.includes('--static-target') ? [] : ['-Animate'])])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // CREATE_NO_WINDOW suppresses the host console window, which otherwise joins
    // the target process's Z band. Our own GUI window is created explicitly.
    windowsHide: nativeTarget || process.argv.includes('--diagnose-hidden-start'),
  });
  child.stderr.resume(); // never expose PowerShell's raw diagnostics
  child.stdin.on('error', () => { if (!finishing) finish(false, 'fixture-pipe'); });
  child.on('error', () => finish(false, 'fixture-spawn'));
  child.on('close', async (code, signal) => {
    // Invalidate in-flight enumeration/load/render replies before exiting.
    // app.exit normally ends execution, but late promises must be safe too.
    if (!finishing) passed = false;
    finishing = true;
    disposeInk();
    clearTimeout(observationTimer); clearTimeout(cleanupTimer); clearTimeout(finalTimer);
    if (viewer && !viewer.isDestroyed()) viewer.destroy();
    const observerClean = observerDone ? await observerDone : null;
    const cleanup = observerClean === false ? 'unconfirmed' : cleanupVerdict({ closed, code, signal, forced });
    emit({ stage: 'cleanup', cleanup, closedMessage: closed, normalExit: code === 0 && !signal,
      forced, ...(observerDone ? { observerEof: observerClean, inkDestroyed: !ink || ink.isDestroyed() } : {}), elapsedMs: Date.now() - started });
    app.exit(passed && cleanup === 'confirmed' ? 0 : 1);
  });
  app.on('before-quit', (event) => { event.preventDefault(); finish(false, 'quit-request'); });
  process.on('SIGINT', () => finish(false, 'interrupted'));
  process.on('SIGTERM', () => finish(false, 'interrupted'));
  observationTimer = setTimeout(() => finish(false, 'observation-timeout'), 30000);
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let record;
    try { record = JSON.parse(line); } catch { if (!finishing) finish(false, 'fixture-protocol'); return; }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      if (!finishing) finish(false, 'fixture-protocol');
      return;
    }
    if (record.type === 'closed') { closed = true; return; }
    if (record.type === 'target-error') { emit({ stage: 'target-error', kind: typeof record.kind === 'string' ? record.kind.slice(0, 64) : 'unknown' }); return; }
    if (record.type === 'mouse') {
      if (Number.isSafeInteger(record.clicks) && Number.isSafeInteger(record.drags) && record.clicks >= 0 && record.drags >= 0)
        targetMouse = { clicks: record.clicks, drags: record.drags,
          occluderClicks: Number.isSafeInteger(record.occluderClicks) ? record.occluderClicks : 0 };
      return;
    }
    if (finishing) return;
    if (record.type === 'identity') {
      if (identity || !matchFixtureSource([{ id: `window:${record.hwnd}:0`, name: record.title }], record)) return finish(false, 'fixture-identity');
      identity = record;
    }
    if (record.type === 'geometry') {
      if (typeof record.visible !== 'boolean' || !Number.isSafeInteger(record.dpi) || record.dpi <= 0) return finish(false, 'fixture-protocol');
      geometry = record;
      emit({ stage: 'target-geometry', visible: record.visible, state: record.state, dpi: record.dpi,
        outerPx: record.outerPx, dwmPx: record.dwmPx });
      if (record.state !== 'normal') return finish(false, 'target-state');
    }
    if (identity && geometry && !capturing) { capturing = true; capture().catch(() => finish(false, 'capture-error')); }
  });

  async function capture() {
    // Enumerate metadata only. Do not request thumbnails of unrelated windows.
    let selected;
    for (let attempt = 0; attempt < 12 && !finishing; attempt++) {
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      if (finishing) return;
      selected = matchFixtureSource(sources, identity);
      if (selected) break;
      if (attempt === 0) emit({ stage: 'source-enumeration', count: sources.length, matched: false });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (finishing) return;
    if (!selected) return finish(false, 'source-missing');
    if (geometry.visible !== true) return finish(false, 'target-hidden');
    emit({ stage: 'source', matched: true, hwndStringMatched: true });
    if (process.argv.includes('--passive-ink')) {
      await startInk();
      if (finishing) return;
      if (occludeRequested) {
        // Wait for the fixture's own occluder to appear above the ink, then
        // confirm the layer is still adjacent to the target below it.
        const deadline = Date.now() + 8000;
        while (!finishing && !occlusionSeen && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (finishing) return;
        if (!occlusionSeen) return finish(false, 'ink-occlusion-timeout');
      }
      if (a4Mode) {
        if (!ink) return finish(false, 'a4-needs-ink');
        const { a4Verdict } = require('./meeting-window-p0-hybrid-ink.cjs');
        clearTimeout(observationTimer);
        observationTimer = setTimeout(() => finish(false, 'observation-timeout'), 150000);
        emit({ stage: 'a4-begin', mode: a4Mode, seconds: Math.round(a4Ms / 1000) });
        const end = Date.now() + a4Ms;
        let counts = { clicks: 0, drags: 0 };
        while (!finishing && Date.now() < end) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          try {
            const value = await ink.webContents.executeJavaScript('globalThis.p0Input()');
            if (value && Number.isSafeInteger(value.clicks) && Number.isSafeInteger(value.drags) &&
                value.clicks >= 0 && value.drags >= 0) counts = { clicks: value.clicks, drags: value.drags };
          } catch { /* keep last known counts */ }
        }
        if (finishing) return;
        const target = targetMouse || { clicks: 0, drags: 0 };
        const verdict = a4Verdict(a4Mode, counts, target);
        emit({ stage: 'a4-result', mode: a4Mode, ink: counts, target, valid: verdict.pass, reason: verdict.reason });
        return finish(verdict.pass, verdict.pass ? 'a4-observed' : 'a4-rejected');
      }
    }
    const endpoint = 'https://meeting-window-hybrid.invalid/';
    const ses = session.fromPartition('meeting-window-hybrid');
    ses.protocol.handle('https', (request) => request.url === endpoint
      ? new Response('<!doctype html><body></body>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" } })
      : new Response(null, { status: 404 }));
    viewer = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
    await viewer.loadURL(endpoint);
    if (finishing) return;
    let requested = false;
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (finishing || requested || request.frame !== viewer.webContents.mainFrame ||
          request.securityOrigin?.replace(/\/$/, '') !== endpoint.replace(/\/$/, '') ||
          !request.videoRequested || request.audioRequested) return callback({});
      requested = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        const source = matchFixtureSource(sources, identity);
        callback(!finishing && source && child.exitCode === null ? { video: source } : {});
      } catch { callback({}); }
    }, { useSystemPicker: false });
    if (perfMode) {
      const metrics = () => {
        const list = app.getAppMetrics().map((m) => m.cpu?.percentCPUUsage || 0);
        return list.reduce((a, b) => a + b, 0);
      };
      const cpuBefore = metrics();
      const perf = await viewer.webContents.executeJavaScript(
        `(${observePerf})(${JSON.stringify({ ms: perfMs, ink: perfInk ? (perfToggle ? "toggle" : true) : false })})`, true);
      const cpuAfter = metrics();
      const valid = !perf.failure && perf.frames > 0 && perf.width >= 1800 &&
        Math.abs(perf.width - (geometry.outerPx.width - 14)) <= 16;
      emit({ stage: 'perf-sample', ...perf, perfInk, cpuPercent: Math.round((cpuBefore + cpuAfter) / 2 * 10) / 10,
        valid, evidence: 'local-only-not-zego' });
      finish(valid, valid ? 'perf-observed' : 'perf-rejected');
      return;
    }
    const result = await viewer.webContents.executeJavaScript(`(${observeMarkerFrames})()`, true);
    if (finishing) return;
    const valid = !result.failure && result.displaySurface === 'window' && result.frames >= 3 &&
      result.markers.length === 4 && (occludeRequested || result.markers.every((m) => m.count > 0)) &&
      (!ink || (inkVerified && result.inkColorPixels === 0)) && (!occludeRequested || occlusionSeen);
    let mapping = null;
    if (ink && inkVerified && geometry && geometry.dwmPx) {
      const { mappingVerdict } = require('./meeting-window-p0-hybrid-ink.cjs');
      mapping = mappingVerdict(result.markers, { width: result.width, height: result.height },
        geometry.dwmPx, { width: inkWidth, height: inkHeight });
      emit({ stage: 'a2-mapping', ...mapping });
    }
    emit({ stage: 'stream-sample', ...result, valid, evidence: 'passive-ink-slice-not-full-A3' });
    finish(valid, valid ? 'stream-observed' : 'stream-rejected');
  }

  function startInk() {
    const { parseNativeSample } = require('./meeting-window-p0-native.cjs');
    const { inkPlan, inkVerdict, page } = require('./meeting-window-p0-hybrid-ink.cjs');
    const target = { ...identity, pid: child.pid, overlay: true, overlayPid: process.pid, passiveInk: true, interactive: a4Mode === 'draw' };
    observer = spawn(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'meeting-window-p0-native.ps1')],
      { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const nativeLines = createInterface({ input: observer.stdout });
    let eof = false, forcedObserver = false, observerClosed = false, killTimer, endTimer, pending = false, baseline, layer, resolveReady, reorders = 0;
    observerDone = new Promise((resolve) => {
      stopObserver = () => {
        if (observerClosed || killTimer || forcedObserver) return;
        observer.stdin.end();
        killTimer = setTimeout(() => {
          forcedObserver = true;
          observer.kill();
          endTimer = setTimeout(() => resolve(false), 1500);
        }, 5000);
      };
      observer.once('close', (code, signal) => {
        observerClosed = true;
        clearTimeout(killTimer); clearTimeout(endTimer);
        resolve(!forcedObserver && eof && code === 0 && !signal);
        if (!finishing) finish(false, 'ink-observer-exit');
      });
    });
    observer.stdin.on('error', () => finish(false, 'ink-observer-pipe'));
    observer.on('error', () => finish(false, 'ink-observer-start'));
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    function request() {
      if (finishing) return;
      pending = true;
      observer.stdin.write(`${JSON.stringify({ layers: layer ? [layer] : [] })}\n`);
      inkPoll = setTimeout(() => finish(false, 'ink-readback-timeout'), baseline ? 3000 : 10000);
    }
    nativeLines.on('line', async (line) => {
      if (line === '{"type":"observer-eof"}') { eof = true; return; }
      if (finishing) return;
      if (!pending) return finish(false, 'ink-protocol');
      pending = false;
      clearTimeout(inkPoll);
      const sample = parseNativeSample(line, target);
      try {
        const plan = inkPlan(sample, screen, baseline);
        if (!baseline) {
          baseline = sample;
          const title = `${identity.title} Overlay ink`;
          ink = new BrowserWindow({ ...plan.dip, title, show: false, frame: false, transparent: true,
            focusable: false, alwaysOnTop: false, skipTaskbar: true, hasShadow: false, thickFrame: false,
            resizable: false, movable: false, webPreferences: { sandbox: true, nodeIntegration: false } });
          if (a4Mode !== 'draw') ink.setIgnoreMouseEvents(true);
          ink.webContents.on('render-process-gone', () => finish(false, 'ink-renderer-exit'));
          inkPoll = setTimeout(() => finish(false, 'ink-load-timeout'), 5000);
          await ink.loadURL(`data:text/html,${encodeURIComponent(page)}`);
          if (finishing) return;
          clearTimeout(inkPoll);
          const handle = ink.getNativeWindowHandle();
          if (![4, 8].includes(handle.length)) return finish(false, 'ink-identity');
          layer = { role: 'ink', title, hwnd: (handle.length === 8 ? handle.readBigUInt64LE() : handle.readUInt32LE()).toString() };
          ink.showInactive();
          // Place our own layer directly above the target. Any window already
          // above the target stays above the ink and can occlude it. The
          // read-only observer below is the authority on the result.
          const placement = await placeInk(layer.hwnd, identity.hwnd);
          if (finishing) return;
          emit({ stage: 'ink-placement', placed: placement?.placed === true, adjacent: placement?.adjacent === true });
          request();
          return;
        }
        const failure = inkVerdict(sample.overlay.layers, layer.hwnd, plan);
        if (failure === 'ink-order' && inkVerified && reorders < 5) {
          // The user may activate the shared window, raising it above our layer.
          // Re-place only our own window, then let the observer re-verify.
          reorders++;
          const actual = sample.overlay.layers[0];
          emit({ stage: 'ink-reorder', attempt: reorders, targetRelative: actual?.targetRelative,
            nextOwner: actual?.nextOwner });
          const replaced = await placeInk(layer.hwnd, identity.hwnd);
          if (finishing) return;
          emit({ stage: 'ink-reorder-result', attempt: reorders, placed: replaced?.placed === true,
            adjacent: replaced?.adjacent === true });
          request();
          return;
        }
        if (failure) {
          const actual = sample.overlay.layers[0];
          emit({ stage: 'ink-readback-rejected', reason: failure, plannedPx: plan.px, actualPx: actual?.outerPx,
            adjacent: actual?.adjacent, topmost: actual?.topmost,
            targetRelative: actual?.targetRelative, nextOwner: actual?.nextOwner, nextRole: actual?.nextRole,
            nextOwnedByTarget: actual?.nextOwnedByTarget, nextVisible: actual?.nextVisible,
            nextOverlapsInk: actual?.nextOverlapsInk, nextHasArea: actual?.nextHasArea });
          return finish(false, failure);
        }
        if (!inkVerified) {
          inkVerified = true;
          inkWidth = plan.px.width; inkHeight = plan.px.height;
          // Pixel evidence for our own layer only: capturePage never reads other
          // windows or the desktop.
          const shot = await ink.webContents.capturePage();
          const size = shot.getSize();
          const pixels = shot.toBitmap();
          let inkPixels = 0;
          for (let i = 0; i + 3 < pixels.length; i += 4) {
            if (pixels[i + 3] >= 128 && Math.abs(pixels[i] - 200) <= 18 &&
                Math.abs(pixels[i + 1] - 53) <= 18 && pixels[i + 2] >= 230) inkPixels++;
          }
          const presented = inkPixels > 0 && size.width === plan.px.width && size.height === plan.px.height;
          emit({ stage: 'ink-presented', inkPixels, width: size.width, height: size.height, presented });
          if (finishing) return;
          if (!presented) return finish(false, 'ink-not-presented');
          emit({ stage: 'ink-native-verified', px: plan.px });
          resolveReady();
        }
        if (occludeRequested && !occlusionSeen) {
          const covered = sample.overlay.layers[0];
          if (covered.occluderTitleHits > 0) {
            emit({ stage: 'ink-occlusion-sample', walk: covered.occluderWalk, hits: covered.occluderTitleHits,
              aboveOwner: covered.aboveOwner, occluderAboveInk: covered.occluderAboveInk, occluderPx: covered.occluderPx });
          }
          if (covered.occluderAboveInk === true) {
            occlusionSeen = true;
            emit({ stage: 'ink-occluded', occluderAboveInk: true, adjacent: covered.adjacent,
              aboveRole: covered.aboveRole, aboveOwner: covered.aboveOwner });
          }
        }
        inkPoll = setTimeout(request, 100);
      } catch (error) {
        if (sample && sample.status === 'unavailable') emit({ stage: 'ink-unavailable-detail', reason: sample.reason });
        finish(false, ['ink-native-unavailable', 'ink-target-state', 'ink-identity', 'ink-dpi', 'ink-geometry'].includes(error.message)
          ? error.message : 'ink-runtime');
      }
    });
    observer.stdin.write(`${JSON.stringify(target)}\n`);
    request();
    return ready;
  }

  // Bounded, injection-free placement of the one ink HWND we created. Failure
  // is not fatal here: the read-only observer still decides pass/fail.
  function placeInk(inkHwnd, targetHwnd) {
    return new Promise((resolve) => {
      const placer = spawn(powershell, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File',
        join(__dirname, 'meeting-window-p0-hybrid-place.ps1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      let settled = false, timer, buffer = '';
      const done = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
      timer = setTimeout(() => { placer.kill(); done(null); }, 5000);
      placer.on('error', () => done(null));
      placer.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try { done(JSON.parse(buffer.slice(0, newline))); } catch { done(null); }
      });
      placer.on('close', () => done(null));
      placer.stdin.end(`${JSON.stringify({ ink: inkHwnd, target: targetHwnd })}\n`);
    });
  }
}

// Local-only performance probe: same-track Canvas 2D composite of the delivered
// window stream. Measures delivered frames and optional ink drawing; never
// captures the desktop or other windows.
async function observePerf({ ms, ink }) {
  let stream, track, stage = 'media-request', frames = 0, drawn = 0, phase = 0;
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: false });
  const started = performance.now();
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    [track] = stream.getVideoTracks();
    video.muted = true; video.srcObject = stream; document.body.append(video);
    stage = 'video-play';
    await video.play();
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    if (!canvas.width || !canvas.height) throw new Error('size');
    stage = 'frame-loop';
    await new Promise((resolve) => {
      function next() {
        frames++;
        try {
          const fresh = canvas.width === video.videoWidth ? null : (canvas.width = video.videoWidth, canvas.height = video.videoHeight);
          void fresh;
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (ink && (ink !== 'toggle' || Math.floor(frames / 30) % 2 === 0)) {
            phase = (phase + 1) % 4;
            context.strokeStyle = '#ff35c8'; context.lineWidth = 6;
            context.beginPath(); context.moveTo(40, canvas.height / 2);
            context.lineTo(canvas.width - 40, canvas.height / 2 + phase * 12); context.stroke();
          }
          drawn++;
        } catch { /* a failed draw must not inflate the count */ }
        if (performance.now() - started < ms) video.requestVideoFrameCallback(next);
        else resolve();
      }
      video.requestVideoFrameCallback(next);
    });
    const elapsedMs = Math.round(performance.now() - started);
    return { frames, drawn, elapsedMs, fps: Math.round(frames / elapsedMs * 10000) / 10,
      width: canvas.width, height: canvas.height, displaySurface: track.getSettings().displaySurface };
  } catch {
    return { failure: stage, frames, width: video.videoWidth, height: video.videoHeight };
  } finally { stream?.getTracks().forEach((t) => t.stop()); video.remove(); }
}

// Runs in a hidden sandboxed renderer; only returns synthetic marker statistics,
// never images, source titles, track ids or device identifiers.
async function observeMarkerFrames() {
  let stream, track, stage = 'media-request';
  const video = document.createElement('video');
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { willReadFrequently: true });
  let frames = 0;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    [track] = stream.getVideoTracks();
    video.muted = true; video.srcObject = stream; document.body.append(video);
    stage = 'video-play';
    await video.play();
    stage = 'frame-wait';
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('frame-timeout')), 10000);
      function next() { if (++frames >= 3) { clearTimeout(timeout); resolve(); } else video.requestVideoFrameCallback(next); }
      video.requestVideoFrameCallback(next);
    });
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    stage = 'pixel-readback';
    context.drawImage(video, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const palette = [ ['TL',255,99,71], ['TR',255,215,0], ['BL',50,205,50], ['BR',0,191,255] ];
    const markers = palette.map(([role, r, g, b]) => {
      let count = 0, sumX = 0, sumY = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (Math.abs(pixels[i] - r) <= 8 && Math.abs(pixels[i + 1] - g) <= 8 && Math.abs(pixels[i + 2] - b) <= 8) {
          count++; sumX += (i / 4) % canvas.width; sumY += Math.floor((i / 4) / canvas.width);
        }
      }
      return { role, count, x: count ? Math.round(sumX / count * 100) / 100 : null, y: count ? Math.round(sumY / count * 100) / 100 : null };
    });
    let inkColorPixels = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] >= 230 && Math.abs(pixels[i + 1] - 53) <= 18 && Math.abs(pixels[i + 2] - 200) <= 18) inkColorPixels++;
    }
    return { frames, width: canvas.width, height: canvas.height, displaySurface: track.getSettings().displaySurface, markers, inkColorPixels };
  } catch {
    return { failure: stage, frames, width: video.videoWidth, height: video.videoHeight,
      displaySurface: track?.getSettings().displaySurface, markers: [] };
  } finally { stream?.getTracks().forEach((t) => t.stop()); video.remove(); }
}

// Electron's default-app loader does not promise require.main === this module.
// Plain Node imports remain side-effect free, while Electron must start it.
if (process.versions.electron) {
  runElectron().catch(() => { console.log(JSON.stringify({ type: 'hybrid', stage: 'startup-error', cleanup: 'unconfirmed' })); require('electron').app.exit(1); });
}
module.exports = { matchFixtureSource, composeAndVerify, cleanupVerdict };

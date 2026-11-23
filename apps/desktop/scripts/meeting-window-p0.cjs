// Standalone Electron entry point; never loads the JuggleWork application.
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');
const { parseNativeSample, classifyNativeSample } = require('./meeting-window-p0-native.cjs');
const { createFixtureOverlay } = require('./meeting-window-p0-overlay.cjs');

const endpoint = 'https://meeting-window-p0.invalid/';
const origin = new URL(endpoint).origin;
const overlayMode = process.argv.includes('--overlay');
const nativeOnly = process.argv.includes('--native-only') || overlayMode;
const emit = (record) => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));
if (process.platform !== 'win32') {
  emit({ type: 'error', stage: 'windows-required' });
  app.exit(1);
} else {
  app.whenReady().then(run).catch(() => {
    emit({ type: 'error', stage: 'electron-startup' });
    app.exit(1);
  });
}

async function run() {
  let ses, viewer;
  if (!nativeOnly) {
    ses = session.fromPartition('meeting-window-p0'); // in memory
    ses.protocol.handle('https', (request) => request.url === endpoint
      ? new Response('<!doctype html><meta charset="utf-8"><body></body>', {
        headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" },
      }) : new Response(null, { status: 404 }));
    viewer = new BrowserWindow({ show: false, webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    } });
    await viewer.loadURL(endpoint);
  }
  emit({ type: 'electron', electron: process.versions.electron, chromium: process.versions.chrome, arch: process.arch });

  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'meeting-window-p0.ps1'), '-Probe',
    ...(overlayMode ? ['-Overlay'] : []),
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const owned = new Set();
  let finished = false, closeIntent = false, framesSeen = false, nativeSeen = false;
  let overlay;
  let overlaySeen = false;
  let poll, observationTimeout, replyTimeout, processingTimeout, fixtureExitTimeout, cleanupTimeout, shutdownComplete;
  const identityTimeout = setTimeout(() => finish('fixture-startup-timeout'), 30_000);

  function stopObservation() {
    overlay?.dispose();
    clearTimeout(identityTimeout);
    clearTimeout(observationTimeout);
    clearTimeout(replyTimeout);
    clearTimeout(processingTimeout);
    clearInterval(poll);
    ses?.setDisplayMediaRequestHandler(null);
    if (viewer && !viewer.isDestroyed()) viewer.destroy(); // releases the stream and any pending frame callbacks
  }

  function own(proc, onClose) {
    owned.add(proc);
    proc.stdin.on('error', () => { if (!finished && !closeIntent) finish(proc === child ? 'fixture-pipe' : 'native-pipe'); });
    proc.on('close', (code) => {
      owned.delete(proc);
      if (!finished) onClose(code);
      else if (owned.size === 0) shutdownComplete();
    });
  }

  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(fixtureExitTimeout);
    stopObservation();
    if (error) emit({ type: 'error', stage: error });
    shutdownComplete = () => {
      clearTimeout(cleanupTimeout);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      app.exit(error || owned.size > 0 ? 1 : 0);
    };
    if (owned.size === 0) return shutdownComplete();
    for (const proc of owned) proc.stdin.end();
    cleanupTimeout = setTimeout(() => {
      for (const proc of owned) {
        if (proc.pid && proc.exitCode === null && proc.signalCode === null) proc.kill();
      }
      cleanupTimeout = setTimeout(() => {
        if (owned.size > 0) emit({ type: 'error', stage: 'cleanup-timeout' });
        shutdownComplete();
      }, 1_000);
    }, 2_000);
  }
  function interrupt() { finish('interrupted'); }
  app.on('before-quit', (event) => { event.preventDefault(); interrupt(); });
  app.on('window-all-closed', () => {}); // keep running while the fixture or cleanup is active
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  child.on('error', () => finish('fixture-spawn'));
  own(child, (code) => {
    if (code !== 0 || !closeIntent) return finish('fixture-exit');
    emit({ type: 'closed' });
    finish(overlayMode ? (overlaySeen ? null : 'closed-before-overlay-verification') : nativeOnly ? (nativeSeen ? null : 'closed-before-native-observation')
      : (framesSeen ? null : 'closed-before-frame-observed'));
  });

  let sequence = 0, geometry, identityReceived = false;
  lines.on('line', (line) => {
    if (finished || closeIntent) return;
    let record;
    try { record = JSON.parse(line); } catch { return finish('fixture-protocol'); }
    if (!record || typeof record !== 'object' || Array.isArray(record)) return finish('fixture-protocol');
    if (record.type === 'identity') {
      if (identityReceived || typeof record.hwnd !== 'string' || !/^[1-9]\d{0,19}$/.test(record.hwnd) ||
          typeof record.title !== 'string' ||
          !/^Meeting Window P0 [a-f0-9]{32}$/.test(record.title)) return finish('invalid-fixture-identity');
      identityReceived = true;
      clearTimeout(identityTimeout);
      observationTimeout = setTimeout(() => finish(overlayMode ? 'first-overlay-timeout' : nativeOnly ? 'first-native-timeout' : 'first-frame-timeout'), 20_000);
      if (nativeOnly) startNative(record);
      else startCapture(record).catch(() => { if (!closeIntent) finish('capture-start'); });
    } else if (overlayMode && record.type === 'mode') {
      if (!['pointer', 'draw'].includes(record.mode)) return finish('fixture-protocol');
      overlay?.setMode(record.mode);
    } else if (overlayMode && record.type === 'fixture-input') {
      if (!['target', 'occluder'].includes(record.role) ||
          ![record.clicks, record.drags].every((n) => Number.isSafeInteger(n) && n >= 0)) return finish('fixture-protocol');
      emit(record);
    } else if (record.type === 'fixture') {
      emit(record);
    } else if (record.type === 'geometry') {
      if (nativeOnly) return;
      let outerDip, dwmDip;
      try {
        outerDip = record.outerPx === null ? null : screen.screenToDipRect(null, record.outerPx);
        dwmDip = record.dwmPx === null ? null : screen.screenToDipRect(null, record.dwmPx);
      } catch {
        return finish('fixture-protocol');
      }
      geometry = { seq: ++sequence, state: record.state };
      emit({ ...record, ...geometry, outerDip, dwmDip });
    } else if (record.type === 'closed') {
      closeIntent = true;
      stopObservation();
      fixtureExitTimeout = setTimeout(() => finish('fixture-exit-timeout'), 5_000);
    } else finish('fixture-protocol');
  });

  function startNative({ hwnd, title }) {
    const target = { hwnd, pid: child.pid, ...(overlayMode ? { overlay: true } : {}) };
    if (overlayMode) overlay = createFixtureOverlay({ BrowserWindow, screen, title, fail: finish, emit: (record) => {
      if (record.type === 'overlay' && record.stage === 'native-verified') {
        overlaySeen = true;
        clearTimeout(observationTimeout);
      }
      emit(record);
    } });
    const observer = spawn(powershell, [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'meeting-window-p0-native.ps1'),
    ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    observer.on('error', () => { if (!closeIntent) finish('native-spawn'); });
    own(observer, () => { if (!closeIntent) finish('native-exit'); });
    let previous, pending = false, processing = false;
    const samples = createInterface({ input: observer.stdout });
    samples.on('line', async (line) => {
      if (finished || closeIntent) return;
      if (!pending) return finish('native-protocol');
      clearTimeout(replyTimeout);
      pending = false;
      const sample = parseNativeSample(line, target);
      if (!sample) return finish('native-protocol');
      const change = classifyNativeSample(previous, sample);
      if (sample.status === 'available') {
        nativeSeen = true;
        if (!overlayMode) clearTimeout(observationTimeout);
      }
      if (change !== 'unchanged' && (change !== 'unavailable' ||
          previous?.status !== sample.status || previous.reason !== sample.reason)) {
        emit({ type: 'native', change, ...sample });
      }
      previous = sample;
      if (overlay) {
        processing = true;
        processingTimeout = setTimeout(() => finish('overlay-processing-timeout'), 5_000);
        try { await overlay.observe(sample, sample.overlay); }
        finally { clearTimeout(processingTimeout); processing = false; }
      }
    });
    function request() {
      if (finished || closeIntent || pending || processing) return;
      pending = true;
      replyTimeout = setTimeout(() => finish('native-reply-timeout'), nativeSeen ? 5000 : 20_000);
      observer.stdin.write(overlay ? `${JSON.stringify({ layers: overlay.identities() })}\n` : 'sample\n');
    }
    observer.stdin.write(`${JSON.stringify({ ...target, title, ...(overlayMode ? { overlayPid: process.pid } : {}) })}\n`);
    request();
    poll = setInterval(request, 100);
  }

  async function startCapture({ hwnd, title }) {
    let requested = false, matched = false;
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (finished || closeIntent || requested || request.frame !== viewer.webContents.mainFrame || request.securityOrigin?.replace(/\/$/, '') !== origin ||
          !request.videoRequested || request.audioRequested) return callback({});
      requested = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'],
          thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        if (finished || closeIntent || child.exitCode !== null || child.signalCode !== null) return callback({});
        // Decimal strings preserve the entire HWND. Only read the name of an
        // HWND candidate and require the private launch nonce before capture.
        const candidates = sources.filter((source) => /^window:([1-9]\d*):\d+$/.exec(source.id)?.[1] === hwnd);
        const selected = candidates.length === 1 && candidates[0].name === title ? candidates[0] : null;
        matched = selected !== null;
        emit({ type: 'source', matched });
        callback(matched ? { video: selected } : {});
      } catch {
        callback({});
      }
    }, { useSystemPicker: false });
    try {
      await viewer.webContents.executeJavaScript(`(${observeFrames})()`, true);
    } catch {
      if (!closeIntent) finish(matched ? 'capture-start' : requested ? 'source-selection' : 'display-request');
      return;
    }
    if (finished || closeIntent) return;

    let lastKey, lastCount = 0, busy = false;
    poll = setInterval(async () => {
      if (busy || finished || closeIntent) return;
      busy = true;
      const sampleGeometry = geometry;
      try {
        const sample = await viewer.webContents.executeJavaScript('globalThis.p0Sample()');
        if (finished || closeIntent) return;
        const { count, trackState, ...dimensions } = sample;
        const frameAdvanced = count > lastCount;
        lastCount = count;
        if (count > 0) {
          framesSeen = true;
          clearTimeout(observationTimeout);
        }
        // Emit transitions, including when callbacks stop or resume. A frame
        // advancing in this interval doesn't prove it reflects this geometry.
        const key = JSON.stringify({ seq: sampleGeometry?.seq, trackState, frameAdvanced, ...dimensions });
        if (lastKey !== key) {
          lastKey = key;
          emit({ type: 'capture', geometrySeq: sampleGeometry?.seq ?? null,
            frameAdvanced, trackState, ...dimensions });
        }
      } catch {
        if (!closeIntent) finish('capture-sample');
      } finally {
        busy = false;
      }
    }, 500);
  }
}

async function observeFrames() {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const [track] = stream.getVideoTracks();
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = stream;
  document.body.append(video);
  let count = 0, frame = null;
  function onFrame(_now, { width, height }) {
    count++;
    frame = { width, height }; // media pixels of a delivered frame, no pixel readback
    video.requestVideoFrameCallback(onFrame);
  }
  video.requestVideoFrameCallback(onFrame);
  await video.play();
  globalThis.p0Sample = () => {
    const { width, height, displaySurface } = track.getSettings();
    return { count, frame, trackState: track.readyState,
      settings: { width, height, displaySurface }, intrinsic: { width: video.videoWidth, height: video.videoHeight } };
  };
}

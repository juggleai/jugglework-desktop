// Standalone Electron entry point; never loads the JuggleWork application.
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const endpoint = 'https://meeting-window-p0.invalid/';
const origin = new URL(endpoint).origin;
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
  const ses = session.fromPartition('meeting-window-p0'); // in memory
  ses.protocol.handle('https', (request) => request.url === endpoint
    ? new Response('<!doctype html><meta charset="utf-8"><body></body>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'" },
    }) : new Response(null, { status: 404 }));
  const viewer = new BrowserWindow({ show: false, webPreferences: {
    session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
  } });
  await viewer.loadURL(endpoint);
  emit({ type: 'electron', electron: process.versions.electron, chromium: process.versions.chrome, arch: process.arch });

  const child = spawn(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'meeting-window-p0.ps1'), '-Probe',
  ], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  let finished = false, fixtureClosed = false, framesSeen = false;
  let poll, firstFrameTimeout;
  const identityTimeout = setTimeout(() => finish('fixture-startup-timeout'), 30_000);

  function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(identityTimeout);
    clearTimeout(firstFrameTimeout);
    clearInterval(poll);
    ses.setDisplayMediaRequestHandler(null);
    if (!viewer.isDestroyed()) viewer.destroy(); // releases the stream and any pending frame callbacks
    if (!fixtureClosed && child.exitCode === null) child.kill();
    if (error) emit({ type: 'error', stage: error });
    app.exit(error ? 1 : 0);
  }
  app.on('before-quit', () => finish('interrupted'));
  child.on('error', () => finish('fixture-spawn'));
  child.on('close', (code) => finish(code === 0 && fixtureClosed
    ? (framesSeen ? null : 'closed-before-frame-observed') : 'fixture-exit'));

  let sequence = 0, geometry;
  lines.on('line', (line) => {
    if (finished) return;
    let record;
    try { record = JSON.parse(line); } catch { return; }
    if (record.type === 'identity') {
      clearTimeout(identityTimeout);
      firstFrameTimeout = setTimeout(() => finish('first-frame-timeout'), 20_000);
      startCapture(record).catch(() => finish('capture-start'));
    } else if (record.type === 'fixture') {
      emit(record);
    } else if (record.type === 'geometry') {
      geometry = { seq: ++sequence, state: record.state };
      emit({ ...record, ...geometry,
        outerDip: record.outerPx ? screen.screenToDipRect(null, record.outerPx) : null,
        dwmDip: record.dwmPx ? screen.screenToDipRect(null, record.dwmPx) : null,
      });
    } else if (record.type === 'closed') {
      fixtureClosed = true;
      emit({ type: 'closed' });
    }
  });

  async function startCapture({ hwnd, title }) {
    if (!/^[1-9]\d*$/.test(hwnd) || !/^Meeting Window P0 [a-f0-9]{32}$/.test(title)) {
      return finish('invalid-fixture-identity');
    }
    let requested = false, matched = false;
    ses.setDisplayMediaRequestHandler(async (request, callback) => {
      if (requested || request.frame !== viewer.webContents.mainFrame || request.securityOrigin?.replace(/\/$/, '') !== origin ||
          !request.videoRequested || request.audioRequested) return callback({});
      requested = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ['window'],
          thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
        if (finished || fixtureClosed || child.exitCode !== null) return callback({});
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
      return finish(matched ? 'capture-start' : requested ? 'source-selection' : 'display-request');
    }
    if (finished) return;

    let lastKey, lastCount = 0, busy = false;
    poll = setInterval(async () => {
      if (busy || fixtureClosed) return;
      busy = true;
      const sampleGeometry = geometry;
      try {
        const sample = await viewer.webContents.executeJavaScript('globalThis.p0Sample()');
        if (finished || fixtureClosed) return;
        const { count, trackState, ...dimensions } = sample;
        const frameAdvanced = count > lastCount;
        lastCount = count;
        if (count > 0) {
          framesSeen = true;
          clearTimeout(firstFrameTimeout);
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
        if (!fixtureClosed) finish('capture-sample');
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

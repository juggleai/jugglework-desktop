// Fixture-only policy/runtime. No application imports or production feature flags.
const roles = ['ink', 'top', 'bottom', 'left', 'right'];
const box = (b) => b && ['x', 'y', 'width', 'height'].every((k) => Number.isSafeInteger(b[k])) && b.width > 0 && b.height > 0;
const same = (a, b) => box(a) && box(b) && ['x', 'y', 'width', 'height'].every((k) => a[k] === b[k]);
const contains = (a, b) => box(a) && box(b) && b.x >= a.x && b.y >= a.y &&
  b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
const decimal = (s) => typeof s === 'string' && /^[1-9]\d{0,19}$/.test(s) && BigInt(s) <= 0xffffffffffffffffn;

function overlayPlan(sample, evidence, screen, baseline) {
  const reject = (reason) => { throw new Error(`overlay-${reason}`); };
  if (sample?.status !== 'available') reject('unavailable');
  if (!decimal(sample.hwnd) || !decimal(sample.processCreated) || !Number.isSafeInteger(sample.pid) || sample.pid <= 0) reject('identity');
  if (baseline && (sample.hwnd !== baseline.sample.hwnd || sample.pid !== baseline.sample.pid ||
      sample.processCreated !== baseline.sample.processCreated)) reject('identity');
  if (baseline && sample.dpi !== baseline.sample.dpi) reject('dpi-change');
  if (sample.state !== 'normal') reject('state');
  const outer = sample.outerPx, client = evidence?.clientPx, border = evidence?.borderPx;
  if (!box(outer) || !box(sample.dwmPx) || !contains(outer, client) || !border ||
      ![border.x, border.y].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 64) ||
      outer.width <= border.x * 2 || outer.height <= border.y * 2) reject('geometry');
  if (baseline && (outer.width !== baseline.sample.outerPx.width || outer.height !== baseline.sample.outerPx.height)) reject('resize');
  // 80 DIP reserved for actual fixture buttons; title and client controls stay native.
  const controls = 80 * sample.dpi / 96;
  if (!Number.isSafeInteger(controls) || client.height <= controls) reject('geometry');
  const px = [
    { ...client, y: client.y + controls, height: client.height - controls },
    { x: outer.x, y: outer.y, width: outer.width, height: border.y },
    { x: outer.x, y: outer.y + outer.height - border.y, width: outer.width, height: border.y },
    { x: outer.x, y: outer.y + border.y, width: border.x, height: outer.height - 2 * border.y },
    { x: outer.x + outer.width - border.x, y: outer.y + border.y, width: border.x, height: outer.height - 2 * border.y },
  ];
  if (!px.every(box)) reject('geometry');
  const outerDip = screen.screenToDipRect(null, outer);
  const display = screen.getDisplayMatching(outerDip);
  if (!display || display.scaleFactor * 96 !== sample.dpi || !contains(display.bounds, outerDip) ||
      (baseline && display.id !== baseline.displayId)) reject('display');
  const dip = px.map((rect) => screen.screenToDipRect(null, rect));
  const mismatches = [outer, ...px].flatMap((rect, i) => {
    const mapped = i === 0 ? outerDip : dip[i - 1];
    const roundTripPx = box(mapped) ? screen.dipToScreenRect(null, mapped) : null;
    return same(roundTripPx, rect) ? [] : [{ role: i === 0 ? 'outer' : roles[i - 1],
      px: rect, dip: mapped ?? null, roundTripPx: roundTripPx ?? null }];
  });
  if (mismatches.length) {
    throw Object.assign(new Error('overlay-mapping'), { mapping: { dpi: sample.dpi, scaleFactor: display.scaleFactor, mismatches } });
  }
  if (baseline) {
    const dx = outer.x - baseline.sample.outerPx.x, dy = outer.y - baseline.sample.outerPx.y;
    if (!same(sample.dwmPx, { ...baseline.sample.dwmPx, x: baseline.sample.dwmPx.x + dx, y: baseline.sample.dwmPx.y + dy }) ||
        !same(client, { ...baseline.client, x: baseline.client.x + dx, y: baseline.client.y + dy }) ||
        border.x !== baseline.border.x || border.y !== baseline.border.y) reject('mapping-change');
  }
  return { px, dip, displayId: display.id, sample, client, border };
}

function checkLayers(layers, own, plan) {
  if (!Array.isArray(layers) || layers.length !== roles.length || own.length !== roles.length) return 'identity';
  for (let i = 0; i < roles.length; i++) {
    const layer = layers[i];
    if (!layer || layer.role !== roles[i] || !decimal(layer.hwnd) || layer.hwnd !== own[i].hwnd) return 'identity';
    if (layer.topmost !== false) return 'topmost';
    if (layer.dpi !== plan.sample.dpi) return 'dpi';
    if (layer.visible !== true) return 'visibility';
    if (!same(layer.outerPx, plan.px[i])) return 'geometry';
  }
  return layers.every((l) => l.adjacent === true) ? 'ok' : 'order';
}

function nativeHandle(buffer) {
  if (!Buffer.isBuffer(buffer) || ![4, 8].includes(buffer.length)) throw new Error('overlay-handle');
  const hwnd = buffer.length === 8 ? buffer.readBigUInt64LE().toString() : buffer.readUInt32LE().toString();
  if (!decimal(hwnd)) throw new Error('overlay-handle');
  return hwnd;
}

function layerPage(role) {
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
    <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;user-select:none;touch-action:none;
    cursor:default;background:${role === 'ink' ? 'rgba(0,0,0,0.01)' : 'rgba(255,180,0,0.18)'}}
    svg{width:100%;height:100%;pointer-events:none}text{font:18px sans-serif;fill:#ff35c8}</style>
    ${role === 'ink' ? '<svg viewBox="0 0 640 360" preserveAspectRatio="none"><path d="M80 220 Q260 60 420 180 L540 100" fill="none" stroke="#ff35c8" stroke-width="8"/><text x="100" y="270">P0 STATIC INK — fixture only</text></svg>' : ''}
    <script>let clicks=0,drags=0,start=null;
    document.onpointerdown=e=>{clicks++;start={x:e.clientX,y:e.clientY};document.body.setPointerCapture(e.pointerId)};
    document.onpointerup=e=>{if(start&&Math.hypot(e.clientX-start.x,e.clientY-start.y)>4)drags++;start=null};
    document.onpointercancel=()=>{start=null};globalThis.p0Input=()=>({clicks,drags});</script>`;
}

function createFixtureOverlay({ BrowserWindow, screen, title, emit, fail }) {
  let windows = [], own = [], baseline, current, mode = 'pointer', verified = false, disposed = false;
  const lastCounts = new Map();
  let telemetryPoll, telemetryDeadline, telemetryPending = false;
  function suspend() {
    verified = false;
    for (const win of windows) if (!win.isDestroyed()) win.setIgnoreMouseEvents(true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    clearInterval(telemetryPoll);
    clearTimeout(telemetryDeadline);
    suspend();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
  }
  function abort(reason) { dispose(); fail(reason); }
  function applyMode() {
    windows.forEach((win, i) => win.setIgnoreMouseEvents(!verified || (i === 0 && mode === 'pointer')));
  }
  async function sampleInputs() {
    if (disposed || !verified || telemetryPending) return;
    telemetryPending = true;
    telemetryDeadline = setTimeout(() => abort('overlay-telemetry-timeout'), 5_000);
    try {
      for (let i = 0; i < windows.length; i++) {
        if (disposed) return;
        const sampledMode = mode;
        const counts = await windows[i].webContents.executeJavaScript('globalThis.p0Input()');
        if (disposed) return;
        if (!counts || ![counts.clicks, counts.drags].every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error('overlay-counters');
        const key = JSON.stringify(counts);
        if (lastCounts.get(i) !== key) {
          lastCounts.set(i, key);
          emit({ type: 'overlay-input', role: roles[i], mode: sampledMode, ...counts });
        }
      }
    } catch (error) {
      if (!disposed) abort(error.message === 'overlay-counters' ? 'overlay-counters' : 'overlay-telemetry');
    } finally {
      clearTimeout(telemetryDeadline);
      telemetryPending = false;
    }
  }
  async function observe(sample, evidence) {
    if (disposed) return;
    try {
      const plan = overlayPlan(sample, evidence, screen, baseline);
      if (!baseline) baseline = plan;
      const previous = current;
      const moved = previous && !same(previous.sample.outerPx, plan.sample.outerPx);
      current = plan;
      if (windows.length === 0) {
        for (const [i, role] of roles.entries()) {
          const win = new BrowserWindow({ show: false, frame: false, transparent: true, backgroundColor: '#00000000',
            ...plan.dip[i],
            title: `${title} Overlay ${role}`, alwaysOnTop: false, focusable: false, skipTaskbar: true,
            hasShadow: false, thickFrame: false, roundedCorners: false, resizable: false, movable: false,
            minimizable: false, maximizable: false, fullscreenable: false,
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
          windows.push(win);
          win.setIgnoreMouseEvents(true);
          win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          win.webContents.on('will-navigate', (event) => event.preventDefault());
          win.webContents.on('render-process-gone', () => { if (!disposed) abort('overlay-renderer'); });
          own.push({ role, hwnd: nativeHandle(win.getNativeWindowHandle()), title: `${title} Overlay ${role}` });
          await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(layerPage(role))}`);
          if (disposed) return;
        }
        if (new Set(own.map((l) => l.hwnd)).size !== 5) throw new Error('overlay-identity');
        windows.forEach((win, i) => { win.setBounds(plan.dip[i]); win.showInactive(); });
        emit({ type: 'overlay', stage: 'awaiting-native-layers', mode });
        return;
      }
      // On translation the readback describes our last placement, not the
      // new bounds. Verify that old placement (including Z order) before moving.
      const result = checkLayers(evidence?.layers, own, moved ? previous : plan);
      if (result !== 'ok') throw new Error(`overlay-${result}`);
      if (moved) {
        suspend();
        windows.forEach((win, i) => win.setBounds(plan.dip[i]));
        emit({ type: 'overlay', stage: 'following-awaiting-readback', mode });
        return;
      }
      const wasVerified = verified;
      verified = true;
      applyMode();
      if (!wasVerified) emit({ type: 'overlay', stage: 'native-verified', mode, dpi: sample.dpi,
        layers: evidence.layers, plannedPx: plan.px, plannedDip: plan.dip });
      // Telemetry is independent of observe: renderer latency must not hold the
      // launcher's native-sampling processing gate while inputs are enabled.
      if (!telemetryPoll) telemetryPoll = setInterval(sampleInputs, 500);
    } catch (error) {
      if (disposed) return;
      if (error.message === 'overlay-mapping' && error.mapping) {
        emit({ type: 'overlay', stage: 'mapping-mismatch', ...error.mapping });
      }
      abort(error.message?.startsWith('overlay-') ? error.message : 'overlay-runtime');
    }
  }
  return { observe, dispose, identities: () => own.map((l) => ({ ...l })),
    setMode(next) {
      if (disposed) return;
      if (!['pointer', 'draw'].includes(next)) return abort('overlay-mode');
      mode = next;
      applyMode();
      emit({ type: 'overlay', stage: 'mode', mode, nativeVerified: verified });
    } };
}

module.exports = { overlayPlan, checkLayers, createFixtureOverlay };

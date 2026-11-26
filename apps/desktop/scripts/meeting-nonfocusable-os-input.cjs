// Independent Windows OS-input experiment. Does not load the product controller/UI.
// Usage: electron this.cjs --ffi ABS_KOFFI --helper ABS_HELPER --evidence ABS_JSON
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { holdApp, trackChild, finishChild } = require('./meeting-window-validation-lifetime.cjs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { experiment: 'nonfocusable-os-input', records: [], pass: false };
const windows = [], children = [];
let foregroundViolations = 0;
const record = (stage, values) => { const row = { stage, ...values }; evidence.records.push(row); console.log(JSON.stringify(row)); };
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const release = holdApp(app);
// A separate disposable profile; no current app profile, dev server or secrets.
app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'meeting-nonfocusable-')));
const profile = app.getPath('userData');
app.whenReady().then(async () => {
  let user32, send, held = false;
  try {
    check(process.platform === 'win32' && process.arch === 'x64', 'requires-windows-x64');
    for (const name of ['--ffi', '--helper', '--evidence']) check(process.argv.includes(name) && path.isAbsolute(arg(name)), 'absolute-arguments-required');
    const k = require(arg('--ffi'));
    user32 = k.load('user32.dll');
    const foreground = user32.func('uintptr_t GetForegroundWindow()');
    const pidOf = user32.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
    const root = user32.func('uintptr_t GetAncestor(uintptr_t hwnd, uint32_t flags)');
    const hit = user32.func('uintptr_t WindowFromPoint(int64_t point)');
    const style = user32.func('int32_t GetWindowLongW(uintptr_t hwnd, int32_t index)');
    const key = user32.func('int16_t GetAsyncKeyState(int32_t key)');
     const metric = user32.func('int32_t GetSystemMetrics(int32_t index)');
     const rect = k.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
     const getRect = user32.func('GetWindowRect', 'int32_t', ['uintptr_t', k.out(k.pointer(rect))]);
     const getFrame = k.load('dwmapi.dll').func('DwmGetWindowAttribute', 'int32_t', ['uintptr_t', 'uint32_t', k.out(k.pointer(rect)), 'uint32_t']);
     const cursor = user32.func('GetCursorPos', 'int32_t', [k.out(k.pointer(k.struct({ x: 'int32_t', y: 'int32_t' })))]);
    const input = user32.func('uint32_t SendInput(uint32_t count, const void *inputs, int32_t size)');
    send = (flags, x = 0, y = 0) => {
      const b = Buffer.alloc(40); // Win64 INPUT: 8-byte header + 32-byte MOUSEINPUT.
      b.writeInt32LE(x, 8); b.writeInt32LE(y, 12); b.writeUInt32LE(flags, 20);
      check(input(1, b, 40) === 1, 'SendInput-refused');
    };
    const display = screen.getPrimaryDisplay();
    check(screen.getAllDisplays().length === 1 && display.scaleFactor === 1, 'requires-single-display-dpi96');
    const work = display.workArea;
    check(work.width >= 800 && work.height >= 600, 'work-area-too-small');
    const bounds = { x: work.x + 100, y: work.y + 160, width: 480, height: 280 };
    const create = options => { const w = new BrowserWindow({ show: false, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'nonfocusable-fixture' }, ...options }); windows.push(w); return w; };
    const target = create({ ...bounds, focusable: true });
    const canvas = create({ ...bounds, transparent: true, backgroundColor: '#00000000', focusable: false });
    const toolbar = create({ x: bounds.x, y: bounds.y - 70, width: 480, height: 50, focusable: true });
    const load = (win, html) => win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await load(target, '<body style="background:#233544;color:white">独立输入实验：自有目标</body>');
    await load(toolbar, '<body style="margin:0;background:#192030;color:white"><button style="width:100%;height:50px">独立实验工具栏（保持前台）</button></body>');
    await load(canvas, `<body style="margin:0;overflow:hidden;background:transparent;touch-action:none"><canvas width="480" height="280"></canvas><script>
      globalThis.events=[];let drawing=false;const c=document.querySelector('canvas'),ctx=c.getContext('2d');
      ctx.strokeStyle='#ff00cc';ctx.lineWidth=8;
      for(const type of ['pointerdown','pointermove','pointerup','pointercancel']) addEventListener(type,e=>{
        events.push({type:e.type,trusted:e.isTrusted,x:e.clientX,y:e.clientY,buttons:e.buttons});
        if(e.type==='pointerdown'){drawing=true;ctx.beginPath();ctx.moveTo(e.clientX,e.clientY);c.setPointerCapture(e.pointerId)}
        if(e.type==='pointermove'&&drawing){ctx.lineTo(e.clientX,e.clientY);ctx.stroke()}
        if(e.type==='pointerup'||e.type==='pointercancel')drawing=false;
      });globalThis.inkPixels=()=>{const p=ctx.getImageData(0,0,480,280).data;let n=0;for(let i=3;i<p.length;i+=4)if(p[i])n++;return n};
      </script></body>`);
    canvas.setIgnoreMouseEvents(false);
    const handles = windows.map(w => w.getNativeWindowHandle().readBigUInt64LE());
     const [targetH, canvasH, toolbarH] = handles;
     // Observe activation synchronously as well as at every input checkpoint.
     let observing = false;
     for (const win of windows) win.hookWindowMessage(0x0006, () => {
       if (observing && BigInt(foreground()) !== toolbarH) foregroundViolations++;
     });
    const own = h => { const p = [0]; return pidOf(h, p) !== 0 && p[0] === process.pid && BigInt(root(h, 2)) === h; };
    check(handles.every(own), 'fixture-identity');
    const spawnHelper = (...args) => { const child = spawn(...args); children.push(trackChild(child, 'strict-helper')); return child; };
    const { createWindowsWindowIdentity } = await import('../electron/meeting-window-identity-windows.mjs');
    const { createWindowsCanvasPlacement } = await import('../electron/meeting-window-placement-windows.mjs');
    const identity = await createWindowsWindowIdentity({ helperPath: arg('--helper'), spawnHelper }).resolveWindowsIdentity(String(targetH));
    check(identity?.pid === process.pid, 'native-target-identity');
    const scoped = { platform: 'win32', windowId: String(targetH), ...identity };
    const place = createWindowsCanvasPlacement({ helperPath: arg('--helper'), spawnHelper });
    const strict = async (stage, visible, checkOnly = false) => {
      let reason, context;
      const result = await place(canvas, scoped, { bounds, visible, checkOnly, onDiagnostic: v => { reason = v; }, onCheckContext: v => { context = v; } });
      record(stage, { result, reason, context }); check(result === true, 'strict-adjacency-refused');
    };
     target.show(); toolbar.show(); toolbar.focus(); await delay(300);
     check(BigInt(foreground()) === toolbarH, 'toolbar-not-foreground');
     const targetFrame = {};
     check(getFrame(targetH, 9, targetFrame, 16) === 0, 'target-frame-unavailable');
     // Chromium's frameless HWND may still have DWM inset borders. Use the
     // production contract's exact frame, rather than assuming Electron bounds.
     Object.assign(bounds, { x: targetFrame.left, y: targetFrame.top, width: targetFrame.right - targetFrame.left, height: targetFrame.bottom - targetFrame.top });
     canvas.setBounds(bounds);
     record('target-frame', { bounds });
    await strict('place-hidden', false);
    canvas.showInactive(); await strict('place-visible', true);
    for (let i = 1; i <= 14; i++) { await strict(`stationary-${i}`, true, true); await delay(40); }
    const sx = metric(76), sy = metric(77), sw = metric(78), sh = metric(79);
    const points = Array.from({ length: 9 }, (_, i) => ({ x: bounds.x + 100 + i * 24, y: bounds.y + 110 + i * 4 }));
     const safety = p => {
      check(handles.every(own) && windows.every(w => !w.isDestroyed() && w.isVisible()), 'fixture-state-changed');
      check(!canvas.isFocusable() && toolbar.isFocusable() && (style(canvasH, -20) & 0x08000000) !== 0, 'focusability-changed');
       check(BigInt(foreground()) === toolbarH, 'foreground-changed');
       check(foregroundViolations === 0, 'foreground-activation-observed');
       const r = {};
       check(getRect(canvasH, r) && r.left === bounds.x && r.top === bounds.y && r.right === bounds.x + bounds.width && r.bottom === bounds.y + bounds.height, 'canvas-geometry-changed');
      const packed = BigInt.asIntN(64, (BigInt(p.y >>> 0) << 32n) | BigInt(p.x >>> 0));
      check(BigInt(root(hit(packed), 2)) === canvasH, 'point-not-owned-canvas');
      check(![2, 4, 16, 17, 18, 91, 92].some(v => key(v) & 0x8000), 'user-input-active');
    };
     check(!(key(1) & 0x8000), 'left-button-already-down');
     observing = true;
    record('environment', { electron: process.versions.electron, chromium: process.versions.chrome, pid: process.pid, bounds, canvasFocusable: canvas.isFocusable(), toolbarFocusable: toolbar.isFocusable(), nativeNoActivate: Boolean(style(canvasH, -20) & 0x08000000), foreground: 'fixture-toolbar' });
    for (let i = 0; i < points.length; i++) {
      await strict(`pre-input-${i}`, true, true); safety(points[i]);
       send(0x8000 | 0x4000 | 0x0001, Math.round((points[i].x - sx) * 65535 / (sw - 1)), Math.round((points[i].y - sy) * 65535 / (sh - 1)));
       const actual = {};
       check(cursor(actual) && actual.x === points[i].x && actual.y === points[i].y, 'cursor-position-mismatch');
      if (i === 0) { safety(points[i]); send(0x0002); held = true; }
      await delay(45); safety(points[i]);
    }
     safety(points.at(-1)); send(0x0004); held = false; await delay(150);
    await strict('post-input-strict', true, true);
    const result = await canvas.webContents.executeJavaScript('({events:globalThis.events,inkPixels:globalThis.inkPixels()})');
    const down = result.events.filter(e => e.type === 'pointerdown'), up = result.events.filter(e => e.type === 'pointerup');
    const moves = result.events.filter(e => e.type === 'pointermove' && e.buttons === 1);
    check(down.length === 1 && up.length === 1 && moves.length >= 5 && result.events.every(e => e.trusted) && result.inkPixels > 500, 'draw-events-incomplete');
    check(BigInt(foreground()) === toolbarH && !canvas.isFocused() && toolbar.isFocusable(), 'foreground-final');
     check(foregroundViolations === 0, 'foreground-activation-observed');
     record('physical-input-result', { ...result, draggingMoves: moves.length, foregroundUnchanged: true, foregroundViolations, canvasFocused: canvas.isFocused(), toolbarFocusable: toolbar.isFocusable() });
    evidence.pass = true;
  } catch (error) { record('stopped', { reason: error.message }); }
  finally {
    if (held && send) { try { send(0x0004); held = false; } catch { /* cleanup remains unconfirmed */ } }
     evidence.processIds = [...new Set([process.pid, ...app.getAppMetrics().map(v => v.pid), ...children.map(v => v.child.pid).filter(Boolean)])];
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    const childCleanup = await Promise.all(children.map(c => finishChild(c, () => c.child.kill())));
     evidence.cleanup = { windowsDestroyed: windows.every(w => w.isDestroyed()), buttonReleased: !held, helpersClosed: childCleanup.every(c => c.closed), helperCount: children.length, childCleanup };
    record('cleanup', evidence.cleanup);
     evidence.profilePath = profile;
     try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
     catch { evidence.cleanup.profileRemovalDeferred = true; }
    fs.writeFileSync(arg('--evidence'), JSON.stringify(evidence, null, 2));
     release(); app.exit(evidence.pass && evidence.cleanup.windowsDestroyed && evidence.cleanup.helpersClosed && !held ? 0 : 1);
  }
});

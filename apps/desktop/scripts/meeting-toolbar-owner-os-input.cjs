// Isolated extension of meeting-nonfocusable-os-input.cjs: same Win64 INPUT,
// identity/place adapters and lifecycle; real toolbar clicks, no product entry.
const { app, BrowserWindow, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { holdApp, trackChild, finishChild } = require('./meeting-window-validation-lifetime.cjs');
const { recoverOnce } = require('./meeting-toolbar-owner-recovery.cjs');
const arg = name => process.argv[process.argv.indexOf(name) + 1];
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { experiment: 'toolbar-owner-os-input', arm: arg('--arm'), round: Number(arg('--round')), records: [], completed: [], pass: false };
const windows = [], children = [], pids = new Set([process.pid]);
const release = holdApp(app);
app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'meeting-toolbar-owner-')));
const profile = app.getPath('userData');
let held = false, send, targetChild, targetRecord, buttonState;
const targetMessages = [];
const crossProcess = process.argv.includes('--cross-process-target');
const scenario = process.argv.includes('--scenario') ? arg('--scenario') : 'layers-before-target';
const targetBeforeLayers = scenario === 'target-before-layers';
const anchorRoles = scenario === 'anchor-roles-no-input' || process.argv.includes('--fixture-anchor-roles');
evidence.scenario = scenario;
const until = async fn => {
  const expires = performance.now() + 10000;
  while (performance.now() < expires) { const value = fn(); if (value) return value; await delay(10); }
  throw new Error('fixture-protocol-timeout');
};
const targetCount = async () => {
  const mark = targetMessages.length;
  targetChild.stdin.write('input-count\n');
  return (await until(() => targetMessages.slice(mark).find(v => v.type === 'input-count'))).clicks;
};
let snapshot = () => ({});
const record = (stage, values = {}) => { const row = { stage, ...snapshot(), ...values }; evidence.records.push(row); console.log(JSON.stringify(row)); };
const complete = stage => evidence.completed.push(stage);
const stages = ['initial-placement', 'target-activation', 'pen-click', 'pen-placement', 'canvas-drag', 'pointer-click', 'pointer-placement', 'target-through'];
const collectPids = () => { for (const m of app.getAppMetrics()) pids.add(m.pid); };
app.whenReady().then(async () => {
  const deadline = setTimeout(() => { record('deadline'); app.exit(2); }, 45000);
  try {
    check(process.platform === 'win32' && process.arch === 'x64', 'requires-windows-x64');
    for (const n of ['--ffi', '--helper', '--evidence']) check(process.argv.includes(n) && path.isAbsolute(arg(n)), 'absolute-arguments-required');
    check(['detached', 'parent-canvas'].includes(evidence.arm) && [1, 2].includes(evidence.round), 'fixed-arm-and-round-required');
    check(['layers-before-target', 'target-before-layers', 'anchor-roles-no-input'].includes(scenario) &&
      (!(targetBeforeLayers || anchorRoles) || (crossProcess && evidence.arm === 'parent-canvas')), 'invalid-scenario');
    check(!process.argv.includes('--fixture-anchor-roles') || targetBeforeLayers, 'anchor-role-click-requires-target-before-layers');
    check(!fs.existsSync(arg('--evidence')), 'existing-evidence-no-rerun');
    const k = require(arg('--ffi')), u = k.load('user32.dll');
    const fg = u.func('uintptr_t GetForegroundWindow()');
    const pidOf = u.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
    const root = u.func('uintptr_t GetAncestor(uintptr_t hwnd, uint32_t flags)');
    const getWindow = u.func('uintptr_t GetWindow(uintptr_t hwnd, uint32_t cmd)');
    const hit = u.func('uintptr_t WindowFromPoint(int64_t point)');
    const style = u.func('int32_t GetWindowLongW(uintptr_t hwnd, int32_t index)');
    const key = u.func('int16_t GetAsyncKeyState(int32_t key)');
    const metric = u.func('int32_t GetSystemMetrics(int32_t index)');
    const rect = k.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
    const getRect = u.func('GetWindowRect', 'int32_t', ['uintptr_t', k.out(k.pointer(rect))]);
    const getFrame = k.load('dwmapi.dll').func('DwmGetWindowAttribute', 'int32_t', ['uintptr_t', 'uint32_t', k.out(k.pointer(rect)), 'uint32_t']);
    const cursor = u.func('GetCursorPos', 'int32_t', [k.out(k.pointer(k.struct({ x: 'int32_t', y: 'int32_t' })))]);
    const input = u.func('uint32_t SendInput(uint32_t count, const void *inputs, int32_t size)');
    send = (flags, x = 0, y = 0) => {
      const b = Buffer.alloc(40); b.writeInt32LE(x, 8); b.writeInt32LE(y, 12); b.writeUInt32LE(flags, 20);
      check(input(1, b, 40) === 1, 'SendInput-refused');
    };
    const d = screen.getPrimaryDisplay(), work = d.workArea;
    check(screen.getAllDisplays().length === 1 && d.scaleFactor === 1 && work.width >= 800 && work.height >= 600, 'requires-single-display-dpi96');
    const bounds = { x: work.x + 100, y: work.y + 160, width: 480, height: 280 };
    const create = options => {
      const w = new BrowserWindow({ show: false, frame: false, resizable: false, hasShadow: false, skipTaskbar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'owner-fixture' }, ...options });
      windows.push(w); return w;
    };
     check(!crossProcess || evidence.arm === 'parent-canvas', 'cross-process-requires-production-owner');
     let target, targetH, targetPid = process.pid;
     if (crossProcess) {
       targetChild = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'meeting-window-validation-target.ps1'),
         '-InitialX', String(bounds.x), '-InitialY', String(bounds.y)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
       targetRecord = trackChild(targetChild, 'native-target'); children.push(targetRecord);
       if (targetChild.pid) pids.add(targetChild.pid);
       targetChild.stdin.on('error', () => {});
       createInterface({ input: targetChild.stdout }).on('line', line => { try { targetMessages.push(JSON.parse(line)); } catch {} });
       const ready = await until(() => targetMessages.find(v => v.type === 'ready'));
       targetH = BigInt(ready.hwnd); targetPid = targetChild.pid;
     } else {
       target = create({ ...bounds, focusable: true });
       targetH = target.getNativeWindowHandle().readBigUInt64LE();
     }
    const canvas = create({ ...bounds, transparent: true, backgroundColor: '#00000000', focusable: false });
    const toolbar = create({ x: bounds.x, y: bounds.y - 70, width: 480, height: 50, focusable: true,
      ...(evidence.arm === 'parent-canvas' ? { parent: canvas } : {}) });
     const [canvasH, toolbarH] = [canvas, toolbar].map(w => w.getNativeWindowHandle().readBigUInt64LE());
     const own = h => { const p = [0]; return pidOf(h, p) !== 0 && p[0] === (h === targetH ? targetPid : process.pid) && BigInt(root(h, 2)) === h; };
     const visible = u.func('int32_t IsWindowVisible(uintptr_t hwnd)');
     buttonState = () => Boolean(key(1) & 0x8000);
    const expectedOwner = evidence.arm === 'parent-canvas' ? canvasH : 0n;
    const ownerOK = () => BigInt(getWindow(toolbarH, 4)) === expectedOwner;
    snapshot = () => ({ foreground: BigInt(fg()) === targetH ? 'target' : BigInt(fg()) === toolbarH ? 'toolbar' : 'other',
      canvasFocused: !canvas.isDestroyed() && canvas.isFocused(), toolbarFocused: !toolbar.isDestroyed() && toolbar.isFocused(),
      ownerVerified: ownerOK(), toolbarOwnerReadback: BigInt(getWindow(toolbarH, 4)) === canvasH ? 'canvas' : BigInt(getWindow(toolbarH, 4)) === 0n ? 'none' : 'unexpected' });
    check([targetH, canvasH, toolbarH].every(own) && ownerOK(), 'fixture-identity-or-owner');
    record('native-owner', { toolbarOwnerReadback: expectedOwner === canvasH ? 'canvas' : 'none', verified: ownerOK(), pid: process.pid });
    const readRect = h => { const r = {}; check(getRect(h, r), 'native-rectangle-unavailable'); return r; };
    const expectedRects = new Map();
    const load = (w, html) => w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const observer = `<script>globalThis.events=[];for(const t of ['pointerdown','pointermove','pointerup','click'])addEventListener(t,e=>events.push({type:e.type,trusted:e.isTrusted,buttons:e.buttons,x:e.clientX,y:e.clientY,id:e.target.id||''}));</script>`;
     if (target) await load(target, '<body style="margin:0;background:#233544;color:white">独立自有 target</body>' + observer);
     const targetDowns = () => crossProcess ? targetCount() : target.webContents.executeJavaScript('events.filter(e=>e.type==="pointerdown").length');
    await load(toolbar, `<body style="margin:0;background:#192030"><button id="pen" style="width:220px;height:50px">Pen</button><button id="pointer" style="width:220px;height:50px">Pointer</button>${observer}<script>globalThis.tool='pointer';for(const id of ['pen','pointer'])document.getElementById(id).addEventListener('click',e=>{if(e.isTrusted){globalThis.tool=id;document.body.dataset.tool=id}});</script>`);
    await load(canvas, `<body style="margin:0;overflow:hidden;touch-action:none;background:transparent"><canvas width="480" height="280"></canvas>${observer}<script>
      const c=document.querySelector('canvas'),ctx=c.getContext('2d');let drawing=false;ctx.strokeStyle='#ff00cc';ctx.lineWidth=8;
      addEventListener('pointerdown',e=>{drawing=true;ctx.beginPath();ctx.moveTo(e.clientX,e.clientY);c.setPointerCapture(e.pointerId)});
      addEventListener('pointermove',e=>{if(drawing){ctx.lineTo(e.clientX,e.clientY);ctx.stroke()}});
      addEventListener('pointerup',()=>drawing=false);
      globalThis.inkPixels=()=>{const p=ctx.getImageData(0,0,480,280).data;let n=0;for(let i=3;i<p.length;i+=4)if(p[i])n++;return n};</script>`);
    const spawnHelper = (...args) => {
      if (anchorRoles && ['place', 'check'].includes(args[1][0])) {
        args[1] = [...args[1], String(toolbarH)];
        args[2] = { ...args[2], stdio: ['ignore', 'pipe', 'pipe'] };
      }
      const c = spawn(...args);
      if (anchorRoles && c.stderr) {
        createInterface({ input: c.stderr }).on('line', line => {
          try { const v = JSON.parse(line); record('anchor-role-diagnostic', v); } catch { /* no raw diagnostics */ }
        });
      }
      children.push(trackChild(c, anchorRoles ? 'anchor-role-helper' : 'standard-helper')); if (c.pid) pids.add(c.pid); return c;
    };
    const { createWindowsWindowIdentity } = await import('../electron/meeting-window-identity-windows.mjs');
    const { createWindowsCanvasPlacement } = await import('../electron/meeting-window-placement-windows.mjs');
    const identityAdapter = createWindowsWindowIdentity({ helperPath: arg('--helper'), spawnHelper });
    const identity = await identityAdapter.resolveWindowsIdentity(String(targetH));
     check(identity?.pid === targetPid, 'native-target-identity');
     record('target-process', { crossProcess, targetPid, identityVerified: true, implementation: crossProcess ? 'existing-native-Win32-fixture' : 'Electron' });
    const scoped = { platform: 'win32', windowId: String(targetH), ...identity };
    const place = createWindowsCanvasPlacement({ helperPath: arg('--helper'), spawnHelper });
    let recoveryUsed = false, mode = 'pointer';
    const strict = async (stage, visible = true, checkOnly = true, allowRecovery = false, deferRecoveryOrder = false) => {
      let reason, context;
      const result = await place(canvas, scoped, { bounds, visible, checkOnly, onDiagnostic: v => reason = v, onCheckContext: v => context = v });
      record(stage, { result, reason, context, foreground: BigInt(fg()) === targetH ? 'target' : BigInt(fg()) === toolbarH ? 'toolbar' : 'other', canvasFocused: canvas.isFocused() });
      if (result === 'hidden-host-target-not-below' && mode === 'pointer' && allowRecovery && !recoveryUsed) {
        recoveryUsed = true;
        record('recovery-start', { trigger: stage, result });
        await recoverOnce({ watchWindow: identityAdapter.watchWindow, target: scoped, suspend, record, mode,
          layout: async (sample, active) => {
            // The watcher actualSize is GetWindowRect, not the DWM mapping
            // bounds. Compare against the original native outer-size baseline.
            const initialOuter = expectedRects.get(targetH);
             check(sample.pid === targetPid && sample.actualSize.width === initialOuter.right - initialOuter.left &&
              sample.actualSize.height === initialOuter.bottom - initialOuter.top, 'recovery-target-size-or-identity');
            Object.assign(bounds, sample.bounds);
            canvas.setBounds(bounds);
            expectedRects.set(targetH, readRect(targetH));
            expectedRects.set(canvasH, { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height });
            await layout('recovery-pointer', active, true);
          } });
        return;
      }
      if (result !== true) throw Object.assign(new Error(`${stage}:strict-adjacency-refused`), { result, deferRecoveryOrder });
    };
    // No show()/focus()/SetForegroundWindow: all activation must come from OS clicks.
     if (target) target.showInactive(); await delay(200);
    const f = {}; check(getFrame(targetH, 9, f, 16) === 0, 'target-frame-unavailable');
    Object.assign(bounds, { x: f.left, y: f.top, width: f.right - f.left, height: f.bottom - f.top });
     canvas.setBounds(bounds);
     if (crossProcess) toolbar.setBounds({ x: bounds.x, y: bounds.y - 70, width: 480, height: 50 });
    expectedRects.set(targetH, readRect(targetH)); expectedRects.set(canvasH, { left: bounds.x, top: bounds.y, right: bounds.x + bounds.width, bottom: bounds.y + bounds.height });
    expectedRects.set(toolbarH, readRect(toolbarH));
     let layersSuspended = false;
     const suspend = () => {
       for (const w of [canvas, toolbar]) { w.setIgnoreMouseEvents(true, { forward: true }); w.hide(); }
       layersSuspended = true;
    };
    const layout = async (requestedMode, active = () => {}, recovery = false) => {
      // Mirrors suspendWindowsLayers + hidden/place/show/visible/toolbar/final.
      suspend(); active();
      await strict(`${requestedMode}-hidden`, false, false, false, recovery); active();
      canvas.showInactive(); await strict(`${requestedMode}-visible`, true, false, false, recovery); active();
      toolbar.showInactive(); await strict(`${requestedMode}-final`); active();
       canvas.setIgnoreMouseEvents(requestedMode !== 'pen', { forward: true }); toolbar.setIgnoreMouseEvents(false);
       layersSuspended = false;
     };
     const sx = metric(76), sy = metric(77), sw = metric(78), sh = metric(79);
     const safety = (p, expectedH, preparation = false) => {
        check((preparation ? targetBeforeLayers && expectedH === targetH && layersSuspended &&
          [canvas, toolbar].every(w => !w.isDestroyed() && !w.isVisible() && !visible(w.getNativeWindowHandle().readBigUInt64LE())) :
          windows.every(w => !w.isDestroyed() && w.isVisible())) && visible(targetH) && (!targetRecord || !targetRecord.exited) && [targetH, canvasH, toolbarH].every(own) && ownerOK(), 'identity-owner-visibility-changed');
      check(!canvas.isFocusable() && toolbar.isFocusable() && (style(canvasH, -20) & 0x08000000) !== 0 && !canvas.isFocused(), 'focusability-changed');
      for (const [h, expected] of expectedRects) { const r = readRect(h); check(Object.keys(expected).every(n => r[n] === expected[n]), 'native-rectangle-changed'); }
      const r = expectedRects.get(expectedH); check(p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom, 'point-outside-expected-window');
      const packed = BigInt.asIntN(64, BigInt(p.y >>> 0) << 32n | BigInt(p.x >>> 0));
      check(BigInt(root(hit(packed), 2)) === expectedH, 'hit-not-expected-self-window');
      check(![2, 4, 16, 17, 18, 91, 92].some(v => key(v) & 0x8000), 'user-input-active');
      check(Boolean(key(1) & 0x8000) === held, 'left-button-state-mismatch');
    };
     const move = (p, h, preparation = false) => {
       safety(p, h, preparation); send(0x8000 | 0x4000 | 1, Math.round((p.x - sx) * 65535 / (sw - 1)), Math.round((p.y - sy) * 65535 / (sh - 1)));
       const actual = {}; check(cursor(actual) && actual.x === p.x && actual.y === p.y, 'cursor-readback-mismatch'); safety(p, h, preparation);
    };
    const click = async (stage, p, h) => {
      await strict(`${stage}-pre-move`); move(p, h);
      await strict(`${stage}-pre-down`); safety(p, h); send(2); held = true;
      // Mouse-up at the verified own hit is synchronous: don't leave a held
      // button across an async helper that activation may cause to reject.
      safety(p, h); send(4); held = false; await delay(160);
      record(`${stage}-os-click`, { selfHit: true, canvasFocused: canvas.isFocused() });
       if (h === toolbarH) mode = await toolbar.webContents.executeJavaScript('globalThis.tool');
       if (h === toolbarH) record(`${stage}-dom-before-strict`, await toolbar.webContents.executeJavaScript('({tool:globalThis.tool,events:globalThis.events})'));
      await strict(`${stage}-post-activation`, true, true, true);
     };
     const targetPoint = { x: bounds.x + 150, y: bounds.y + 160 };
     record('environment', { electron: process.versions.electron, chromium: process.versions.chrome, pid: process.pid, bounds,
       toolbarOwnerReadback: ownerOK() ? evidence.arm === 'parent-canvas' ? 'canvas' : 'none' : 'unexpected', canvasNoActivate: Boolean(style(canvasH, -20) & 0x08000000) });
      if (scenario === 'anchor-roles-no-input') {
        suspend();
        check([targetH, canvasH, toolbarH].every(own) && ownerOK() && visible(targetH) &&
          [canvasH, toolbarH].every(h => !visible(h)) && !canvas.isFocusable() && toolbar.isFocusable(), 'no-input-preconditions');
        const mark = targetMessages.length;
        targetChild.stdin.write('activate\n');
        const activated = await until(() => targetMessages.slice(mark).find(v => v.type === 'ack' && v.action === 'activate'));
        check(activated.ok && BigInt(fg()) === targetH, 'program-activation-refused');
        record('target-program-activation', { noInjectedInput: true, nativeMouseDowns: await targetCount() });
        await layout('initial'); complete('initial-placement');
        evidence.pass = true;
        return; // Diagnostic scenario never enters any input/recovery path.
      } else if (targetBeforeLayers) {
       // No adjacency exists yet: both layers are hidden and explicitly ignore
       // input. This sole preparation click retains all native input gates.
       suspend();
       check(await targetCount() === 0, 'preparation-target-already-clicked');
       move(targetPoint, targetH, true); safety(targetPoint, targetH, true);
       send(2); held = true; safety(targetPoint, targetH, true); send(4); held = false;
       await delay(160); safety(targetPoint, targetH, true);
       record('target-preparation-os-click', { selfHit: true, layersHidden: true, layersIgnoreInput: layersSuspended });
     } else {
       await layout('initial'); complete('initial-placement');
       await click('target-activation', targetPoint, targetH);
     }
    check(BigInt(fg()) === targetH, 'target-not-foreground');
     const targetEvents = crossProcess ? { nativeMouseDowns: await targetCount() } : await target.webContents.executeJavaScript('events');
    record('target-activation-events', { events: targetEvents });
      check(crossProcess ? targetEvents.nativeMouseDowns === 1 : targetEvents.some(e => e.type === 'click' && e.trusted), 'target-click-unconfirmed'); complete('target-activation');
     if (targetBeforeLayers) {
       // Initial strict failure is terminal, with no recovery or activation.
        await layout('initial'); complete('initial-placement');
        if (anchorRoles) { evidence.pass = true; return; } // Single preparation click + strict initial placement only.
      }
    const toolClick = async tool => {
      const r = await toolbar.webContents.executeJavaScript(`(()=>{const r=document.getElementById('${tool}').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`);
      const b = toolbar.getContentBounds(), p = { x: Math.round(b.x + r.x + r.width / 2), y: Math.round(b.y + r.y + r.height / 2) };
      await click(`${tool}-click`, p, toolbarH);
      const state = await toolbar.webContents.executeJavaScript('({tool:globalThis.tool,events:globalThis.events})');
      record(`${tool}-dom-state`, state);
      check(state.tool === tool && state.events.some(e => e.id === tool && e.type === 'click' && e.trusted) && BigInt(fg()) === toolbarH, 'trusted-tool-click-unconfirmed');
      complete(`${tool}-click`); mode = tool; await layout(tool); complete(`${tool}-placement`);
    };
    await toolClick('pen');
    const points = Array.from({ length: 9 }, (_, i) => ({ x: bounds.x + 100 + i * 24, y: bounds.y + 110 + i * 4 }));
     const beforeTarget = await targetDowns();
    for (let i = 0; i < points.length; i++) {
      await strict(`drag-${i}-pre`); move(points[i], canvasH);
      check(BigInt(fg()) === toolbarH, 'drag-toolbar-foreground-lost');
      if (i === 0) { await strict('drag-pre-down'); safety(points[i], canvasH); send(2); held = true; }
      await delay(45); safety(points[i], canvasH);
    }
    await strict('drag-pre-up'); safety(points.at(-1), canvasH); send(4); held = false; await delay(150); await strict('drag-final');
    const draw = await canvas.webContents.executeJavaScript('({events,inkPixels:inkPixels()})');
    record('draw-result', draw);
    check(draw.events.filter(e => e.type === 'pointerdown').length === 1 && draw.events.filter(e => e.type === 'pointerup').length === 1 && draw.events.filter(e => e.type === 'pointermove' && e.buttons === 1).length >= 5 && draw.events.every(e => e.trusted) && draw.inkPixels > 500, 'draw-incomplete');
     check(await targetDowns() === beforeTarget, 'draw-leaked-to-target'); complete('canvas-drag');
    await toolClick('pointer');
    const beforeCanvas = draw.events.filter(e => e.type === 'pointerdown').length;
    await click('target-through', targetPoint, targetH);
     const after = crossProcess ? { nativeMouseDowns: await targetCount() } : await target.webContents.executeJavaScript('events');
     check((crossProcess ? after.nativeMouseDowns === beforeTarget + 1 : after.filter(e => e.type === 'pointerdown').length === beforeTarget + 1 && after.at(-1).trusted) && BigInt(fg()) === targetH, 'target-through-unconfirmed');
    check(await canvas.webContents.executeJavaScript('events.filter(e=>e.type==="pointerdown").length') === beforeCanvas, 'pointer-captured-by-canvas');
    record('target-through-events', { events: after }); complete('target-through'); evidence.pass = true;
  } catch (error) { record('stopped', { reason: error.message }); evidence.stopReason = error.message; }
  finally {
    clearTimeout(deadline);
    if (held && send) { try { send(4); held = false; } catch { /* reported below */ } }
    collectPids();
    for (const w of windows) if (!w.isDestroyed()) w.destroy();
     const childCleanup = await Promise.all(children.map(c => finishChild(c, () => c === targetRecord ? c.child.stdin.end('exit\n') : c.child.kill())));
     evidence.cleanup = { windowsDestroyed: windows.every(w => w.isDestroyed()), buttonReleased: !held, nativeLeftButtonDown: buttonState?.(),
       targetDestroyed: !crossProcess || targetMessages.some(v => v.type === 'cleanup' && v.destroyed), helpersClosed: childCleanup.every(c => c.closed), childCleanup };
    evidence.processIds = [...pids]; evidence.profilePath = profile; evidence.notCovered = stages.filter(s => !evidence.completed.includes(s));
    record('cleanup', evidence.cleanup);
    fs.writeFileSync(arg('--evidence'), JSON.stringify(evidence, null, 2));
    release(); app.exit(evidence.pass && evidence.cleanup.windowsDestroyed && evidence.cleanup.helpersClosed && !held ? 0 : 1);
  }
});

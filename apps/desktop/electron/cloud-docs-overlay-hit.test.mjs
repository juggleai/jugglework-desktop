import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// 独立测试进程，不启动 Desktop Main，也不使用用户的 partition 或登录资料。
if (process.versions.electron) {
  const { app, BrowserWindow, WebContentsView, ipcMain } = await import("electron");
  const root = process.argv.at(-1);
  app.setPath("userData", root);
  app.setPath("sessionData", root);
  app.on("window-all-closed", () => {});
  async function run() {
  await app.whenReady();
  let win;
  let imageServer;
  let exitCode = 0;
  let stage = "starting";
  const timeout = setTimeout(() => { console.error(`fixture timed out: ${stage}`); app.exit(1); }, 18000);
  try {
    const { createServer } = await import("node:http");
    imageServer = createServer();
    /** @type {Promise<import('node:http').ServerResponse>} */
    const pendingImage = new Promise(resolve => {
      imageServer.once("request", (_request, response) => resolve(response));
    });
    await new Promise(resolve => imageServer.listen(0, "127.0.0.1", resolve));
    const address = imageServer.address();
    if (!address || typeof address === "string") throw new Error("fixture image server unavailable");
    const imageUrl = `http://127.0.0.1:${address.port}/pending-image`;
    win = new BrowserWindow({ width: 800, height: 600, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
    win.webContents.on("console-message", (_event, level, message) => { if (level >= 3) console.error(message); });
    const native = new WebContentsView({ webPreferences: {
      backgroundThrottling: false,
      preload: fileURLToPath(new URL("./cloud-docs-preload.cjs", import.meta.url)),
    } });
    win.contentView.addChildView(native);
    native.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    stage = "native load";
    await native.webContents.loadURL("data:text/html,<body style='background:red'><input id='editor' aria-label='Native editor'></body>");
    const observations = [];
    ipcMain.on("fixture:bounds", (event, input) => {
      if (event.sender !== win.webContents) return;
      native.setVisible(input.visible);
      observations.push(input.visible);
    });
    ipcMain.handle("fixture:snapshot", (_event, mode) => {
      if (mode === "reject") throw new Error("fixture capture failed");
      if (mode === "decode-error") return imageUrl;
      return null;
    });
    ipcMain.handle("fixture:status", () => ({ ready: true }));
    stage = "host load";
    await win.loadFile(`${root}/fixture.html`);
    await win.webContents.executeJavaScript("new Promise(resolve => { const poll = () => window.fixture?.open ? resolve(true) : setTimeout(poll, 10); poll(); })");
    stage = "first Rail hint paints while forwarding is delayed";
    native.setBounds({ x: 400, y: 0, width: 400, height: 600 });
    const heldHint = new Promise(resolve => {
      ipcMain.on("fixture:rail-hint", (event, input) => {
        if (event.sender !== win.webContents) return;
        if (input.hint) resolve(input.hint);
        else native.webContents.send("jugglework:docs:rail-hint", null);
      });
    });
    win.focus();
    win.webContents.focus();
    win.webContents.sendInputEvent({ type: "mouseMove", x: 360, y: 140 });
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      let positionedFrames = 0;
      const poll = () => {
        const hint = document.querySelector('[data-app-rail-tooltip][data-open]');
        if (hint && getComputedStyle(hint).opacity !== '0') {
          reject(new Error('the host painted a Rail hint before native delivery'));
          return;
        }
        const box = hint?.getBoundingClientRect();
        if (box && box.left < 400 && box.right > 400) positionedFrames++;
        if (positionedFrames >= 3) resolve(true);
        else if (performance.now() > deadline) reject(new Error('the Rail tooltip did not overlap the native host: ' + JSON.stringify(box)));
        else requestAnimationFrame(poll);
      };
      poll();
    })`);
    assert.equal(native.getVisible(), true);
    assert.equal(await win.webContents.executeJavaScript("fixture.captures"), 0);
    native.webContents.send("jugglework:docs:rail-hint", await heldHint);
    await native.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => {
        const hint = document.querySelector('[data-jugglework-rail-hint]');
        const box = hint?.getBoundingClientRect();
        if (hint && box.width > 40 && box.left >= 0 && box.right <= innerWidth &&
            hint.shadowRoot === null && getComputedStyle(hint).pointerEvents === 'none') resolve(true);
        else if (performance.now() > deadline) reject(new Error('full passive Rail hint did not render'));
        else requestAnimationFrame(poll);
      };
      poll();
    })`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 200, y: 140 });
    await native.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => !document.querySelector('[data-jugglework-rail-hint]') ? resolve(true)
        : performance.now() > deadline ? reject(new Error('forwarded Rail tooltip did not close')) : requestAnimationFrame(poll);
      poll();
    })`);
    console.info("PASS: overlapping host tooltip stays transparent through delayed IPC and one full native hint appears");
    for (const mode of ["null", "reject", "null"]) {
      stage = `${mode}: fallback`;
      await win.webContents.executeJavaScript(`fixture.open(${JSON.stringify(mode)})`);
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const poll = () => document.querySelector('[data-cloud-docs-placeholder]') && fixture.hidden
          ? resolve(true) : performance.now() > deadline ? reject(new Error('fallback did not hide native')) : requestAnimationFrame(poll);
        poll();
      })`);
      assert.equal(native.getVisible(), false, "actual native view must yield pointer input to DOM");
      assert.equal(native.webContents.isDestroyed(), false, "retained native document stays alive");
      const hit = await win.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('[role="menuitem"]');
        const box = button.getBoundingClientRect();
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        return { x, y, target: document.elementFromPoint(x, y)?.getAttribute('role'), text: document.querySelector('[data-cloud-docs-placeholder]').textContent, clicks: fixture.clicks };
      })()`);
      assert.equal(hit.target, "menuitem", "DOM hit testing must select the menu, not the placeholder");
      assert.ok(hit.text.trim(), "fallback is an explicit document placeholder");
      stage = `${mode}: pointer`;
      // native 已真实隐藏，向宿主投递指针事件；不调用 React props 或 DOM click()。
      win.webContents.sendInputEvent({ type: "mouseDown", x: Math.round(hit.x), y: Math.round(hit.y), button: "left", clickCount: 1 });
      win.webContents.sendInputEvent({ type: "mouseUp", x: Math.round(hit.x), y: Math.round(hit.y), button: "left", clickCount: 1 });
      await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const poll = () => fixture.clicks > ${hit.clicks} ? resolve(true) : performance.now() > deadline ? reject(new Error('menu did not receive pointer')) : requestAnimationFrame(poll);
        poll();
      })`);
      await win.webContents.executeJavaScript("fixture.close()");
      stage = `${mode}: restore`;
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        const poll = () => !document.querySelector('[data-cloud-docs-placeholder]') && !fixture.hidden ? resolve(true) : setTimeout(poll, 10);
        poll();
      })`);
      assert.equal(native.getVisible(), true);
    }
    for (const kind of ["dialog", "alert-dialog", "sheet"]) {
      stage = `${kind}: actual BaseUI modal`;
      await win.webContents.executeJavaScript(`fixture.open('null', ${JSON.stringify(kind)})`);
      const modal = await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
        const deadline = performance.now() + 5000;
        const poll = () => {
          const popup = document.querySelector('[data-slot="${kind}-content"]');
          const backdrop = document.querySelector('[data-slot="${kind}-overlay"]');
          if (popup && backdrop && fixture.hidden) {
            const p = popup.getBoundingClientRect(), h = document.querySelector('[data-host]').getBoundingClientRect();
            resolve({ intersects: p.right > h.left && p.left < h.right && p.bottom > h.top && p.top < h.bottom,
              ariaModal: popup.getAttribute('aria-modal'), slot: backdrop.dataset.slot,
              hit: document.elementFromPoint(650, 400)?.getAttribute('data-slot') });
          } else if (performance.now() > deadline) reject(new Error('modal backdrop did not hide native'));
          else requestAnimationFrame(poll);
        }; poll();
      })`);
      assert.equal(modal.intersects, false, "real popup must not intersect the native host");
      assert.notEqual(modal.ariaModal, "true", "fixture covers BaseUI output without aria-modal");
      assert.equal(modal.slot, `${kind}-overlay`);
      assert.equal(modal.hit, `${kind}-overlay`, "background hit must land on the modal backdrop");
      assert.equal(native.getVisible(), false, "nonintersecting modal still hides the native background");
      await win.webContents.executeJavaScript("fixture.close()");
      await win.webContents.executeJavaScript(`new Promise(resolve => {
        const poll = () => !document.querySelector('[data-cloud-docs-placeholder]') && !fixture.hidden ? resolve(true) : setTimeout(poll, 10);
        poll();
      })`);
      assert.equal(native.getVisible(), true);
    }
    stage = "close-before-decode / onError while restoring / reopen-before-RAF";
    await win.webContents.executeJavaScript("fixture.open('decode-error')");
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => document.querySelector('[data-snapshot]') ? resolve(true)
        : performance.now() > deadline ? reject(new Error('pending image missing')) : setTimeout(poll, 10);
      poll();
    })`);
    const imageResponse = await pendingImage;
    assert.equal(await win.webContents.executeJavaScript("fixture.errors"), 0);
    await win.webContents.executeJavaScript("fixture.holdFrames = true; fixture.close()");
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      const poll = () => fixture.frames.length ? resolve(true) : setTimeout(poll, 10); poll();
    })`);
    assert.equal(native.getVisible(), true);
    // 真正结束延迟的图片响应，让 Chromium 解码失败并触发 React onError，不手动调用事件／props。
    assert.ok(imageResponse, "Chromium must have requested the undecoded image");
    imageResponse.writeHead(200, { "Content-Type": "image/png" });
    imageResponse.end("invalid png");
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => fixture.errors === 1 ? resolve(true)
        : performance.now() > deadline ? reject(new Error('real image error missing')) : setTimeout(poll, 10); poll();
    })`);
    assert.equal(native.getVisible(), true, "decode error during restoration must not hide native");
    const captures = await win.webContents.executeJavaScript("fixture.captures");
    await win.webContents.executeJavaScript("fixture.open('decode-error')");
    const reopened = await win.webContents.executeJavaScript(`({ fallback: !!document.querySelector('[data-cloud-docs-placeholder]'), image: !!document.querySelector('[data-snapshot]'), captures: fixture.captures })`);
    assert.equal(reopened.fallback, true);
    assert.equal(reopened.image, false);
    assert.equal(reopened.captures, captures, "reopening must reuse the failed frame as fallback");
    await win.webContents.executeJavaScript("fixture.paint()");
    assert.equal(native.getVisible(), true, "first fallback frame must not hide native");
    await win.webContents.executeJavaScript("fixture.paint()");
    assert.equal(native.getVisible(), false, "painted fallback must yield actual native input");
    const raceHit = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('[role="menuitem"]').getBoundingClientRect();
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), clicks: fixture.clicks };
    })()`);
    win.webContents.sendInputEvent({ type: "mouseDown", x: raceHit.x, y: raceHit.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: raceHit.x, y: raceHit.y, button: "left", clickCount: 1 });
    await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => fixture.clicks > ${raceHit.clicks} ? resolve(true)
        : performance.now() > deadline ? reject(new Error('reopened menu did not receive pointer')) : setTimeout(poll, 10); poll();
    })`);
    await win.webContents.executeJavaScript("fixture.holdFrames = false; fixture.close()");
    await win.webContents.executeJavaScript(`new Promise(resolve => {
      const poll = () => !document.querySelector('[data-cloud-docs-placeholder]') && !fixture.hidden ? resolve(true) : setTimeout(poll, 10); poll();
    })`);
    stage = "restored native typing";
    win.focus();
    native.webContents.focus();
    await native.webContents.executeJavaScript("document.querySelector('#editor').focus()");
    for (const keyCode of "restored") native.webContents.sendInputEvent({ type: "char", keyCode });
    await native.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const poll = () => document.querySelector('#editor').value === 'restored' ? resolve(true)
        : performance.now() > deadline ? reject(new Error('restored native did not receive typing: ' + document.querySelector('#editor').value)) : setTimeout(poll, 10);
      poll();
    })`);
    assert.ok(observations.includes(false));
    native.webContents.close();
    console.info("PASS: null/reject fallback paints, actual native yields, DOM hit test and pointer menu action succeed, same native restores");
    console.info("PASS: actual BaseUI dialog/alert-dialog/sheet backdrops without aria-modal globally occlude nonintersecting native host; restored native accepts typing");
    console.info("PASS: real Chromium decode error during restoration survives reopen-before-RAF; fallback paints before native hides and reopened menu receives pointer");
  } catch (error) { console.error(error); exitCode = 1; }
  finally { clearTimeout(timeout); imageServer?.close(); if (win && !win.isDestroyed()) win.destroy(); app.exit(exitCode); }
  }
  void run();
} else {
  const { test } = await import("node:test");
  const { mkdtemp, readFile, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { build } = await import("esbuild");
  const require = createRequire(import.meta.url);
  test("real native yields to menu and actual BaseUI modal backdrops, restores and accepts typing", { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cloud-docs-overlay-hit-"));
    try {
      await build({
        absWorkingDir: fileURLToPath(new URL("../../app", import.meta.url)),
        stdin: { resolveDir: fileURLToPath(new URL("../../app", import.meta.url)), loader: "tsx", contents: `
          import * as React from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { useCloudDocsBounds } from './src/react-app/domains/cloud-docs/use-cloud-docs-bounds';
          import { CloudDocsPlaceholder } from './src/react-app/domains/cloud-docs/cloud-docs-placeholder';
          import { Dialog, DialogContent, DialogTitle, DialogDescription } from './src/components/ui/dialog';
          import { AlertDialog, AlertDialogContent, AlertDialogTitle, AlertDialogDescription } from './src/components/ui/alert-dialog';
          import { Sheet, SheetContent, SheetTitle, SheetDescription } from './src/components/ui/sheet';
          import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './src/components/ui/tooltip';
          const { ipcRenderer } = window.require('electron');
          window.fixture = { clicks: 0, hidden: false, mode: 'null', errors: 0, captures: 0, frames: [], holdFrames: false };
          const raf = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = callback => fixture.holdFrames ? (fixture.frames.push(callback), -fixture.frames.length) : raf(callback);
          fixture.paint = () => new Promise(resolve => raf(time => {
            flushSync(() => { for (const callback of fixture.frames.splice(0)) callback(time); });
            resolve();
          }));
          window.__JUGGLEWORK_ELECTRON__ = { cloudDocs: {
            setBounds: input => { fixture.hidden = !input.visible; ipcRenderer.send('fixture:bounds', input); },
            setRailHint: input => ipcRenderer.send('fixture:rail-hint', input),
            snapshot: () => { fixture.captures++; return ipcRenderer.invoke('fixture:snapshot', fixture.mode); },
            status: () => ipcRenderer.invoke('fixture:status'),
          } };
          function Host() {
            const host = React.useRef(null);
            const bounds = useCloudDocsBounds(host, undefined, { mirrorRailHints: true });
            const [menu, setMenu] = React.useState(false);
            const [kind, setKind] = React.useState('menu');
            fixture.open = (mode, kind = 'menu') => { fixture.mode = mode; flushSync(() => { setKind(kind); setMenu(true); }); };
            fixture.close = () => flushSync(() => setMenu(false));
            React.useLayoutEffect(() => bounds.sync('fixture-instance', true), [menu]);
            React.useEffect(() => {
              const observer = new MutationObserver(() => bounds.sync('fixture-instance', true));
              observer.observe(document.body, {childList:true,subtree:true,attributes:true,attributeFilter:['style','class','data-open','data-closed']});
              return () => observer.disconnect();
            }, []);
            return <><div ref={host} data-host style={{position:'absolute',left:400,top:0,width:400,height:600}}>
              {bounds.snapshot && <img data-snapshot src={bounds.snapshot} onLoad={bounds.loaded} onError={() => { bounds.failed(); fixture.errors++; }} />}
              {bounds.fallback && <CloudDocsPlaceholder />}
            </div>
            <TooltipProvider><Tooltip>
              <TooltipTrigger style={{position:'absolute',left:345,top:126,width:32,height:28}}>Rail</TooltipTrigger>
              <TooltipContent side="right" sideOffset={8} hideArrow data-app-rail-tooltip="Calendar">Calendar</TooltipContent>
            </Tooltip></TooltipProvider>
            {menu && kind === 'menu' && <div role="menu" style={{position:'absolute',left:500,top:100,zIndex:50}}>
              <button role="menuitem" style={{width:180,height:50}} onClick={() => fixture.clicks++}>Menu action</button>
            </div>}
            <Dialog open={menu && kind === 'dialog'}><DialogContent showCloseButton={false}><DialogTitle>Dialog</DialogTitle><DialogDescription>Modal fixture</DialogDescription></DialogContent></Dialog>
            <AlertDialog open={menu && kind === 'alert-dialog'}><AlertDialogContent><AlertDialogTitle>Alert</AlertDialogTitle><AlertDialogDescription>Modal fixture</AlertDialogDescription></AlertDialogContent></AlertDialog>
            <Sheet open={menu && kind === 'sheet'}><SheetContent showCloseButton={false}><SheetTitle>Sheet</SheetTitle><SheetDescription>Modal fixture</SheetDescription></SheetContent></Sheet>
            </>;
          }
          createRoot(document.getElementById('root')).render(<Host />);
        ` },
        bundle: true, platform: "browser", format: "iife", outfile: `${root}/fixture.js`,
      });
      const appStyles = await readFile(new URL("../../app/src/styles/custom.css", import.meta.url), "utf8");
      await writeFile(`${root}/fixture.html`, `<!doctype html><style>
        ${appStyles}
        body{margin:0} [data-cloud-docs-placeholder]{position:absolute;inset:0;background:#fafafa;color:#444;display:flex;align-items:center;justify-content:center;pointer-events:none}
        [data-slot="tooltip-content"]{width:90px;height:28px;background:#333;color:white}
        [data-slot$="-overlay"]{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.3)}
        [data-slot$="-content"]{position:fixed;left:10px;top:10px;width:180px;height:120px;z-index:51;background:white}
      </style><div id="root"></div><script src="fixture.js"></script>`);
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const result = spawnSync(require("electron"), [fileURLToPath(import.meta.url), root], { env, encoding: "utf8", timeout: 25000 });
      assert.equal(result.error, undefined, `${result.error?.message}\n${result.stdout}\n${result.stderr}`);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /PASS: overlapping host tooltip stays transparent/);
      assert.match(result.stdout, /PASS: null\/reject/);
      console.info(result.stdout.trim());
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  });
}

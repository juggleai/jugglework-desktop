import { app, BrowserWindow, ipcMain, dialog, Menu, webContents } from "electron";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOfficePanel } from "../electron/office-panel.mjs";
import { createOfficeResources, classifyOfficeResource } from "../electron/office-resources.mjs";
import { createFileWindows } from "../electron/file-windows.mjs";
import { assertOfficeResources, resourceFailure } from "./office-acceptance-resources.mjs";
import { acceptanceOptions } from "./office-acceptance-options.mjs";
import { acceptanceContent } from "./office-acceptance-content.mjs";
import { syntheticDialogChoices } from "./office-acceptance-dialogs.mjs";
import { prepareAcceptanceApp, prepareAcceptanceWindow, focusAcceptanceEditor } from "./office-acceptance-focus.mjs";
import { syntheticSheetInputState, syntheticSheetToolbarState, selectSyntheticCellText,
  observeSyntheticInput, acceptanceMenuState, installAcceptanceMenu } from "./office-acceptance-input.mjs";

// Same real engine/resource/page-commit chain as verify-office-selection-worker.mjs,
// hosted by the production FileWindowApp and its generated sandbox CJS bridge.
const [root, uiOrigin, preload] = process.argv.slice(2);
const { format, kind } = acceptanceOptions(process.argv.slice(5));
const reviewResources = process.argv.includes("--review-resources");
const uiUndoToolbar = process.argv.includes("--ui-undo-toolbar");
const uiUndo = process.argv.includes("--ui-undo") || uiUndoToolbar;
assert.ok(root && uiOrigin && preload);
app.setPath("userData", join(root, "profile"));
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { OfficeEngine } = await import(pathToFileURL(join(root, "engine.mjs")).href);
const engine = new OfficeEngine({ resourceDirectory: join(desktop, "resources/office-engine"), logDirectory: join(root, "logs") });
const relativePath = `synthetic.${format}`, filePath = join(root, relativePath);
const workspaceId = "office-acceptance", sessionId = "synthetic-session";
const prefix = `/workspace/${workspaceId}`;
let stage = "ready", panel, files, server, window, doc, generation = 0, stopping = false;
const requests = [], layouts = [], violations = [];
const resourceReports = [];
let resourceService;
const closeReports = [], saveReports = [], resourceEvidence = [];
const uiUndoEvidence = [];
const toolbarEvidence = [];
const shortcutInputs = [];
const nativeFocusEvents = [], menuEvidence = [];
const diagnosticListeners = [];
let shortcutInputContents, shortcutInputListener;
const content = acceptanceContent(engine, filePath, format, kind, () => doc.engineFileId);
const dialogs = syntheticDialogChoices(dialog, async () => assert.equal((await engine.editor(filePath)).is_dirty, true));
const originalErrorBox = dialog.showErrorBox;
dialog.showErrorBox = (title, message) => { violations.push(`Native error: ${title}: ${message}`); };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(label, fn) {
  const deadline = Date.now() + 25_000;
  let last;
  while (Date.now() < deadline) {
    assertOfficeResources(reviewResources ? resourceReports.map((report) => ({ ...report, unknownFailures: [] })) : resourceReports);
    try { const result = await fn(); if (result) return result; } catch (error) { last = error; }
    await wait(100);
  }
  throw new Error(`${label} timed out${last ? `: ${last.message}` : ""}`);
}
const evaluate = (contents, fn, ...args) => contents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
async function documentState() {
  if (doc?.state !== "closed") {
    const editor = await engine.editor(filePath);
    if (editor) { doc.engineFileId = editor.file_id; doc.dirty = editor.is_dirty; doc.state = "ready"; }
  }
  return { document: { ...doc } };
}
async function openDocument() {
  if (!doc || doc.state === "closed") {
    const previewUrl = await engine.previewUrl(filePath);
    doc = { documentId: `synthetic-document-${++generation}`, pageId: `synthetic-page-${generation}`, workspaceId,
      ownerSessionId: sessionId, relativePath, name: relativePath, kind,
      state: "opening", engineFileId: null, previewUrl, dirty: false };
  }
  return documentState();
}
async function route(method, pathname, body = {}) {
  requests.push(`${method} ${pathname}`);
  const url = new URL(pathname, "http://127.0.0.1");
  const path = url.pathname;
  if (method === "GET" && path === "/workspaces") return { items: [{ id: workspaceId, path: root }] };
  if (method === "GET" && path === `${prefix}/files/stat`) return { exists: true, kind: "file" };
  if (method === "GET" && path === `${prefix}/office/capabilities`) return engine.capabilities();
  if (method === "POST" && path === `${prefix}/office/open`) {
    assert.equal(body.path, relativePath); assert.equal(body.sessionId, sessionId);
    return openDocument();
  }
  const base = `${prefix}/office/${doc?.documentId}`;
  if (method === "GET" && path === base) return documentState();
  if (method === "POST" && path === `${base}/context`) return { ok: true };
  if (method === "POST" && path === `${base}/save`) {
    await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId });
    await engine.save(doc.engineFileId);
    saveReports.push({ via: "toolbar", nativeDirtyCleared: !(await engine.editor(filePath)).is_dirty });
    return documentState();
  }
  if (method === "POST" && path === `${base}/close`) {
    assert.ok(["save", "discard"].includes(body.decision));
    const dirtyBefore = (await engine.editor(filePath)).is_dirty;
    if (body.decision === "save") {
      await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId });
      await engine.save(doc.engineFileId);
      assert.equal((await engine.editor(filePath)).is_dirty, false);
      saveReports.push({ via: "close", dirtyBefore, nativeDirtyCleared: true });
    }
    await engine.close(doc.engineFileId, body.decision === "discard"); doc.state = "closed";
    closeReports.push({ decision: body.decision, dirtyBefore, nativeClosed: !(await engine.editor(filePath)) });
    return { document: { ...doc } };
  }
  if (method === "POST" && path === `${base}/page-failed`) throw new Error("Real SDK page failed");
  const session = `${prefix}/sessions/${sessionId}`;
  const item = { id: sessionId, title: "Synthetic acceptance backend", directory: root, time: { created: 1, updated: 1 } };
  if (method === "GET" && path === session) return { item };
  if (method === "GET" && path === `${session}/snapshot`) return { item: { session: item, messages: [], status: { type: "idle" }, todos: [] } };
  if (method === "GET" && path === `${session}/messages`) return { items: [] };
  if (method === "GET" && path === `${session}/interactions/snapshot`) return { item: { rootSessionId: sessionId, includeDescendants: true, permissions: [], questions: [] } };
  if (method === "GET" && path === `${prefix}/session-runs`) return { items: [] };
  if (method === "GET" && path === `${session}/permission-mode`) return { item: { mode: "default" } };
  if (method === "GET" && path === `${prefix}/opencode/provider`) return { all: [], connected: [], default: {} };
  if (method === "GET" && path === `${prefix}/opencode/agent`) return [];
  throw new Error(`Unexpected synthetic backend request: ${method} ${pathname}`);
}
async function cleanup(code) {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  const hard = setTimeout(() => app.exit(1), 5000);
  try {
    if (shortcutInputContents && !shortcutInputContents.isDestroyed())
      shortcutInputContents.removeListener("before-input-event", shortcutInputListener);
    for (const [source, name, listener] of diagnosticListeners) source.removeListener(name, listener);
    panel?.destroy(); files?.dispose();
    dialogs.restore();
    dialog.showErrorBox = originalErrorBox;
    server?.closeAllConnections();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await engine.dispose();
  } catch (error) { console.error("cleanup failed", error); code = 1; }
  clearTimeout(hard); app.exit(code);
}
const timer = setTimeout(() => { console.error(`Office file-window timeout: ${stage}`); void cleanup(1); }, 135_000);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void cleanup(1); });
async function click(contents, selector) {
  const point = await eventually(`clickable ${selector}`, () => evaluate(contents, (selector) => {
    const node = document.querySelector(selector), rect = node?.getBoundingClientRect();
    if (!node || node.disabled || !rect?.width || !rect.height) return null;
    const x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    return node.contains(document.elementFromPoint(x, y)) ? { x, y } : null;
  }, selector));
  contents.sendInputEvent({ type: "mouseMove", ...point });
  contents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  contents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}
const nativeView = () => window.contentView.children.find((view) => view.webContents);
const readCell = () => content.read();
async function focusNativeInput(contents) {
  await focusAcceptanceEditor({ uiUndo, app, BrowserWindow, host: window, contents,
    attachedContents: nativeView()?.webContents, eventually, evaluate });
}
async function inputReport(label, extra = {}) {
  const contents = nativeView()?.webContents;
  const report = { label, ...extra, native: await content.readInputCells(),
    focus: { app: app.isActive(), window: window.isFocused(), contents: contents?.isFocused() },
    page: contents && !contents.isDestroyed() ? await evaluate(contents, syntheticSheetInputState) : null };
  console.log(JSON.stringify({ officeSyntheticInput: report }));
  return report;
}
async function layout(label, identity, dirty = true, expectedWidth) {
  const measurement = await eventually(`${label} native bounds match DOM`, async () => {
    const view = nativeView();
    if (!view?.getVisible()) return false;
    const rect = await evaluate(window.webContents, () => {
      const node = document.querySelector('[data-office-document] > .relative');
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
    });
    const actual = view.getBounds();
    if (expectedWidth && !expectedWidth(actual.width)) return false;
    return rect && Object.keys(rect).every((key) => Math.abs(rect[key] - actual[key]) <= 1) ? actual : false;
  });
  const state = (await documentState()).document;
  assert.equal(state.documentId, identity.documentId);
  assert.equal(state.engineFileId, identity.engineFileId);
  assert.equal(nativeView().webContents.id, identity.webContentsId);
  assert.equal(window.webContents.id, identity.hostWebContentsId);
  assert.equal(state.dirty, dirty);
  assert.equal(await readCell(), "42");
  layouts.push({ label, bounds: measurement, ...identity, dirty: state.dirty });
  return measurement;
}
async function run() {
  try {
    await app.whenReady();
    if (uiUndo) {
      menuEvidence.push({ label: "Electron default before fixture menu", menu: acceptanceMenuState(Menu) });
      installAcceptanceMenu(Menu, uiUndo);
      menuEvidence.push({ label: "isolated standard role menu", menu: acceptanceMenuState(Menu) });
      console.log(JSON.stringify({ officeFixtureMenu: menuEvidence }));
    }
    const activation = await prepareAcceptanceApp(app, uiUndo);
    if (activation) console.log(JSON.stringify({ officeFixtureActivation: { ...activation,
      execPath: process.execPath, defaultApp: process.defaultApp === true, pid: process.pid, parentPid: process.ppid } }));
    assert.equal((await engine.capabilities()).engineVersion, "0.0.0.499", "Resource exceptions require the reviewed SDK version");
    await content.create();
    const originalBytes = await content.disk("10");
    server = createServer(async (req, res) => {
      try {
        if (/\/(?:events|event)(?:\?|$)/.test(req.url)) {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write('data: {"type":"server.connected","properties":{}}\n\n'); return;
        }
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const value = await route(req.method, req.url, chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value));
      } catch (error) { violations.push(error.message); res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = { getJson: (path) => route("GET", path), postJson: (path, body) => route("POST", path, body) };
    const manifest = JSON.parse(await readFile(join(desktop, "resources/office-assets/manifest.json"), "utf8"));
    resourceService = createOfficeResources({ assetsDirectory: join(desktop, "resources/office-assets"), cacheDirectory: join(root, "fonts"),
      fetch: async (url, options) => {
        assert.ok(manifest.entries.some((entry) => entry.kind === "font" && entry.url === url), "Only manifest-pinned public fonts may be fetched");
        return fetch(url, { ...options, credentials: "omit", redirect: "error", signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) });
      } });
    resourceService.subscribe((id, state) => {
      const report = resourceReports.find((item) => item.documentId === id);
      if (report && state) {
        report.coreFailures = Math.max(report.coreFailures, state.coreFailures ?? 0);
        report.fontFailures = Math.max(report.fontFailures, state.fontFailures ?? 0);
      }
      if (state?.coreFailures) violations.push("Required Office resource failed");
    });
    const resources = {
      ...resourceService,
      attach(partition, host) {
        const report = { format, generation, documentId: host.documentId, coreFailures: 0, requiredMissing: 0, fontFailures: 0, unknownFailures: [] };
        resourceReports.push(report);
        const binding = resourceService.attach({ protocol: partition.protocol, webRequest: partition.webRequest,
          fetch: async (request, options) => {
            const classification = classifyOfficeResource(request.url, host.origin, manifest, request.destination);
            try {
              const response = (process.argv.includes("--fail-required-resource") && classification.kind === "core") ||
                (process.argv.includes("--fail-unknown-resource") && new URL(request.url).pathname === "/v2/user/attribute/get")
                ? new Response(null, { status: 503 }) : await partition.fetch(request, options);
              if (classification.kind === "core" && !response.ok) report.requiredMissing++;
              if (classification.kind === "unknown" && !response.ok)
                report.unknownFailures.push(resourceFailure(request, response.status, format));
              if (reviewResources && classification.kind === "unknown" && !response.ok) resourceEvidence.push({
                format, method: request.method, endpoint: new URL(request.url).pathname, status: response.status,
                sameOrigin: new URL(request.url).origin === host.origin, destination: request.destination, core: false });
              if (reviewResources && /javascript|text\/html/.test(response.headers.get("content-type") ?? "")) {
                const source = await response.clone().text();
                for (const term of ["auth_apply/check", "scenes_calc", "user_flag", "/api/vipcenter/comment/user/info", "browser-backend-worker", "/addon/editor-addons", "metadata.v1.json"] ) {
                  if (resourceEvidence.some((entry) => entry.term === term)) continue;
                  const needle = source.indexOf(term);
                  if (needle >= 0) {
                    resourceEvidence.push({ script: new URL(request.url).pathname, term, caller: source.slice(Math.max(0, needle - 250), needle + 650) });
                  }
                }
              }
              return response;
            } catch (error) {
              if (classification.kind === "unknown") report.unknownFailures.push(resourceFailure(request, "transport-error", format));
              throw error;
            }
          },
        }, { ...host, onCoreFailure: () => { report.coreFailures = Math.max(1, report.coreFailures); violations.push("Required Office resource callback"); host.onCoreFailure(); } });
        return { ...binding, dispose() { console.log(JSON.stringify({ officeResourceDiagnostics: report })); binding.dispose(); } };
      },
    };
    panel = createOfficePanel({ client, resources, getWindow: () => null, getWindows: () => files.windows(),
      resolveWindow: (sender) => files.windowFor(sender), onDocumentClosed: (id) => files.documentClosed(id) });
    files = createFileWindows({ client, office: panel, getMainWindow: () => null,
      // Only explicit UI acceptance may activate this isolated BrowserWindow.
      dock: { prepareWindow(host) { prepareAcceptanceWindow(host, uiUndo); }, update() {}, dispose() {} },
      getAccess: async () => ({ baseUrl, clientToken: "synthetic-acceptance-only" }),
      getDesktopConfig: async () => ({}), getAppearance: async () => ({ lang: "en", theme: "light" }),
      recentPath: join(root, "recent.json"), preloadPath: preload,
      loadWindow: async (host) => {
        host.webContents.session.webRequest.onBeforeRequest((detail, callback) => {
          const url = new URL(detail.url);
          const allowed = ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:", "devtools:"].includes(url.protocol);
          if (!allowed) violations.push(`Blocked external URL: ${url.origin}`);
          callback({ cancel: !allowed });
        });
        host.webContents.on("preload-error", (_event, _path, error) => violations.push(`preload: ${error.message}`));
        await host.loadURL(`${uiOrigin}/file-window.html`);
      },
    });
    files.registerIpc(ipcMain); panel.registerIpc(ipcMain);
    ipcMain.handle("jugglework:desktop", (event, command, url, init) => {
      assert.equal(command, "__fetch"); return files.fetch(event, url, init, fetch);
    });
    stage = "real FileWindowApp and native SDK load";
    await files.open({ workspaceId, sessionId, path: relativePath });
    [window] = files.windows();
    const pageReady = async () => {
      if (!nativeView() || !await evaluate(nativeView().webContents, (kind) => kind === "doc" ? Boolean(window.pad?.editor) :
        kind === "slide" ? Boolean(window.pray?.()?.getSelectionService?.()?.currentSlide) : Boolean(window.SpreadsheetApp?.view?.canvas?.inputManager && window.SpreadsheetApp?.workbook?.activeSheet), kind)) return false;
      if (!(await documentState()).document.engineFileId) return false;
      await content.read();
      return true;
    };
    await eventually(`SDK ${kind} ready`, pageReady);
    await eventually("page-owned native model bound", async () => (await documentState()).document.engineFileId);
    assert.ok(nativeView().webContents.getURL().includes(`/static/${kind}/pc.html`));
    await eventually("SDK commit adapter ready", async () => {
      await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId }); return true;
    });
    if (kind === "sheet") await eventually("SDK grid first render", () => evaluate(nativeView().webContents, () => {
      const canvas = window.SpreadsheetApp.view.canvas;
      return document.readyState === "complete" && canvas.clientRect.container.getBoundingClientRect().height > 100 &&
        canvas.areaData.getDisplayViewLeftByCol(1) > 0 && canvas.areaData.getDisplayViewTopByRow(1) > 0;
    }));
    const identity = { documentId: doc.documentId, engineFileId: doc.engineFileId, webContentsId: nativeView().webContents.id, hostWebContentsId: window.webContents.id };
    stage = "real native dirty edit";
    assert.equal(await content.read(), "10");
    const pool = await engine.tool("get_pool_status", {});
    assert.equal(pool.pool_size, 1, "Only the page-owned native model may be open");
    assert.equal(pool.open_editors[0].file_id, identity.engineFileId);
    await content.edit("42");
    await eventually("native dirty acknowledged", async () => (await engine.editor(filePath)).is_dirty);
    assert.deepEqual(await readFile(filePath), originalBytes, "dirty edit must not save implicitly");
    const contents = nativeView().webContents;
    const shortcut = (key, shift = false) => {
      const modifiers = [process.platform === "darwin" ? "meta" : "control", ...(shift ? ["shift"] : [])];
      contents.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
      contents.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
    };
    const focusedShortcut = async (label, shift = false) => {
      await eventually(`${label} editor committed with B2 selected`, () => evaluate(contents, () => {
        const view = window.SpreadsheetApp.view, ranges = view.getSelectionRanges();
        return !view.canvas.inputManager.isInputtingState() && ranges.length === 1 &&
          ranges[0].startRowIndex === 1 && ranges[0].endRowIndex === 1 &&
          ranges[0].startColIndex === 1 && ranges[0].endColIndex === 1;
      }));
      // Observe existing focus; never retry activation to make a shortcut pass.
      const page = await evaluate(contents, syntheticSheetInputState);
      const focus = { app: app.isActive(), window: window.isFocused(), contents: contents.isFocused(), page: page.pageFocus };
      console.log(JSON.stringify({ officeSyntheticShortcutFocus: { label, focus, page,
        focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null } }));
      assert.ok(Object.values(focus).every(Boolean),
        `Native focus lost before ${label}; shortcut not dispatched; interactive acceptance required: ${JSON.stringify(focus)}`);
      assert.equal(page.inputting, false);
      shortcut("Z", shift);
    };
    const toolbarReport = async (label) => {
      const report = { label, nativeValue: await readCell(), dirty: (await engine.editor(filePath)).is_dirty,
        ...await evaluate(contents, syntheticSheetToolbarState) };
      toolbarEvidence.push(report);
      console.log(JSON.stringify({ officeSyntheticToolbar: report }));
      return report;
    };
    const historyAction = async (label, redo = false) => {
      if (!uiUndoToolbar) return focusedShortcut(label, redo);
      const action = redo ? "redo" : "undo";
      const report = await toolbarReport(label);
      const buttons = report.controls.filter((control) => control.action === action && control.visible && control.enabled && control.hit &&
        (control.tag === "BUTTON" || control.attributes.role === "button"));
      assert.ok(buttons.length, `No visible enabled hit-tested SDK toolbar ${action} button`);
      const [button] = buttons;
      contents.sendInputEvent({ type: "mouseMove", ...button.point });
      contents.sendInputEvent({ type: "mouseDown", ...button.point, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...button.point, button: "left", clickCount: 1 });
    };
    if (uiUndo) {
      shortcutInputContents = contents;
      const platform = await evaluate(contents, observeSyntheticInput);
      console.log(JSON.stringify({ officeSyntheticPlatform: platform }));
      for (const [source, names, target] of [[app, ["did-become-active", "did-resign-active"], "app"],
        [window, ["focus", "blur", "hide", "minimize"], "window"],
        [contents, ["focus", "blur"], "editor"], [window.webContents, ["focus", "blur"], "host"]]) {
        for (const name of names) {
          const listener = () => {
            const report = { target, event: name, time: Date.now(),
              focus: { app: app.isActive(), window: window.isFocused(), contents: contents.isFocused() },
              focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null };
            nativeFocusEvents.push(report);
            console.log(JSON.stringify({ officeSyntheticNativeFocus: report }));
          };
          source.on(name, listener); diagnosticListeners.push([source, name, listener]);
        }
      }
      shortcutInputListener = (event, input) => {
        if (!["KeyZ", "KeyA", "Enter"].includes(input.code)) return;
        const report = { time: Date.now(), type: input.type, key: input.key, code: input.code, meta: input.meta,
          control: input.control, shift: input.shift, alt: input.alt, isAutoRepeat: input.isAutoRepeat,
          defaultPrevented: event.defaultPrevented,
          focus: { app: app.isActive(), window: window.isFocused(), contents: contents.isFocused() },
          focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null };
        shortcutInputs.push(report);
        console.log(JSON.stringify({ officeSyntheticBeforeInput: report }));
      };
      contents.on("before-input-event", shortcutInputListener);
      stage = "real SDK UI input and undo";
      if (uiUndoToolbar) {
        const report = await toolbarReport("before UI text input");
        for (const action of ["undo", "redo"]) assert.ok(report.controls.some((control) =>
          control.action === action && control.visible && (control.tag === "BUTTON" || control.attributes.role === "button")),
        `No visible SDK toolbar ${action} button`);
      }
      const cellPoint = await evaluate(contents, () => {
        const canvas = window.SpreadsheetApp.view.canvas, r = canvas.clientRect.container.getBoundingClientRect();
        return { x: Math.round(r.x + canvas.headSize.displayRowHeadWidth + canvas.areaData.getDisplayViewLeftByCol(1) + 30),
          y: Math.round(r.y + canvas.headSize.displayColHeadHeight + canvas.areaData.getDisplayViewTopByRow(1) + 10) };
      });
      if (uiUndoToolbar) contents.focus();
      else await focusNativeInput(contents);
      uiUndoEvidence.push(uiUndoToolbar ? { action: "native webContents focus requested; actual UI input required" } : { action: "native-focus", confirmed: true });
      const beforeInput = await readCell();
      assert.equal(beforeInput, "42");
      uiUndoEvidence.push({ action: "before UI input", nativeValue: beforeInput });
      await inputReport("before mouse", { cellPoint, target: { address: "B2", row: 1, col: 1 } });
      contents.sendInputEvent({ type: "mouseMove", ...cellPoint });
      contents.sendInputEvent({ type: "mouseDown", ...cellPoint, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseUp", ...cellPoint, button: "left", clickCount: 1 });
      contents.sendInputEvent({ type: "mouseDown", ...cellPoint, button: "left", clickCount: 2 });
      contents.sendInputEvent({ type: "mouseUp", ...cellPoint, button: "left", clickCount: 2 });
      await eventually("cell editor active", () => evaluate(contents, () => window.SpreadsheetApp.view.canvas.inputManager.isInputtingState()));
      await inputReport("after double click");
      shortcut("A");
      await inputReport("after real Select All with standard menu");
      const selected = await evaluate(contents, () => document.getSelection()?.toString());
      if (selected !== "42") await selectSyntheticCellText(contents, evaluate, eventually, "42");
      await inputReport("after real text selection", { selectAllSucceeded: selected === "42" });
      await contents.insertText("84");
      await eventually("synthetic editor contains replacement text", () => evaluate(contents, () =>
        document.activeElement?.id === "alloy-rich-text-editor" && document.activeElement.textContent === "84"));
      await inputReport("after insertText");
      contents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      contents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
      await inputReport("after Enter");
      await eventually("UI input committed to real native model", async () => (await readCell()) === "84");
      uiUndoEvidence.push({ action: "UI insertText + Enter", nativeValue: "84" });
      await inputReport("native insert confirmed");
      stage = uiUndoToolbar ? "UI toolbar undo after committed input" : "UI undo after committed input (no refocus)";
      await historyAction("undo before layouts");
      await inputReport("after history input dispatch");
      await eventually("UI undo confirmed natively", async () => (await readCell()) === "42");
      uiUndoEvidence.push({ action: "UI undo before layouts", nativeValue: "42" });
      await inputReport("native undo confirmed");
    }
    const full = await layout("collapsed-initial", identity);
    stage = "AI expand";
    const ai = 'button[aria-controls="file-window-conversation"]';
    const closeAi = '.file-window-close-conversation';
    await click(window.webContents, ai);
    await eventually("real conversation mounted", () => evaluate(window.webContents,
      () => Boolean(document.querySelector('#file-window-conversation:not([hidden]) .file-window-conversation-body')?.childElementCount)));
    const expanded = await layout("expanded", identity, true, (width) => width < full.width - 200);
    assert.ok(expanded.width < full.width - 200);
    stage = "AI resize";
    const divider = await evaluate(window.webContents, () => {
      const r = document.querySelector('[role="separator"]').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
    window.webContents.sendInputEvent({ type: "mouseMove", ...divider });
    window.webContents.sendInputEvent({ type: "mouseDown", ...divider, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseMove", x: divider.x - 100, y: divider.y, modifiers: ["leftButtonDown"] });
    window.webContents.sendInputEvent({ type: "mouseUp", x: divider.x - 100, y: divider.y, button: "left", clickCount: 1 });
    await eventually("separator state changed", () => evaluate(window.webContents,
      () => Number(document.querySelector('[role="separator"]')?.getAttribute("aria-valuenow")) > 48));
    const resized = await layout("resized", identity, true, (width) => width < expanded.width - 80);
    assert.ok(resized.width < expanded.width - 80);
    stage = "narrow screen hides native view without replacing model";
    window.setSize(720, 700);
    await eventually("narrow conversation hides native view", async () => !nativeView() && !contents.isDestroyed() && await evaluate(window.webContents,
      () => innerWidth <= 760 && getComputedStyle(document.querySelector('.file-window-document')).display === "none"));
    assert.equal(doc.documentId, identity.documentId);
    assert.equal((await engine.editor(filePath)).file_id, identity.engineFileId);
    assert.equal((await engine.editor(filePath)).is_dirty, true);
    assert.equal(contents.id, identity.webContentsId);
    assert.equal(window.webContents.id, identity.hostWebContentsId);
    assert.equal(await content.read(), "42");
    layouts.push({ label: "narrow-expanded", nativeAttached: false, nativeAlive: true, ...identity, dirty: true });
    await click(window.webContents, closeAi);
    const narrow = await layout("narrow-collapsed", identity);
    assert.equal(narrow.width, 720);
    window.setSize(1280, 860);
    await layout("wide-restored", identity);
    await click(window.webContents, ai);
    await layout("expanded-restored", identity, true, (width) => width < full.width - 200);
    stage = "AI collapse";
    await click(window.webContents, closeAi);
    await eventually("AI collapsed", () => evaluate(window.webContents, () => document.querySelector('#file-window-conversation')?.hidden));
    const collapsed = await layout("collapsed", identity, true, (width) => width === full.width);
    assert.equal(collapsed.width, full.width);
    assert.deepEqual(await readFile(filePath), originalBytes);
    if (uiUndo) {
      stage = "UI redo/undo retained across AI layout changes";
      await historyAction("redo after layouts", true);
      await eventually("UI redo retained", async () => (await readCell()) === "84");
      uiUndoEvidence.push({ action: "UI redo after layouts", nativeValue: "84" });
      await inputReport("native redo after layouts confirmed");
      await historyAction("undo after layouts");
      await eventually("UI undo retained", async () => (await readCell()) === "42");
      uiUndoEvidence.push({ action: "UI undo after layouts", nativeValue: "42" });
      await inputReport("native undo after layouts confirmed");
      assert.equal((await engine.editor(filePath)).is_dirty, true);
      assert.deepEqual(await readFile(filePath), originalBytes, "UI history must not save implicitly");
      if (uiUndoToolbar) await toolbarReport("after retained undo/redo; before save");
    }
    stage = "save through FileWindowApp toolbar";
    await click(window.webContents, '[data-file-editor-toolbar] button[aria-label="Save"]');
    await eventually("native save completed", async () => !(await engine.editor(filePath)).is_dirty && await content.disk("42"));
    await layout("saved", identity, false);
    stage = "close through real tab UI";
    await click(window.webContents, ".file-window-close");
    await eventually("native model closed", async () => doc.state === "closed" && !(await engine.editor(filePath)));
    assert.equal(nativeView(), undefined);
    stage = "reopen same path";
    await files.open({ workspaceId, sessionId, path: relativePath });
    await eventually("reopened SDK ready", pageReady);
    assert.equal(await readCell(), "42");
    assert.equal((await engine.editor(filePath)).is_dirty, false);
    assert.notEqual(nativeView().webContents.id, identity.webContentsId, "close/reopen really creates a new page");
    await eventually("reopened page commits ready", async () => {
      await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId });
      return evaluate(nativeView().webContents, () => document.readyState === "complete");
    });
    const closeReopenValue = await readCell();
    stage = "dirty native host close cancel/save/discard with synthetic dialog choices";
    const disk42 = await content.disk("42");
    await content.edit("84");
    await eventually("dirty before close cancellation", async () => (await engine.editor(filePath)).is_dirty);
    const cancelIdentity = { documentId: doc.documentId, engineFileId: doc.engineFileId, nativeId: nativeView().webContents.id, hostId: window.id };
    const closesBeforeCancel = closeReports.length;
    dialogs.enqueue("cancel"); window.close();
    await eventually("synthetic cancel consumed", () => dialogs.reports.at(-1)?.choice === "cancel");
    await wait(200);
    assert.equal(window.isDestroyed(), false); assert.equal(window.id, cancelIdentity.hostId);
    assert.equal(doc.documentId, cancelIdentity.documentId); assert.equal(doc.engineFileId, cancelIdentity.engineFileId);
    assert.equal(nativeView().webContents.id, cancelIdentity.nativeId);
    assert.equal((await engine.editor(filePath)).is_dirty, true); assert.equal(await content.read(), "84");
    assert.deepEqual(await readFile(filePath), disk42); assert.equal(closeReports.length, closesBeforeCancel);
    dialogs.enqueue("save"); window.close();
    await eventually("dirty save closes real host and model", async () => window.isDestroyed() && doc.state === "closed" && !(await engine.editor(filePath)));
    await content.disk("84");
    await files.open({ workspaceId, sessionId, path: relativePath }); [window] = files.windows();
    await eventually("saved close reopens native SDK", pageReady);
    await eventually("saved reopen commit ready", async () => { await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId }); return true; });
    assert.equal(await content.read(), "84"); assert.equal((await engine.editor(filePath)).is_dirty, false);
    const disk84 = await content.disk("84");
    await content.edit("96");
    await eventually("dirty before discard", async () => (await engine.editor(filePath)).is_dirty);
    dialogs.enqueue("discard"); window.close();
    await eventually("dirty discard closes real host and model", async () => window.isDestroyed() && doc.state === "closed" && !(await engine.editor(filePath)));
    assert.deepEqual(await readFile(filePath), disk84);
    await files.open({ workspaceId, sessionId, path: relativePath }); [window] = files.windows();
    await eventually("discard close reopens native SDK", pageReady);
    await eventually("discard reopen commit ready", async () => { await panel.prepareSave({ workspaceId, documentId: doc.documentId, pageId: doc.pageId }); return true; });
    assert.equal(await content.read(), "84"); assert.equal((await engine.editor(filePath)).is_dirty, false);
    await click(window.webContents, ".file-window-close");
    await eventually("final native model closed", async () => doc.state === "closed" && !(await engine.editor(filePath)) && !nativeView());
    dialogs.assertConsumed();
    assert.deepEqual(dialogs.reports.map((report) => report.choice), ["cancel", "save", "discard"]);
    assert.equal((await engine.tool("get_pool_status", {})).pool_size, 0, "Final close must release every native model");
    if (reviewResources) console.log(JSON.stringify({ resourceEvidence }));
    assertOfficeResources(resourceReports);
    assert.ok(requests.some((path) => path.includes("/opencode/provider")), "real conversation must request its backend");
    assert.deepEqual(violations, []);
    console.log(JSON.stringify({ result: "pass", electron: process.versions.electron,
      testedFormats: [format], sdk: { available: (await engine.capabilities()).available, engineVersion: (await engine.capabilities()).engineVersion },
      resourceReports, uiUndoEvidence, toolbarEvidence, shortcutInputs, nativeFocusEvents, menuEvidence, backend: "synthetic session + Main desktopConfig/client; no model invoked",
      ui: "production FileWindowApp + createFileWindows + createOfficePanel + generated sandbox CJS",
      edit: uiUndo ? "native sheet_set_cell_value + SDK UI insertText natively read back as 84" : `real native ${kind} tool write/readback; no UI text input`,
      undo: uiUndo ? `${uiUndoToolbar ? "SDK toolbar mouse" : "keyboard shortcut"} UI undo 84→42 before layout; redo 42→84 and undo 84→42 after layout, native readback confirmed` : "not tested; opt in with sheet/csv --ui-undo or --ui-undo-toolbar", layouts,
      save: { originalPath: true, nativeDirtyCleared: true, closeReopenValue, diskContent: true, saveReports },
      dirtyClose: { dialogChoices: dialogs.reports, closeReports, cancelPreservesIdentityDirtyDisk: true, saveReopen: "84", discardReopen: "84" },
      focus: uiUndoToolbar ? "native webContents focus requested; real mouse/insertText/keys verified by native model readback" : uiUndo ? "isolated fixture BrowserWindow + native webContents focused; no global desktop input" : "OS show/focus suppressed in isolated fixture; focus behavior not tested" }));
    await cleanup(0);
  } catch (error) {
    console.error(`Office file-window acceptance failed at ${stage}`, error);
    if (uiUndo && kind === "sheet" && doc?.engineFileId && doc.state !== "closed") {
      try {
        await inputReport("failure final readback");
        if (uiUndoToolbar && shortcutInputContents && !shortcutInputContents.isDestroyed()) {
          const report = { label: "failure final readback", nativeValue: await readCell(), dirty: (await engine.editor(filePath)).is_dirty,
            ...await evaluate(shortcutInputContents, syntheticSheetToolbarState) };
          toolbarEvidence.push(report);
          console.log(JSON.stringify({ officeSyntheticToolbar: report }));
        }
      }
      catch (diagnosticError) { console.error("Synthetic input diagnostic failed", diagnosticError); }
    }
    console.error(JSON.stringify({ testedFormats: [format], uiUndoEvidence, toolbarEvidence, shortcutInputs, nativeFocusEvents, menuEvidence, resourceReports, resourceEvidence, violationCount: violations.length, layouts, closeReports, dialogs: dialogs.reports }));
    await cleanup(1);
  }
}
void run();

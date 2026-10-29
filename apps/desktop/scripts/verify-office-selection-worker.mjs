import { app, BrowserWindow, ipcMain, session } from "electron";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, readFile } from "node:fs/promises";
import { OfficeEngine } from "../../server/dist/office/engine.js";
import { OfficeSelectionEdits } from "../../server/dist/office/selection-edits.js";
import { describeOfficeSelectionTool } from "../../server/dist/office/selection-tools.js";
import { createOfficeResources } from "../electron/office-resources.mjs";
import { readOfficePageSelection } from "../electron/office-page-selection.mjs";
import { revealOfficePageSelection } from "../electron/office-page-reveal.mjs";
import { waitForWordPageCommit, waitForSheetPageCommit, waitForSlidePageCommit } from "../electron/office-page-commit.mjs";

const root = process.argv[2];
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const picturePageTest = process.argv.includes("--slide-picture-page");
app.setPath("userData", join(root, "profile"));
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const engine = new OfficeEngine({ resourceDirectory: join(desktop, "resources/office-engine"), logDirectory: join(root, "logs") });
const resources = createOfficeResources({ assetsDirectory: join(desktop, "resources/office-assets"), cacheDirectory: join(root, "fonts"),
  ...(picturePageTest ? { fetch: async () => { throw new Error("图片页回归禁止联网"); } } : {}) });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let current, attached, document, edits;
const templates = [];
const reports = [];
const captures = [];
const referencesByCapture = new Map();
const canceledCaptures = new Set();
const selectionActionSelector = '[data-jugglework-office-action="request-edits"]';
const focusEvents = [];
function traceFocus(type, detail = {}) {
  focusEvents.push({ at: Date.now(), type, ...detail });
  if (focusEvents.length > 100) focusEvents.shift();
}
for (const name of ["activate", "did-become-active", "did-resign-active", "browser-window-focus", "browser-window-blur"]) {
  app.on(name, () => traceFocus(`app:${name}`));
}
async function focusDiagnostics() {
  const native = current && !current.isDestroyed() ? { appActive: app.isActive(), visible: current.isVisible(), focused: current.isFocused(), webFocused: current.webContents.isFocused() } : null;
  const page = native ? await evaluate(() => ({
    focused: document.hasFocus(), visibility: document.visibilityState,
    active: document.activeElement?.outerHTML.slice(0, 300),
    ui: document.getElementById("juggle-office-selection-ui")?.innerText,
    hover: [...document.querySelectorAll(":hover")].slice(-4).map((node) => node.getAttribute("aria-label") || node.id || node.tagName),
    events: window.__selectionWorkerFocusEvents,
  })).catch((error) => ({ error: error.message })) : null;
  console.error(JSON.stringify({ focusDiagnostics: { native, page, events: focusEvents, captures, reports } }));
}
let holdCaptureReply = false, releaseCaptureReply = null;
const fontUrls = new Set();
async function eventually(action) {
  const caller = new Error(`等待验收条件超时：${action.toString()}`);
  const deadline = Date.now() + 25_000; let error;
  while (Date.now() < deadline) { try { const value = await action(); if (value) return value; } catch (next) { error = next; } await wait(100); }
  throw error ?? caller;
}
const evaluate = async (fn, ...args) => {
  const result = await current.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${fn.toString()})(...${JSON.stringify(args)})}}catch(error){return {ok:false,message:String(error?.message??error)}}})()`);
  if (!result.ok) throw new Error(`页面验收失败：${result.message}`);
  return result.value;
};
const read = () => evaluate(readOfficePageSelection, document.kind);
/** 原生窗口的 focused 先于 renderer focus 通知；输入必须等两端都完成激活。 */
async function focusCurrentWindow() {
  if (!app.isActive()) app.focus({ steal: true });
  if (!current.isFocused()) current.focus();
  await eventually(async () => current.isVisible() && current.isFocused() && current.webContents.isFocused() && await evaluate(() => document.hasFocus()));
}
/** 真实鼠标先移动再按下；只执行一次点击，不在采集或写入失败后重放。 */
async function clickSelectionEntry() {
  traceFocus("click:activate");
  await focusCurrentWindow();
  const point = await evaluate((selector) => {
    const entry = window.document.querySelector(selector), rect = entry.getBoundingClientRect();
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    if (rect.width <= 0 || rect.height <= 0 || entry.disabled || !entry.contains(document.elementFromPoint(point.x, point.y))) throw new Error("选区入口不可点击");
    return point;
  }, selectionActionSelector);
  traceFocus("click:entry", point);
  current.webContents.sendInputEvent({ type: "mouseMove", ...point });
  current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  current.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

ipcMain.handle("jugglework:office:selection-capture", async (event, { captureId, expectedSelection }) => {
  traceFocus("ipc:capture", { captureId });
  assert.equal(event.sender, current.webContents);
  assert.notEqual(await evaluate(() => window.document.activeElement?.getAttribute("aria-label")), "说说你想怎么修改");
  const started = performance.now();
  const reference = await edits.capture(document, captureId, expectedSelection);
  assert.notEqual(reference.locator.kind, "doc-caret");
  if (picturePageTest) {
    const native = await evaluate(() => { const s = window.pray().getSelectionService(); return { index: s.currentSlideIndex, id: s.currentSlide.id }; });
    assert.deepEqual(reference.locator, { kind: "slide-pages", pageIndices: [native.index] });
    assert.deepEqual(expectedSelection, { pageIndex: [native.index], shapeIds: [], nativeSlideIds: [native.id] });
  }
   if (!["slide-text", "slide-pages"].includes(reference.locator.kind)) await evaluate(revealOfficePageSelection, reference.locator);
  captures.push({ kind: document.kind, referenceId: reference.referenceId, locator: reference.locator, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(JSON.stringify(reference)) });
  referencesByCapture.set(captureId, reference);
  if (holdCaptureReply) await new Promise((resolve) => { releaseCaptureReply = resolve; });
  traceFocus("ipc:captured", { captureId });
  return { reference };
});
ipcMain.handle("jugglework:office:selection-submit", async (event, input) => {
  traceFocus("ipc:submit", { captureId: input.captureId });
  assert.equal(event.sender, current.webContents);
  if (picturePageTest) {
    const reference = referencesByCapture.get(input.captureId);
    assert.equal(reference?.referenceId, input.referenceId);
    assert.equal(reference.locator.kind, "slide-pages");
    assert.equal(input.mode, "add");
    assert.equal(typeof input.text, "string");
    assert.ok(input.text.length > 0);
    // 有限 preload 桥只登记添加结果；不调用模型工具或保存文档。
    reports.push({ kind: document.kind, text: input.text, mode: input.mode, selectionRef: input.referenceId,
      locator: reference.locator, writes: 0, saved: false });
    return { ok: true };
  }
   await edits.prepareTurn("ws", "chat", `turn-${document.kind}`, { officeSelectionRefs: [input.referenceId], officeInstructions: [{ instructionId: "fixture-instruction", text: input.text, bindingState: "bound", referenceIds: [input.referenceId] }] });
   if (referencesByCapture.get(input.captureId)?.locator.kind === "slide-pages") {
     assert.equal(process.argv.includes("--slide-page"), true);
      const locator = referencesByCapture.get(input.captureId).locator;
      assert.deepEqual(locator.pageIndices, [0]);
      const invoke = (name, args) => edits.call("ws", "chat", `turn-${document.kind}`, "assistant", name, args, input.referenceId);
      const toolNames = await edits.tools("ws", "chat", `turn-${document.kind}`, input.referenceId);
      const schemas = (await engine.listTools()).filter((tool) => toolNames.includes(tool.name)).map((tool) => describeOfficeSelectionTool(tool, locator));
      console.log(JSON.stringify({ slidePageSchemas: schemas.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })) }));
     const before = await engine.tool("slide_get_page_info", { file_id: document.engineFileId, page_index: 0 });
     assert.equal(before.shapes.length, 2, "整页验收必须有两个普通文本框");
     const [first, second] = before.shapes;
     const changes = [
       ["slide_set_text", { shape_id: first.id, text: "整页修改后的标题" }],
       ["slide_set_text", { shape_id: second.id, text: "整页修改后的正文" }],
       ["slide_set_text_property", { shape_id: first.id, bold: true, color: "FF0000", font_size: 24 }],
       ["slide_set_shape_properties", { shape_id: second.id, x: 50, y: 160, w: 320, h: 90 }],
     ];
      const receipts = [];
      for (const [name, args] of changes) {
        assert.ok(toolNames.includes(name));
        const schema = schemas.find((tool) => tool.name === name).inputSchema;
        assert.ok(Object.keys(args).every((key) => Object.hasOwn(schema.properties, key)));
        assert.ok(schema.required.every((key) => Object.hasOwn(args, key)));
        const result = await invoke(name, args);
       assert.equal(result.receipt.status, "modified");
       assert.equal(result.receipt.readback, "confirmed");
       assert.equal(result.receipt.requiresReselection, false, "单页引用允许连续修改不同框及样式/几何");
        assert.equal(result.receipt.selectionRef, input.referenceId);
        receipts.push({ tool: name, ...result.receipt });
     }
     const changed = await engine.tool("slide_get_page_info", { file_id: document.engineFileId, page_index: 0 });
     assert.equal(changed.page_id, before.page_id);
     assert.deepEqual(changed.shapes.map((shape) => shape.id), before.shapes.map((shape) => shape.id));
     assert.equal(changed.shapes[0].text.replace(/\r$/, ""), "整页修改后的标题");
     assert.equal(changed.shapes[1].text.replace(/\r$/, ""), "整页修改后的正文");
     for (const [key, expected] of Object.entries({ x: 50, y: 160, w: 320, h: 90 })) assert.equal(changed.shapes[1][key], expected);
     const styled = await engine.tool("slide_get_text", { file_id: document.engineFileId, page_index: 0, shape_id: first.id });
     assert.ok(styled.runs.length > 0);
     assert.ok(styled.runs.every((run) => run.bold === true && run.color === "FF0000" && run.font_size === 24));
      const saved = await edits.save("ws", "chat", `turn-${document.kind}`, input.referenceId);
      assert.equal(saved.receipt.saved, true); assert.equal(saved.receipt.selectionRef, input.referenceId);
      assert.equal((await engine.tool("slide_get_info", { file_id: document.engineFileId })).is_dirty, false);
      reports.push({ kind: document.kind, text: input.text, mode: input.mode, selectionRef: input.referenceId, writes: changes.length, receipts, saveReceipt: saved.receipt, saved: true });
     return { ok: true };
   }
  const textRange = referencesByCapture.get(input.captureId)?.locator.kind === "slide-text";
  const tool = textRange ? "slide_set_text_property" : { doc: "doc_replace_text", sheet: "sheet_set_cell_value", slide: "slide_set_text" }[document.kind];
  const args = textRange ? { bold: true } : document.kind === "sheet" ? { cell: { row: 0, col: 0, value_type: "STRING", string_value: "已修改" } }
    : { text: document.kind === "doc" && process.argv.includes("--word-cross") ? "新正文\n\n新末" : "已修改" };
  const result = await edits.call("ws", "chat", `turn-${document.kind}`, "assistant", tool, args, input.referenceId);
  assert.equal(result.receipt.status, "modified");
  await edits.save("ws", "chat", `turn-${document.kind}`, input.referenceId);
  reports.push({ kind: document.kind, text: input.text, mode: input.mode, saved: true });
  return { ok: true };
});
ipcMain.handle("jugglework:office:selection-cancel", (event, { captureId }) => {
  traceFocus("ipc:cancel", { captureId });
  assert.equal(event.sender, current.webContents);
  const reference = referencesByCapture.get(captureId);
  if (reference) edits.release("ws", "chat", [reference.referenceId]);
  canceledCaptures.add(captureId);
  return { ok: true };
});
async function cleanup() {
  const window = current; current = null;
  const binding = attached; attached = null;
  if (window && !window.isDestroyed()) window.destroy();
  binding?.dispose();
  await engine.dispose();
  for (const path of templates) await rm(path, { force: true });
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void cleanup().finally(() => app.exit(1)); });
async function run() {
try {
  await app.whenReady();
  for (const entry of JSON.parse(await readFile(join(desktop, "resources/office-assets/manifest.json"), "utf8")).entries)
    if (entry.kind === "font") fontUrls.add(entry.url);
  console.log("Office 选区页面验收宿主已就绪");
  for (const kind of ["doc", "sheet", "slide"]) {
     const filter = process.argv.find((arg) => arg.startsWith("--kind="))?.slice(7);
     if (filter && filter !== kind) continue;
     if (["--slide-page", "--slide-page-ui", "--slide-identity", "--slide-picture-page"].some((flag) => process.argv.includes(flag)) && kind !== "slide") continue;
    console.log(`验证 ${kind} 页面`);
     const picturePageInput = picturePageTest && process.argv.find((arg) => arg.startsWith("--slide-picture-page-input="))?.split("=").slice(1).join("=");
     const created = picturePageInput ? { file_path: picturePageInput } : await engine.tool(`create_${kind}`, {});
     if (!picturePageInput) {
     templates.push(created.file_path);
    const query = { doc: "doc_get_last_operable_pos", sheet: "sheet_get_sheet_info", slide: "slide_get_info" }[kind];
    await eventually(async () => { const info = await engine.tool(query, { file_id: created.file_id }); return kind !== "slide" || info.is_open; });
    if (kind === "doc") {
      await engine.tool("doc_insert_text", { file_id: created.file_id, idx: 0, text: "前文 选中的内容 后文" });
      for (const text of ["", "", "是多少"]) {
        const end = await engine.tool("doc_get_last_operable_pos", { file_id: created.file_id });
        await engine.tool("doc_insert_paragraph_with_text", { file_id: created.file_id, idx: end.position, text, type: 0 });
      }
    }
    if (kind === "slide") {
      if (!picturePageTest) await engine.tool("slide_add_text", { file_id: created.file_id, page_index: 0, x: 30, y: 30, w: 300, h: 80, text: "前选中后" });
      if (process.argv.includes("--slide-page")) await engine.tool("slide_add_text", { file_id: created.file_id, page_index: 0, x: 30, y: 150, w: 300, h: 80, text: "第二个普通文本框" });
      if (process.argv.includes("--slide-page-ui")) await engine.tool("slide_add_slide", { file_id: created.file_id, index: -1 });
      if (picturePageTest) {
        await engine.tool("slide_add_slide", { file_id: created.file_id, index: -1 });
        for (const index of [0, 1]) {
          if (index) await engine.tool("slide_add_text", { file_id: created.file_id, page_index: index, x: 30, y: 30, w: 300, h: 80, text: "同页保留正文" });
          await engine.tool("slide_add_image", { file_id: created.file_id, page_index: index, x: 400, y: 200, w: 160, h: 100,
            image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0V0AAAAASUVORK5CYII=" });
        }
      }
    }
    const fixturePath = join(root, `验收.${{ doc: "docx", sheet: "xlsx", slide: "pptx" }[kind]}`);
    await engine.tool("save_file", { file_id: created.file_id, file_path: fixturePath });
     await engine.close(created.file_id);
     created.file_path = fixturePath;
     }
    const preview = new URL(await engine.previewUrl(created.file_path));
    const partition = session.fromPartition(`selection-${kind}`);
    const outgoing = [];
    partition.webRequest.onSendHeaders((detail) => { const url = new URL(detail.url); if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname !== "127.0.0.1") outgoing.push(detail.url); });
    const blockedWrites = [];
    const pagePartition = picturePageTest ? { protocol: partition.protocol, webRequest: partition.webRequest, fetch: (request, options) => {
      const url = new URL(request.url);
      if (url.origin !== preview.origin) throw new Error("图片页回归禁止联网");
      if (request.method === "POST" && url.pathname === "/localapi/commitrevision") {
        blockedWrites.push(url.pathname);
        return Promise.resolve(new Response(JSON.stringify({ code: -1, message: "图片页回归禁止内容写入" }), { status: 409, headers: { "Content-Type": "application/json" } }));
      }
      return partition.fetch(request, options);
    } } : partition;
    attached = resources.attach(pagePartition, { documentId: kind, origin: preview.origin, filePath: created.file_path, kind, selectionUi: true, commit: { error: null },
      save: async () => { assert.equal(picturePageTest, false, "图片页回归不允许保存"); const editor = await engine.editor(created.file_path); await engine.save(editor.file_id); return { engineFileId: editor.file_id }; }, onCoreFailure: () => {} });
    current = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(desktop, "electron/office-selection-preload.cjs") } });
    for (const name of ["ready-to-show", "show", "focus", "blur"]) current.on(name, () => traceFocus(`window:${name}`, { kind }));
    await current.loadURL(preview.href);
    await evaluate(() => {
      const events = window.__selectionWorkerFocusEvents = [];
      for (const type of ["focus", "blur", "focusin", "focusout", "pointerdown", "pointerup", "mousemove", "visibilitychange"]) {
        window.addEventListener(type, (event) => {
          const target = event.target === window ? "window" : event.target?.getAttribute?.("aria-label") || event.target?.id || event.target?.tagName;
          if (type === "mousemove" && events.at(-1)?.type === type && events.at(-1)?.target === target) return;
          events.push({ at: Date.now(), type, target, trusted: event.isTrusted,
            focused: document.hasFocus(), active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.id || document.activeElement?.tagName,
            x: event.clientX, y: event.clientY });
          if (events.length > 100) events.shift();
        }, true);
      }
    });
    traceFocus("window:activate", { kind });
    current.show();
    await focusCurrentWindow();
    console.log(`${kind} 页面已加载`);
    const editor = await eventually(() => engine.editor(created.file_path));
    document = { documentId: `doc-${kind}`, pageId: `page-${kind}`, artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: created.file_path, name: kind, state: "ready", engineFileId: editor.file_id, kind };
    const prepare = { doc: waitForWordPageCommit, sheet: waitForSheetPageCommit, slide: waitForSlidePageCommit }[kind];
    await eventually(async () => { await current.webContents.executeJavaScript(`(${prepare.toString()})(window,1000)`); return true; });
    // 页面函数首参是 scope，单独序列化注入 window，避免把窗口当作 JSON 传递。
    edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => current.webContents.executeJavaScript(`(${prepare.toString()})(window,1000)`), selection: async () => {const selected=await read();if(process.argv.includes("--inspect"))console.log(JSON.stringify({captureSelection:selected}));return selected;},
      tool: (name, args) => { if (picturePageTest) assert.ok(name.startsWith("slide_get_"), "图片页采集只允许读取"); return engine.tool(name, args); },
      modified: async () => { assert.equal(picturePageTest, false); }, save: async () => { assert.equal(picturePageTest, false); await engine.save(document.engineFileId); return document; } });
    if (picturePageTest) {
      const before = await engine.tool("slide_get_info", { file_id: editor.file_id });
      const pages = [];
      for (const index of picturePageInput ? [0, 49, 50] : [0, 1]) {
        await focusCurrentWindow();
        const thumbnail = await eventually(() => evaluate((index) => {
          const s = window.pray().getSelectionService(), outer = window.document.getElementById(s.slides[index].key);
          if (!outer) return null;
          outer.scrollIntoView({ block: "center" });
          const r = outer.getBoundingClientRect();
          return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null;
        }, index));
        current.webContents.sendInputEvent({ type: "mouseMove", ...thumbnail });
        current.webContents.sendInputEvent({ type: "mouseDown", ...thumbnail, button: "left", clickCount: 1 });
        current.webContents.sendInputEvent({ type: "mouseUp", ...thumbnail, button: "left", clickCount: 1 });
        await eventually(() => evaluate((index) => { const s = window.pray().getSelectionService(); return s.currentSlideIndex === index && s.currentSlide === s.slides[index] && s.lastMouseDownRegion === "slidelist" && s.currentSlide.children.length > 0; }, index));
        await wait(250);
        const page = await engine.tool("slide_get_page_info", { file_id: editor.file_id, page_index: index });
        const picture = page.shapes.find((shape) => shape.type === "picture");
        assert.ok(picture);
        const point = await evaluate((picture, size) => {
          const rect = window.document.getElementById("stable-layer").getBoundingClientRect();
          if (!(rect.width > 0 && rect.height > 0 && size.w_pt > 0 && size.h_pt > 0)) throw new Error("图片可见位置不可用");
          return { x: Math.round(rect.x + (picture.x + picture.w / 2) * rect.width / size.w_pt),
            y: Math.round(rect.y + (picture.y + picture.h / 2) * rect.height / size.h_pt) };
        }, picture, before);
        await focusCurrentWindow();
        current.webContents.sendInputEvent({ type: "mouseMove", ...point });
        current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        current.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
        await eventually(async () => (await read())?.shapeIds?.[0] === picture.id);
        assert.deepEqual(await read(), { pageIndex: index, shapeIds: [picture.id] }, "默认选区读取仍保留图片对象语义");
        await eventually(() => evaluate((selector) => { const entry = window.document.querySelector(selector); return entry?.style.display === "block" && entry.textContent === "✦ AI 编辑当前页" && entry.getAttribute("aria-label") === "AI 编辑当前页"; }, selectionActionSelector));
        const count = captures.length;
        await clickSelectionEntry();
        await eventually(() => evaluate(() => window.document.activeElement?.getAttribute("aria-label") === "说说你想怎么修改"));
        assert.equal(captures.length, count + 1, "真实 pointerdown 只采集一次");
        assert.deepEqual(captures.at(-1).locator, { kind: "slide-pages", pageIndices: [index] });
        assert.equal(await evaluate(() => window.document.activeElement.value), "");
        assert.equal(reports.length, pages.length, "采集和打开输入框不应自动添加要求");
        current.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return", modifiers: ["control"] });
        current.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return", modifiers: ["control"] });
        await wait(150);
        assert.equal(reports.length, pages.length, "空要求不能发送");
        const text = `第 ${index + 1} 页图片入口要求`;
        await current.webContents.insertText(text);
        assert.equal(await evaluate(() => window.document.activeElement.value), text);
        current.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        current.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await eventually(() => reports.length === pages.length + 1);
        assert.equal(reports.at(-1).text, text);
        assert.equal(reports.at(-1).mode, "add");
        assert.deepEqual(reports.at(-1).locator, { kind: "slide-pages", pageIndices: [index] });
        await eventually(() => evaluate(() => !window.document.querySelector('[aria-label="编辑所选内容"]')));
        assert.deepEqual(await engine.tool("slide_get_page_info", { file_id: editor.file_id, page_index: index }), page);
        pages.push({ index, pageId: page.page_id, pictureId: picture.id, textShapes: page.shapes.filter(s => s.type === "shape").length,
          scope: reports.at(-1).locator, mode: reports.at(-1).mode });
      }
      assert.deepEqual(await engine.tool("slide_get_info", { file_id: editor.file_id }), before);
      assert.deepEqual(blockedWrites, []);
      assert.deepEqual(outgoing, []);
      console.log(JSON.stringify({ slidePicturePage: "passed", fixture: picturePageInput ? "attachment copy" : "generated", pages, injection: "production configureOfficePageResponse toString chain", writes: 0, saved: false, externalRequests: 0 }));
      current.destroy(); current = null; attached.dispose(); attached = null;
      await engine.close(editor.file_id, true);
      continue;
    }
    if (kind === "doc") {
      await current.webContents.executeJavaScript("pad.editor.enterEditMode()");
      await eventually(() => evaluate(() => window.document.activeElement?.id === "melo-hidden-editor"));
    }
    await wait(150);
    if (kind === "sheet") {
      await current.webContents.executeJavaScript("SpreadsheetApp.view.canvas.selectApi.selectRows(SpreadsheetApp.view.canvas.normalSelectData,[0,0])");
      if (process.argv.includes("--inspect")) console.log(JSON.stringify({ rowIntent: await current.webContents.executeJavaScript("SpreadsheetApp.view.getSelectionRanges().map(r=>({...r,endColInfinite:r.endColIndex===Infinity,endRowInfinite:r.endRowIndex===Infinity}))") }));
      await current.webContents.executeJavaScript("SpreadsheetApp.view.setCurrentSelection({xRange:[0,0],yRange:[0,0]})");
      const firstSheetId = await evaluate(() => window.SpreadsheetApp.workbook.activeSheet.getSheetId());
      await eventually(() => evaluate(() => !!window.ContainerApp?.containerView?.footer?.sheetsbarService));
      assert.equal(await evaluate(() => window.__WB_DOCS_FEATURE_LIST__?.aiEdit), false);
      const secondSheetId = await evaluate(async () => window.ContainerApp.containerView.footer.sheetsbarService.triggerAddSheet({ sheetName: "定位验收", isCreateEmptySheet: true, autoSwitch: false }));
      assert.ok(secondSheetId);
      await evaluate(async (id) => window.ContainerApp.containerView.footer.sheetsbarService.triggerSwitchSheet(id, window.ContainerApp.containerModel.activeSheetId, {}), secondSheetId);
      await eventually(() => evaluate((id) => window.SpreadsheetApp.view.renderedSheetId === id && window.SpreadsheetApp.workbook.activeSheet.getSheetId() === id, secondSheetId));
      await evaluate(() => window.SpreadsheetApp.view.setCurrentSelection({ xRange: [3, 3], yRange: [5, 5] }));
      const assertSheetAnchor = async () => eventually(() => evaluate((selector) => {
        const app = window.SpreadsheetApp, canvas = app.view.canvas;
        const range = app.view.getSelectionRanges()[0];
        const rect = canvas.clientRect.container.getBoundingClientRect();
        const x = rect.left + canvas.headSize.displayRowHeadWidth + canvas.areaData.getDisplayViewLeftByCol(range.startColIndex);
        const y = rect.top + canvas.headSize.displayColHeadHeight + canvas.areaData.getDisplayViewBottomByRow(range.startRowIndex) + 8;
        const entry = document.querySelector(selector), actual = entry.getBoundingClientRect();
        return entry.style.display === "block" && Math.abs(actual.left - x) < 1 && Math.abs(actual.top - y) < 1;
      }, selectionActionSelector));
      // 必须真实点击底部 tab，不能用画布鼠标位置或手动 selectionchange 掩盖旧定位问题。
      const clickSheetTab = async (id) => {
        const point = await eventually(() => evaluate((id) => {
          const tab = [...document.querySelectorAll('[role="tab"][data-tab-id]')].find((node) => node.getAttribute("data-tab-id") === id);
          const rect = tab?.getBoundingClientRect();
          return rect?.width > 0 ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null;
        }, id));
        current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        current.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
        await eventually(() => evaluate((id) => window.SpreadsheetApp.view.renderedSheetId === id && window.SpreadsheetApp.workbook.activeSheet.getSheetId() === id, id));
        await assertSheetAnchor();
        assert.equal(await evaluate(() => document.querySelectorAll(".ai-prompt-card-entry").length), 0, "切表后不出现 SDK 原生 AI 入口");
      };
      await clickSheetTab(firstSheetId);
      await clickSheetTab(secondSheetId);
      await evaluate(() => window.SpreadsheetApp.view.setCurrentSelection({ xRange: [3, 3], yRange: [5, 5] }));
      await assertSheetAnchor();
      assert.equal((await read()).ranges[0].startRowIndex, 5);
      await evaluate(async () => window.SpreadsheetApp.view.canvas.scale.scaleTo(1.25));
      await assertSheetAnchor();
      await evaluate(() => window.SpreadsheetApp.view.canvas.scrollApi.scrollToRenderFrom({ row: 20, col: 5 }, true));
      await eventually(() => evaluate((selector) => document.querySelector(selector).style.display === "none", selectionActionSelector));
      await evaluate(() => window.SpreadsheetApp.view.canvas.scrollApi.scrollToRenderFrom({ row: 0, col: 0 }, true));
      await assertSheetAnchor();
      await evaluate(async () => window.SpreadsheetApp.view.canvas.scale.scaleTo(1));
      await evaluate(async () => {
        const app = window.SpreadsheetApp;
        await app.behaviorApi.dimensionApi.setFreeze({ sheetId: app.workbook.activeSheet.getSheetId(), rowCount: 2, colCount: 1 });
      });
      for (const [row, col] of [[0, 0], [0, 3], [5, 0], [5, 3]]) {
        await evaluate((row, col) => window.SpreadsheetApp.view.setCurrentSelection({ xRange: [col, col], yRange: [row, row] }), row, col);
        await assertSheetAnchor();
      }
      await evaluate(async () => {
        const app = window.SpreadsheetApp;
        await app.behaviorApi.dimensionApi.setFreeze({ sheetId: app.workbook.activeSheet.getSheetId(), rowCount: -1, colCount: -1 });
      });
      // 靠近网格底部时向上翻转，不能覆盖工作表 tab 的点击区域。
      await evaluate(() => {
        const canvas = window.SpreadsheetApp.view.canvas;
        const row = canvas.areaData.row.flow.renderTo - 1;
        window.SpreadsheetApp.view.setCurrentSelection({ xRange: [0, 0], yRange: [row, row] });
      });
      const assertEntryInsideGrid = async () => eventually(() => evaluate((selector) => {
        const entry = document.querySelector(selector), rect = entry.getBoundingClientRect();
        const view = window.SpreadsheetApp.view, canvas = view.canvas;
        const grid = canvas.clientRect.container.getBoundingClientRect();
        const tabs = [...document.querySelectorAll('[role="tab"][data-tab-id]')].map((node) => node.getBoundingClientRect());
        const range = view.getSelectionRanges()[0];
        const left = grid.left + canvas.headSize.displayRowHeadWidth + canvas.areaData.getDisplayViewLeftByCol(range.startColIndex);
        return entry.style.display === "block" && Math.abs(rect.left - left) < 1 &&
          rect.top >= grid.top + canvas.headSize.displayColHeadHeight && rect.bottom <= grid.bottom &&
          tabs.every((tab) => rect.bottom <= tab.top || rect.top >= tab.bottom || rect.right <= tab.left || rect.left >= tab.right);
      }, selectionActionSelector));
      await assertEntryInsideGrid();
      // 最后一行只露出上部时仍有入口，并在网格内向上翻转。
      const partialRow = await evaluate(() => window.SpreadsheetApp.view.canvas.areaData.row.flow.renderTo);
      await engine.tool("sheet_set_dimension_size", { file_id: editor.file_id, sheet_id: secondSheetId,
        dimensions: [{ dimension_type: "row", start_index: partialRow, end_index: partialRow, size: 100 }] });
      await evaluate((row) => window.SpreadsheetApp.view.setCurrentSelection({ xRange: [0, 0], yRange: [row, row] }), partialRow);
      await eventually(() => evaluate((row) => {
        const area = window.SpreadsheetApp.view.canvas.areaData;
        return area.getDisplayViewTopByRow(row) < area.row.flow.displayViewSize &&
          area.getDisplayViewBottomByRow(row) > area.row.flow.displayViewSize;
      }, partialRow));
      await assertEntryInsideGrid();
      assert.equal(await evaluate((selector, row) => {
        const canvas = window.SpreadsheetApp.view.canvas;
        const top = canvas.clientRect.container.getBoundingClientRect().top + canvas.headSize.displayColHeadHeight + canvas.areaData.getDisplayViewTopByRow(row);
        return document.querySelector(selector).getBoundingClientRect().bottom < top;
      }, selectionActionSelector, partialRow), true);
      // 高行、宽列分别超过视口，左上角可见即可显示；组合时也不能落到 tabs 上。
      for (const dimensions of [
        [{ dimension_type: "row", start_index: 0, end_index: 0, size: 1000 }],
        [{ dimension_type: "col", start_index: 0, end_index: 0, size: 2000 },
          { dimension_type: "row", start_index: 0, end_index: 0, is_clear: true }],
        [{ dimension_type: "row", start_index: 0, end_index: 0, size: 1000 }],
      ]) {
        await engine.tool("sheet_set_dimension_size", { file_id: editor.file_id, sheet_id: secondSheetId, dimensions });
        await evaluate(() => {
          const view = window.SpreadsheetApp.view;
          view.canvas.scrollApi.scrollToRenderFrom({ row: 0, col: 0 }, true);
          view.setCurrentSelection({ xRange: [0, 0], yRange: [0, 0] });
        });
        await eventually(() => evaluate((dimension) => {
          const canvas = window.SpreadsheetApp.view.canvas, area = canvas.areaData;
          return dimension === "row" ? area.getDisplayViewBottomByRow(0) > area.row.flow.displayViewSize
            : area.getDisplayViewRightByCol(0) > area.col.flow.displayViewSize;
        }, dimensions[0].dimension_type));
        await assertEntryInsideGrid();
      }
      await engine.tool("sheet_set_dimension_size", { file_id: editor.file_id, sheet_id: secondSheetId, dimensions: [
        { dimension_type: "row", start_index: 0, end_index: 0, is_clear: true },
        { dimension_type: "col", start_index: 0, end_index: 0, is_clear: true },
        { dimension_type: "row", start_index: partialRow, end_index: partialRow, is_clear: true },
      ] });
      await clickSheetTab(firstSheetId);
    }
    let wordNodes;
    if (kind === "doc") {
      const structure = await engine.tool("doc_resolve_document_structure", { file_id: editor.file_id, mode: "full", text_preview_length: 200 });
      wordNodes = structure.nodes;
      const target = wordNodes.find((node) => node.text_preview === "是多少");
      assert.ok(target);
      const cross = process.argv.includes("--word-cross");
      const begin = cross ? 2 : target.start_index;
      const text = cross ? " 选中的内容 后文\r\r是多少" : "是多少";
      // 使用真实 GCP 的段尾范围；只去掉最终结构回车，跨段中间的分隔符和空段仍须保留。
      await evaluate(revealOfficePageSelection, { kind: "doc-text", ranges: [{ begin, end: target.end_index + 1 }] });
      assert.equal(await evaluate(() => window.pad.editor.getRefText(window.pad.editor.selection.gcpRange)), `${text}\r`);
      assert.deepEqual(await read(), { ranges: [{ begin, end: target.end_index, length: target.end_index - begin }], selectedText: text });
    }
    const clickSlideThumbnail = async () => {
      const thumbnail = await eventually(() => evaluate(() => {
        const selection = window.pray().getSelectionService();
        const outer = document.getElementById(selection.slides[selection.currentSlideIndex].key);
        if (!document.getElementById("left_bar")?.contains(outer)) return null;
        const rect = outer.getBoundingClientRect();
        return rect.width > 0 ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
      }));
      current.webContents.sendInputEvent({ type: "mouseDown", ...thumbnail, button: "left", clickCount: 1 });
      current.webContents.sendInputEvent({ type: "mouseUp", ...thumbnail, button: "left", clickCount: 1 });
      await eventually(() => evaluate(() => window.pray().getSelectionService().lastMouseDownRegion === "slidelist"));
    };
    const selectFixtureRange = async (locator) => {
      if (kind !== "slide") { await evaluate(revealOfficePageSelection, locator); return; }
      if (locator?.kind === "slide-pages") { await clickSlideThumbnail(); return; }
      // 隔离模板中固定文本框位于页面左上角；用真实鼠标事件验证入口，不能用 SDK 直接选框掩盖事件丢失。
      const point = await evaluate(() => {
        const rect = window.document.getElementById("stable-layer").getBoundingClientRect();
        return { x: Math.round(rect.x + 40), y: Math.round(rect.y + 40) };
      });
      current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      current.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
      current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
      current.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 65, y: point.y, modifiers: ["leftButtonDown"] });
      current.webContents.sendInputEvent({ type: "mouseUp", x: point.x + 65, y: point.y, button: "left", clickCount: 1 });
      await wait(150);
      if (process.argv.includes("--inspect")) console.log(JSON.stringify({ slidePointer: await read(), entry: await evaluate((selector) => window.document.querySelector(selector).style.display, selectionActionSelector) }));
      await eventually(() => evaluate((selector) => window.document.querySelector(selector)?.style.display === "block", selectionActionSelector));
    };
    if (kind === "slide") {
      await selectFixtureRange();
      assert.ok((await read()).textSelection?.count > 0, "先建立真实文字选区，再点击同页缩略图");
      await clickSlideThumbnail();
      if (process.argv.includes("--slide-identity") || process.argv.includes("--slide-page")) {
        await eventually(() => evaluate(() => window.pray().getSelectionService().lastMouseDownRegion === "slidelist"));
        const native = await evaluate(() => {
          const selection = window.pray().getSelectionService();
          return selection.selectedSlides.selectedArray.slice().map((slide) => ({ pageIndex: slide.listIndex, key: slide.key,
            modelKey: selection.slides[slide.listIndex]?.key, modelId: selection.slides[slide.listIndex]?.id,
            modelUniqueID: selection.slides[slide.listIndex]?.uniqueID, id: slide.id, uniqueID: slide.uniqueID }));
        });
        const info = await engine.tool("slide_get_info", { file_id: editor.file_id });
        for (const slide of native) {
          const page = await engine.tool("slide_get_page_info", { file_id: editor.file_id, page_index: slide.pageIndex });
          console.log(JSON.stringify({ slideIdentityEvidence: { native: slide, info, page, keyMatchesPageId: slide.key === page.page_id }, schemas: (await engine.listTools()).filter((tool) => ["slide_get_info", "slide_get_page_info"].includes(tool.name)), shapeToolNames: (await engine.listTools()).filter((tool) => /slide_.*(shape|position|geometry)/.test(tool.name)).map((tool) => tool.name) }));
          assert.equal(slide.id, page.page_id, "SDK slide.id 必须严格等于引擎 page_id");
          assert.equal(slide.uniqueID, page.page_id);
          assert.equal(slide.modelId, page.page_id); assert.equal(slide.modelUniqueID, page.page_id);
          assert.equal(slide.id, info.slide_ids[slide.pageIndex]);
          assert.equal(slide.key, slide.modelKey);
          assert.equal((await read()).nativeSlideIds[native.indexOf(slide)], page.page_id);
        }
        console.log(JSON.stringify({ slideIdentity: "passed", native, nativeSlideIds: (await read()).nativeSlideIds, engineSlideIds: info.slide_ids }));
        if (process.argv.includes("--slide-identity")) {
          current.destroy(); current = null; attached.dispose(); attached = null;
          await engine.close(editor.file_id, true);
          continue;
        }
      }
      await eventually(() => evaluate((selector) => window.pray().getSelectionService().lastMouseDownRegion === "slidelist" && document.querySelector(selector).style.display === "block", selectionActionSelector));
      const selectedPage = await read();
      const nativePage = await evaluate(() => {
        const selection = window.pray().getSelectionService(), slide = selection.selectedSlides.selectedArray[0];
        return { pageIndex: [slide.listIndex], shapeIds: [], nativeSlideIds: [slide.id] };
      });
      assert.deepEqual(selectedPage, nativePage, "同页缩略图必须替换之前文字/形状，不沿用 textSelection");
      assert.equal(await evaluate(() => document.querySelectorAll('[class*="aiEditThumbnailButton"],[class*="aiEditEntry"]').length), 0, "选页时 SDK 在线 AI 入口保持关闭");
      const anchor = await evaluate((selector) => {
        const selection = window.pray().getSelectionService(), slide = selection.selectedSlides.selectedArray[0];
        const outer = document.getElementById(slide.key), preview = outer.querySelector("canvas").getBoundingClientRect();
        const entry = document.querySelector(selector), rect = entry.getBoundingClientRect();
        const bar = document.getElementById("left_bar").getBoundingClientRect();
        return { text: entry.textContent, label: entry.getAttribute("aria-label"), nearThumbnail: ((rect.left >= preview.right && rect.left - preview.right <= 12) || (rect.right <= preview.left && preview.left - rect.right <= 12)) && rect.top >= preview.top && rect.bottom <= preview.bottom,
          insideBar: rect.right <= bar.right, preview: { left: preview.left, right: preview.right, top: preview.top, bottom: preview.bottom }, entry: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } };
      }, selectionActionSelector);
      assert.equal(anchor.text, "✦"); assert.equal(anchor.label, "AI 编辑所选幻灯片");
      assert.equal(anchor.nearThumbnail, true, JSON.stringify(anchor)); assert.equal(anchor.insideBar, true, JSON.stringify(anchor));
      if (process.argv.includes("--slide-page-ui")) {
        const second = await evaluate(() => {
          const service = window.pray().getSelectionService(), outer = document.getElementById(service.slides[1].key);
          const rect = outer.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
        });
        current.webContents.sendInputEvent({ type: "mouseDown", ...second, button: "left", clickCount: 1, modifiers: ["shift"] });
        current.webContents.sendInputEvent({ type: "mouseUp", ...second, button: "left", clickCount: 1, modifiers: ["shift"] });
        await eventually(async () => (await read())?.pageIndex?.length === 2);
        const multiPage = await read();
        assert.equal(multiPage.nativeSlideIds.length, 2); assert.deepEqual(multiPage.shapeIds, []);
        await eventually(() => evaluate((selector) => document.querySelector(selector).style.display === "block", selectionActionSelector));
        await clickSelectionEntry();
        await eventually(() => evaluate(() => document.querySelector('#juggle-office-selection-ui [role="status"]')?.textContent === "整页编辑目前一次支持一页，请只选择一张幻灯片"));
        assert.equal(captures.length, 0, "多页不能误投第一页或发送 capture");
        assert.equal(await evaluate(() => !!document.querySelector('[aria-label="编辑所选内容"]')), false);
        console.log(JSON.stringify({ slidePageUi: "passed", selectedPage, anchor, multiPage, multiPageRejectedLocally: true, proof: "not exercised" }));
        current.destroy(); current = null; attached.dispose(); attached = null;
        await engine.close(editor.file_id, true);
        assert.ok(outgoing.every((url) => fontUrls.has(url)), "页面不能请求在线 AI");
        continue;
      }
      if (!process.argv.includes("--slide-page")) await selectFixtureRange();
    }
    {
      const selected = await read(); assert.ok(selected);
      await current.webContents.executeJavaScript("document.dispatchEvent(new Event('selectionchange'))");
      if (process.argv.includes("--inspect")) { await wait(100); console.log(JSON.stringify({ui:await evaluate((selector) => ({root:!!document.getElementById("juggle-office-selection-ui"),button:document.querySelector(selector)?.style.cssText,visibility:document.visibilityState}), selectionActionSelector),selection:await read(),visible:current.isVisible(),focused:current.isFocused()})); }
      await eventually(() => evaluate((selector) => window.document.querySelector(selector)?.style.display === "block", selectionActionSelector));
      const entryPresentation = await evaluate((selector) => {
        const entry = window.document.querySelector(selector); const style = getComputedStyle(entry);
        return { text: entry.textContent, ariaLabel: entry.getAttribute("aria-label"), presentationIcon: !!entry.querySelector('[data-jugglework-office-icon="presentation"]'), color: style.color, backgroundColor: style.backgroundColor, borderColor: style.borderColor, fontWeight: style.fontWeight, padding: style.padding, borderRadius: style.borderRadius, boxShadow: style.boxShadow };
      }, selectionActionSelector);
      assert.deepEqual(entryPresentation, { text: kind === "slide" && process.argv.includes("--slide-page") ? "✦" : "✦ AI 编辑", ariaLabel: kind === "slide" && process.argv.includes("--slide-page") ? "AI 编辑所选幻灯片" : "AI 编辑选区", presentationIcon: false, color: "rgb(24, 24, 24)", backgroundColor: "rgb(255, 255, 255)", borderColor: "rgb(225, 225, 225)", fontWeight: "400", padding: kind === "slide" && process.argv.includes("--slide-page") ? "2px" : "8px 13px", borderRadius: "12px", boxShadow: "rgba(0, 0, 0, 0.133) 0px 3px 12px 0px" });
      if (kind === "doc") {
        holdCaptureReply = true;
        await clickSelectionEntry();
        await eventually(() => releaseCaptureReply).catch(async (error) => {
          console.error(await current.webContents.executeJavaScript("({text:document.getElementById('juggle-office-selection-ui')?.innerText,active:document.activeElement?.outerHTML.slice(0,300)})")); throw error;
        });
        const reference = captures.at(-1);
        await current.webContents.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))");
        holdCaptureReply = false; releaseCaptureReply(); releaseCaptureReply = null;
        await eventually(() => canceledCaptures.size > 0);
        await wait(150);
        assert.equal(await evaluate(() => !!window.document.querySelector('[aria-label="编辑所选内容"]')), false, "外部点击取消后，迟到采集不能重新弹窗");
        await selectFixtureRange(reference.locator);
        await current.webContents.executeJavaScript("document.dispatchEvent(new Event('selectionchange'))");
        await eventually(() => evaluate((selector) => window.document.querySelector(selector)?.style.display === "block", selectionActionSelector));
      }
      await clickSelectionEntry();
      await eventually(() => current.webContents.executeJavaScript("document.activeElement?.getAttribute('aria-label')==='说说你想怎么修改'")).catch(async (error) => {
        console.error(await current.webContents.executeJavaScript("({text:document.getElementById('juggle-office-selection-ui')?.innerText,active:document.activeElement?.outerHTML.slice(0,300)})")); throw error;
      });
      const layout = await evaluate(() => {
        const panel = window.document.querySelector('[aria-label="编辑所选内容"]');
        return { width: panel.offsetWidth, height: panel.offsetHeight, summary: !!panel.querySelector('summary'), close: !!panel.querySelector('[aria-label="取消编辑要求"]'), menu: getComputedStyle(panel.querySelector('.selection-choices')).display };
      });
      assert.ok(layout.width <= 280 && layout.height <= 38, JSON.stringify(layout));
      assert.equal(layout.summary, false); assert.equal(layout.close, false); assert.equal(layout.menu, "none");
      const actionPoint = await evaluate(() => {
        const rect = window.document.querySelector('[aria-label="添加选区与要求"]').getBoundingClientRect();
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
      });
      current.webContents.sendInputEvent({ type: "mouseMove", ...actionPoint });
      await eventually(() => evaluate(() => getComputedStyle(window.document.querySelector('.selection-choices')).display === "block"));
      current.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
      await eventually(() => evaluate(() => getComputedStyle(window.document.querySelector('.selection-choices')).display === "none"));
      const dismissed = captures.at(-1);
      const dismissedId = [...referencesByCapture].find(([, value]) => value.referenceId === dismissed.referenceId)[0];
      await current.webContents.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true}))");
      await eventually(() => canceledCaptures.has(dismissedId));
      assert.equal(await evaluate(() => !!window.document.querySelector('[aria-label="编辑所选内容"]')), false);
      assert.equal(reports.filter((report) => report.kind === kind).length, 0, "外部点击不提交要求");
      await selectFixtureRange(dismissed.locator);
      await current.webContents.executeJavaScript("document.dispatchEvent(new Event('selectionchange'))");
      await eventually(() => evaluate((selector) => window.document.querySelector(selector)?.style.display === "block", selectionActionSelector));
      await clickSelectionEntry();
      await eventually(() => current.webContents.executeJavaScript("document.activeElement?.getAttribute('aria-label')==='说说你想怎么修改'"));
      await current.webContents.executeJavaScript("(()=>{const input=document.activeElement;input.value='中文修改要求';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));})()");
      assert.equal(reports.filter((report) => report.kind === kind).length, 0);
      await current.webContents.executeJavaScript("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))");
      await eventually(() => reports.find((report) => report.kind === kind));
      assert.equal(reports.at(-1).text, "中文修改要求"); assert.equal(reports.at(-1).mode, "send");
    }
    if (kind === "doc") {
      const structure = await engine.tool("doc_resolve_document_structure", { file_id: editor.file_id, mode: "full", text_preview_length: 200 });
      let shift = 0;
      assert.deepEqual(structure.nodes, wordNodes.map((node, i) => {
        const text = process.argv.includes("--word-cross") ? (i === 0 ? "前文新正文" : node.text_preview === "是多少" ? "新末" : node.text_preview)
          : node.text_preview === "是多少" ? "已修改" : node.text_preview;
        const delta = (text?.length ?? 0) - (node.text_preview?.length ?? 0);
        const expected = { ...node, start_index: node.start_index + shift, end_index: node.end_index + shift + delta, ...(text === undefined ? {} : { text_preview: text }) };
        shift += delta;
        return expected;
      }));
    }
    current.destroy(); current = null; attached.dispose(); attached = null;
    await engine.close(editor.file_id, true);
    assert.ok(outgoing.every((url) => fontUrls.has(url)), `页面只能补充清单内固定字体，不能请求在线 AI：${outgoing.filter((url) => !fontUrls.has(url)).map((url) => {const parsed=new URL(url);return parsed.origin+parsed.pathname;}).join(",")}`);
  }
  console.log(JSON.stringify({ nativeSelectionPages: process.argv.includes("--slide-page-ui") ? "UI only; page proof/save not exercised" : "passed", captures, reports }));
} catch (error) { console.error(error); await focusDiagnostics(); process.exitCode = 1; }
finally {
  await cleanup();
  app.exit(process.exitCode ?? 0);
}
}
void run();

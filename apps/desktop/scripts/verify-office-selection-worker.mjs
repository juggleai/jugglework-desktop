import { app, BrowserWindow, ipcMain, session } from "electron";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, readFile } from "node:fs/promises";
import { OfficeEngine } from "../../server/dist/office/engine.js";
import { OfficeSelectionEdits } from "../../server/dist/office/selection-edits.js";
import { createOfficeResources } from "../electron/office-resources.mjs";
import { readOfficePageSelection } from "../electron/office-page-selection.mjs";
import { revealOfficePageSelection } from "../electron/office-page-reveal.mjs";
import { waitForWordPageCommit, waitForSheetPageCommit, waitForSlidePageCommit } from "../electron/office-page-commit.mjs";

const root = process.argv[2];
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
app.setPath("userData", join(root, "profile"));
app.commandLine.appendSwitch("use-mock-keychain");
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});
const engine = new OfficeEngine({ resourceDirectory: join(desktop, "resources/office-engine"), logDirectory: join(root, "logs") });
const resources = createOfficeResources({ assetsDirectory: join(desktop, "resources/office-assets"), cacheDirectory: join(root, "fonts") });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let current, attached, document, edits;
const templates = [];
const reports = [];
const captures = [];
const referencesByCapture = new Map();
const canceledCaptures = new Set();
let holdCaptureReply = false, releaseCaptureReply = null;
const fontUrls = new Set(JSON.parse(await readFile(join(desktop, "resources/office-assets/manifest.json"), "utf8")).entries.filter((entry) => entry.kind === "font").map((entry) => entry.url));
async function eventually(action) {
  const deadline = Date.now() + 25_000; let error;
  while (Date.now() < deadline) { try { const value = await action(); if (value) return value; } catch (next) { error = next; } await wait(100); }
  throw error ?? new Error("原生选区页面未就绪");
}
const evaluate = (fn, ...args) => current.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
const read = () => evaluate(readOfficePageSelection, document.kind);
/** 原生按钮点击同时建立窗口焦点；DOM 合成 pointerdown 不会像用户点击一样激活窗口。 */
async function clickSelectionEntry() {
  app.focus({ steal: true }); current.focus();
  await eventually(() => current.isFocused());
  const point = await evaluate(() => {
    const rect = window.document.querySelector('[aria-label="AI 编辑选区"]').getBoundingClientRect();
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
  });
  current.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
  current.webContents.sendInputEvent({ type: "mouseUp", ...point, button: "left", clickCount: 1 });
}

ipcMain.handle("jugglework:office:selection-capture", async (event, { captureId, expectedSelection }) => {
  assert.equal(event.sender, current.webContents);
  assert.notEqual(await evaluate(() => window.document.activeElement?.getAttribute("aria-label")), "说说你想怎么修改");
  const started = performance.now();
  const reference = await edits.capture(document, captureId, expectedSelection);
  assert.notEqual(reference.locator.kind, "doc-caret");
  if (reference.locator.kind !== "slide-text") await evaluate(revealOfficePageSelection, reference.locator);
  captures.push({ kind: document.kind, referenceId: reference.referenceId, locator: reference.locator, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(JSON.stringify(reference)) });
  referencesByCapture.set(captureId, reference);
  if (holdCaptureReply) await new Promise((resolve) => { releaseCaptureReply = resolve; });
  return { reference };
});
ipcMain.handle("jugglework:office:selection-submit", async (event, input) => {
  assert.equal(event.sender, current.webContents);
  await edits.prepareTurn("ws", "chat", `turn-${document.kind}`, { officeSelectionRefs: [input.referenceId], officeInstructions: [{ instructionId: "fixture-instruction", text: input.text, bindingState: "bound", referenceIds: [input.referenceId] }] });
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
  console.log("Office 选区页面验收宿主已就绪");
  for (const kind of ["doc", "sheet", "slide"]) {
    const filter = process.argv.find((arg) => arg.startsWith("--kind="))?.slice(7);
    if (filter && filter !== kind) continue;
    console.log(`验证 ${kind} 页面`);
    const created = await engine.tool(`create_${kind}`, {});
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
    if (kind === "slide") await engine.tool("slide_add_text", { file_id: created.file_id, page_index: 0, x: 30, y: 30, w: 300, h: 80, text: "前选中后" });
    const fixturePath = join(root, `验收.${{ doc: "docx", sheet: "xlsx", slide: "pptx" }[kind]}`);
    await engine.tool("save_file", { file_id: created.file_id, file_path: fixturePath });
    await engine.close(created.file_id);
    created.file_path = fixturePath;
    const preview = new URL(await engine.previewUrl(created.file_path));
    const partition = session.fromPartition(`selection-${kind}`);
    const outgoing = [];
    partition.webRequest.onSendHeaders((detail) => { const url = new URL(detail.url); if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && url.hostname !== "127.0.0.1") outgoing.push(detail.url); });
    attached = resources.attach(partition, { documentId: kind, origin: preview.origin, filePath: created.file_path, kind, selectionUi: true, commit: { error: null },
      save: async () => { const editor = await engine.editor(created.file_path); await engine.save(editor.file_id); return { engineFileId: editor.file_id }; }, onCoreFailure: () => {} });
    current = new BrowserWindow({ width: 1100, height: 850, show: false, webPreferences: { session: partition, sandbox: true, contextIsolation: true, backgroundThrottling: false, preload: join(desktop, "electron/office-selection-preload.cjs") } });
    await current.loadURL(preview.href);
    current.show(); app.focus({ steal: true }); current.focus();
    await eventually(() => current.isFocused());
    await wait(150);
    console.log(`${kind} 页面已加载`);
    const editor = await eventually(() => engine.editor(created.file_path));
    document = { documentId: `doc-${kind}`, pageId: `page-${kind}`, artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: created.file_path, name: kind, state: "ready", engineFileId: editor.file_id, kind };
    const prepare = { doc: waitForWordPageCommit, sheet: waitForSheetPageCommit, slide: waitForSlidePageCommit }[kind];
    await eventually(async () => { await current.webContents.executeJavaScript(`(${prepare.toString()})(window,1000)`); return true; });
    // 页面函数首参是 scope，单独序列化注入 window，避免把窗口当作 JSON 传递。
    edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => current.webContents.executeJavaScript(`(${prepare.toString()})(window,1000)`), selection: async () => {const selected=await read();if(process.argv.includes("--inspect"))console.log(JSON.stringify({captureSelection:selected}));return selected;},
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(document.engineFileId); return document; } });
    if (kind === "doc") {
      await current.webContents.executeJavaScript("pad.editor.enterEditMode()");
      await eventually(() => evaluate(() => window.document.activeElement?.id === "melo-hidden-editor"));
    }
    await wait(150);
    if (kind === "sheet") {
      await current.webContents.executeJavaScript("SpreadsheetApp.view.canvas.selectApi.selectRows(SpreadsheetApp.view.canvas.normalSelectData,[0,0])");
      if (process.argv.includes("--inspect")) console.log(JSON.stringify({ rowIntent: await current.webContents.executeJavaScript("SpreadsheetApp.view.getSelectionRanges().map(r=>({...r,endColInfinite:r.endColIndex===Infinity,endRowInfinite:r.endRowIndex===Infinity}))") }));
      await current.webContents.executeJavaScript("SpreadsheetApp.view.setCurrentSelection({xRange:[0,0],yRange:[0,0]})");
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
    const selectFixtureRange = async (locator) => {
      if (kind !== "slide") { await evaluate(revealOfficePageSelection, locator); return; }
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
      if (process.argv.includes("--inspect")) console.log(JSON.stringify({ slidePointer: await read(), entry: await evaluate(() => window.document.querySelector('[aria-label="AI 编辑选区"]').style.display) }));
      await eventually(() => current.webContents.executeJavaScript("document.querySelector('[aria-label=\"AI 编辑选区\"]')?.style.display==='block'"));
    };
    if (kind === "slide") await selectFixtureRange();
    {
      const selected = await read(); assert.ok(selected);
      await current.webContents.executeJavaScript("document.dispatchEvent(new Event('selectionchange'))");
      if (process.argv.includes("--inspect")) { await wait(100); console.log(JSON.stringify({ui:await current.webContents.executeJavaScript("({root:!!document.getElementById('juggle-office-selection-ui'),button:document.querySelector('[aria-label=\"AI 编辑选区\"]')?.style.cssText,visibility:document.visibilityState})"),selection:await read(),visible:current.isVisible(),focused:current.isFocused()})); }
      await eventually(() => current.webContents.executeJavaScript("document.querySelector('[aria-label=\"AI 编辑选区\"]')?.style.display==='block'"));
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
        await eventually(() => current.webContents.executeJavaScript("document.querySelector('[aria-label=\"AI 编辑选区\"]')?.style.display==='block'"));
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
      await eventually(() => current.webContents.executeJavaScript("document.querySelector('[aria-label=\"AI 编辑选区\"]')?.style.display==='block'"));
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
  console.log(JSON.stringify({ nativeSelectionPages: "passed", captures, reports }));
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  await cleanup();
  app.exit(process.exitCode ?? 0);
}
}
void run();

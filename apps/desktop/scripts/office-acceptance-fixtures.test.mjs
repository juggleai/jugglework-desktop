import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptanceOptions } from "./office-acceptance-options.mjs";
import { syntheticDialogChoices } from "./office-acceptance-dialogs.mjs";
import { prepareAcceptanceApp, prepareAcceptanceWindow, focusAcceptanceEditor } from "./office-acceptance-focus.mjs";
import { acceptanceContent } from "./office-acceptance-content.mjs";
import { installAcceptanceMenu, acceptanceMenuState, observeSyntheticInput } from "./office-acceptance-input.mjs";

test("fixture menu stays opt-in and uses only ordinary native roles without command callbacks", () => {
  const forbidden = new Proxy({}, { get() { assert.fail("Ordinary acceptance must not change menus"); } });
  installAcceptanceMenu(forbidden, false);
  let template, current;
  const Menu = { buildFromTemplate(value) { template = value; return { items: value }; },
    setApplicationMenu(value) { current = value; }, getApplicationMenu: () => current };
  installAcceptanceMenu(Menu, true, "darwin");
  assert.deepEqual(template, [{ role: "appMenu" }, { label: "Edit", submenu: [
    { role: "undo" }, { role: "redo" }, { role: "selectAll" },
  ] }]);
  assert.equal(acceptanceMenuState({ getApplicationMenu: () => null }), null);
  const menu = acceptanceMenuState({ getApplicationMenu: () => ({ items: [{ role: "undo", enabled: true }] }) });
  assert.equal(menu[0].role, "undo");
});

test("DOM diagnostics passively observe real input without preventing or dispatching it", () => {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  const listeners = new Map();
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener(type, listener, options) {
      assert.deepEqual(options, { capture: true, passive: true }); listeners.set(type, listener);
    } } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      hasFocus: () => true, activeElement: { id: "fixture" }, visibilityState: "visible",
    } });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "fixture" } });
    assert.equal(observeSyntheticInput().platform, "MacIntel");
    listeners.get("keydown")({ key: "z", code: "KeyZ", isTrusted: true, metaKey: true,
      ctrlKey: false, defaultPrevented: false, target: { id: "fixture", tagName: "DIV" } });
    const [event] = window.officeAcceptanceInputEvents;
    assert.equal(event.trusted, true); assert.equal(event.meta, true); assert.equal(event.control, false);
    assert.equal(event.pageFocus, true);
  } finally {
    for (const key of ["window", "document", "navigator"]) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]); else delete globalThis[key];
    }
  }
});

test("CLI maps both syntaxes and refuses conflicting/unknown options", () => {
  for (const [kind, format] of Object.entries({ doc: "docx", sheet: "xlsx", slide: "pptx", csv: "csv" })) {
    assert.equal(acceptanceOptions(["--kind", kind]).format, format);
    assert.equal(acceptanceOptions([`--format=${format}`]).format, format);
  }
  for (const args of [["--kind=pdf"], ["--format"], ["--kind=doc", "--format=xlsx"], ["--skip-resources"]]) assert.throws(() => acceptanceOptions(args));
  for (const flag of ["--ui-undo", "--ui-undo-toolbar"]) {
    for (const format of ["csv", "xlsx"]) assert.ok(acceptanceOptions([`--format=${format}`, flag]).flags.includes(flag));
    for (const format of ["docx", "pptx"]) assert.throws(() => acceptanceOptions([`--format=${format}`, flag]), /sheet\/csv only/);
  }
});
test("synthetic UI diagnostics read the same native B2 target as fixture content with zero-based coordinates", async () => {
  const values = [["name", "value"], ["synthetic", "42"], ["", ""]];
  const engine = { async tool(name, args) {
    assert.equal(args.file_id, "page-owned-model");
    if (name === "sheet_get_sheet_info") return { sheets: [{ sheet_id: "synthetic-sheet" }] };
    assert.equal(name, "sheet_get_cell_data", "Diagnostics must only read the native model");
    assert.equal(args.sheet_id, "synthetic-sheet");
    assert.equal(args.start_row, args.end_row); assert.equal(args.start_col, args.end_col);
    return { csv_data: values[args.start_row][args.start_col] };
  } };
  const content = acceptanceContent(engine, "synthetic.csv", "csv", "sheet", () => "page-owned-model");
  assert.equal(await content.read(), "42");
  assert.deepEqual(await content.readInputCells(), { sheetId: "synthetic-sheet",
    cells: { A1: "name", B1: "value", A2: "synthetic", B2: "42", B3: "" } });
});
test("ordinary fixture suppresses activation; UI mode retains native methods", () => {
  const calls = [];
  const nativeShow = () => calls.push("show"), nativeFocus = () => calls.push("focus");
  const host = () => ({ show: nativeShow, focus: nativeFocus, showInactive: () => calls.push("inactive") });
  const ordinary = host();
  prepareAcceptanceWindow(ordinary, false);
  ordinary.show(); ordinary.focus();
  assert.deepEqual(calls, ["inactive"]);
  const ui = host();
  prepareAcceptanceWindow(ui, true);
  assert.equal(ui.show, nativeShow); assert.equal(ui.focus, nativeFocus);
});
test("app activation policy and Dock changes require explicit macOS UI mode", async () => {
  const forbidden = new Proxy({}, { get() { assert.fail("Must not touch application activation"); } });
  await prepareAcceptanceApp(forbidden, false, "darwin");
  await prepareAcceptanceApp(forbidden, true, "linux");
  await assert.rejects(prepareAcceptanceApp({ isReady: () => false }, true, "darwin"), /app.whenReady/);
  const calls = [];
  let visible = false;
  const app = { isReady: () => true, isActive: () => false,
    setActivationPolicy: (policy) => calls.push(policy),
    dock: { isVisible: () => visible, async show() { calls.push("dock.show"); await Promise.resolve(); visible = true; } } };
  assert.deepEqual(await prepareAcceptanceApp(app, true, "darwin"), {
    activationPolicyRequested: "regular", dockVisibleBefore: false, dockVisibleAfter: true, appActiveAfter: false,
  });
  assert.deepEqual(calls, ["regular", "dock.show"]);
});
test("native input activation rejects unapproved or nonisolated targets before side effects", async () => {
  const forbidden = () => { assert.fail("Must not activate outside explicit isolated UI mode"); };
  const contents = { focus: forbidden };
  const host = { show: forbidden, focus: forbidden };
  const args = { uiUndo: true, host, contents, attachedContents: contents,
    app: { focus: forbidden }, BrowserWindow: { getAllWindows: () => [host] } };
  await assert.rejects(focusAcceptanceEditor({ ...args, uiUndo: false }), /explicit --ui-undo/);
  await assert.rejects(focusAcceptanceEditor({ ...args, attachedContents: {} }), /attached fixture/);
  await assert.rejects(focusAcceptanceEditor({ ...args, BrowserWindow: { getAllWindows: () => [host, {}] } }), /sole isolated/);
});
test("renderer focus cannot substitute for native window or webContents focus", async () => {
  const contents = { focus() {}, isFocused: () => false };
  let focused = false;
  const host = { show() {}, focus() {}, isFocused: () => focused, isVisible: () => true,
    isFocusable: () => true, isMinimized: () => false };
  const args = { uiUndo: true, host, contents, attachedContents: contents,
    app: { isActive: () => true }, BrowserWindow: { getAllWindows: () => [host] },
    eventually: async (_label, check) => check(), evaluate: async () => true };
  await assert.rejects(focusAcceptanceEditor(args), /"focused":false/);
  focused = true;
  await assert.rejects(focusAcceptanceEditor(args), /"contents":false/);
});
test("focused window and renderer cannot substitute for an active fixture app", async () => {
  const contents = { focus() {}, isFocused: () => true };
  const host = { show() {}, focus() {}, isFocused: () => true, isVisible: () => true,
    isFocusable: () => true, isMinimized: () => false };
  const app = { isActive: () => false, focus() {} };
  await assert.rejects(focusAcceptanceEditor({ uiUndo: true, app, host, contents, attachedContents: contents,
    BrowserWindow: { getAllWindows: () => [host] }, eventually: async (_label, check) => check(), evaluate: async () => true }), /"app":false/);
});
test("synthetic dialogs only return exact queued choices, preserve production handler", async () => {
  const original = () => { throw new Error("Should not display an OS dialog"); };
  const dialog = { showMessageBox: original };
  let inspections = 0;
  const fixture = syntheticDialogChoices(dialog, async () => { inspections++; });
  const options = { title: "关闭文档", buttons: ["保存并关闭", "放弃修改", "取消"], cancelId: 2 };
  try {
    await assert.rejects(dialog.showMessageBox(options), /Unexpected native dialog/);
    for (const [choice, expected] of [["cancel", 2], ["save", 0], ["discard", 1]]) {
      fixture.enqueue(choice);
      assert.equal((await dialog.showMessageBox({}, options)).response, expected);
      fixture.assertConsumed();
    }
    assert.equal(inspections, 3);
    assert.ok(fixture.reports.every((report) => report.synthetic));
  } finally { fixture.restore(); }
  assert.equal(dialog.showMessageBox, original);
});

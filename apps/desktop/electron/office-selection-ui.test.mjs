import test from "node:test";
import assert from "node:assert/strict";
import { installOfficeSelectionUi } from "./office-selection-ui.mjs";
import { readOfficeSheetSelectionAnchor } from "./office-sheet-selection-anchor.mjs";
import { readOfficePageSelection } from "./office-page-selection.mjs";

// 只替代 DOM/IPC 边界，执行实际 UI 的采集、失焦和取消监听器。
function fixture({ kind = "doc", readSelection = () => ({ ranges: [{ begin: 0, end: 2, length: 2 }], selectedText: "正文" }), setup = () => {}, autoCapture = true } = {}) {
  const listeners = new Map();
  class Element {
    parent = null;
    children = [];
    style = {};
    attributes = {};
    disabled = false;
    constructor(tagName) { this.tagName = tagName.toUpperCase(); }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    setAttribute(key, value) { this.attributes[key] = value; }
    remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
    focus() {}
  }
  let review, resolveCapture, frame = () => {};
  const canceled = [];
  const captures = [];
  const doc = {
    body: new Element("body"), createElement: (name) => new Element(name),
    getElementById: () => null, addEventListener() {},
  };
  const scope = {
    document: doc, crypto: { randomUUID: () => "capture" }, innerWidth: 1000, innerHeight: 800,
    navigator: { platform: "Mac" }, setTimeout() {},
    requestAnimationFrame(callback) { frame = callback; return 1; }, cancelAnimationFrame() {},
    addEventListener(name, callback) { listeners.set(name, [...(listeners.get(name) ?? []), callback]); },
    juggleworkOfficeSelection: {
      capture: (captureId, selection) => { captures.push({ captureId, selection: structuredClone(selection) }); return new Promise((resolve) => { resolveCapture = resolve; }); },
      cancel: async (id) => { canceled.push(id); },
      onReview(callback) { review = callback; return () => { review = null; }; },
    },
  };
  setup(scope);
  installOfficeSelectionUi(kind, readSelection, scope, readOfficeSheetSelectionAnchor);
  const root = doc.body.children[0], entry = root.children[1];
  const emit = (name, target = scope) => {
    for (const callback of listeners.get(name) ?? []) callback({ target, preventDefault() {}, stopPropagation() {}, clientX: 10, clientY: 10 });
  };
  const refresh = () => { emit("pointerup"); frame(); };
  refresh();
  if (autoCapture) emit("pointerdown", entry);
  const finish = async () => { resolveCapture({ reference: { referenceId: "ref" } }); await new Promise((resolve) => setImmediate(resolve)); };
  const panel = () => root.children.find((child) => child.attributes.role === "dialog");
  return { scope, emit, canceled, captures, entry, root, refresh, finish, panel, review: (...args) => review?.(...args) };
}

test("原生核对中仅保留同一个 pending capture，关闭 modal 后原采集交付", async () => {
  const f = fixture();
  f.review({ captureId: "capture", pending: true });
  f.emit("blur");
  assert.deepEqual(f.canceled, []);
  f.review({ captureId: "capture", pending: false });
  await f.finish();
  assert.ok(f.panel());
  // 输入浮层已建立时，旧通知不能豁免普通失焦。
  f.review({ captureId: "capture", pending: true });
  f.emit("blur");
  assert.equal(f.panel(), undefined);
  assert.deepEqual(f.canceled, ["capture"]);
});

for (const cause of ["ordinary-blur", "wrong-capture", "outside-click", "pagehide", "modal-ended"])
  test(`核对 UI ${cause} 取消后迟到通知和 capture 回复不能重建浮层`, async () => {
    const f = fixture();
    if (cause !== "ordinary-blur") f.review({ captureId: cause === "wrong-capture" ? "old-capture" : "capture", pending: true });
    if (cause === "modal-ended") f.review({ captureId: "capture", pending: false });
    f.emit(cause === "outside-click" ? "pointerdown" : cause === "pagehide" ? "pagehide" : "blur");
    assert.deepEqual(f.canceled, ["capture"]);
    f.review({ captureId: "capture", pending: true });
    await f.finish();
    assert.equal(f.panel(), undefined);
    assert.ok(f.canceled.every((id) => id === "capture"));
  });

test("表格单块转多块仍显示入口，首块不可见时定位后块但采集保留全部范围", async () => {
  const selection = { sheetId: "sheet", ranges: [{ sheetId: "sheet", startRowIndex: 3, endRowIndex: 4, startColIndex: 3, endColIndex: 4 }], drawingIds: [] };
  let firstVisible = true;
  const dimension = () => ({ frozen: { to: 0, displayViewSize: 40, renderFrom: 0, renderTo: 0 }, flow: { displayViewSize: 300, renderFrom: 3, renderTo: 12 } });
  const f = fixture({
    kind: "sheet", readSelection: () => selection, autoCapture: false,
    setup(scope) {
      scope.SpreadsheetApp = {
        workbook: { activeSheet: { getSheetId: () => "sheet", getRowCount: () => 20, getColCount: () => 20 } },
        view: { renderedSheetId: "sheet", canvas: {
          headSize: { displayRowHeadWidth: 45, displayColHeadHeight: 25 },
          viewManager: { getActiveCanvasInfos: () => [{ canvasType: "single" }] },
          clientRect: { container: { isConnected: true, getBoundingClientRect: () => ({ left: 10, top: 90, width: 500, height: 400 }) } },
          areaData: { row: dimension(), col: dimension(), isCellVisiable: (row) => row !== 3 || firstVisible,
            getDisplayViewLeftByCol: (col) => col === 3 ? 80 : 160,
            getDisplayViewRightByCol: (col) => col === 3 ? 120 : 200,
            getDisplayViewTopByRow: (row) => row === 3 ? 60 : 140,
            getDisplayViewBottomByRow: (row) => row === 3 ? 100 : 180 },
        } },
      };
    },
  });
  assert.equal(f.entry.style.display, "block");
  assert.equal(f.root.style.left, "135px");
  selection.ranges.push({ sheetId: "sheet", startRowIndex: 5, endRowIndex: 6, startColIndex: 5, endColIndex: 6 });
  const original = structuredClone(selection);
  f.refresh();
  assert.equal(f.entry.style.display, "block");
  assert.equal(f.root.style.left, "135px");
  firstVisible = false;
  f.refresh();
  assert.equal(f.entry.style.display, "block");
  assert.equal(f.root.style.left, "215px");
  assert.equal(f.root.style.top, "303px");
  // 可见后块不能掩盖首块的无效身份；修复身份后才重新开放完整选择。
  selection.ranges[0].sheetId = "other-sheet";
  f.refresh();
  assert.equal(f.entry.style.display, "none");
  assert.deepEqual(f.captures, []);
  selection.ranges[0].sheetId = "sheet";
  f.refresh();
  assert.equal(f.entry.style.display, "block");
  f.emit("pointerdown", f.entry);
  assert.deepEqual(f.captures, [{ captureId: "capture", selection: original }]);
  assert.deepEqual(selection, original);
  await f.finish();
  assert.ok(f.panel());
});

test("图片入口明确显示当前页并走与缩略图相同的页引用采集和要求输入", async () => {
  const page = { type: "Slide", listIndex: 0, id: "native", uniqueID: "native", children: [] };
  const image = { type: "Image", id: "picture", uniqueID: "picture", isImage: () => true, parent: page };
  page.children.push(image);
  const service = { currentSlideIndex: 0, currentSlide: page, slides: [page], lastMouseDownRegion: "editor",
    selectedSlides: { selectedArray: [] }, selectedElements: { selectedArrayForType: (type) => type === "SelectedEleMgrType_SLIDE" ? [image] : [] } };
  const f = fixture({ kind: "slide", readSelection: readOfficePageSelection, autoCapture: false,
    setup(scope) { scope.pray = () => ({ getSelectionService: () => service }); } });
  assert.equal(f.entry.textContent, "✦ AI 编辑当前页");
  assert.equal(f.entry.style.display, "block");
  f.emit("pointerdown", f.entry);
  assert.deepEqual(f.captures, [{ captureId: "capture", selection: { pageIndex: [0], shapeIds: [], nativeSlideIds: ["native"] } }]);
  await f.finish(); assert.ok(f.panel());
  assert.equal(f.panel().children[0].attributes["aria-label"], "说说你想怎么修改");
});

import test from "node:test";
import assert from "node:assert/strict";
import { readOfficeSheetSelectionAnchor } from "./office-sheet-selection-anchor.mjs";

function fixture() {
  const dimension = () => ({ frozen: { to: 0, displayViewSize: 40, renderFrom: 0, renderTo: 0 },
    flow: { displayViewSize: 300, renderFrom: 3, renderTo: 12 } });
  const area = { row: dimension(), col: dimension(), isCellVisiable: () => true,
    getDisplayViewLeftByCol: () => 80, getDisplayViewRightByCol: () => 120,
    getDisplayViewTopByRow: () => 60, getDisplayViewBottomByRow: () => 100 };
  const canvas = { areaData: area, headSize: { displayRowHeadWidth: 45, displayColHeadHeight: 25 },
    viewManager: { getActiveCanvasInfos: () => [{ canvasType: "single" }] },
    clientRect: { container: { isConnected: true, getBoundingClientRect: () => ({ left: 10, top: 90, width: 500, height: 400 }) } } };
  const view = { renderedSheetId: "sheet-2", canvas };
  const scope = { innerWidth: 1000, innerHeight: 800, SpreadsheetApp: { view,
    workbook: { activeSheet: { getSheetId: () => "sheet-2", getRowCount: () => 20, getColCount: () => 20 } } } };
  const selection = { sheetId: "sheet-2", ranges: [{ sheetId: "sheet-2", startRowIndex: 3, endRowIndex: 3, startColIndex: 3, endColIndex: 3 }] };
  return { scope, selection, area, canvas, view };
}

test("表格入口使用当前选区的显示坐标与容器偏移，不使用鼠标或重复缩放", () => {
  const { selection, scope } = fixture();
  assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: 135, y: 215, top: 175, minY: 115, maxY: 490 });
});

test("冻结与流动窗格分别校验可见边界，不把滚到冻结区后面的单元格夹到边缘", () => {
  for (const row of [0, 3]) for (const col of [0, 3]) {
    const { selection, scope, area } = fixture();
    Object.assign(selection.ranges[0], { startRowIndex: row, endRowIndex: row, startColIndex: col, endColIndex: col });
    area.getDisplayViewLeftByCol = () => col === 0 ? 0 : 40;
    area.getDisplayViewRightByCol = () => col === 0 ? 40 : 80;
    area.getDisplayViewTopByRow = () => row === 0 ? 0 : 40;
    area.getDisplayViewBottomByRow = () => row === 0 ? 40 : 80;
    assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: col === 0 ? 55 : 95, y: row === 0 ? 155 : 195, top: row === 0 ? 115 : 155, minY: 115, maxY: 490 });
    area.getDisplayViewLeftByCol = () => -1;
    assert.equal(readOfficeSheetSelectionAnchor(selection, scope), null);
  }
});

test("高行宽列和底部部分可见单元格保留真实左上角，下边缘取窗格可见交集", () => {
  for (const [top, bottom, right] of [[60, 1000, 120], [60, 100, 1000], [60, 1000, 1000], [320, 360, 120]]) {
    const { selection, scope, area } = fixture();
    area.getDisplayViewTopByRow = () => top;
    area.getDisplayViewBottomByRow = () => bottom;
    area.getDisplayViewRightByCol = () => right;
    assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), {
      x: 135, y: 115 + Math.min(bottom, 340), top: 115 + top, minY: 115, maxY: 490,
    });
  }
  const { selection, scope, area } = fixture();
  area.getDisplayViewBottomByRow = () => 1000;
  scope.innerHeight = 400;
  assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: 135, y: 400, top: 175, minY: 115, maxY: 388 });
});

test("冻结单元格末端裁剪到冻结窗格，流动单元格左上角被遮挡时仍拒绝", () => {
  const { selection, scope, area } = fixture();
  Object.assign(selection.ranges[0], { startRowIndex: 0, startColIndex: 0 });
  area.getDisplayViewLeftByCol = area.getDisplayViewTopByRow = () => 0;
  area.getDisplayViewRightByCol = area.getDisplayViewBottomByRow = () => 1000;
  assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: 55, y: 155, top: 115, minY: 115, maxY: 490 });
  Object.assign(selection.ranges[0], { startRowIndex: 3, startColIndex: 3 });
  for (const [left, top] of [[39, 60], [80, 39], [340, 60], [80, 340]]) {
    area.getDisplayViewLeftByCol = () => left;
    area.getDisplayViewTopByRow = () => top;
    assert.equal(readOfficeSheetSelectionAnchor(selection, scope), null);
  }
});

test("切表未渲染完成、未知画布或不可见选区不沿用旧锚点", () => {
  const cases = [
    ({ view }) => { view.renderedSheetId = "sheet-1"; },
    ({ selection }) => { selection.ranges[0].sheetId = "sheet-1"; },
    ({ canvas }) => { canvas.viewManager.getActiveCanvasInfos = () => [{ canvasType: "main" }]; },
    ({ canvas }) => { canvas.clientRect.container.isConnected = false; },
    ({ area }) => { area.isCellVisiable = () => false; },
    ({ area }) => { area.getDisplayViewRightByCol = () => 80; },
    ({ area }) => { area.getDisplayViewTopByRow = () => NaN; },
    ({ area }) => { area.getDisplayViewTopByRow = () => 340; },
  ];
  for (const mutate of cases) {
    const value = fixture(); mutate(value);
    assert.equal(readOfficeSheetSelectionAnchor(value.selection, value.scope), null);
  }
});

test("多块选择按原顺序取首个可见真实左上角，不改变任何范围", () => {
  const { selection, scope, area } = fixture();
  selection.ranges.push({ sheetId: "sheet-2", startRowIndex: 5, endRowIndex: 6, startColIndex: 5, endColIndex: 6 });
  const original = structuredClone(selection);
  area.getDisplayViewLeftByCol = (col) => col === 3 ? 80 : 160;
  area.getDisplayViewRightByCol = (col) => col === 3 ? 120 : 200;
  area.getDisplayViewTopByRow = (row) => row === 3 ? 60 : 140;
  area.getDisplayViewBottomByRow = (row) => row === 3 ? 100 : 180;
  assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: 135, y: 215, top: 175, minY: 115, maxY: 490 });
  area.isCellVisiable = (row) => row === 5;
  assert.deepEqual(readOfficeSheetSelectionAnchor(selection, scope), { x: 215, y: 295, top: 255, minY: 115, maxY: 490 });
  // SDK 可见标记不足以绕过冻结遮挡检查；首块起点被遮住时仍只用后块真实起点。
  area.isCellVisiable = () => true;
  area.getDisplayViewLeftByCol = (col) => col === 3 ? 39 : 160;
  assert.equal(readOfficeSheetSelectionAnchor(selection, scope).x, 215);
  area.isCellVisiable = () => false;
  assert.equal(readOfficeSheetSelectionAnchor(selection, scope), null);
  assert.deepEqual(selection, original);
});

test("任一范围身份或完整坐标无效时拒绝，即使其他范围可见", () => {
  const invalid = [null, { sheetId: undefined }, { sheetId: "other" }, { startRowIndex: -1 }, { startRowIndex: 4 },
    { startColIndex: -1 }, { startColIndex: 4 }, { endRowIndex: undefined }, { endColIndex: undefined },
    { endRowIndex: 20 }, { endColIndex: 20 }, { endRowIndex: Infinity }, { endColIndex: 3.5 }];
  for (const changes of invalid) for (const position of [0, 1]) {
    const { selection, scope } = fixture();
    const range = changes === null ? null : { ...selection.ranges[0], ...changes };
    selection.ranges.splice(position, 0, range);
    assert.equal(readOfficeSheetSelectionAnchor(selection, scope), null);
  }
  for (const name of ["getRowCount", "getColCount"]) for (const count of [0, -1, undefined, Infinity, 3.5]) {
    const { selection, scope } = fixture();
    scope.SpreadsheetApp.workbook.activeSheet[name] = () => count;
    assert.equal(readOfficeSheetSelectionAnchor(selection, scope), null);
  }
  for (const ranges of [[], null, {}, [undefined], new Array(2)]) {
    const { selection, scope } = fixture();
    assert.equal(readOfficeSheetSelectionAnchor({ ...selection, ranges }, scope), null);
  }
});

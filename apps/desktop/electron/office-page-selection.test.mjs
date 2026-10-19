import assert from "node:assert/strict";
import test from "node:test";
import { readOfficePageSelection } from "./office-page-selection.mjs";

test("Word 字符选区保留真实坐标，跨单元格及未知页面不冒充连续文字", () => {
  let cells = [];
  let end = 8;
  const scope = {
    pad: {
      editor: {
        selection: { gcpRange: { begin: () => 2, end: () => end } },
        service: {
          getSelection: () => ({
            getTableSelectionArea: () => ({ cellRanges: cells }),
          }),
        },
        getRefText: () => "选中的文字",
      },
    },
  };
  assert.deepEqual(readOfficePageSelection("doc", scope), {
    ranges: [{ begin: 2, end: 8, length: 6 }],
    selectedText: "选中的文字",
  });
  cells = [1];
  assert.equal(readOfficePageSelection("doc", scope), null);
  cells = [];
  end = NaN;
  assert.equal(readOfficePageSelection("doc", scope), null);
  assert.equal(readOfficePageSelection("doc", {}), null);
});

test("表格选区使用当前真实子表和模型边界，浮动对象不泄漏旧单元格坐标", () => {
  let type = 1;
  const scope = {
    SpreadsheetApp: {
      workbook: {
        activeSheet: {
          getSheetId: () => "actual_sheet",
          getRowCount: () => 20,
          getColCount: () => 8,
        },
      },
      view: {
        getSelectionType: () => type,
        getSelectionRanges: () => [
          {
            sheetId: "actual_sheet",
            startRowIndex: 1,
            endRowIndex: 1,
            startColIndex: 0,
            endColIndex: Infinity,
          },
        ],
      },
    },
  };
  assert.deepEqual(readOfficePageSelection("sheet", scope), {
    sheetId: "actual_sheet",
    drawingIds: [],
    ranges: [
      {
        sheetId: "actual_sheet",
        startRowIndex: 1,
        endRowIndex: 1,
        startColIndex: 0,
        endColIndex: 7,
      },
    ],
  });
  type = 3;
  assert.equal(readOfficePageSelection("sheet", scope), null);
  assert.equal(readOfficePageSelection("sheet", {}), null);
});

test("PPT 采集页面及形状身份，多页选择保留所有页且不沿用形状，备注和组内选区返回空", () => {
  const pages = [{ listIndex: 1 }];
  const observable = (items) => ({ slice: () => items.slice() });
  let nestedKind = "";
  const selection = {
    currentSlideIndex: 1,
    lastMouseDownRegion: "editor",
    selectedBlank: { enabled: false },
    selectedSlides: { selectedArray: observable(pages) },
    selectedElements: {
      selectedArrayForType: (kind) =>
        observable(
          kind === nestedKind
            ? [{ id: "nested" }]
            : kind === "SelectedEleMgrType_SLIDE"
              ? [{ id: "shape_actual" }]
              : [],
        ),
    },
  };
  const scope = { pray: () => ({ getSelectionService: () => selection }) };
  assert.deepEqual(readOfficePageSelection("slide", scope), {
    pageIndex: 1,
    shapeIds: ["shape_actual"],
  });
  pages.push({ listIndex: 3 });
  assert.deepEqual(readOfficePageSelection("slide", scope), {
    pageIndex: [1, 3],
    shapeIds: [],
  });
  selection.lastMouseDownRegion = "note";
  assert.equal(readOfficePageSelection("slide", scope), null);
  selection.lastMouseDownRegion = "editor";
  nestedKind = "SelectedEleMgrType_GROUP";
  assert.equal(readOfficePageSelection("slide", scope), null);
  nestedKind = "SelectedEleMgrType_SMART_ART";
  assert.equal(readOfficePageSelection("slide", scope), null);
  nestedKind = "";
  selection.selectedBlank.enabled = true;
  assert.equal(readOfficePageSelection("slide", scope), null);
  assert.equal(readOfficePageSelection("slide", {}), null);
});

test("PPT 内部文字选区保留跨段落 UTF-16 位置，反向选择和无效输入不能退成整形状", () => {
  let points = {
    anchor: { path: [1], offset: 2 },
    focus: { path: [0], offset: 1 },
  };
  const shape = {
    id: "shape_A",
    paragraphList: [
      { textRuns: [{ text: "甲😀乙" }] },
      { textRuns: [{ text: "正文尾" }] },
    ],
    editorInstance: { isEditing: true, getSelection: () => points },
  };
  const selection = {
    currentSlideIndex: 0,
    lastMouseDownRegion: "editor",
    selectedBlank: { enabled: false },
    selectedSlides: { selectedArray: [] },
    selectedElements: {
      selectedArrayForType: (kind) =>
        kind === "SelectedEleMgrType_SLIDE" ? [shape] : [],
    },
  };
  const scope = { pray: () => ({ getSelectionService: () => selection }) };
  assert.deepEqual(readOfficePageSelection("slide", scope), {
    pageIndex: 0,
    shapeIds: ["shape_A"],
    textSelection: {
      shapeId: "shape_A",
      start: 1,
      count: 6,
      selectedText: "😀乙\r正文",
    },
  });
  points = {
    anchor: { path: [1], offset: 3 },
    focus: { path: [1], offset: 3 },
  };
  assert.deepEqual(readOfficePageSelection("slide", scope)?.textSelection, {
    shapeId: "shape_A",
    start: 8,
    count: 0,
    selectedText: "",
  });
  points.focus.offset = 4;
  assert.equal(readOfficePageSelection("slide", scope), null);
  points.focus = { path: [-1], offset: 0 };
  assert.equal(readOfficePageSelection("slide", scope), null);
  shape.editorInstance.isEditing = false;
  assert.deepEqual(readOfficePageSelection("slide", scope), {
    pageIndex: 0,
    shapeIds: ["shape_A"],
  });
});

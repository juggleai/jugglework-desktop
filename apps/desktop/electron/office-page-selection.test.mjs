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

test("Word 单段与跨段段尾选择只排除最后一个结构回车，保留空白、空段和原坐标", () => {
  let begin = 26, end = 30, text = "是多少\r";
  const scope = { pad: { editor: {
    selection: { gcpRange: { begin: () => begin, end: () => end } },
    service: { getSelection: () => ({ getTableSelectionArea: () => ({ cellRanges: [] }) }) },
    getRefText: () => text,
  } } };
  assert.deepEqual(readOfficePageSelection("doc", scope), { ranges: [{ begin: 26, end: 29, length: 3 }], selectedText: "是多少" });
  begin = 0; end = 4; text = "字  \r";
  assert.deepEqual(readOfficePageSelection("doc", scope), { ranges: [{ begin: 0, end: 3, length: 3 }], selectedText: "字  " });
  end = 1; text = "\r";
  assert.deepEqual(readOfficePageSelection("doc", scope), { ranges: [{ begin: 0, end: 0, length: 0 }], selectedText: "" });
  text = "甲\r\r乙\r"; end = text.length;
  assert.deepEqual(readOfficePageSelection("doc", scope), { ranges: [{ begin: 0, end: 4, length: 4 }], selectedText: "甲\r\r乙" });
  for (const raw of ["甲\n乙\r", "甲[line_break]\r"]) {
    text = raw; end = raw === "甲[line_break]\r" ? 2 : raw.length;
    assert.equal(readOfficePageSelection("doc", scope).ranges[0].end, end);
    assert.equal(readOfficePageSelection("doc", scope).selectedText, raw);
  }
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

test("表格仅以已验证的维度哨兵建立行列意图，有限全宽矩形和全表不冒充整行", () => {
  let endCol = 2147483647, endRow = 2;
  const scope = { SpreadsheetApp: { workbook: { activeSheet: { getSheetId: () => "s", getRowCount: () => 20, getColCount: () => 8 } },
    view: { getSelectionType: () => 1, getSelectionRanges: () => [{ sheetId: "s", startRowIndex: 0, endRowIndex: endRow, startColIndex: 0, endColIndex: endCol }] } } };
  assert.equal(readOfficePageSelection("sheet", scope).selectionKind, "rows");
  endCol = 7;
  assert.equal(readOfficePageSelection("sheet", scope).selectionKind, undefined);
  endRow = 2147483647;
  assert.equal(readOfficePageSelection("sheet", scope).selectionKind, "columns");
  endCol = 2147483647;
  assert.equal(readOfficePageSelection("sheet", scope).selectionKind, undefined);
});

test("PPT 采集页面及形状身份，多页选择保留所有页且不沿用形状，备注和组内选区返回空", () => {
  const pages = [{ listIndex: 1, key: "render-one", id: "page-one", uniqueID: "page-one" }];
  const observable = (items) => ({ slice: () => items.slice() });
  let nestedKind = "";
  const selection = {
    currentSlideIndex: 1,
    slides: [null, { key: "render-one", id: "page-one", uniqueID: "page-one" }, null, { key: "render-three", id: "page-three", uniqueID: "page-three" }],
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
  selection.lastMouseDownRegion = "slidelist";
  assert.deepEqual(readOfficePageSelection("slide", scope), { pageIndex: [1], shapeIds: [], nativeSlideIds: ["page-one"] });
  selection.lastMouseDownRegion = "player";
  assert.equal(readOfficePageSelection("slide", scope), null);
  selection.lastMouseDownRegion = "editor";
  pages.push({ listIndex: 3, key: "render-three", id: "page-three", uniqueID: "page-three" });
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
    slides: [{ key: "render-zero", id: "page-zero", uniqueID: "page-zero" }],
    lastMouseDownRegion: "editor",
    selectedBlank: { enabled: false },
    selectedSlides: { selectedArray: [] },
    selectedElements: {
      selectedArrayForType: (kind) =>
        kind === "SelectedEleMgrType_SLIDE" ? [shape] : [],
    },
  };
  const scope = { pray: () => ({ getSelectionService: () => selection }) };
  selection.lastMouseDownRegion = "slidelist";
  selection.selectedSlides.selectedArray = [{ listIndex: 0, key: "render-zero", id: "page-zero", uniqueID: "page-zero" }];
  assert.deepEqual(readOfficePageSelection("slide", scope), { pageIndex: [0], shapeIds: [], nativeSlideIds: ["page-zero"] });
  selection.lastMouseDownRegion = "editor";
  selection.selectedSlides.selectedArray = [];
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

test("PPT 页选择严格配对原生 id/uniqueID 和索引，DOM key 不能替代授权身份", () => {
  const pages = [{ listIndex: 2, key: "render-two", id: "native-two", uniqueID: "native-two" }, { listIndex: 0, key: "render-zero", id: "native-zero", uniqueID: "native-zero" }];
  const selection = { lastMouseDownRegion: "slidelist", selectedSlides: { selectedArray: /** @type {any[]} */ (pages) },
    slides: [{ key: "render-zero", id: "native-zero", uniqueID: "native-zero" }, { key: "render-one", id: "native-one", uniqueID: "native-one" }, { key: "render-two", id: "native-two", uniqueID: "native-two" }] };
  const scope = { pray: () => ({ getSelectionService: () => selection }) };
  assert.deepEqual(readOfficePageSelection("slide", scope), { pageIndex: [2, 0], shapeIds: [], nativeSlideIds: ["native-two", "native-zero"] });
  for (const invalid of [[], [{ listIndex: 0 }], [{ ...pages[1], listIndex: -1 }],
    [{ listIndex: 0, key: "render-zero" }], [{ ...pages[1], id: "render-zero", uniqueID: "render-zero" }],
    [{ ...pages[1], uniqueID: "native-two" }], [{ ...pages[1], id: "" }], [{ ...pages[0], listIndex: 0 }],
    [pages[1], pages[1]]]) {
    selection.selectedSlides.selectedArray = invalid;
    assert.equal(readOfficePageSelection("slide", scope), null);
  }
  selection.selectedSlides.selectedArray = pages;
  selection.slides[2].uniqueID = "wrong-native-id";
  assert.equal(readOfficePageSelection("slide", scope), null);
  selection.slides[2].uniqueID = "native-two";
  // 渲染 key 改变不能改变原生页授权，也不能把它发送成 nativeSlideIds。
  selection.slides[2].key = "new-render-key";
  assert.deepEqual(readOfficePageSelection("slide", scope).nativeSlideIds, ["native-two", "native-zero"]);
  for (const region of [undefined, "", "unknown", "player", "note", "toolbar"]) {
    selection.lastMouseDownRegion = region;
    assert.equal(readOfficePageSelection("slide", scope), null);
  }
});

test("图片 AI 当前页入口显式绑定直接图片所属真实单页，普通选区查询仍保留对象", () => {
  const page = { type: "Slide", listIndex: 0, id: "native", uniqueID: "native", children: [] };
  /** @type {{ type: string, id: string, uniqueID: string, isImage(): boolean, parent: unknown }} */
  const image = { type: "Image", id: "picture", uniqueID: "picture", isImage: () => true, parent: page };
  page.children.push(image);
  const selection = { currentSlideIndex: 0, currentSlide: page, slides: [page], lastMouseDownRegion: "editor",
    selectedSlides: { selectedArray: [] }, selectedElements: { selectedArrayForType: (type) => type === "SelectedEleMgrType_SLIDE" ? [image] : [] } };
  const scope = { pray: () => ({ getSelectionService: () => selection }) };
  assert.deepEqual(readOfficePageSelection("slide", scope), { pageIndex: 0, shapeIds: ["picture"] });
  const read = () => readOfficePageSelection("slide", scope, { picturePage: true });
  assert.deepEqual(read(), { pageIndex: [0], shapeIds: [], nativeSlideIds: ["native"] });
  selection.selectedSlides.selectedArray = [page];
  assert.deepEqual(read().nativeSlideIds, ["native"]);
  for (const mutate of [() => { image.parent = {}; }, () => { page.uniqueID = "other"; },
    () => { selection.currentSlideIndex = 1; }, () => { page.children = []; },
    () => { page.children = [image, image]; }, () => { image.isImage = () => false; },
    () => { selection.selectedSlides.selectedArray = [page, page]; }]) {
    image.parent = page; image.isImage = () => true; page.uniqueID = "native"; selection.currentSlideIndex = 0;
    page.children = [image]; selection.selectedSlides.selectedArray = [];
    mutate(); assert.equal(read(), null);
  }
});

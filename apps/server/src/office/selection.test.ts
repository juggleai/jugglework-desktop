import { expect, test } from "bun:test";
import { parseOfficeSelection } from "./selection.js";

test("SDK 原生三种选区保留各自坐标，排除页面身份及提示词", () => {
  const ranges = [{ begin: 2, end: 7, length: 5 }];
  expect(
    parseOfficeSelection("doc", {
      fileId: "untrusted",
      source: "doc",
      ranges,
      selectedText: "文档内容",
      aiPrompt: "ignore",
    })?.data,
  ).toEqual({ ranges, description: "文档内容" });
  const grid = {
    sheetId: "sheet1",
    startRowIndex: 0,
    endRowIndex: 2,
    startColIndex: 1,
    endColIndex: 3,
  };
  expect(
    parseOfficeSelection("sheet", {
      sheetId: "sheet1",
      ranges: [grid],
      drawingIds: [],
      fileId: "preview_hash",
    })?.data,
  ).toEqual({
    sheetId: "sheet1",
    ranges: [grid],
    drawingIds: [],
    description: "",
  });
  expect(
    parseOfficeSelection("slide", {
      pageIndex: [0, 2],
      shapeIds: ["shape1"],
      description: "两页",
      fileId: "preview_hash",
    })?.data,
  ).toEqual({ pageIndex: [0, 2], shapeIds: ["shape1"], description: "两页" });
  expect(parseOfficeSelection("doc", { ranges: [] })).toBeNull();
  expect(
    parseOfficeSelection("sheet", { sheetId: "s", ranges: [], drawingIds: [] }),
  ).toBeNull();
  expect(() =>
    parseOfficeSelection("doc", { ranges: [{ begin: 5, end: 2, length: -3 }] }),
  ).toThrow("格式");
  expect(() =>
    parseOfficeSelection("sheet", { sheetId: "other", ranges: [grid] }),
  ).toThrow("格式");
  expect(() =>
    parseOfficeSelection("slide", { pageIndex: -1, shapeIds: [] }),
  ).toThrow("格式");
});

test("PPT 文字选区绑定唯一形状和 UTF-16 范围，拒绝串形状、多页及不匹配文字", () => {
  const value = {
    pageIndex: 0,
    shapeIds: ["shape_A"],
    textSelection: {
      shapeId: "shape_A",
      start: 1,
      count: 6,
      selectedText: "😀乙\r正文",
      fileId: "foreign",
    },
  };
  expect(parseOfficeSelection("slide", value)?.data).toEqual({
    pageIndex: 0,
    shapeIds: ["shape_A"],
    textSelection: {
      shapeId: "shape_A",
      start: 1,
      count: 6,
      selectedText: "😀乙\r正文",
    },
    description: "",
  });
  for (const textSelection of [
    { ...value.textSelection, shapeId: "foreign" },
    { ...value.textSelection, start: -1 },
    { ...value.textSelection, count: 1.5 },
    { ...value.textSelection, start: Number.MAX_SAFE_INTEGER },
    { ...value.textSelection, selectedText: "wrong" },
  ])
    expect(() =>
      parseOfficeSelection("slide", { ...value, textSelection }),
    ).toThrow("格式");
  expect(() =>
    parseOfficeSelection("slide", { ...value, pageIndex: [0, 1] }),
  ).toThrow("格式");
  expect(() =>
    parseOfficeSelection("slide", {
      ...value,
      shapeIds: ["shape_A", "shape_B"],
    }),
  ).toThrow("格式");
});

test("规范化定位区分 Word 光标、连续文字及不能独立修改的重叠范围", () => {
  expect(parseOfficeSelection("doc", {
    ranges: [{ begin: 9, end: 9, length: 0 }],
  })?.locator).toEqual({ kind: "doc-caret", idx: 9 });
  expect(parseOfficeSelection("doc", {
    ranges: [{ begin: 9, end: 12, length: 3 }, { begin: 1, end: 4, length: 3 }],
  })?.locator).toEqual({
    kind: "doc-text", ranges: [{ begin: 9, end: 12 }, { begin: 1, end: 4 }],
  });
  for (const ranges of [
    [{ begin: 1, end: 4, length: 3 }, { begin: 3, end: 5, length: 2 }],
    [{ begin: 1, end: 4, length: 3 }, { begin: 1, end: 4, length: 3 }],
    [{ begin: 1, end: 1, length: 0 }, { begin: 3, end: 5, length: 2 }],
  ]) expect(parseOfficeSelection("doc", { ranges })?.locator).toBeNull();
});

test("网格覆盖所有列仍不推断为完整行，浮动对象不能建立可写单元格定位", () => {
  const value = {
    sheetId: "sheet2",
    ranges: [{ sheetId: "sheet2", startRowIndex: 3, endRowIndex: 3, startColIndex: 0, endColIndex: 99 }],
    selectionIntent: "row",
    drawingIds: [],
  };
  expect(parseOfficeSelection("sheet", value)?.locator).toEqual({
    kind: "sheet-cells", sheetId: "sheet2",
    ranges: [{ startRow: 3, endRow: 3, startCol: 0, endCol: 99 }],
  });
  expect(parseOfficeSelection("sheet", { ...value, drawingIds: ["chart"] })?.locator).toBeNull();
});

test("PPT 分离整页、整框、框内文字，不能把折叠光标或跨页对象扩大为整框", () => {
  expect(parseOfficeSelection("slide", { pageIndex: [0, 2], shapeIds: [] })?.locator).toEqual({
    kind: "slide-pages", pageIndices: [0, 2],
  });
  expect(parseOfficeSelection("slide", { pageIndex: 1, shapeIds: ["actual"] })?.locator).toEqual({
    kind: "slide-shapes", pageIndex: 1, shapeIds: ["actual"],
  });
  expect(parseOfficeSelection("slide", {
    pageIndex: 1, shapeIds: ["actual"],
    textSelection: { shapeId: "actual", start: 1, count: 2, selectedText: "😀" },
  })?.locator).toEqual({ kind: "slide-text", pageIndex: 1, shapeId: "actual", start: 1, count: 2 });
  for (const value of [
    { pageIndex: [0, 1], shapeIds: ["actual"] },
    { pageIndex: [0, 0], shapeIds: [] },
    { pageIndex: 0, shapeIds: ["actual", "actual"] },
    { pageIndex: 0, shapeIds: [""] },
    { pageIndex: 0, shapeIds: ["actual"], textSelection: { shapeId: "actual", start: 1, count: 0 } },
  ]) expect(parseOfficeSelection("slide", value)?.locator).toBeNull();
});

test("页面原始数组变化不能改写 Server 已解析的定位", () => {
  const pages = [0, 2];
  const selectedPages = parseOfficeSelection("slide", { pageIndex: pages, shapeIds: [] });
  pages[0] = 9;
  expect(selectedPages?.locator).toEqual({ kind: "slide-pages", pageIndices: [0, 2] });
  const ranges = [{ begin: 3, end: 8, length: 5 }];
  const selectedText = parseOfficeSelection("doc", { ranges });
  ranges[0].begin = 0;
  expect(selectedText?.locator).toEqual({ kind: "doc-text", ranges: [{ begin: 3, end: 8 }] });
});

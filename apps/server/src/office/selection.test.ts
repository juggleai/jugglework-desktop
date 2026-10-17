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

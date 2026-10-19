import { expect, test } from "bun:test";
import type { OfficeSelectionLocator } from "@jugglework/types/office";
import { describeOfficeSelectionTool, officeSelectionToolNames, planOfficeSelectionTool } from "./selection-tools.js";
import { parseOfficeSelection } from "./selection.js";

const plan = (locator: OfficeSelectionLocator, name: string, args: Record<string, unknown> = {}) =>
  planOfficeSelectionTool(locator, "actual-model", name, args);

test("Word 选区工具发现声明宿主跨段契约，不能改写普通原生工具目录", () => {
  const native = { name: "doc_replace_text", description: "原生单段替换", inputSchema: { type: "object", properties: { ranges: { type: "array" }, text: { type: "string" } }, required: ["ranges", "text"] } };
  const adapted = describeOfficeSelectionTool(native);
  expect(adapted.description).toContain("保留原有段数");
  expect(adapted.inputSchema.required).toEqual(["text"]);
  expect(native.inputSchema.required).toEqual(["ranges", "text"]);
  expect(native.description).toBe("原生单段替换");
});

test("Word 两处文字相同时仍使用第二处固定坐标，不接受搜索、全篇及重复范围", () => {
  const locator = parseOfficeSelection("doc", {
    ranges: [{ begin: 12, end: 15, length: 3 }],
    selectedText: "同文案",
  })!.locator!;
  expect(plan(locator, "doc_replace_text", { text: "新标题" })).toEqual({
    args: { file_id: "actual-model", ranges: [{ begin: 12, end: 15 }], text: "新标题" },
    effect: "coordinates",
  });
  for (const ranges of [
    [{ begin: 1, end: 4 }],
    [{ begin: 12, end: 16 }],
    [{ begin: 12, end: 13 }, { begin: 12, end: 13 }],
    [{ begin: 12, end: 12 }],
    [{ begin: 12, end: Infinity }],
    null,
  ]) expect(() => plan(locator, "doc_replace_text", { ranges, text: "错误位置" })).toThrow();
  expect(() => plan(locator, "doc_find", { text: "同文案" })).toThrow("尚不支持");
  expect(() => plan(locator, "doc_replace_text", { text: "改写", file_id: "other" })).toThrow("不一致");
  expect(() => plan(locator, "doc_replace_text", { text: "改写", replace_all: true })).toThrow("尚未适配");
  expect(plan(locator, "doc_get_text_property", { idx: 14 }).effect).toBe("read");
  expect(() => plan(locator, "doc_get_text_property", { idx: 15 })).toThrow();
});

test("Word 光标仅允许原位插入；多块文字样式保留各块，坐标变化暂要求拆分", () => {
  const caret = parseOfficeSelection("doc", { ranges: [{ begin: 8, end: 8, length: 0 }] })!.locator!;
  expect(plan(caret, "doc_insert_text", { text: "添加" }).args.idx).toBe(8);
  expect(() => plan(caret, "doc_insert_text", { idx: 9, text: "越界" })).toThrow();
  expect(() => plan(caret, "doc_replace_text", { text: "删除" })).toThrow();
  const locator: OfficeSelectionLocator = {
    kind: "doc-text", ranges: [{ begin: 2, end: 5 }, { begin: 12, end: 15 }],
  };
  expect(plan(locator, "doc_update_text_property", { bold: true }).args.ranges).toEqual(locator.ranges);
  expect(() => plan(locator, "doc_update_text_property", {
    ranges: [{ begin: 2, end: 15 }], bold: true,
  })).toThrow();
  expect(() => plan(locator, "doc_replace_text", { text: "新文字" })).toThrow("拆分");
});

test("第二子表 A8 不改第一子表，单元格选区不能通过删除维度扩大为整行", () => {
  const locator = parseOfficeSelection("sheet", {
    sheetId: "second-sheet",
    ranges: [{ sheetId: "second-sheet", startRowIndex: 7, endRowIndex: 7, startColIndex: 0, endColIndex: 0 }],
  })!.locator!;
  const input = { cell: { row: 7, col: 0, value_type: "NUMBER", number_value: 10 } };
  const result = plan(locator, "sheet_set_cell_value", input);
  expect(result.args).toEqual({ ...input, file_id: "actual-model", sheet_id: "second-sheet" });
  expect(input).not.toHaveProperty("sheet_id");
  expect(() => plan(locator, "sheet_set_cell_value", { ...input, sheet_id: "first-sheet" })).toThrow();
  expect(() => plan(locator, "sheet_set_cell_value", { cell: { ...input.cell, row: 0 } })).toThrow();
  expect(() => plan(locator, "sheet_delete_dimension", { dimension_type: "row", index: 7, count: 1 })).toThrow("尚不支持");
  expect(plan(locator, "sheet_get_cell_data").args).toEqual({
    file_id: "actual-model", sheet_id: "second-sheet", start_row: 7, end_row: 7, start_col: 0, end_col: 0,
  });
});

test("不相邻表格区域不能用包围矩形授权中间单元格，部分坐标不能自动补齐", () => {
  const locator: OfficeSelectionLocator = {
    kind: "sheet-cells", sheetId: "sheet",
    ranges: [
      { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      { startRow: 4, endRow: 5, startCol: 4, endCol: 5 },
    ],
  };
  expect(() => plan(locator, "sheet_set_cell_style", { format: { bold: true } })).toThrow();
  expect(() => plan(locator, "sheet_set_cell_style", {
    start_row: 0, end_row: 5, start_col: 0, end_col: 5, format: { bold: true },
  })).toThrow();
  expect(() => plan(locator, "sheet_get_cell_data", { start_row: 0 })).toThrow();
  expect(() => plan(locator, "sheet_set_cell_value", { cell: { row: 2, col: 2, value_type: "STRING", string_value: "空隙" } })).toThrow();
  expect(plan(locator, "sheet_set_cell_style", {
    start_row: 4, end_row: 5, start_col: 4, end_col: 5, format: { bold: true },
  }).effect).toBe("content");
});

test("完整行列引用仅映射相应维度，不串子表、不溢出区间，并标记坐标变化", () => {
  for (const [kind, dimension] of [["sheet-rows", "row"], ["sheet-columns", "col"]] as const) {
    const locator: OfficeSelectionLocator = { kind, sheetId: "actual", ranges: [{ start: 3, end: 4 }] };
    expect(plan(locator, "sheet_delete_dimension")).toEqual({
      args: { file_id: "actual-model", sheet_id: "actual", dimension_type: dimension, index: 3, count: 2 },
      effect: "coordinates",
    });
    expect(() => plan(locator, "sheet_delete_dimension", { dimension_type: dimension === "row" ? "col" : "row" })).toThrow();
    for (const [index, count] of [[2, 1], [3, 3], [3, 0], [4, 2], [3, Number.MAX_SAFE_INTEGER]])
      expect(() => plan(locator, "sheet_delete_dimension", { index, count })).toThrow();
  }
});

test("PPT 同文案不同形状仅修改指定框，框内两字样式不能变成整框或末尾", () => {
  const selected: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 1, shapeId: "second-shape", start: 3, count: 2 };
  expect(plan(selected, "slide_set_text_property", { bold: true })).toEqual({
    args: { file_id: "actual-model", page_index: 1, shape_id: "second-shape", index: 3, count: 2, bold: true },
    effect: "content",
  });
  for (const extra of [
    { page_index: 0 }, { shape_id: "first-shape" }, { shape_ids: ["first-shape", "second-shape"] },
    { shapes: [{ shape_id: "second-shape", index: 0, count: -1, bold: true }] },
    { count: -1 }, { count: 3 }, { index: 0, count: 2 }, { index: 4, count: 2 }, { row: 0, col: 0 },
    { index: null }, { index: 3, count: Number.MAX_SAFE_INTEGER },
  ]) expect(() => plan(selected, "slide_set_text_property", { bold: true, ...extra })).toThrow();
  expect(() => plan(selected, "slide_set_text", { text: "不能替换整个框" })).toThrow("尚不支持");
  const shape: OfficeSelectionLocator = { kind: "slide-shapes", pageIndex: 1, shapeIds: ["second-shape"] };
  const replacement = plan(shape, "slide_set_text", { text: "明确整框替换" });
  expect(replacement.args.shape_id).toBe("second-shape");
  expect(replacement.effect).toBe("coordinates");
  expect(officeSelectionToolNames({ kind: "slide-pages", pageIndices: [1, 3] })).toEqual([]);
});

test("多形状须指定其中的真实身份，参数克隆后不因调用者后续改动而改投目标", () => {
  const locator: OfficeSelectionLocator = { kind: "slide-shapes", pageIndex: 0, shapeIds: ["a", "b"] };
  expect(() => plan(locator, "slide_set_text", { text: "不猜测目标" })).toThrow();
  expect(plan(locator, "slide_set_text", { shape_id: "b", text: "更新 b" }).args.shape_id).toBe("b");
  const input = { ranges: [{ begin: 10, end: 12 }], bold: true };
  const result = plan({ kind: "doc-text", ranges: [{ begin: 10, end: 14 }] }, "doc_update_text_property", input);
  input.ranges[0].begin = 0;
  expect(result.args.ranges).toEqual([{ begin: 10, end: 12 }]);
});

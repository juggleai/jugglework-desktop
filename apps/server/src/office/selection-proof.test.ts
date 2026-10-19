import { expect, test } from "bun:test";
import { officeDocRangeParts, readOfficeSelectionProof, verifyOfficeSelectionEdit } from "./selection-proof.js";

test("公式回读允许原生函数名大小写规范化，不掩盖字符串、名称、引用或邻格的实际变化", () => {
  const before = { stamp: "", state: { kind: "sheet", sheetId: "sheet", region: {}, sheets: [], merges: [], formats: [],
    cells: [{ row: 0, col: 0, value_type: "NUMBER", number_value: 1 }, { row: 0, col: 1, value_type: "STRING", string_value: "保留" }] } };
  const locator = { kind: "sheet-cells" as const, sheetId: "sheet", ranges: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 0 }] };
  const verify = (expected: string, actual: string, adjacent = "保留") => verifyOfficeSelectionEdit(before,
    { stamp: "", state: { ...before.state, cells: [{ row: 0, col: 0, value_type: "NUMBER", number_value: 3, formula: actual }, { row: 0, col: 1, value_type: "STRING", string_value: adjacent }] } },
    locator, "sheet_set_cell_value", { sheet_id: "sheet", cell: { row: 0, col: 0, value_type: "FORMULA", formula: expected } });
  expect(() => verify("=sum(A2:A3)", "SUM(A2:A3)")).not.toThrow();
  const expected = '=if(\'sum(Keep)\'!A2="MiXeD", "say ""sum(A1)""", Table[sum(Keep)])';
  const actual = expected.replace("=if(", "=IF(");
  expect(() => verify(expected, actual)).not.toThrow();
  for (const changed of [actual.replace("MiXeD", "MIXED"), actual.replace("sum(A1)", "SUM(A1)"), actual.replace("'sum(Keep)'", "'SUM(Keep)'"), actual.replace("[sum(Keep)]", "[SUM(Keep)]"), actual.replace("!A2", "!A3")]) {
    expect(() => verify(expected, changed)).toThrow("尚未确认");
  }
  expect(() => verify("=sum(A2:A3)", "=SUM(A2:A3)", "被修改")).toThrow("尚未确认");
});

test("跨段定位保留空段及 UTF-16 边界，缺段或非连续结构不能被拼成正文", () => {
  const nodes = [
    { start_index: 0, end_index: 4, text_preview: "前甲😀" },
    { start_index: 5, end_index: 5, text_preview: "" },
    { start_index: 6, end_index: 9, text_preview: "乙后文" },
  ];
  expect(officeDocRangeParts({ nodes }, { begin: 1, end: 7 }).map((part) => part.text)).toEqual(["甲😀", "", "乙"]);
  for (const invalid of [nodes.filter((_node, i) => i !== 1), [{ ...nodes[0], end_index: 3 }, ...nodes.slice(1)]]) {
    expect(() => officeDocRangeParts({ nodes: invalid }, { begin: 1, end: 7 })).toThrow("无法完整核对");
  }
});

test("跨段改写回读必须核对首尾未选字、坐标和段落属性，不能只检查新文字", () => {
  const nodes = [
    { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "前甲" },
    { type: "Paragraph", start_index: 3, end_index: 5, text_preview: "乙后" },
  ];
  const before = { stamp: "", state: { kind: "doc", revision: 1, last: 5, nodes, paragraphs: [{ idx: 0, alignment: "left" }, { idx: 3, alignment: "right" }],
    properties: [0, 1, 3, 4].map((idx) => ({ idx, bold: idx === 0 })) } };
  const after = { stamp: "", state: { kind: "doc", revision: 3, last: 6,
    nodes: [{ ...nodes[0], end_index: 3, text_preview: "前新甲" }, { ...nodes[1], start_index: 4, end_index: 6, text_preview: "新后" }],
    paragraphs: [{ idx: 0, alignment: "left" }, { idx: 4, alignment: "right" }],
    properties: [0, 1, 2, 4, 5].map((idx) => ({ idx, bold: idx === 0 })) } };
  const locator = { kind: "doc-text" as const, ranges: [{ begin: 1, end: 4 }] };
  const verify = () => verifyOfficeSelectionEdit(before, after, locator, "doc_replace_text", { ranges: locator.ranges, text: "新甲\r新" }, 2);
  expect(verify).not.toThrow();
  after.state.nodes[1].text_preview = "新错";
  expect(verify).toThrow("尚未确认");
  after.state.nodes[1].text_preview = "新后";
  after.state.paragraphs[1].alignment = "left";
  expect(verify).toThrow("尚未确认");
  after.state.paragraphs[1].alignment = "right";
  after.state.properties[0].bold = false;
  expect(verify).toThrow("尚未确认");
});

test("Word 空段落可省略预览，非空或未知内容不能被补成空串", async () => {
  const read = (node: Record<string, unknown>) => readOfficeSelectionProof(async (name) => {
    if (name === "doc_get_last_operable_pos") return { position: 5, version: 0 };
    if (name === "doc_resolve_document_structure") return {
      version: 0, pagination: { has_more: false, total_nodes: 2 },
      nodes: [{ type: "Paragraph", start_index: 0, end_index: 2, text_preview: "正文" }, node],
    };
    return { idx: 0, version: 0 };
  }, "model", { kind: "doc-text", ranges: [{ begin: 0, end: 1 }] });
  const empty = { type: "Paragraph", start_index: 3, end_index: 3 };
  expect((await read(empty)).state.nodes).toEqual([
    { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "正文" },
    { ...empty, text_preview: "" },
  ]);
  for (const invalid of [
    { ...empty, end_index: 5 }, { ...empty, text_preview: null },
    { ...empty, type: "Table" }, { ...empty, end_index: 5, text_preview: "短" },
  ]) await expect(read(invalid)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("PPT 全选末段可继承段尾格式，局部选字不能连带改变段尾", () => {
  const before = { stamp: "", state: { kind: "slide", revision: 0, pageIds: ["page"], page: { version: 0, shapes: [] },
    texts: [{ shapeId: "shape", text: "正文\r", characters: [{ bold: false }, { bold: false }, { bold: false }] }] } };
  const after = structuredClone(before);
  after.state.revision = 1;
  after.state.texts[0].characters.forEach((char) => { char.bold = true; });
  const locator = { kind: "slide-text" as const, pageIndex: 0, shapeId: "shape", start: 0, count: 2 };
  const args = { shape_id: "shape", index: 0, count: 2, bold: true };
  expect(() => verifyOfficeSelectionEdit(before, after, locator, "slide_set_text_property", args)).not.toThrow();
  after.state.texts[0].characters[0].bold = false;
  expect(() => verifyOfficeSelectionEdit(before, after, { ...locator, start: 1, count: 1 }, "slide_set_text_property", { ...args, index: 1, count: 1 })).toThrow("尚未确认");
});

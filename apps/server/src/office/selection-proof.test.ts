import { expect, test } from "bun:test";
import { officeDocRangeParts, readOfficeSelectionProof, verifyOfficeSelectionEdit } from "./selection-proof.js";
import { OfficeSelectionEdits } from "./selection-edits.js";
import type { OfficeDocumentSession } from "@jugglework/types/office";

test("PPT 多页选择明确拒绝，不误报正文过长也不读取或扩大到多页形状", async () => {
  await expect(readOfficeSelectionProof(async () => { throw new Error("多页拒绝不应读取模型"); }, "model", { kind: "slide-pages", pageIndices: [0, 1] }))
    .rejects.toMatchObject({ code: "office_selection_slide_pages_unsupported" });
});

test("PPT 图片选择准确提示缩略图入口，不将图片扩大为整页引用或读取其文字", async () => {
  const calls: string[] = [];
  const tool = async (name: string) => {
    calls.push(name);
    if (name === "slide_get_info") return { version: 0, slide_ids: ["page"], slide_count: 1 };
    if (name === "slide_get_page_info") return { version: 0, page_id: "page", shape_count: 2,
      shapes: [{ id: "image", type: "picture" }, { id: "text", type: "shape", text: "正文" }] };
    throw new Error("不得读取图片文字或写入");
  };
  for (const shapeIds of [["image"], ["image", "text"]]) {
    calls.length = 0;
    await expect(readOfficeSelectionProof(tool, "model", { kind: "slide-shapes", pageIndex: 0, shapeIds }))
      .rejects.toMatchObject({ code: "office_selection_slide_picture_selected" });
    expect(calls).toEqual(["slide_get_info", "slide_get_page_info"]);
  }
  await expect(readOfficeSelectionProof(tool, "model", { kind: "slide-shapes", pageIndex: 0, shapeIds: ["image", "missing"] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("PPT 形状清单与文字 runs 必须完整且无重叠，不能用首个 run 掩盖其他格式", async () => {
  const read = (alter: (name: string, result: Record<string, unknown>) => Record<string, unknown> = (_name, result) => result) => readOfficeSelectionProof(async (name) => {
    const results: Record<string, Record<string, unknown>> = {
      slide_get_info: { version: 1, slide_ids: ["page"], slide_count: 1 },
      slide_get_page_info: { version: 1, page_id: "page", shape_count: 2, shapes: [{ id: "text", type: "shape", text: "正文" }, { id: "image", type: "image" }] },
      slide_get_text: { version: 1, text: "正文", length: 2, runs: [{ start: 0, end: 2, bold: false }] },
    };
    return alter(name, results[name]);
  }, "model", { kind: "slide-text", pageIndex: 0, shapeId: "text", start: 0, count: 1 });
  expect((await read()).state.kind).toBe("slide");
  for (const runs of [[{ start: 0, end: 2 }, { start: 1, end: 2 }], [{ start: 1, end: 2 }], [{ start: 0, end: 3 }]])
    await expect(read((name, result) => name === "slide_get_text" ? { ...result, runs } : result)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  await expect(read((name, result) => name === "slide_get_page_info" ? { ...result, shape_count: 3 } : result)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  await expect(read((name, result) => name === "slide_get_page_info" ? { ...result, shapes: [{ id: "text", type: "shape", text: "正文" }, { id: "text", type: "image" }] } : result)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

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

test("Word 所选空段落可省略预览，所选非空或未知内容不能被补成空串", async () => {
  const read = (node: Record<string, unknown>) => readOfficeSelectionProof(async (name) => {
    if (name === "doc_get_last_operable_pos") return { position: node.end_index, version: 0 };
    if (name === "doc_resolve_document_structure") return {
      version: 0, pagination: { has_more: false, total_nodes: 2 },
      nodes: [{ type: "Paragraph", start_index: 0, end_index: 2, text_preview: "正文" }, node],
    };
    return { idx: 0, version: 0 };
  }, "model", { kind: "doc-caret", idx: 3 });
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

type DocNode = Record<string, unknown> & { type: string; start_index: number; end_index: number };

test("Word 完整结构必须从0连续覆盖last，首尾缺失、中间缺口、重叠和乱序均拒绝", async () => {
  const body = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const tail = { type: "Paragraph", start_index: 3, end_index: 5, text_preview: "尾段" };
  for (const nodes of [[], [tail], [body], [body, { ...tail, start_index: 4 }],
    [body, { ...tail, start_index: 2 }], [tail, body]]) {
    await expect(readOfficeSelectionProof(async (name) => {
      if (name === "doc_get_last_operable_pos") return { position: 5, version: 7 };
      if (name === "doc_resolve_document_structure") return { version: 7, nodes, pagination: { has_more: false, total_nodes: nodes.length } };
      throw new Error("无效结构不得继续读取");
    }, "model", { kind: "doc-caret", idx: 1 })).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
});

test("Word 未选分页完整证明后可保留和移位，选中或未知分页内容拒绝", async () => {
  for (const type of ["PageBreak", "Paragraph"]) {
    const body = { type: "Paragraph", start_index: 0, end_index: 4, text_preview: "前选中后" };
    const page: DocNode = { type, start_index: 5, end_index: 6, paragraph_index: 2 };
    const tail = { type: "Paragraph", start_index: 7, end_index: 9, text_preview: "尾段" };
    const read = (idx = 1, change: Record<string, unknown> = {}, detailChange: Record<string, unknown> = {}, preceding = "前选中后[line_break][page_break][line_break]尾段") =>
      readOfficeSelectionProof(async (name, args) => {
        if (name === "doc_get_last_operable_pos") return { position: 9, version: 7, preceding_text: preceding };
        if (name === "doc_resolve_document_structure") return { version: 7,
          nodes: args.idx === 5 ? [{ ...page, ...change, ...detailChange }] : [body, { ...page, ...change }, tail],
          pagination: { has_more: false, total_nodes: 3 } };
        return { idx: args.idx, version: 7 };
      }, "model", { kind: "doc-caret", idx });
    const before = await read();
    const after = structuredClone(before);
    after.state.revision = 8; after.state.last = 10;
    const nodes = after.state.nodes as DocNode[];
    nodes[0].text_preview = "前新正文后"; nodes[0].end_index++;
    for (const node of nodes.slice(1)) { node.start_index++; node.end_index++; }
    after.state.properties = [0, 1, 2, 3, 4].map((idx) => ({ idx }));
    const locator = { kind: "doc-text" as const, ranges: [{ begin: 1, end: 3 }] };
    const verify = () => verifyOfficeSelectionEdit(before, after, locator, "doc_replace_text", { ranges: locator.ranges, text: "新正文" });
    expect(verify).not.toThrow();
    nodes[1].content = { type: "ChangedBreak" };
    expect(verify).toThrow("尚未确认");
    await expect(read(5)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
    for (const change of [...(type === "PageBreak" ? [{ text_preview: "隐" }] : []), { children: [] }, { end_index: 5 }])
      await expect(read(1, change)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
    await expect(read(1, {}, { paragraph_id: "changed" })).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
    if (type === "Paragraph") await expect(read(1, {}, {}, "前选中后[line_break]隐[line_break]尾段"))
      .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
});

/** 模拟原生 UTF-8 预览截断及 doc_find 的前后 30 字上下文，正文补全独立于属性读取。 */
function docProofFixture(nodes: DocNode[], selected: DocNode, text: string,
  exactMatch: Record<string, unknown> = {}, otherTexts: Record<string, string> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    calls.push({ name, args });
    if (name === "doc_get_last_operable_pos") return { position: nodes.at(-1)!.end_index, version: 7 };
    if (name === "doc_resolve_document_structure") return {
      version: 7, pagination: { has_more: false, total_nodes: nodes.length }, nodes: structuredClone(nodes),
    };
    if (name === "doc_find") {
      const prefix = String(args.text);
      const node = nodes.find((node) => (node === selected ? text : otherTexts[String(node.paragraph_id)])?.startsWith(prefix));
      if (!prefix || !node) throw new Error(`无对应完整段落：${prefix}`);
      const content = node === selected ? text : otherTexts[String(node.paragraph_id)];
      return { version: 7, total: 1, locations: [{
        begin: node.start_index, end: node.start_index + prefix.length, paragraph_id: node.paragraph_id,
        related_text: `[${prefix}]${content.slice(prefix.length, prefix.length + 30)}`,
        ...(node === selected && prefix === text ? exactMatch : {}),
      }] };
    }
    if (name === "doc_get_paragraph_property" || name === "doc_get_text_property") return { idx: args.idx, version: 7 };
    throw new Error(`未预期的工具：${name}`);
  };
  return { calls, call };
}

test("Word 普通正文补全未选长段内容，属性只读取所选段，未适配结构拒绝", async () => {
  const selected = { type: "Paragraph", paragraph_id: "body", start_index: 0, end_index: 4, text_preview: "前选中后" };
  const nodes = [selected,
    { type: "Paragraph", paragraph_id: "unselected-long", start_index: 5, end_index: 505, text_preview: "未选长段预览" },
  ];
  const long = "未选长段预览" + "甲".repeat(494);
  const { call, calls } = docProofFixture(nodes, selected, "前选中后", {}, { "unselected-long": long });
  const proof = await readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] });
  expect(officeDocRangeParts(proof.state, { begin: 1, end: 3 }).map((part) => part.text)).toEqual(["选中"]);
  expect(calls.filter(({ name }) => name === "doc_get_text_property").map(({ args }) => args.idx)).toEqual([0, 1, 2, 3]);
  expect(calls.filter(({ name }) => name === "doc_get_paragraph_property").map(({ args }) => args.idx)).toEqual([0]);
  expect(calls.some(({ name, args }) => name === "doc_resolve_document_structure" && args.mode === "compact")).toBe(true);
  expect((proof.state.nodes as DocNode[])[1].text_preview).toBe(long);
  nodes[1].type = "PageBreak";
  await expect(readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("Word 所选158字中文与未选500字正文均完整补全，未选段不占属性预算", async () => {
  const text = "所选正文" + "甲".repeat(150) + "末尾保留";
  expect(text).toHaveLength(158);
  expect(Buffer.byteLength(text)).toBeGreaterThan(200);
  const selected = { type: "Paragraph", paragraph_id: "selected-long", start_index: 0, end_index: text.length, text_preview: text.slice(0, 66) };
  const nodes = [selected, { type: "Paragraph", paragraph_id: "unselected-long", start_index: 159, end_index: 659, text_preview: "无关长段" }];
  const unrelated = "无关长段" + "乙".repeat(496);
  const { call, calls } = docProofFixture(nodes, selected, text, {}, { "unselected-long": unrelated });
  const proof = await readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 2, end: 4 }] });
  expect((proof.state.nodes as DocNode[]).find((node) => node.paragraph_id === selected.paragraph_id)?.text_preview).toBe(text);
  expect(officeDocRangeParts(proof.state, { begin: 2, end: 4 }).map((part) => part.text)).toEqual(["正文"]);
  const finds = calls.filter(({ name }) => name === "doc_find");
  expect(finds.length).toBeGreaterThan(1);
  expect(finds.some(({ args }) => args.text === text)).toBe(true);
  expect(finds.at(-1)?.args.text).toBe(unrelated);
  expect((proof.state.nodes as DocNode[])[1].text_preview).toBe(unrelated);
  expect(calls.filter(({ name }) => name === "doc_get_text_property")).toHaveLength(158);
});

for (const mismatch of [
  { begin: 1 }, { end: 157 }, { paragraph_id: "other-paragraph" }, { table_id: "table" },
]) test(`Word 补全文字后拒绝最终查找位置或段落身份不一致 ${JSON.stringify(mismatch)}`, async () => {
  const text = "所选正文" + "甲".repeat(150) + "末尾保留";
  const selected = { type: "Paragraph", paragraph_id: "selected", start_index: 0, end_index: text.length, text_preview: text.slice(0, 66) };
  const { call, calls } = docProofFixture([selected], selected, text, mismatch);
  await expect(readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 2, end: 4 }] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(calls.some(({ name, args }) => name === "doc_find" && args.text === text)).toBe(true);
});

test("Word 补全文字后最终查找版本必须仍与结构版本一致", async () => {
  const text = "所选正文" + "甲".repeat(150) + "末尾保留";
  const selected = { type: "Paragraph", paragraph_id: "selected", start_index: 0, end_index: text.length, text_preview: text.slice(0, 66) };
  const fixture = docProofFixture([selected], selected, text);
  await expect(readOfficeSelectionProof(async (name, args) => {
    const result = await fixture.call(name, args);
    return name === "doc_find" && args.text === text ? { ...result, version: 8 } : result;
  }, "model", { kind: "doc-text", ranges: [{ begin: 2, end: 4 }] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(fixture.calls.some(({ name, args }) => name === "doc_find" && args.text === text)).toBe(true);
});

test("Word 首段无 paragraph_id 仍须同版本固定坐标最终全文匹配，有身份时不能忽略", async () => {
  const text = "真实首段" + "甲".repeat(150) + "尾字";
  const selected = { type: "Paragraph", start_index: 0, end_index: text.length, text_preview: text.slice(0, 66) };
  const { call, calls } = docProofFixture([selected], selected, text, { paragraph_id: "native-optional" });
  const proof = await readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] });
  expect((proof.state.nodes as DocNode[])[0].text_preview).toBe(text);
  expect(calls.at(-1)?.name).toBe("doc_get_last_operable_pos");
  expect(calls.some(({ name, args }) => name === "doc_find" && args.text === text)).toBe(true);
  for (const mismatch of [{ begin: 1 }, { end: text.length - 1 }, { table_id: "table" }]) {
    const invalid = docProofFixture([selected], selected, text, mismatch);
    await expect(readOfficeSelectionProof(invalid.call, "model", { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] }))
      .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  }
});

test("Word 未选表格读取完整cells及相对结构，缺格、截断、复杂结构或版本不符拒绝", async () => {
  const text = "表格正文" + "甲".repeat(300) + "尾字";
  const start = 3, end = start + 4 + text.length;
  const body = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const table = { type: "Table", start_index: start, end_index: end, table_start: start, table_end: end, row_count: 1, col_count: 1, table_id: "table" };
  const full = { ...table, table_rows: [{ row: 1, cells: [{ row: 1, col: 1, start_index: start + 1, end_index: start + 1 + text.length, text_preview: text.slice(0, 10) }] }] };
  const info = { version: 7, block: { type: "table", id: "table", idx: start, end_idx: end + 1,
    table: { row_count: 1, col_count: 1, cells: [{ row: 1, col: 1, text, is_merge_continue: false }] } }, table_start_index: start, table_end_index: end + 1, resolved_idx: start };
  const fixture = docProofFixture([body, table], body, "选中");
  const read = (mutate: (value: typeof info) => void = () => {}, mutateStructure: (value: typeof full) => void = () => {},
    mutateProperty: (name: string, value: Record<string, unknown>) => void = () => {}) => readOfficeSelectionProof(async (name, args) => {
    if (name === "doc_resolve_document_structure" && args.idx === start) {
      const value = structuredClone(full); mutateStructure(value); return { version: 7, nodes: [value] };
    }
    if (name === "doc_get_table_info") { const value = structuredClone(info); mutate(value); return value; }
    const value = await fixture.call(name, args);
    if (name === "doc_get_text_property" || name === "doc_get_paragraph_property") mutateProperty(name, value);
    return value;
  }, "model", { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] });
  const proof = await read();
  const content = (proof.state.nodes as Array<Record<string, any>>)[1].content;
  expect(content.block.table.cells[0].text).toBe(text);
  expect(content.block.idx).toBe(0);
  expect(content.structure.table_rows[0].cells[0].start_index).toBe(1);
  for (const mutate of [
    (value: typeof info) => { value.block.table.cells = []; },
    (value: typeof info) => { value.block.table.cells[0].text = text.slice(0, 200); },
    (value: typeof info) => { value.block.table.cells[0].text += "隐藏段落"; },
    (value: typeof info) => { value.block.table.cells[0].col = 2; },
    (value: typeof info) => { value.block.table.cells[0].is_merge_continue = true; },
    (value: typeof info) => { value.block.table.cells[0].text = text.slice(0, -1) + "\r"; },
    (value: typeof info) => { value.block.table.cells[0].text = text.slice(0, -1) + "\uFFFC"; },
    (value: typeof info) => { value.block.end_idx++; },
    (value: typeof info) => { value.version++; },
  ]) await expect(read(mutate)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  for (const mutate of [
    (value: typeof full) => { value.table_rows[0].cells[0].text_preview = "不符预览"; },
    (value: typeof full) => { Object.assign(value.table_rows[0].cells[0], { children: [] }); },
    (value: typeof full) => { value.table_rows[0].cells[0].start_index++; },
  ]) await expect(read(() => {}, mutate)).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(content.properties).toHaveLength(text.length);
  expect(content.properties.at(-1).idx).toBe(text.length);
  expect(content.paragraphs).toEqual([{ idx: 1 }]);
  expect(fixture.calls.filter(({ name }) => name === "doc_get_text_property")
    .every(({ args }) => Number(args.idx) < 2 || (Number(args.idx) >= start + 1 && Number(args.idx) < start + 1 + text.length))).toBe(true);
  const ranges = [{ begin: 0, end: 2 }];
  const verify = (after: typeof proof) => verifyOfficeSelectionEdit(proof, after, { kind: "doc-text", ranges }, "doc_replace_text", { ranges, text: "选中" });
  const unchanged = await read(); unchanged.state.revision = 8;
  expect(() => verify(unchanged)).not.toThrow();
  for (const tool of ["doc_get_text_property", "doc_get_paragraph_property"]) {
    const changed = await read(() => {}, () => {}, (name, value) => {
      if (name === tool && value.idx === (tool === "doc_get_text_property" ? start + text.length : start + 1))
        Object.assign(value, tool === "doc_get_text_property" ? { bold: true } : { alignment: "right" });
    });
    changed.state.revision = 8;
    expect(() => verify(changed)).toThrow("尚未确认");
  }
  await expect(read(() => {}, () => {}, (name, value) => {
    if (name === "doc_get_text_property" && value.idx === start + text.length) value.version = 8;
  })).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("Word 所有未选表格共用1024字符属性预算，第二表超限不读取其属性", async () => {
  const body = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const makeTable = (start: number, id: string) => ({ type: "Table", table_id: id, start_index: start,
    end_index: start + 604, table_start: start, table_end: start + 604, row_count: 1, col_count: 1 });
  const tables = [makeTable(3, "first"), makeTable(608, "second")];
  const reads: number[] = [];
  await expect(readOfficeSelectionProof(async (name, args) => {
    if (name === "doc_get_last_operable_pos") return { version: 7, position: tables[1].end_index };
    const table = tables.find((table) => table.start_index === args.idx);
    if (name === "doc_resolve_document_structure") return args.idx === undefined
      ? { version: 7, nodes: [body, ...tables], pagination: { has_more: false, total_nodes: 3 } }
      : { version: 7, nodes: [{ ...table!, table_rows: [{ row: 1, cells: [{ row: 1, col: 1,
        start_index: table!.start_index + 1, end_index: table!.start_index + 601, text_preview: "甲" }] }] }] };
    if (name === "doc_get_table_info") return { version: 7, resolved_idx: args.idx, table_start_index: args.idx,
      table_end_index: table!.end_index + 1, block: { type: "table", id: table!.table_id, idx: args.idx, end_idx: table!.end_index + 1,
        table: { row_count: 1, col_count: 1, cells: [{ row: 1, col: 1, text: "甲".repeat(600) }] } } };
    reads.push(Number(args.idx)); return { idx: args.idx, version: 7 };
  }, "model", { kind: "doc-caret", idx: 1 })).rejects.toThrow("表格属性超过");
  expect(reads).toHaveLength(601);
  expect(reads.every((idx) => idx >= 4 && idx < 604)).toBe(true);
});

for (const caret of [false, true]) test(`Word 全文16384预算在${caret ? "插入" : "改写"}前预检，超限零写入`, async () => {
  const nodes: DocNode[] = [{ type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" }];
  while (nodes.at(-1)!.end_index < 16384) {
    const start = nodes.at(-1)!.end_index + 1, length = Math.min(199, 16384 - start);
    nodes.push({ type: "Paragraph", start_index: start, end_index: start + length, text_preview: "甲".repeat(length) });
  }
  let writes = 0;
  const document = { documentId: "budget", pageId: "page", workspaceId: "ws", ownerSessionId: "chat",
    relativePath: "预算.docx", name: "预算.docx", state: "ready", engineFileId: "model" } as OfficeDocumentSession;
  const fixture = docProofFixture(nodes, nodes[0], "选中");
  const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
    selection: async () => ({ ranges: [{ begin: 1, end: caret ? 1 : 2, length: caret ? 0 : 1 }], selectedText: caret ? "" : "中" }),
    tool: async (name, args) => { if (["doc_insert_text", "doc_replace_text"].includes(name)) writes++; return fixture.call(name, args); },
    modified: async () => { throw new Error("不应确认修改"); }, save: async () => document });
  const ref = await edits.capture(document, "capture");
  await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId],
    officeInstructions: [{ instructionId: "i", text: "扩写", bindingState: "bound", referenceIds: [ref.referenceId] }] });
  await expect(edits.call("ws", "chat", "turn", "assistant", caret ? "doc_insert_text" : "doc_replace_text", { text: "扩写" }, ref.referenceId))
    .rejects.toThrow("16384");
  expect(writes).toBe(0);
});

test("Word 未选表格超256格在请求完整cells前拒绝", async () => {
  const body = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const table = { type: "Table", start_index: 3, end_index: 800, row_count: 257, col_count: 1 };
  const fixture = docProofFixture([body, table], body, "选中");
  await expect(readOfficeSelectionProof(fixture.call, "model", { kind: "doc-caret", idx: 1 }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(fixture.calls.filter(({ name }) => name === "doc_resolve_document_structure")).toHaveLength(1);
  expect(fixture.calls.some(({ name }) => name === "doc_get_table_info")).toBe(false);
});

test("Word 正文跨度及补全调用有界，拒绝截断查找结果，不扩大属性预算", async () => {
  const selected = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const large = { type: "Paragraph", start_index: 3, end_index: 16385, text_preview: "长段" };
  const over = docProofFixture([selected, large], selected, "选中");
  await expect(readOfficeSelectionProof(over.call, "model", { kind: "doc-caret", idx: 1 }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(over.calls).toHaveLength(1);
  const text = "甲".repeat(5000);
  const node = { type: "Paragraph", start_index: 0, end_index: text.length, text_preview: text.slice(0, 66) };
  const fixture = docProofFixture([selected, { ...node, start_index: 3, end_index: 5003, paragraph_id: "long" }], selected, "选中", {}, { long: text });
  await expect(readOfficeSelectionProof(fixture.call, "model", { kind: "doc-caret", idx: 1 }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(fixture.calls.filter(({ name }) => name === "doc_find")).toHaveLength(128);
  expect(fixture.calls.some(({ name }) => name === "doc_get_text_property")).toBe(false);
  const truncated = docProofFixture([node], node, text);
  await expect(readOfficeSelectionProof(async (name, args) => {
    const result = await truncated.call(name, args);
    return name === "doc_find" ? { ...result, total: 2 } : result;
  }, "model", { kind: "doc-caret", idx: 1 })).rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("Word 全文补全512次总预算独立于每段128次预算", async () => {
  const selected = { type: "Paragraph", start_index: 0, end_index: 2, text_preview: "选中" };
  const otherTexts: Record<string, string> = {};
  const nodes: DocNode[] = [selected];
  for (let i = 0; i < 5; i++) {
    const text = `${i}` + "甲".repeat(3099), start = nodes.at(-1)!.end_index + 1;
    otherTexts[`long-${i}`] = text;
    nodes.push({ type: "Paragraph", paragraph_id: `long-${i}`, start_index: start, end_index: start + text.length, text_preview: text.slice(0, 1) });
  }
  const fixture = docProofFixture(nodes, selected, "选中", {}, otherTexts);
  await expect(readOfficeSelectionProof(fixture.call, "model", { kind: "doc-caret", idx: 1 }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
  expect(fixture.calls.filter(({ name }) => name === "doc_find")).toHaveLength(512);
  expect(fixture.calls.some(({ name }) => name === "doc_get_text_property")).toBe(false);
});

for (const type of ["Table", "PageBreak"]) test(`Word 所选 ${type} 即使预览长度吻合仍拒绝`, async () => {
  const selected = { type, start_index: 0, end_index: 2, text_preview: "选中" };
  const { call } = docProofFixture([selected], selected, "选中");
  await expect(readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 0, end: 1 }] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("Word 仅选少数字符仍不能绕过所选段落 256 字符属性预算", async () => {
  const text = "a".repeat(257);
  const selected = { type: "Paragraph", paragraph_id: "over-budget", start_index: 0, end_index: text.length, text_preview: text.slice(0, 200) };
  const { call } = docProofFixture([selected], selected, text);
  await expect(readOfficeSelectionProof(call, "model", { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] }))
    .rejects.toMatchObject({ code: "office_selection_proof_unavailable" });
});

test("Word 普通正文改写回读保留未选表格完整内容和长段，前段移位不误判", () => {
  const nodes = [
    { type: "Paragraph", paragraph_id: "body", start_index: 0, end_index: 4, text_preview: "前选中后" },
    { type: "Table", table_id: "table", start_index: 5, end_index: 11, table_start: 5, table_end: 11,
      content: { cells: [{ row: 1, col: 1, text: "表格保留" }], start: 0, end: 7 } },
    { type: "Paragraph", paragraph_id: "long", start_index: 12, end_index: 512, text_preview: "未选长段" + "甲".repeat(494) + "尾字" },
  ];
  const before = { stamp: "", state: { kind: "doc", revision: 7, last: 512, nodes,
    paragraphs: [{ idx: 0 }], properties: [0, 1, 2, 3].map((idx) => ({ idx, bold: false })) } };
  const after = structuredClone(before);
  after.state.revision++;
  after.state.last++;
  after.state.nodes[0].text_preview = "前新正文后";
  after.state.nodes[0].end_index++;
  for (const node of after.state.nodes.slice(1)) {
    node.start_index++;
    node.end_index++;
    if (node.table_start !== undefined) node.table_start++;
    if (node.table_end !== undefined) node.table_end++;
  }
  after.state.properties = [0, 1, 2, 3, 4].map((idx) => ({ idx, bold: false }));
  const locator = { kind: "doc-text" as const, ranges: [{ begin: 1, end: 3 }] };
  const verify = () => verifyOfficeSelectionEdit(before, after, locator, "doc_replace_text", { ranges: locator.ranges, text: "新正文" });
  expect(verify).not.toThrow();
  after.state.nodes[2].text_preview = after.state.nodes[2].text_preview!.slice(0, -1) + "错";
  expect(verify).toThrow("尚未确认");
  after.state.nodes[2].text_preview = nodes[2].text_preview;
  after.state.nodes[1].content!.cells[0].text = "表格误改";
  expect(verify).toThrow("尚未确认");
  after.state.nodes[1].content!.cells[0].text = "表格保留";
  after.state.nodes[1].table_id = "different-table";
  expect(verify).toThrow("尚未确认");
});

test("Word 删除所选唯一高亮文字允许段落派生高亮摘要消失", () => {
  const before = { stamp: "", state: { kind: "doc", revision: 1, last: 4,
    nodes: [{ type: "Paragraph", start_index: 0, end_index: 4, text_preview: "前选中后", has_highlights: true }],
    paragraphs: [{ idx: 0 }], properties: [0, 1, 2, 3].map((idx) => ({ idx, bold: false })) } };
  const after = { stamp: "", state: { kind: "doc", revision: 2, last: 2,
    nodes: [{ type: "Paragraph", start_index: 0, end_index: 2, text_preview: "前后" }],
    paragraphs: [{ idx: 0 }], properties: [0, 1].map((idx) => ({ idx, bold: false })) } };
  const ranges = [{ begin: 1, end: 3 }];
  expect(() => verifyOfficeSelectionEdit(before, after, { kind: "doc-text", ranges }, "doc_replace_text", { ranges, text: "" })).not.toThrow();
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

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfficeDocumentSession, OfficeSelectionLocator } from "@jugglework/types/office";
import { OfficeEngine } from "./engine.js";
import { parseOfficeSelection } from "./selection.js";
import { planOfficeSelectionTool } from "./selection-tools.js";
import { officeDocRangeParts, readOfficeSelectionProof, verifyOfficeSelectionEdit } from "./selection-proof.js";
import { OfficeSelectionEdits } from "./selection-edits.js";

const nativeTest = process.env.JUGGLEWORK_TEST_OFFICE_NATIVE === "1" ? test : test.skip;

nativeTest("真实 SDK 规范化小写函数名后可确认选区修改并保存重开，未选单元格保留", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    for (const row of [0, 1]) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row, col: 0, value_type: "NUMBER", number_value: row + 1 } });
    const document = { documentId: "formula-case", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "公式.xlsx", name: "公式.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 1, endColIndex: 1 }] }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "formula-case-capture");
    await edits.prepareTurn("ws", "chat", "formula-case-turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "B1 填入求和公式", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "formula-case-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 1, value_type: "FORMULA", formula: "=sum(A1:A2)" } }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    await edits.save("ws", "chat", "formula-case-turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const cells = (await engine.tool("sheet_get_cell_data", { file_id: reopened, sheet_id: sheetId, start_row: 0, end_row: 1, start_col: 0, end_col: 1, return_csv: false, include_formula: true })).cells as Array<{ row: number; col: number; number_value?: number; formula?: string }>;
    expect(cells.find((cell) => cell.row === 0 && cell.col === 1)).toMatchObject({ number_value: 3, formula: "=SUM(A1:A2)" });
    expect(cells.filter((cell) => cell.col === 0).map((cell) => cell.number_value)).toEqual([1, 2]);
  });
}, 30_000);

nativeTest("真实 SDK 三格式选区颜色、字号、斜体按生效值回读", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前选中后" });
    const locator: OfficeSelectionLocator = { kind: "doc-text", ranges: [{ begin: 1, end: 3 }] };
    await call(engine, fileId, locator, "doc_update_text_property", { color: "FF0000", font_size: 18, italic: true });
  });
  await withModel("slide", async (engine, fileId) => {
    await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x: 20, y: 20, w: 200, h: 80, text: "前选中后" });
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapeId = (page.shapes as Array<{ id: string }>)[0].id;
    const locator: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 0, shapeId, start: 1, count: 2 };
    await call(engine, fileId, locator, "slide_set_text_property", { color: "FF0000", font_size: 18, italic: true });
    await call(engine, fileId, { ...locator, start: 0, count: 4 }, "slide_set_text_property", { bold: true });
  });
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await call(engine, fileId, { kind: "sheet-cells", sheetId, ranges: [{ startRow: 0, endRow: 0, startCol: 0, endCol: 0 }] }, "sheet_set_cell_style", { format: { bold: true, italic: true, font_size: 18, font_color: "FFFF0000", background_color: "FF00FF00", wrap_text: true, horizontal_align: "center" } });
  });
}, 30_000);

nativeTest("真实 SDK 合并区保持拓扑，普通单元格编辑不受无关标题合并区影响", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_merge_cell", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 1 });
    const merges = await engine.tool("sheet_get_merged_cells", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 3, start_col: 0, end_col: 3 });
    const locator: OfficeSelectionLocator = { kind: "sheet-cells", sheetId, ranges: [{ startRow: 2, endRow: 2, startCol: 0, endCol: 0 }] };
    await call(engine, fileId, locator, "sheet_set_cell_value", { cell: { row: 2, col: 0, value_type: "STRING", string_value: "正文" } });
    expect(await engine.tool("sheet_get_merged_cells", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 3, start_col: 0, end_col: 3 })).toEqual(merges);
  });
}, 30_000);

nativeTest("真实 SDK 拒绝半个合并区和非锚点写入，不把含公式工作簿的空格样式实体化", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_merge_cell", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 1 });
    let endCol = 0, writes = 0;
    const document = { documentId: "merge", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "合并.xlsx", name: "合并.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 0, endColIndex: endCol }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_value") writes++; return engine.tool(name, args); }, modified: async () => {}, save: async () => document });
    await expect(edits.capture(document, "partial")).rejects.toThrow("完整合并单元格");
    endCol = 1;
    const ref = await edits.capture(document, "whole");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改为标题", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 1, value_type: "STRING", string_value: "错误" } }, ref.referenceId)).rejects.toThrow("左上角");
    expect(writes).toBe(0);
    expect((await edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 0, value_type: "STRING", string_value: "标题" } }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    expect(writes).toBe(1);
  });
  await withModel("sheet", async (engine, fileId) => {
    const sheetId = ((await engine.tool("sheet_get_sheet_info", { file_id: fileId })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col: 0, value_type: "FORMULA", formula: "=COUNTA(B1)" } });
    let writes = 0;
    const document = { documentId: "formula", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "公式.xlsx", name: "公式.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 1, endColIndex: 1 }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_style") writes++; return engine.tool(name, args); }, modified: async () => {}, save: async () => document });
    const ref = await edits.capture(document, "blank");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "空格加粗", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_set_cell_style", { format: { bold: true } }, ref.referenceId)).rejects.toThrow("空白单元格");
    expect(writes).toBe(0);
  });
}, 30_000);

for (const axis of ["row", "col"] as const) nativeTest(`真实 SDK 完整${axis === "row" ? "行" : "列"}删除回读全部单元格和样式，保存后旧坐标失效`, async () => {
  await withModel("sheet", async (engine, fileId) => {
    const before = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheet = (before.sheets as Array<{ sheet_id: string; row_count: number; col_count: number }>)[0];
    for (let row = 0; row < 3; row++) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheet.sheet_id, cell: { row: axis === "row" ? row : 0, col: axis === "row" ? 0 : row, value_type: "NUMBER", number_value: row + 1 } });
    const document = { documentId: "dimension", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "数据.xlsx", name: "数据.xlsx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId: sheet.sheet_id, selectionKind: axis === "row" ? "rows" : "columns", ranges: [{ sheetId: sheet.sheet_id, startRowIndex: 0, endRowIndex: axis === "row" ? 0 : sheet.row_count - 1, startColIndex: 0, endColIndex: axis === "row" ? sheet.col_count - 1 : 0 }] }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "dimension-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "dimension-request", text: "删除选择的维度", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "turn", "assistant", "sheet_delete_dimension", {}, ref.referenceId))?.receipt?.requiresReselection).toBe(true);
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await expect(edits.call("ws", "chat", "turn", "assistant", "sheet_delete_dimension", {}, ref.referenceId)).rejects.toThrow("坐标");
    const after = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    expect((after.sheets as typeof before.sheets as Array<Record<string, number>>)[0][axis === "row" ? "row_count" : "col_count"]).toBe(sheet[axis === "row" ? "row_count" : "col_count"] - 1);
    const values = await engine.tool("sheet_get_cell_data", { file_id: fileId, sheet_id: sheet.sheet_id, start_row: 0, end_row: axis === "row" ? 3 : 0, start_col: 0, end_col: axis === "row" ? 0 : 3, return_csv: false });
    expect((values.cells as Array<{ number_value: number }>).map((cell) => cell.number_value)).toEqual([2, 3]);
  });
}, 30_000);

/** 测试只创建隔离模板副本；产品不新增 Agent 创建文档能力。 */
async function withModel(
  kind: "doc" | "sheet" | "slide",
  verify: (engine: OfficeEngine, fileId: string, path: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-selection-native-"));
  const engine = new OfficeEngine({ logDirectory: join(root, "logs") });
  let path: string | undefined;
  try {
    const created = await engine.tool(`create_${kind}`, {});
    if (typeof created.file_path !== "string" || typeof created.file_id !== "string")
      throw new Error("隔离模板缺少模型身份或原路径");
    path = created.file_path;
    const fileId = created.file_id;
    const query = { doc: "doc_get_last_operable_pos", sheet: "sheet_get_sheet_info", slide: "slide_get_info" }[kind];
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const info = await engine.tool(query, { file_id: fileId });
        if (kind !== "slide" || info.is_open === true) break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
      }
      if (Date.now() >= deadline) throw new Error("隔离模型未就绪");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await verify(engine, fileId, path);
  } finally {
    // 仅处置本测试实例。先退出原生进程，再移除其模板及日志，不触及桌面正在编辑的文件。
    await engine.dispose();
    if (path) await rm(path, { force: true });
    await rm(root, { recursive: true, force: true });
  }
}

/** 用生产范围解析生成 SDK 参数；此用例核对映射，不代表浮层、消息归属或内容基线已接入。 */
async function call(
  engine: OfficeEngine,
  fileId: string,
  locator: OfficeSelectionLocator,
  name: string,
  input: Record<string, unknown>,
) {
  const plan = planOfficeSelectionTool(locator, fileId, name, input);
  const query = engine.tool.bind(engine);
  const before = await readOfficeSelectionProof(query, fileId, locator);
  const output = await engine.tool(name, plan.args);
  const after = await readOfficeSelectionProof(query, fileId, locator);
  verifyOfficeSelectionEdit(before, after, locator, name, plan.args);
  return output;
}

nativeTest("真实 SDK 按第二处 Word 原生范围替换，保存重开后第一处同文案保留", async () => {
  await withModel("doc", async (engine, fileId, path) => {
    const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
    await engine.tool("doc_insert_text", { file_id: fileId, idx: end.position, text: "同文案 间隔 同文案" });
    const found = await engine.tool("doc_find", { file_id: fileId, text: "同文案" });
    const matches = (found.locations as Array<{ begin: number; end: number }>).map(({ begin, end }) => ({ begin, end })).sort((a, b) => a.begin - b.begin);
    expect(matches).toHaveLength(2);
    const selected = matches[1];
    const locator = parseOfficeSelection("doc", {
      ranges: [{ ...selected, length: selected.end - selected.begin }], selectedText: "同文案",
    })!.locator!;
    await call(engine, fileId, locator, "doc_replace_text", { text: "新标题" });
    const unchanged = await engine.tool("doc_find", { file_id: fileId, text: "同文案" });
    expect((unchanged.locations as Array<{ begin: number; end: number }>).map(({ begin, end }) => ({ begin, end }))).toEqual([matches[0]]);
    const updated = await engine.tool("doc_find", { file_id: fileId, text: "新标题" });
    expect(updated.total).toBe(1);
    expect((updated.locations as Array<{ begin: number }>)[0].begin).toBe(selected.begin);
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    expect((await engine.tool("doc_find", { file_id: reopened, text: "同文案" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: reopened, text: "新标题" })).total).toBe(1);
  });
}, 30_000);

nativeTest("真实 SDK 含空段落的 Word 可以采集及定点改写，空段落和其他文字保留", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "选区正文" });
    for (const text of ["", "保留尾段"]) {
      const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: end.position, text, type: 0 });
    }
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "full", text_preview_length: 200 });
    expect((structure.nodes as Array<Record<string, unknown>>).some((node) => node.start_index === node.end_index && node.text_preview === undefined)).toBe(true);
    const document = { documentId: "empty-paragraph", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "正文.docx", name: "正文.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin: 0, end: 2, length: 2 }], selectedText: "选区" }),
      tool: engine.tool.bind(engine), modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "empty-paragraph-capture");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改成修改", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "修改" }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    await edits.save("ws", "chat", "turn", ref.referenceId);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "修改正文" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "保留尾段" })).total).toBe(1);
  });
}, 30_000);

for (const fillEmpty of [false, true]) nativeTest(`真实 Word 跨段改写${fillEmpty ? "填入空段" : "保留空段"}和 emoji，保存重开保留首尾文字及段落属性`, async () => {
  await withModel("doc", async (engine, fileId, path) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "前缀甲😀" });
    for (const text of ["", "", "乙丙后缀", "未选末段"]) {
      const end = await engine.tool("doc_get_last_operable_pos", { file_id: fileId });
      await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: end.position, text, paragraph_property: { spacing_after: 8 } });
    }
    const structure = await engine.tool("doc_resolve_document_structure", { file_id: fileId, mode: "full", text_preview_length: 200 });
    const nodes = structure.nodes as Array<{ start_index: number; end_index: number; text_preview?: string }>;
    const target = nodes.find((node) => node.text_preview === "乙丙后缀")!;
    const locator = { kind: "doc-text" as const, ranges: [{ begin: 2, end: target.start_index + 2 }] };
    const selectedText = officeDocRangeParts({ nodes: nodes.map((node) => ({ ...node, text_preview: node.text_preview ?? "" })) }, locator.ranges[0]).map((part) => part.text).join("\r");
    expect(selectedText).toBe("甲😀\r\r乙丙");
    await engine.tool("doc_update_text_property", { file_id: fileId, ranges: [{ begin: 0, end: 2 }], color: "FF0000", bold: true });
    await engine.tool("doc_update_text_property", { file_id: fileId, ranges: [{ begin: target.start_index + 2, end: target.end_index }], italic: true });
    let writes = 0;
    const document = { documentId: "cross", pageId: "page", artifactId: "fixture", workspaceId: "ws", ownerSessionId: "chat", relativePath: "跨段.docx", name: "跨段.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ ...locator.ranges[0], length: locator.ranges[0].end - 2 }], selectedText }),
      tool: async (name, args) => { if (["doc_replace_text", "doc_insert_text", "doc_update_text_property"].includes(name)) writes++; return engine.tool(name, args); },
      modified: async () => {}, save: async () => { await engine.save(fileId); return document; } });
    const ref = await edits.capture(document, "cross");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "按段润色并加粗", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    expect(edits.context("ws", "chat", "turn").contents[0].ranges[0].paragraphs).toEqual(["甲😀", "", "乙丙"]);
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_update_text_property", { bold: true }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    const styleWrites = writes;
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "不能合成一段" }, ref.referenceId)).rejects.toThrow("相同段数");
    expect(writes).toBe(styleWrites);
    expect((await edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: `改写😀\r\n${fillEmpty ? "中段" : ""}\r\n新尾` }, ref.referenceId))?.receipt?.readback).toBe("confirmed");
    expect(writes).toBe(styleWrites + (fillEmpty ? 3 : 2));
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "重试" }, ref.referenceId)).rejects.toThrow("重新选择");
    await edits.save("ws", "chat", "turn", ref.referenceId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const updated = await engine.tool("doc_resolve_document_structure", { file_id: reopened, mode: "full", text_preview_length: 200 });
    const actual = updated.nodes as typeof nodes;
    expect(actual.map((node) => node.text_preview ?? "")).toEqual(nodes.map((node, i) => i === 0 ? "前缀改写😀" : node === target ? "新尾后缀"
      : fillEmpty && node.start_index === node.end_index && node.start_index < target.start_index ? "中段" : node.text_preview ?? ""));
    expect(await engine.tool("doc_get_text_property", { file_id: reopened, idx: 0 })).toMatchObject({ bold: true, color: "FF0000" });
    const suffix = actual.find((node) => node.text_preview === "新尾后缀")!;
    expect(await engine.tool("doc_get_text_property", { file_id: reopened, idx: suffix.start_index + 2 })).toMatchObject({ italic: true });
    expect(await engine.tool("doc_get_paragraph_property", { file_id: reopened, idx: suffix.start_index })).toMatchObject({ spacing: { after_pt: 8 } });
  });
}, 30_000);

nativeTest("真实 Word 跨段改写发生部分写入后不自动重试或确认保存", async () => {
  await withModel("doc", async (engine, fileId) => {
    await engine.tool("doc_insert_text", { file_id: fileId, idx: 0, text: "第一段" });
    await engine.tool("doc_insert_paragraph_with_text", { file_id: fileId, idx: 3, text: "第二段" });
    const document = { documentId: "partial", pageId: "page", workspaceId: "ws", ownerSessionId: "chat", relativePath: "跨段.docx", name: "跨段.docx", state: "ready", engineFileId: fileId } as OfficeDocumentSession;
    let writes = 0;
    const edits = new OfficeSelectionEdits({ document: async () => document, prepare: async () => {},
      selection: async () => ({ ranges: [{ begin: 1, end: 6, length: 5 }], selectedText: "一段\r第二" }),
      tool: async (name, args) => { if (name === "doc_replace_text" && ++writes === 2) throw new Error("写入响应中断"); return engine.tool(name, args); },
      modified: async () => {}, save: async () => document });
    const ref = await edits.capture(document, "partial");
    await edits.prepareTurn("ws", "chat", "turn", { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "逐段改写", bindingState: "bound", referenceIds: [ref.referenceId] }] });
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "改一\n改二" }, ref.referenceId)).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    await expect(edits.call("ws", "chat", "turn", "assistant", "doc_replace_text", { text: "改一\n改二" }, ref.referenceId)).rejects.toThrow("尚待核对");
    await expect(edits.save("ws", "chat", "turn", ref.referenceId)).rejects.toThrow("暂不能");
    expect(writes).toBe(2);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "第一段" })).total).toBe(1);
    expect((await engine.tool("doc_find", { file_id: fileId, text: "改二段" })).total).toBe(1);
  });
}, 30_000);

nativeTest("真实 SDK 的本轮引用在草稿清理后仍固定原模型，漏引用拒绝，同表两个引用连续写入及保存可确认", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    for (const col of [0, 1]) await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col, value_type: "NUMBER", number_value: col + 1 } });
    let col = 0, saves = 0, writes = 0;
    const document: OfficeDocumentSession = { documentId: "od_fixed", pageId: "page-fixed", artifactId: "artifact", workspaceId: "ws", ownerSessionId: "ses", relativePath: "固定.xlsx", name: "固定.xlsx", state: "ready", engineFileId: fileId, previewUrl: null, dirty: true, savedAt: null };
    const edits = new OfficeSelectionEdits({
      document: async () => structuredClone(document), prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: col, endColIndex: col }] }),
      tool: async (name, args) => { if (name === "sheet_set_cell_value") writes++; return engine.tool(name, args); },
      modified: async () => {}, save: async () => { saves++; await engine.save(fileId); return document; },
    });
    const a = await edits.capture(document, "capture-a"); col = 1;
    const b = await edits.capture(document, "capture-b");
    const submission = { officeSelectionRefs: [a.referenceId, b.referenceId], officeInstructions: [
      { instructionId: "i-a", text: "A1 改为 10", bindingState: "bound" as const, referenceIds: [a.referenceId] },
      { instructionId: "i-b", text: "B1 改为 20", bindingState: "bound" as const, referenceIds: [b.referenceId] },
    ] };
    await edits.prepareTurn("ws", "ses", "user-turn", submission);
    edits.release("ws", "ses", [a.referenceId, b.referenceId]);
    await expect(edits.call("ws", "ses", "user-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 999 } })).rejects.toThrow("selectionRef");
    await expect(edits.save("ws", "ses", "user-turn")).rejects.toThrow("selectionRef");
    expect(writes).toBe(0); expect(saves).toBe(0);
    for (const [ref, column, value] of [[a, 0, 10], [b, 1, 20]] as const) {
      const result = await edits.call("ws", "ses", "user-turn", "assistant", "sheet_set_cell_value", { cell: { row: 0, col: column, value_type: "NUMBER", number_value: value } }, ref.referenceId);
      expect(result?.receipt?.status).toBe("modified");
    }
    await edits.save("ws", "ses", "user-turn", a.referenceId);
    expect(writes).toBe(2); expect(saves).toBe(1);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const actualSheet = ((await engine.tool("sheet_get_sheet_info", { file_id: reopened })).sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    expect((await engine.tool("sheet_get_cell_data", { file_id: reopened, sheet_id: actualSheet, start_row: 0, end_row: 0, start_col: 0, end_col: 1, return_csv: true })).csv_data).toBe("10,20");
  });
}, 30_000);

nativeTest("真实 SDK 写入后响应丢失时不重复执行；失去选区的指令与旧内容不能接收为有效新任务", async () => {
  await withModel("sheet", async (engine, fileId) => {
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const sheetId = (info.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 1 } });
    let writes = 0;
    const document: OfficeDocumentSession = { documentId: "od_unknown", pageId: "page-unknown", artifactId: "artifact", workspaceId: "ws", ownerSessionId: "ses", relativePath: "待核对.xlsx", name: "待核对.xlsx", state: "ready", engineFileId: fileId, previewUrl: null, dirty: true, savedAt: null };
    const edits = new OfficeSelectionEdits({
      document: async () => document, prepare: async () => {},
      selection: async () => ({ sheetId, ranges: [{ sheetId, startRowIndex: 0, endRowIndex: 0, startColIndex: 0, endColIndex: 0 }] }),
      tool: async (name, args) => { const result = await engine.tool(name, args); if (name === "sheet_set_cell_value") { writes++; throw new Error("response timed out after application"); } return result; },
      modified: async () => { throw new Error("未知效果不得确认交付"); }, save: async () => { throw new Error("未知效果不得确认保存"); },
    });
    const ref = await edits.capture(document, "capture");
    await expect(edits.prepareTurn("ws", "ses", "orphan", { officeSelectionRefs: [], officeInstructions: [{ instructionId: "i", text: "删除选中内容", referenceIds: [], bindingState: "needs-selection" }] })).rejects.toThrow("重新选择");
    const submission = { officeSelectionRefs: [ref.referenceId], officeInstructions: [{ instructionId: "i", text: "改为 20", referenceIds: [ref.referenceId], bindingState: "bound" as const }] };
    await edits.prepareTurn("ws", "ses", "user", submission);
    const args = { cell: { row: 0, col: 0, value_type: "NUMBER", number_value: 20 } };
    await expect(edits.call("ws", "ses", "user", "assistant", "sheet_set_cell_value", args, ref.referenceId)).rejects.toMatchObject({ code: "office_selection_edit_unconfirmed" });
    await expect(edits.call("ws", "ses", "user", "assistant", "sheet_set_cell_value", args, ref.referenceId)).rejects.toThrow("待核对");
    await expect(edits.save("ws", "ses", "user", ref.referenceId)).rejects.toThrow("尚未确认");
    expect(writes).toBe(1);
    expect((await engine.tool("sheet_get_cell_data", { file_id: fileId, sheet_id: sheetId, start_row: 0, end_row: 0, start_col: 0, end_col: 0, return_csv: true })).csv_data).toBe("20");
    await expect(edits.prepareTurn("ws", "ses", "new-user", submission)).rejects.toThrow("已变化");
  });
}, 30_000);

nativeTest("真实 SDK 第二子表 A8/B8 连续范围写值，首表同名单元格与旁边数据保存后保留", async () => {
  await withModel("sheet", async (engine, fileId, path) => {
    const first = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const firstId = (first.sheets as Array<{ sheet_id: string }>)[0].sheet_id;
    await engine.tool("sheet_add_sheet", { file_id: fileId, name: "第二子表" });
    const info = await engine.tool("sheet_get_sheet_info", { file_id: fileId });
    const secondId = (info.sheets as Array<{ sheet_id: string; name: string }>).find((sheet) => sheet.name === "第二子表")!.sheet_id;
    for (const [sheetId, col, value] of [[firstId, 0, 10], [secondId, 0, 10], [secondId, 1, 20], [secondId, 2, 30]] as const)
      await engine.tool("sheet_set_cell_value", { file_id: fileId, sheet_id: sheetId, cell: { row: 7, col, value_type: "NUMBER", number_value: value } });
    for (const [col, value] of [[0, 100], [1, 200]]) {
      const locator: OfficeSelectionLocator = { kind: "sheet-cells", sheetId: secondId, ranges: [{ startRow: 7, endRow: 7, startCol: col, endCol: col }] };
      await call(engine, fileId, locator, "sheet_set_cell_value", { cell: { row: 7, col, value_type: "NUMBER", number_value: value } });
    }
    const read = (model: string, sheetId: string, lastCol: number) => engine.tool("sheet_get_cell_data", {
      file_id: model, sheet_id: sheetId, start_row: 7, end_row: 7, start_col: 0, end_col: lastCol, return_csv: true,
    });
    expect((await read(fileId, firstId, 0)).csv_data).toBe("10");
    expect((await read(fileId, secondId, 2)).csv_data).toBe("100,200,30");
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    const reopened = (await engine.editor(path))!.file_id;
    const sheets = (await engine.tool("sheet_get_sheet_info", { file_id: reopened })).sheets as Array<{ sheet_id: string; name: string }>;
    expect((await read(reopened, sheets[0].sheet_id, 0)).csv_data).toBe("10");
    expect((await read(reopened, sheets.find((sheet) => sheet.name === "第二子表")!.sheet_id, 2)).csv_data).toBe("100,200,30");
  });
}, 30_000);

nativeTest("真实 SDK 同页同文案形状只修改第二框内两个字的加粗，邻字与第一框保存重开后保留", async () => {
  await withModel("slide", async (engine, fileId, path) => {
    for (const x of [20, 200])
      await engine.tool("slide_add_text", { file_id: fileId, page_index: 0, x, y: 20, w: 150, h: 50, text: "前选中后", font_size: 20 });
    const page = await engine.tool("slide_get_page_info", { file_id: fileId, page_index: 0 });
    const shapes = page.shapes as Array<{ id: string; x: number }>;
    const selected = shapes.find((shape) => shape.x === 200)!;
    const locator: OfficeSelectionLocator = { kind: "slide-text", pageIndex: 0, shapeId: selected.id, start: 1, count: 2 };
    await call(engine, fileId, locator, "slide_set_text_property", { bold: true });
    const verify = async (model: string) => {
      const current = await engine.tool("slide_get_page_info", { file_id: model, page_index: 0 });
      for (const shape of current.shapes as Array<{ id: string; x: number }>) {
        const text = await engine.tool("slide_get_text", { file_id: model, page_index: 0, shape_id: shape.id });
        expect(text.text).toBe("前选中后\r");
        const runs = text.runs as Array<{ start: number; end: number; bold?: boolean }>;
        for (let offset = 0; offset < (text.length as number); offset++) {
          const run = runs.find((run) => offset >= run.start && offset < run.end)!;
          expect(run).toBeDefined();
          expect(run.bold === true).toBe(shape.x === 200 && offset >= 1 && offset < 3);
        }
      }
    };
    await verify(fileId);
    await engine.save(fileId);
    await engine.close(fileId);
    await engine.tool("open_file", { file_path: path, wait: true });
    await verify((await engine.editor(path))!.file_id);
  });
}, 30_000);

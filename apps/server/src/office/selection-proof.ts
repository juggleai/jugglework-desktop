import { createHash } from "node:crypto";
import type { OfficeSelectionLocator, OfficeTextRange } from "@jugglework/types/office";
import { ApiError } from "../errors.js";
import { readSlidePageState, verifySlidePageEdit } from "./slide-page-proof.js";

type Tool = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
type ObjectValue = Record<string, unknown>;

/** 完整且有预算的模型读取；内容保留在宿主，不随每次工具调用发送给模型。 */
export interface OfficeSelectionProof {
  stamp: string;
  state: ObjectValue;
}

function unavailable(message = "无法完整核对选区内容，请缩小范围或重新选择"): never {
  throw new ApiError(409, "office_selection_proof_unavailable", message);
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as ObjectValue;
}
function objects(value: unknown): ObjectValue[] {
  if (!Array.isArray(value)) unavailable();
  return value.map(object);
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) unavailable();
  return value;
}

/** 只对已解析的 JSON 事实排序；不丢失缺省值、空值、数组顺序及真实身份。 */
export function officeProofJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    return item;
  });
}

function proof(state: ObjectValue): OfficeSelectionProof {
  const json = officeProofJson(state);
  if (Buffer.byteLength(json) > 4 * 1024 * 1024) unavailable();
  return { state, stamp: createHash("sha256").update(json).digest("hex") };
}

function withoutVersion(value: ObjectValue): ObjectValue {
  const { version: _version, ...content } = value;
  return content;
}

/** 结构预览按字节截断；查找上下文只用于提出候选，完整文字必须再由原生范围及版本确认。 */
async function completeDocParagraph(query: Tool, node: ObjectValue, revision: number): Promise<ObjectValue> {
  const start = integer(node.start_index), end = integer(node.end_index), length = end - start;
  if (!length && node.type === "Paragraph" && node.text_preview === undefined) return { ...node, text_preview: "" };
  if (length < 0 || typeof node.text_preview !== "string" || node.text_preview.length > length) unavailable();
  if (node.text_preview.length === length) return node;
  if (!node.text_preview) unavailable();
  let text = node.text_preview;
  // 全文补全与选区属性预算独立；每段最多128次，全文另有限额。最后一次必须查找完整文字。
  for (let attempt = 0; attempt < 128; attempt++) {
    const found = await query("doc_find", { text });
    if (found.version !== revision) unavailable("文档正在变化，请重新选择");
    const locations = objects(found.locations);
    if (locations.length > 4096 || found.total !== locations.length) unavailable();
    const matches = locations.filter((item) => item.begin === start && item.end === start + text.length &&
      (node.paragraph_id === undefined || item.paragraph_id === node.paragraph_id) && item.table_id === undefined);
    if (matches.length !== 1) unavailable();
    if (text.length === length) return { ...node, text_preview: text };
    const context = matches[0].related_text, marker = `[${text}]`;
    if (typeof context !== "string") unavailable();
    const at = context.indexOf(marker);
    if (at < 0 || at !== context.lastIndexOf(marker)) unavailable();
    const suffix = context.slice(at + marker.length, at + marker.length + length - text.length);
    if (!suffix) unavailable();
    text += suffix;
  }
  unavailable();
}

export const OFFICE_DOC_MAX_SPAN = 16_384;

/** 分页不含正文；旧 SDK 的无预览 Paragraph 还须由最多10个 GCP 的末尾原文证明分页占位符。 */
async function completeDocPageBreak(query: Tool, node: ObjectValue, revision: number, tail: ObjectValue): Promise<ObjectValue> {
  const start = integer(node.start_index), end = integer(node.end_index);
  const plain = (value: ObjectValue) => ["PageBreak", "Paragraph"].includes(String(value.type)) && end === start + 1 &&
    (value.text_preview === undefined || value.text_preview === "") &&
    Object.keys(value).every((key) => ["type", "start_index", "end_index", "paragraph_index", "paragraph_id", "text_preview"].includes(key));
  if (!plain(node)) unavailable();
  const detail = await query("doc_resolve_document_structure", { idx: start });
  const blocks = objects(detail.nodes);
  if (detail.version !== revision || blocks.length !== 1 || !plain(blocks[0]) ||
      officeProofJson(blocks[0]) !== officeProofJson(node)) unavailable();
  if (node.type === "Paragraph") {
    if (typeof tail.preceding_text !== "string") unavailable();
    const text = tail.preceding_text.replace(/\[line_break\]/g, "\r").replace(/\[page_break\]/g, "\f");
    // 其他占位符、无法定位的摘要及可能与占位符展示混淆的字面括号均不采信。
    if (/[\[\]]/.test(text) || text.length !== Math.min(10, integer(tail.position)) ||
        text[start - (integer(tail.position) - text.length)] !== "\f")
      unavailable("当前 SDK 无法完整证明此处分页结构，请单独处理该文档");
  }
  return { ...node, content: { type: "PageBreak" } };
}

/** 只适配可由完整 cells 文字及原生范围相互证明的平面表格；所有内部坐标相对表首保存。 */
async function completeDocTable(query: Tool, node: ObjectValue, revision: number,
  reserveProperties: (characters: number, paragraphs: number) => void): Promise<ObjectValue> {
  const start = integer(node.start_index), end = integer(node.end_index);
  // 先核对轻量网格预算，避免对已知超预算表格请求完整 cells。
  const rows = integer(node.row_count), cols = integer(node.col_count);
  if (!rows || !cols || rows * cols > 256) unavailable();
  const detail = await query("doc_resolve_document_structure", { idx: start });
  const blocks = objects(detail.nodes);
  if (detail.version !== revision || blocks.length !== 1) unavailable();
  const full = blocks[0];
  if (full.type !== "Table" || full.start_index !== start || full.end_index !== end ||
      full.table_start !== start || full.table_end !== end || full.table_id !== node.table_id) unavailable();
  const info = await query("doc_get_table_info", { idx: start });
  const block = object(info.block), table = object(block.table);
  // SDK 的结构 table_end 为闭区间，table-info 的 end_idx 为开区间。
  if (info.version !== revision || block.type !== "table" || block.idx !== start || block.end_idx !== end + 1 ||
      info.table_start_index !== start || info.table_end_index !== end + 1 || info.resolved_idx !== start ||
      (node.table_id !== undefined && block.id !== node.table_id)) unavailable();
  const cells = objects(table.cells), rowNodes = objects(full.table_rows);
  if (cells.length !== rows * cols || rowNodes.length !== rows || table.row_count !== rows || table.col_count !== cols ||
      full.row_count !== rows || full.col_count !== cols) unavailable();
  const relativeRows: ObjectValue[] = [];
  let position = start + 1;
  for (let row = 1; row <= rows; row++) {
    const rowNode = rowNodes[row - 1], children = objects(rowNode.cells);
    if (rowNode.row !== row || children.length !== cols) unavailable();
    const relativeCells: ObjectValue[] = [];
    for (let col = 1; col <= cols; col++) {
      const cell = cells[(row - 1) * cols + col - 1], child = children[col - 1];
      // 合并、嵌套、图片或多段结构不能仅靠文字证明，长度/平面网格不吻合即拒绝。
      if (cell.row !== row || cell.col !== col || typeof cell.text !== "string" || cell.is_merge_continue === true ||
          /[\r\n\uFFFC]/.test(cell.text) ||
          Object.keys(child).some((key) => !["row", "col", "start_index", "end_index", "text_preview"].includes(key)) ||
          typeof child.text_preview !== "string" || !cell.text.startsWith(child.text_preview) ||
          child.row !== row || child.col !== col || child.start_index !== position || child.end_index !== position + cell.text.length)
        unavailable();
      relativeCells.push({ ...child, start_index: position - start, end_index: position + cell.text.length - start });
      position += cell.text.length + 2;
    }
    relativeRows.push({ ...rowNode, cells: relativeCells });
    position++;
  }
  if (position !== end) unavailable();
  // 所有未选表格共用独立预算；空格也读取段首的继承文字属性，不能靠空文字绕过属性预算。
  reserveProperties(cells.reduce((sum, cell) => sum + Math.max(1, (cell.text as string).length), 0), cells.length);
  const properties: ObjectValue[] = [], paragraphs: ObjectValue[] = [];
  const readProperty = async (name: string, idx: number) => {
    const value = await query(name, { idx });
    if (value.version !== revision || value.idx !== idx) unavailable("文档正在变化，请重新选择");
    return { ...withoutVersion(value), idx: idx - start };
  };
  for (const row of relativeRows) for (const child of objects(row.cells)) {
    const begin = start + integer(child.start_index), finish = start + integer(child.end_index);
    paragraphs.push(await readProperty("doc_get_paragraph_property", begin));
    for (let idx = begin; idx < Math.max(begin + 1, finish); idx++)
      properties.push(await readProperty("doc_get_text_property", idx));
  }
  return { ...node, content: { block: { ...block, idx: 0, end_idx: end + 1 - start },
    structure: { ...full, start_index: 0, end_index: end - start, table_start: 0, table_end: end - start, table_rows: relativeRows },
    properties, paragraphs } };
}

/** 比较公式的表示差异；只忽略输入等号及函数名大小写，保留字符串、工作表名和结构化列名。 */
function canonicalFormula(formula: string): string {
  // TIPS: 不能对整条公式 upper-case，否则会掩盖字符串常量和带引号名称的实际变化。
  return formula.replace(/^=/, "").replace(
    /"(?:[^"]|"")*"|'(?:[^']|'')*'|\[[^\]]*\]|([A-Za-z_\\][A-Za-z0-9_.\\]*)(?=\s*\()/g,
    (token, name: string | undefined) => name ? name.toUpperCase() : token,
  );
}

/**
 * 将已证明的连续正文范围映射到各段文字；段落分隔符占一个 GCP，空段不能丢失。
 * @param state 原生模型的完整正文证明
 * @param range 固定的 UTF-16 半开范围，端点必须落在已读取的正文段落中
 */
export function officeDocRangeParts(state: ObjectValue, range: OfficeTextRange) {
  const nodes = objects(state.nodes);
  const first = nodes.findIndex((node) => range.begin >= integer(node.start_index) && range.begin <= integer(node.end_index));
  const last = nodes.findIndex((node) => range.end >= integer(node.start_index) && range.end <= integer(node.end_index));
  if (first < 0 || last < first || range.end < range.begin) unavailable();
  return nodes.slice(first, last + 1).map((node, offset) => {
    const start = integer(node.start_index), end = integer(node.end_index);
    if (offset && start !== integer(nodes[first + offset - 1].end_index) + 1) unavailable();
    if (typeof node.text_preview !== "string" || node.text_preview.length !== end - start) unavailable();
    const begin = Math.max(start, range.begin), finish = Math.min(end, range.end);
    return { nodeIndex: first + offset, begin, end: finish, text: node.text_preview.slice(begin - start, finish - start) };
  });
}

/**
 * 读取配套模型的确定性内容证明；缺少完整数据或超过预算时拒绝，不采信截断摘要。
 * @param call 已绑定引擎的只读工具通道
 * @param fileId Server 持有的模型身份
 * @param locator 规范化的固定范围
 */
export async function readOfficeSelectionProof(
  call: Tool,
  fileId: string,
  locator: OfficeSelectionLocator,
  coverage: OfficeSelectionLocator[] = [locator],
): Promise<OfficeSelectionProof> {
  const query = (name: string, args: ObjectValue = {}) => call(name, { ...args, file_id: fileId });
  if (locator.kind === "doc-text" || locator.kind === "doc-caret") {
    const start = await query("doc_get_last_operable_pos");
    const revision = integer(start.version);
    const last = integer(start.position);
    // 每次证明：正文跨度≤16384 UTF-16、顶层≤256、全文查找≤512、每表≤256格。
    // 所选段属性≤256字符；所有表格独立≤1024字符(空格计1)、≤256个单格段属性；总证明≤4 MiB。
    if (last > OFFICE_DOC_MAX_SPAN) unavailable();
    let finds = 0;
    const docQuery: Tool = (name, args) => {
      if (name === "doc_find" && ++finds > 512) unavailable();
      return query(name, args);
    };
    const structure = await query("doc_resolve_document_structure", { mode: "compact", limit: 257, text_preview_length: 200, include_table_cells: false, include_textbox_children: false });
    const pagination = object(structure.pagination);
    if (pagination.has_more !== false || integer(pagination.total_nodes) > 256 || structure.version !== revision) unavailable();
    const nodes = objects(structure.nodes).map((node) => {
      // TIPS: SDK 对空段落省略 text_preview；只有明确的零长度普通段落可还原为空串，未知正文仍拒绝。
      if (node.type === "Paragraph" && node.text_preview === undefined &&
          integer(node.start_index) === integer(node.end_index)) return { ...node, text_preview: "" };
      return node;
    });
    if (!nodes.length || nodes.length !== pagination.total_nodes) unavailable();
    let position = 0;
    for (const node of nodes) {
      const begin = integer(node.start_index), finish = integer(node.end_index);
      if (begin !== position || finish < begin || finish > last || !["Paragraph", "Heading", "Title", "Subtitle", "Table", "PageBreak"].includes(String(node.type))) unavailable();
      position = finish + 1;
    }
    if (position !== last + 1) unavailable();
    const isPageBreak = (node: ObjectValue) => node.type === "PageBreak" ||
      (node.type === "Paragraph" && node.text_preview === undefined && integer(node.end_index) > integer(node.start_index));
    const ranges = coverage.flatMap((item) => item.kind === "doc-caret" ? [{ begin: item.idx, end: item.idx }]
      : item.kind === "doc-text" ? item.ranges : []);
    if (!ranges.length || ranges.some((range) => range.end > last)) unavailable();
    const selectedIndices = new Set<number>();
    for (const range of ranges) {
      const first = nodes.findIndex((node) => range.begin >= integer(node.start_index) && range.begin <= integer(node.end_index));
      const final = nodes.findIndex((node) => range.end >= integer(node.start_index) && range.end <= integer(node.end_index));
      if (first < 0 || final < first || range.end < range.begin) unavailable();
      for (let index = first; index <= final; index++) selectedIndices.add(index);
    }
    const selectedNodes = nodes.filter((_node, index) => selectedIndices.has(index));
    if (selectedNodes.some((node) => isPageBreak(node) || !["Paragraph", "Heading", "Title", "Subtitle"].includes(String(node.type))))
      unavailable("请选择普通正文，暂不支持表格或分页等结构内容");
    const positions = new Set<number>();
    for (const node of selectedNodes) {
      for (let idx = node.start_index as number; idx < (node.end_index as number); idx++) positions.add(idx);
    }
    if (positions.size > 256) unavailable();
    let tableCharacters = 0, tableParagraphs = 0;
    const reserveTableProperties = (characters: number, paragraphs: number) => {
      tableCharacters += characters; tableParagraphs += paragraphs;
      if (tableCharacters > 1024 || tableParagraphs > 256) unavailable("未选表格属性超过完整核对预算，请单独处理该文档");
    };
    for (let index = 0; index < nodes.length; index++) nodes[index] = nodes[index].type === "Table"
      ? await completeDocTable(docQuery, nodes[index], revision, reserveTableProperties)
      : isPageBreak(nodes[index]) ? await completeDocPageBreak(docQuery, nodes[index], revision, start)
      : await completeDocParagraph(docQuery, nodes[index], revision);
    // 补全后仍须验证连续段落边界，不能把表格或分页节点拼成普通文字。
    for (const range of ranges) officeDocRangeParts({ nodes }, range);
    const properties: ObjectValue[] = [];
    const paragraphs: ObjectValue[] = [];
    for (const node of selectedNodes) {
      const property = await query("doc_get_paragraph_property", { idx: node.start_index });
      if (property.version !== revision) unavailable("文档正在变化，请重新选择");
      paragraphs.push(withoutVersion(property));
    }
    for (const idx of positions) {
      const property = await query("doc_get_text_property", { idx });
      if (property.version !== revision) unavailable("文档正在变化，请重新选择");
      properties.push(withoutVersion(property));
    }
    const end = await query("doc_get_last_operable_pos");
    if (end.version !== revision || end.position !== last) unavailable("文档正在变化，请重新选择");
    return proof({ kind: "doc", revision, last, nodes, properties, paragraphs });
  }
  if (locator.kind.startsWith("sheet-")) {
    if (!("sheetId" in locator)) unavailable();
    const info = await query("sheet_get_sheet_info");
    const sheets = objects(info.sheets);
    const sheet = sheets.find((item) => item.sheet_id === locator.sheetId);
    if (!sheet) unavailable("选区工作表已不存在，请重新选择");
    const rows = integer(sheet.row_count), cols = integer(sheet.col_count);
    const dimension = locator.kind === "sheet-rows" || locator.kind === "sheet-columns";
    let endRow = Math.max(0, integer(sheet.used_row_count) - 1);
    let endCol = Math.max(0, integer(sheet.used_col_count) - 1);
    for (const item of coverage) {
      if (!("sheetId" in item) || item.sheetId !== locator.sheetId) unavailable();
      if (item.kind === "sheet-cells") for (const range of item.ranges) {
        if (range.endRow >= rows || range.endCol >= cols) unavailable();
        endRow = Math.max(endRow, range.endRow + 1);
        endCol = Math.max(endCol, range.endCol + 1);
      }
      else if (item.kind === "sheet-rows") for (const range of item.ranges) {
        if (range.end >= rows) unavailable();
        endRow = Math.max(endRow, range.end + 1);
      }
      else if (item.kind === "sheet-columns") for (const range of item.ranges) {
        if (range.end >= cols) unavailable();
        endCol = Math.max(endCol, range.end + 1);
      }
    }
    endRow = Math.min(endRow, rows - 1); endCol = Math.min(endCol, cols - 1);
    if (dimension) { endRow = rows - 1; endCol = cols - 1; }
    if (rows <= 0 || cols <= 0 || (endRow + 1) * (endCol + 1) > (dimension ? 8192 : 4096)) unavailable();
    const region = { sheet_id: locator.sheetId, start_row: 0, start_col: 0, end_row: endRow, end_col: endCol };
    const read = async () => {
      const values = await query("sheet_get_cell_data", { ...region, return_csv: false, include_formula: true });
      const styles = await query("sheet_get_cell_style", region);
      const merged = await query("sheet_get_merged_cells", region);
      const cells = objects(values.cells), formats = objects(styles.cells), merges = objects(merged.merged_cells);
      if (formats.length !== (endRow + 1) * (endCol + 1)) unavailable();
      const keys = new Set<string>();
      for (const cell of formats) {
        const row = integer(cell.row), col = integer(cell.col);
        if (row > endRow || col > endCol || keys.has(`${row}:${col}`)) unavailable();
        keys.add(`${row}:${col}`);
      }
      const valueKeys = new Set<string>();
      for (const cell of cells) {
        const row = integer(cell.row), col = integer(cell.col), key = `${row}:${col}`;
        if (row > endRow || col > endCol || valueKeys.has(key)) unavailable();
        valueKeys.add(key);
      }
      const order = (a: ObjectValue, b: ObjectValue) => (a.row as number) - (b.row as number) || (a.col as number) - (b.col as number);
      return { cells: cells.sort(order), formats: formats.sort(order), merges };
    };
    const first = await read();
    const afterInfo = await query("sheet_get_sheet_info");
    const second = await read();
    if (officeProofJson(info) !== officeProofJson(afterInfo) || officeProofJson(first) !== officeProofJson(second))
      unavailable("表格正在变化，请重新选择");
    if (dimension && first.merges.length) unavailable("选区删除行列暂不支持包含合并单元格的工作表");
    if (!dimension) for (const merge of first.merges) {
      if (merge.sheet_id !== locator.sheetId || integer(merge.end_row) < integer(merge.start_row) || integer(merge.end_col) < integer(merge.start_col)) unavailable();
      for (const item of coverage) if (item.kind === "sheet-cells") for (const range of item.ranges) {
        const intersects = range.startRow <= (merge.end_row as number) && range.endRow >= (merge.start_row as number) && range.startCol <= (merge.end_col as number) && range.endCol >= (merge.start_col as number);
        if (intersects && !(range.startRow <= (merge.start_row as number) && range.endRow >= (merge.end_row as number) && range.startCol <= (merge.start_col as number) && range.endCol >= (merge.end_col as number)))
          unavailable("请选择完整合并单元格，不能只修改合并区域的一部分");
      }
    }
    if (dimension && (sheets.length !== 1 || first.cells.some((cell) => typeof cell.formula === "string")))
      unavailable("选区删除行列目前支持不含公式和合并单元格的单工作表，请单独处理复杂工作簿");
    return proof({ kind: "sheet", sheets, sheetId: locator.sheetId, region, ...first });
  }
  if (locator.kind === "slide-pages") {
    if (coverage.length !== 1 || officeProofJson(coverage[0]) !== officeProofJson(locator))
      throw new ApiError(409, "office_selection_slide_pages_unsupported", "整页引用不能与其他 PPT 引用混用，请只发送一个整页引用");
    return proof(await readSlidePageState(query, locator));
  }
  if (locator.kind !== "slide-shapes" && locator.kind !== "slide-text") unavailable();
  const info = await query("slide_get_info");
  const revision = integer(info.version);
  if (!Array.isArray(info.slide_ids) || info.slide_ids.length !== integer(info.slide_count) ||
      !info.slide_ids.every((id) => typeof id === "string" && id.length > 0) || new Set(info.slide_ids).size !== info.slide_ids.length || !info.slide_ids[locator.pageIndex]) unavailable();
  const page = await query("slide_get_page_info", { page_index: locator.pageIndex });
  const shapes = objects(page.shapes);
  if (page.version !== revision || shapes.length > 128 || integer(page.shape_count) !== shapes.length ||
      page.page_id !== info.slide_ids[locator.pageIndex] ||
      shapes.some((shape) => typeof shape.id !== "string" || !shape.id || typeof shape.type !== "string") ||
      new Set(shapes.map((shape) => shape.id)).size !== shapes.length) unavailable();
  const ids = [...new Set(coverage.flatMap((item) => item.kind === "slide-text" && item.pageIndex === locator.pageIndex ? [item.shapeId]
    : item.kind === "slide-shapes" && item.pageIndex === locator.pageIndex ? item.shapeIds : []))];
  if (!ids.length || ids.some((id) => !shapes.some((shape) => shape.id === id))) unavailable("所选对象已变化，请重新选择");
  if (ids.some((id) => shapes.some((shape) => shape.id === id && shape.type === "picture")))
    throw new ApiError(409, "office_selection_slide_picture_selected", "当前选区包含图片，不是整页选择；整页选择请点击左侧幻灯片缩略图。图片内文字暂不支持直接改写");
  if (ids.some((id) => !shapes.some((shape) => shape.id === id && shape.type === "shape" && typeof shape.text === "string")))
    unavailable("仅支持普通文本框，请重新选择");
  const texts: ObjectValue[] = [];
  for (const id of ids) {
    const text = await query("slide_get_text", { page_index: locator.pageIndex, shape_id: id });
    if (text.version !== revision || typeof text.text !== "string" || text.text.length !== integer(text.length) ||
        text.text.length > 4096 + (text.text.endsWith("\r") ? 1 : 0)) unavailable();
    const runs = objects(text.runs);
    let runEnd = 0;
    for (const run of runs) {
      const begin = integer(run.start), end = integer(run.end);
      if (begin !== runEnd || end < begin || end > text.text.length) unavailable();
      runEnd = end;
    }
    if (runEnd !== text.text.length) unavailable();
    if (locator.kind === "slide-text" && locator.start + locator.count > text.text.length) unavailable();
    // 原生继承样式可能在编辑后显式展开；按每字符生效样式比较，避免把等价 run 分裂当作误改。
    const font = shapes.find((shape) => shape.id === id)?.font_size;
    const characters = Array.from({ length: text.text.length }, (_, idx) => {
      const run = runs.find((item) => integer(item.start) <= idx && integer(item.end) > idx);
      if (!run) unavailable();
      return { bold: run.bold === true, italic: run.italic === true,
        color: run.color ?? "", font_size: run.font_size ?? font ?? 0,
        underline: run.underline ?? 0, strikethrough: run.strikethrough ?? 0 };
    });
    texts.push({ shapeId: id, text: text.text, characters });
  }
  const end = await query("slide_get_info");
  if (end.version !== revision || officeProofJson(end.slide_ids) !== officeProofJson(info.slide_ids)) unavailable("幻灯片正在变化，请重新选择");
  return proof({ kind: "slide", revision, pageIds: info.slide_ids, page, texts });
}

/**
 * 核对配套工具实际效果及邻接内容；不把成功响应当成修改确认。
 * @param before 调用前已核对的完整证明
 * @param after 原生调用后重新读取的证明
 * @param locator 固定定位；改变坐标的操作由调用方在确认后使旧定位失效
 * @param tool 原生工具名
 * @param args 已由范围解析器约束的实际调用参数
 * @param nativeWrites 宿主完成的原生写入次数，跨段改写按实际执行段数核对版本推进
 */
export function verifyOfficeSelectionEdit(
  before: OfficeSelectionProof,
  after: OfficeSelectionProof,
  locator: OfficeSelectionLocator,
  tool: string,
  args: ObjectValue,
  nativeWrites = 1,
): void {
  const fail = () => { throw new ApiError(409, "office_selection_edit_unconfirmed", "修改结果尚未确认，请检查文档后重新选择，不要重复执行"); };
  const old = structuredClone(before.state), actual = after.state;
  if (old.kind !== actual.kind) fail();
  if (old.kind === "slide-page") { verifySlidePageEdit(old, actual, tool, args); return; }
  if (old.kind === "doc") {
    if (actual.revision !== (old.revision as number) + nativeWrites) fail();
    const nodes = objects(old.nodes), next = objects(actual.nodes);
    if (nodes.length !== next.length) fail();
    if (tool === "doc_replace_text" || tool === "doc_insert_text") {
      const range = tool === "doc_insert_text" ? { begin: args.idx as number, end: args.idx as number } : (args.ranges as Array<{ begin: number; end: number }>)[0];
      const parts = officeDocRangeParts(old, range);
      const texts = (args.text as string).split("\r");
      if (parts.length !== texts.length) fail();
      let shift = 0;
      const nodeShifts: number[] = [];
      for (let i = 0; i < nodes.length; i++) {
        nodeShifts.push(shift);
        let expected = nodes[i].text_preview;
        const partIndex = parts.findIndex((part) => part.nodeIndex === i);
        let delta = 0;
        if (partIndex >= 0) {
          if (typeof expected !== "string") fail();
          const part = parts[partIndex], offset = part.begin - (nodes[i].start_index as number);
          expected = (expected as string).slice(0, offset) + texts[partIndex] + (expected as string).slice(offset + part.end - part.begin);
          delta = texts[partIndex].length - (part.end - part.begin);
        }
        const expectedNode: ObjectValue = { ...nodes[i], start_index: (nodes[i].start_index as number) + shift,
          end_index: (nodes[i].end_index as number) + shift + delta };
        if (expected !== undefined) expectedNode.text_preview = expected;
        for (const key of ["table_start", "table_end"]) if (typeof expectedNode[key] === "number") expectedNode[key] = (expectedNode[key] as number) + shift;
        const actualNode = { ...next[i] };
        // 删除所选文字可能清除其派生高亮摘要；段落身份和未选节点摘要仍必须严格一致。
        if (partIndex >= 0) { delete expectedNode.has_highlights; delete actualNode.has_highlights; }
        if (officeProofJson(actualNode) !== officeProofJson(expectedNode)) fail();
        shift += delta;
      }
      if (actual.last !== (old.last as number) + shift) fail();
      const shiftedIndex = (idx: number) => idx + parts.reduce((shift, part, i) => shift + (idx >= part.end ? texts[i].length - (part.end - part.begin) : 0), 0);
      for (const paragraph of objects(old.paragraphs)) {
        const idx = integer(paragraph.idx);
        // 段属性查询锚定段首；段内改写不移动本段段首，只累加前面段落的变化。
        const nodeIndex = nodes.findIndex((node) => node.start_index === idx);
        if (nodeIndex < 0) fail();
        const shifted = idx + nodeShifts[nodeIndex];
        const next = objects(actual.paragraphs).find((item) => item.idx === shifted);
        if (!next || officeProofJson({ ...paragraph, idx: shifted }) !== officeProofJson(next)) fail();
      }
      const properties = objects(old.properties), updated = objects(actual.properties);
      for (const property of properties) {
        const idx = integer(property.idx);
        if (idx >= range.begin && idx < range.end) continue;
        const shifted = shiftedIndex(idx);
        const next = updated.find((item) => item.idx === shifted);
        if (!next || officeProofJson({ ...property, idx: shifted }) !== officeProofJson(next)) fail();
      }
      return;
    }
    if (officeProofJson(nodes) !== officeProofJson(next)) fail();
    if (officeProofJson(old.paragraphs) !== officeProofJson(actual.paragraphs)) fail();
    const properties = objects(old.properties), updated = objects(actual.properties);
    for (let i = 0; i < properties.length; i++) {
      const property = properties[i];
      const selected = (args.ranges as Array<{ begin: number; end: number }>).some((range) => (property.idx as number) >= range.begin && (property.idx as number) < range.end);
      if (selected) for (const key of ["bold", "italic", "color", "font_size"]) if (Object.hasOwn(args, key)) property[key] = args[key];
      if (officeProofJson(property) !== officeProofJson(updated[i])) fail();
    }
    return;
  }
  if (old.kind === "sheet") {
    if (tool === "sheet_delete_dimension") {
      const axis = args.dimension_type === "row" ? "row" : "col";
      const countKey = axis === "row" ? "row_count" : "col_count";
      const index = integer(args.index), count = integer(args.count);
      const shift = (items: unknown) => objects(items).flatMap((cell) => {
        const position = integer(cell[axis]);
        if (position >= index && position < index + count) return [];
        return [{ ...cell, [axis]: position >= index + count ? position - count : position }];
      }).sort((a, b) => (a.row as number) - (b.row as number) || (a.col as number) - (b.col as number));
      const oldSheets = objects(old.sheets), nextSheets = objects(actual.sheets);
      if (oldSheets.length !== 1 || nextSheets.length !== 1) fail();
      const expected = { ...oldSheets[0], [countKey]: integer(oldSheets[0][countKey]) - count };
      const stable = (sheet: ObjectValue) => { const { used_row_count: _r, used_col_count: _c, ...value } = sheet; return value; };
      if (officeProofJson(stable(expected)) !== officeProofJson(stable(nextSheets[0])) || officeProofJson(old.merges) !== officeProofJson(actual.merges)) fail();
      if (officeProofJson(shift(old.cells)) !== officeProofJson(objects(actual.cells).sort((a, b) => (a.row as number) - (b.row as number) || (a.col as number) - (b.col as number))) ||
        officeProofJson(shift(old.formats)) !== officeProofJson(objects(actual.formats).sort((a, b) => (a.row as number) - (b.row as number) || (a.col as number) - (b.col as number)))) fail();
      const region = { ...object(old.region), [axis === "row" ? "end_row" : "end_col"]: integer(object(old.region)[axis === "row" ? "end_row" : "end_col"]) - count };
      if (officeProofJson(region) !== officeProofJson(actual.region)) fail();
      return;
    }
    if (officeProofJson(old.region) !== officeProofJson(actual.region)) fail();
    if (officeProofJson(old.sheets) !== officeProofJson(actual.sheets) || officeProofJson(old.merges) !== officeProofJson(actual.merges)) {
      // 写入原先空白的边缘允许 used_* 扩展，其他子表身份及网格必须保持不变。
      const stable = (sheets: unknown) => objects(sheets).map((item) => {
        if (item.sheet_id !== args.sheet_id) return item;
        const { used_row_count: _r, used_col_count: _c, ...sheet } = item;
        return sheet;
      });
      if (officeProofJson(stable(old.sheets)) !== officeProofJson(stable(actual.sheets)) || officeProofJson(old.merges) !== officeProofJson(actual.merges)) fail();
    }
    const cells = new Map(objects(old.cells).map((cell) => [`${cell.row}:${cell.col}`, cell]));
    const updated = new Map(objects(actual.cells).map((cell) => [`${cell.row}:${cell.col}`, cell]));
    const canonicalCell = (cell: ObjectValue | undefined) => {
      if (!cell) return null;
      if (typeof cell.formula === "string") return { row: cell.row, col: cell.col, formula: canonicalFormula(cell.formula) };
      return cell;
    };
    if (tool === "sheet_set_cell_value" && old.sheetId === args.sheet_id) {
      const expected = object(args.cell), key = `${expected.row}:${expected.col}`;
      if (officeProofJson(canonicalCell(expected)) !== officeProofJson(canonicalCell(updated.get(key)))) fail();
      cells.delete(key); updated.delete(key);
    }
    if (tool === "sheet_set_cell_style" && old.sheetId === args.sheet_id) for (const [key, cell] of updated) {
      // 原生样式写入会把空格实体化为空字符串单元格；仅接受目标范围内这一已验证派生效果。
      if (!cells.has(key) && (cell.row as number) >= (args.start_row as number) && (cell.row as number) <= (args.end_row as number) &&
        (cell.col as number) >= (args.start_col as number) && (cell.col as number) <= (args.end_col as number) &&
        officeProofJson(cell) === officeProofJson({ row: cell.row, col: cell.col, value_type: "STRING", string_value: "" })) updated.delete(key);
    }
    if (officeProofJson([...cells].map(([key, cell]) => [key, canonicalCell(cell)])) !== officeProofJson([...updated].map(([key, cell]) => [key, canonicalCell(cell)]))) fail();
    const formats = objects(old.formats), changed = objects(actual.formats);
    for (let i = 0; i < formats.length; i++) {
      const style = formats[i];
      if (tool === "sheet_set_cell_style" && old.sheetId === args.sheet_id && (style.row as number) >= (args.start_row as number) && (style.row as number) <= (args.end_row as number) &&
        (style.col as number) >= (args.start_col as number) && (style.col as number) <= (args.end_col as number))
        for (const [key, value] of Object.entries(object(args.format))) {
          if (!Object.hasOwn(style, key) || args.is_clear === true) fail();
          style[key] = value;
        }
      if (officeProofJson(style) !== officeProofJson(changed[i])) fail();
    }
    return;
  }
  if (old.kind === "slide") {
    if (actual.revision !== (old.revision as number) + 1 || officeProofJson(old.pageIds) !== officeProofJson(actual.pageIds)) fail();
    const texts = objects(old.texts), changed = objects(actual.texts);
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i];
      if (text.shapeId === args.shape_id) {
        if (tool === "slide_set_text") { if (changed[i].text !== `${args.text}\r`) fail(); continue; }
        const characters = objects(text.characters);
        for (let index = args.index as number; index < (args.index as number) + (args.count as number); index++)
          for (const key of ["bold", "italic", "color", "font_size"]) if (Object.hasOwn(args, key)) characters[index][key] = args[key];
        const content = text.text as string, end = content.length - 1;
        // TIPS: SDK 格式化完整末段时会同时实体化段尾回车的继承样式；只接受末段已全选且回车同步采用本次属性。
        // 局部文字选择不能借此改变未选文字或其他段落的属性。
        if (content.endsWith("\r") && (args.index as number) <= content.lastIndexOf("\r", end - 1) + 1 &&
            (args.index as number) + (args.count as number) === end) {
          const updated = objects(changed[i].characters);
          for (const key of ["bold", "italic", "color", "font_size"]) if (Object.hasOwn(args, key) && updated[end]?.[key] === args[key]) characters[end][key] = args[key];
        }
      }
      if (officeProofJson(text) !== officeProofJson(changed[i])) fail();
    }
    const page = withoutVersion(object(old.page)), current = withoutVersion(object(actual.page));
    for (const value of [page, current]) for (const shape of objects(value.shapes)) if (shape.id === args.shape_id) {
      if (tool === "slide_set_text") delete shape.text;
      if (Object.hasOwn(args, "font_size")) delete shape.font_size;
    }
    if (officeProofJson(page) !== officeProofJson(current)) fail();
    return;
  }
  fail();
}

import type { OfficeSelectionLocator } from "@jugglework/types/office";
import { ApiError } from "../errors.js";

type Value = Record<string, unknown>;
type Query = (name: string, args?: Value) => Promise<Value>;
export const SLIDE_PAGE_MAX_SHAPES = 128;
export const SLIDE_PAGE_MAX_TEXT = 16_384;
export const SLIDE_PAGE_MAX_BOX_TEXT = 4096;
export const SLIDE_PAGE_MAX_PROOF = 4 * 1024 * 1024;
export interface SlidePageShape {
  id: string;
  type: string;
  editable: boolean;
  reason: string;
  detail: Value;
  table?: Value;
  group?: Value;
}
export interface SlidePageState extends Value {
  kind: "slide-page";
  revision: number;
  pageIds: string[];
  pageIndex: number;
  pageId: string;
  size: { w: number; h: number; wEmu: number; hEmu: number };
  page: Value;
  shapes: SlidePageShape[];
  texts: Value[];
}
const json = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
function unavailable(message = "无法完整核对整页对象，请缩小选择范围"): never {
  throw new ApiError(409, "office_selection_proof_unavailable", message);
}
function unsupported(message: string): never { throw new ApiError(409, "office_selection_slide_objects_unsupported", message); }
function obj(value: unknown): Value {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  return value as Value;
}
function list(value: unknown): Value[] { if (!Array.isArray(value)) unavailable(); return value.map(obj); }
function int(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) unavailable(); return value; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function stable(value: Value): Value { const { version: _version, ...rest } = value; return rest; }
function same(a: unknown, b: unknown): boolean { return json(a) === json(b); }

/** 页引用只绑定一个真实原生页；页序号本身不构成采集身份。 */
export function slidePageIndex(locator: OfficeSelectionLocator): number {
  if (locator.kind !== "slide-pages" || locator.pageIndices.length !== 1)
    throw new ApiError(409, "office_selection_slide_pages_unsupported", "首版整页编辑只支持单页；请选择一页后重新发送，多页整页编辑暂不支持");
  return int(locator.pageIndices[0]);
}

/** 保留所有公开 run 字段；严格证明 UTF-16 全覆盖，不能采信首字符样式摘要。 */
function validateText(text: Value): number {
  if (typeof text.text !== "string" || text.text.length !== int(text.length) || text.text.length > SLIDE_PAGE_MAX_BOX_TEXT + 1 ||
      (text.text !== "" && !text.text.endsWith("\r")) || /[\u0000\ufffc]/.test(text.text) || !Array.isArray(text.hyperlinks)) unavailable("文本长度、嵌入内容或完整 runs 无法核对");
  const runs = list(text.runs), paragraphs = list(text.paragraphs);
  if (!text.text.length && (runs.length || paragraphs.length || text.hyperlinks.length)) unavailable("无 text body 形状必须返回完整空文字、空 runs/paragraphs/hyperlinks");
  for (const run of runs) {
    for (const key of ["bold", "italic", "is_hyperlink"]) if (run[key] !== undefined && typeof run[key] !== "boolean") unavailable("run 样式类型无法核对");
    if (run.font_size !== undefined && !positive(run.font_size)) unavailable();
    for (const key of ["font_name", "color"]) if (run[key] !== undefined && typeof run[key] !== "string") unavailable();
  }
  list(text.hyperlinks);
  for (const items of [runs, paragraphs]) {
    let end = 0;
    for (const item of items) {
      if (int(item.start) !== end || int(item.end) <= end || int(item.end) > text.text.length) unavailable("文本 runs 或段落有缺漏、重复或越界");
      end = int(item.end);
    }
    if (end !== text.text.length) unavailable("文本 runs 或段落未完整覆盖");
  }
  // SDK 的 paragraphs 是格式分组，不总是 CR 段落边界；仅验证完整覆盖，不推测段落样式。
  return text.text.length;
}

/** 按类型读取全部公开可核对事实。未知对象明确拒绝，group 子项递归读取而非仅保留摘要。 */
export async function readSlidePageState(query: Query, locator: OfficeSelectionLocator): Promise<SlidePageState> {
  const pageIndex = slidePageIndex(locator);
  const info = await query("slide_get_info");
  const revision = int(info.version), pageIds = info.slide_ids;
  // 原生 *_pt 摘要会取整；页大小的真实边界只由正整数 EMU 派生。
  const wEmu = int(info.w_emu), hEmu = int(info.h_emu), w = wEmu / 12700, h = hEmu / 12700;
  if (!Array.isArray(pageIds) || pageIds.length !== int(info.slide_count) ||
      !pageIds.every((id) => typeof id === "string" && id) || new Set(pageIds).size !== pageIds.length ||
      !pageIds[pageIndex] || !wEmu || !hEmu || info.w_pt !== Math.round(w) || info.h_pt !== Math.round(h)) unavailable();
  const pageId = pageIds[pageIndex] as string;
  const read = async (name: string, args: Value = {}) => {
    const result = await query(name, { page_index: pageIndex, ...args });
    if (result.version !== revision || (result.page_index !== undefined && result.page_index !== pageIndex) ||
        (result.page_id !== undefined && result.page_id !== pageId)) unavailable("幻灯片正在变化，请重新选择");
    return stable(result);
  };
  const page = await read("slide_get_page_info"), top = list(page.shapes);
  if (page.page_id !== pageId || page.page_index !== pageIndex || int(page.shape_count) !== top.length ||
      top.length > SLIDE_PAGE_MAX_SHAPES || !Array.isArray(page.animations) || int(page.anim_count) !== page.animations.length) unavailable();
  const shapes: SlidePageShape[] = [], texts: Value[] = [], ids = new Set<string>();
  let characters = 0;
  const reserve = (text: Value) => { characters += validateText(text); if (characters > SLIDE_PAGE_MAX_TEXT) unavailable("整页文字超过 16384 UTF-16 核对预算"); };
  let rootParent: string | undefined;
  const visit = async (summary: Value, parentId?: string) => {
    const id = summary.id;
    if (typeof id !== "string" || !id || ids.has(id) || ids.size >= SLIDE_PAGE_MAX_SHAPES || typeof summary.type !== "string") unavailable("页内 shape_id 重复、缺漏或对象超过 128 个");
    ids.add(id);
    if (!["shape", "picture", "table", "group", "connector"].includes(summary.type))
      unsupported(`整页包含尚无完整读取适配的 ${summary.type} 对象（${id}），不能证明其保留效果；请选择普通文本框`);
    const detail = await read("slide_get_shape_info", { shape_id: id });
    if (detail.id !== id || detail.type !== summary.type || detail.page_id !== pageId || detail.page_index !== pageIndex ||
        typeof detail.parent_id !== "string" || !detail.parent_id) unavailable();
    if (parentId ? detail.parent_id !== parentId : rootParent !== undefined && detail.parent_id !== rootParent) unavailable("对象父级身份无法核对");
    if (!parentId) rootParent = detail.parent_id as string;
    const bounds = obj(detail.bounds);
    if (typeof detail.is_placeholder !== "boolean" || typeof detail.name !== "string") unavailable("对象详情缺少完整公开身份属性");
    const geometry = ["shape", "picture", "connector"].includes(summary.type) ? obj(detail.style).geometry : undefined;
    if (["shape", "picture", "connector"].includes(summary.type) && typeof geometry !== "string") unavailable("对象几何样式无法完整核对");
    // SDK 线条既可能是 shape，也可能是导入的 connector；不能仅凭零尺寸或含 text 判为普通框。
    const line = (summary.type === "shape" || summary.type === "connector") && geometry === "line";
    // 公开 getter 仅提供整数 pt；不以容差或换算伪造亚 pt 对象证明。
    for (const key of ["x", "y", "w", "h"]) if (!Number.isSafeInteger(bounds[key]) ||
        (summary[key] !== undefined && summary[key] !== bounds[key])) unavailable("对象位置与详细读取不一致");
    const width = int(bounds.w), height = int(bounds.h);
    if (line ? !width && !height : !width || !height) unavailable();
    const body = detail.body_pr === undefined ? {} : obj(detail.body_pr);
    const ordinary = summary.type === "shape" && !line && typeof detail.text === "string" && detail.is_placeholder === false &&
      !parentId && (bounds.rotation === undefined || bounds.rotation === 0) &&
      !bounds.flip_h && !bounds.flip_v && !body.rot_deg && (body.vert === undefined || body.vert === "horz") && !body.from_word_art && !body.has_prst_tx_warp &&
      body.autofit_type !== "spAutoFit";
    const shape: SlidePageShape = { id, type: summary.type, editable: ordinary, reason: ordinary ? "普通顶层文本框" : "保留对象：仅可读取，不可改写或移动", detail };
    shapes.push(shape);
    if (summary.type === "shape") {
      const text = await read("slide_get_text", { shape_id: id });
      if (text.shape_id !== id || text.ok !== true || (detail.text === undefined ? text.text !== "" : text.text !== detail.text) ||
          (summary.text !== undefined && summary.text !== text.text)) unavailable();
      reserve(text); texts.push({ shapeId: id, ...text });
      if (text.length === 0) { shape.editable = false; shape.reason = "保留对象：无 text body 的装饰形状，仅可读取"; }
    } else if (summary.type === "picture") {
      if (typeof detail.image_embed_id !== "string" || !detail.image_embed_id || summary.img !== detail.image_embed_id) unavailable("图片资源身份无法核对");
    } else if (summary.type === "table") {
      const table = await read("slide_get_table_info", { shape_id: id });
      const rows = int(table.row_count), cols = int(table.col_count), cells = list(table.cells);
      if (!rows || !cols || rows * cols > 256 || cells.length !== rows * cols ||
          !Array.isArray(table.row_heights) || table.row_heights.length !== rows || !table.row_heights.every(positive) ||
          !Array.isArray(table.col_widths) || table.col_widths.length !== cols || !table.col_widths.every(positive)) unavailable("仅支持可完整核对的最多 256 格简单表格");
      const text = await read("slide_get_text", { shape_id: id }), richCells = list(text.cells);
      if (text.ok !== true || text.shape_id !== id || richCells.length !== cells.length) unavailable();
      cells.forEach((cell, i) => {
        const row = Math.floor(i / cols), col = i % cols, rich = richCells[i];
        if (cell.row !== row || cell.col !== col || rich.row !== row || rich.col !== col ||
            cell.anchor_row !== row || cell.anchor_col !== col || rich.anchor_row !== row || rich.anchor_col !== col ||
            cell.row_span !== 1 || cell.col_span !== 1 || cell.is_merge_continue || rich.is_merge_continue)
          unsupported("首版整页保留仅支持无合并的简单表格；合并格暂无法完整核对");
        reserve(rich);
        if (`${cell.text}\r` !== rich.text) unavailable("表格摘要与完整文字不一致");
      });
      shape.table = table; texts.push({ shapeId: id, ...text });
    } else if (summary.type === "group") {
      const group = await read("slide_get_group_info", { group_id: id });
      // page-info 与 group-info 必须枚举相同的真实子项，缺少任一完整枚举即拒绝。
      const children = list(summary.children), full = list(group.children);
      if (group.group_id !== id || group.ok !== true || int(group.child_count) !== children.length || !same(children, full)) unavailable("组合对象的完整子项无法核对");
      shape.group = group;
      for (const child of children) await visit(child, id);
    }
  };
  for (const summary of top) await visit(summary);
  if (rootParent && ids.has(rootParent)) unavailable("顶层对象父级与页内对象身份冲突");
  const end = await query("slide_get_info");
  if (end.version !== revision || !same(end.slide_ids, pageIds) || end.w_emu !== wEmu || end.h_emu !== hEmu ||
      end.w_pt !== Math.round(w) || end.h_pt !== Math.round(h)) unavailable("幻灯片正在变化，请重新选择");
  const state: SlidePageState = { kind: "slide-page", revision, pageIds: pageIds as string[], pageIndex, pageId,
    size: { w, h, wEmu, hEmu }, page, shapes, texts };
  if (Buffer.byteLength(json(state)) > SLIDE_PAGE_MAX_PROOF) unavailable("整页证明超过 4 MiB 核对预算");
  return state;
}

/** planner 只消费 Server 已核对的 baseline，不接收 Agent 提交的对象目录。 */
export function slidePageScope(state: Value | undefined, locator: OfficeSelectionLocator): SlidePageState {
  const pageIndex = slidePageIndex(locator);
  if (state?.kind !== "slide-page" || state.pageIndex !== pageIndex || state.pageId !== (state.pageIds as string[])?.[pageIndex]) unavailable("整页引用缺少当前已核对的对象目录");
  return state as SlidePageState;
}
export function slidePageDescriptor(state: SlidePageState) {
  return { pageIndex: state.pageIndex, pageId: state.pageId, size: state.size,
    editable: state.shapes.filter((s) => s.editable).map((s) => s.id),
    preserved: state.shapes.filter((s) => !s.editable).map((s) => ({ shapeId: s.id, type: s.type, reason: s.reason })),
    verification: "核对公开对象详情、全部文字 runs、简单表格网格和文字、图片资源身份；对象几何仅覆盖原生 getter 的整数 pt 事实，无法检测仍落在同一取整值内的跨对象亚 pt 误改，不证明亚 pt 保真、SDK 未公开的包内属性或图片字节；页边界由整数 EMU 精确派生" };
}
export function slidePageGetter(state: SlidePageState, tool: string, args: Value): Value {
  if (tool === "slide_get_page_info") return { ...structuredClone(state.page), version: state.revision, scope: slidePageDescriptor(state) };
  const shape = state.shapes.find((s) => s.id === args.shape_id);
  if (!shape) unavailable();
  if (tool === "slide_get_shape_info") return { ...structuredClone(shape.detail), version: state.revision, editable: shape.editable, reason: shape.reason, ...(shape.table ? { table: structuredClone(shape.table) } : {}), ...(shape.group ? { group: structuredClone(shape.group) } : {}) };
  const text = state.texts.find((t) => t.shapeId === shape.id);
  if (!text) unsupported(`对象 ${shape.id}（${shape.type}）没有可读取文字`);
  const { shapeId: _shapeId, ...output } = structuredClone(text);
  return { ...output, version: state.revision };
}

/** 写前计算新总文字及最坏 run 分裂证明预算；预算拒绝不得产生原生写入。 */
export function validateSlidePageBudget(state: SlidePageState, tool: string, args: Value): number {
  const target = state.texts.find((t) => t.shapeId === args.shape_id);
  let total = 0, bytes = Buffer.byteLength(json({ ...state, texts: [] }));
  for (const text of state.texts) {
    const items = text.cells ? list(text.cells) : [text];
    for (const item of items) {
      const length = tool === "slide_set_text" && text === target ? (args.text as string).length + 1 : int(item.length);
      total += length;
      // 所有原有 style 字段保留；每字符一个 run 加一个 paragraph 的保守上界。
      const styles = list(item.runs).map(({ start: _s, end: _e, ...style }) => Buffer.byteLength(json({ ...style, bold: true, italic: true, color: "FFFFFF", font_size: 400 })));
      bytes += length * (Math.max(128, ...styles) + 128) + length * 8 + 2048;
    }
  }
  // page 与 detail 同时含正文，扩写按最坏 JSON 转义长度预算。
  if (tool === "slide_set_text") bytes += (args.text as string).length * 12;
  if (total > SLIDE_PAGE_MAX_TEXT || bytes > SLIDE_PAGE_MAX_PROOF) unavailable("修改后整页超过 16384 UTF-16 或 4 MiB 完整核对预算，请缩小改写");
  return bytes;
}

/** 按字符比较公开 run 事实；缺省与显式值不同，绝不以首字符摘要补全其他 run。 */
function characters(text: Value): Value[] {
  const runs = list(text.runs);
  return Array.from({ length: int(text.length) }, (_, i) => {
    const run = runs.find((r) => int(r.start) <= i && int(r.end) > i);
    if (!run) unavailable();
    const { start: _s, end: _e, ...style } = run;
    return style;
  });
}

/** 一次纯文字/样式/transform 的真实 SDK version 均 +1；其他公开事实逐项不变。 */
export function verifySlidePageEdit(before: Value, after: Value, tool: string, args: Value): void {
  const fail: () => never = () => { throw new ApiError(409, "office_selection_edit_unconfirmed", "整页修改结果尚未确认，请检查后重新选择，不要重复执行"); };
  const old = structuredClone(before) as SlidePageState, next = structuredClone(after) as SlidePageState;
  if (next.kind !== "slide-page" || next.revision !== old.revision + 1) fail();
  const target = old.shapes.find((s) => s.id === args.shape_id), changed = next.shapes.find((s) => s.id === args.shape_id);
  if (!target?.editable || !changed?.editable) fail();
  const text = old.texts.find((t) => t.shapeId === target.id), updated = next.texts.find((t) => t.shapeId === target.id);
  if (!text || !updated) fail();
  if (tool === "slide_set_text") {
    if (updated.text !== `${args.text}\r`) fail();
    // 允许所选整框的 run 格式重置；非文本 body/shape 属性仍逐项比较。
    old.texts = old.texts.filter((t) => t.shapeId !== target.id);
    next.texts = next.texts.filter((t) => t.shapeId !== target.id);
    for (const state of [old, next]) {
      delete state.shapes.find((s) => s.id === target.id)!.detail.text;
      delete list(state.page.shapes).find((s) => s.id === target.id)!.text;
      // 首字符派生摘要随 run 重置；只有完整目标 runs 允许变化。
      for (const key of ["font_color", "font_name", "font_size"]) {
        delete state.shapes.find((s) => s.id === target.id)!.detail[key];
        delete list(state.page.shapes).find((s) => s.id === target.id)![key];
      }
    }
  } else if (tool === "slide_set_text_property") {
    if (text.text !== updated.text) fail();
    const original = characters(text), expected = structuredClone(original), actual = characters(updated);
    const begin = args.index as number, end = begin + (args.count as number);
    for (let i = begin; i < end; i++) for (const key of ["bold", "italic", "color", "font_size"]) if (Object.hasOwn(args, key)) expected[i][key] = args[key];
    // SDK 会把完整末段样式实体化到尾 CR；只接受末段全选时的已验证派生效果。
    const content = text.text as string, tail = content.length - 1;
    if (end === tail && begin <= content.lastIndexOf("\r", tail - 1) + 1)
      for (const key of ["bold", "italic", "color", "font_size"]) if (Object.hasOwn(args, key) && actual[tail]?.[key] === args[key]) expected[tail][key] = args[key];
    // 真实 SDK 首次格式化会仅把末尾 CR 的 font_name/font_size 从前一个字符显式展开。
    // 只接受原尾 CR 缺省且展开值严格等于原相邻字符的事实；不从 detail 摘要或新首字推断。
    if (content.endsWith("\r") && tail > 0) for (const key of ["font_name", "font_size"]) {
      if (!Object.hasOwn(expected[tail], key) && Object.hasOwn(original[tail - 1], key) && actual[tail][key] === original[tail - 1][key])
        expected[tail][key] = original[tail - 1][key];
    }
    if (!same(expected, actual)) fail();
    // paragraphs 的原生格式分组可合并；正文、hyperlinks 和其余公开字段仍不变。
    for (const item of [text, updated]) { delete item.runs; delete item.paragraphs; }
    for (const state of [old, next]) for (const key of ["font_color", "font_size"]) {
      const argKey = key === "font_color" ? "color" : key;
      if (Object.hasOwn(args, argKey)) {
        const detail = state.shapes.find((s) => s.id === target.id)!.detail, summary = list(state.page.shapes).find((s) => s.id === target.id)!;
        delete detail[key]; delete summary[key];
      }
    }
  } else if (tool === "slide_set_shape_properties") {
    const bounds = obj(target.detail.bounds), summary = list(old.page.shapes).find((s) => s.id === target.id)!;
    for (const key of ["x", "y", "w", "h"]) if (Object.hasOwn(args, key)) { bounds[key] = args[key]; summary[key] = args[key]; }
  } else fail();
  old.revision = next.revision;
  if (!same(old, next)) fail();
}

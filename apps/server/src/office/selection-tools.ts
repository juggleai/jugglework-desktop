import type {
  OfficeGridRange,
  OfficeSelectionLocator,
  OfficeTextRange,
} from "@jugglework/types/office";
import { ApiError } from "../errors.js";
import type { OfficeToolDefinition } from "./content-tools.js";
import { slidePageScope, validateSlidePageBudget } from "./slide-page-proof.js";

const DOC_STYLE_KEYS = [
  "bold", "italic", "underline", "strikethrough", "double_strike", "small_caps",
  "color", "background_color", "highlight", "font_size", "font_family",
  "vertical_align", "clear_properties",
] as const;
const SLIDE_STYLE_KEYS = [
  "bold", "italic", "underline", "strikethrough", "color", "font_name",
  "font_size", "letter_spacing", "baseline", "hyperlink", "hyperlink_tooltip",
] as const;
const GRID_KEYS = ["start_row", "end_row", "start_col", "end_col"] as const;
const SHEET_STYLE_TYPES = { background_color: "string", font_color: "string", font_family: "string", font_size: "number", bold: "boolean", italic: "boolean", horizontal_align: "string", vertical_align: "string", number_format_pattern: "string", strike_through: "boolean", underline: "string", wrap_text: "boolean" } as const;

/** 选区通道对原生工具的宿主适配契约；跨段文本由宿主分解，不能冒称原生接口直接支持。 */
export function describeOfficeSelectionTool(tool: OfficeToolDefinition, locator?: OfficeSelectionLocator | number): OfficeToolDefinition {
  if (typeof locator === "object" && locator.kind === "slide-pages" && officeSelectionToolNames(locator).includes(tool.name)) {
    const adapted = structuredClone(tool);
    const keys = ["file_id", "page_index", ...(tool.name === "slide_get_page_info" ? [] : ["shape_id"]),
      ...(tool.name === "slide_set_text" ? ["text"] : tool.name === "slide_set_text_property" ? ["index", "count", "bold", "italic", "color", "font_size"]
        : tool.name === "slide_set_shape_properties" ? ["x", "y", "w", "h"] : [])];
    const props = adapted.inputSchema.properties as Record<string, unknown>;
    adapted.inputSchema.properties = Object.fromEntries(keys.filter((key) => Object.hasOwn(props, key)).map((key) => [key, props[key]]));
    const selected = adapted.inputSchema.properties as Record<string, unknown>;
    if (selected.shape_id) selected.shape_id = { type: "string", minLength: 1, description: "当前整页 baseline 目录中的单个真实 shape_id；写入仅支持 editable=true 的普通顶层文本框。" };
    if (selected.text) selected.text = { type: "string", minLength: 1, maxLength: 4096, description: "最多4096 UTF-16（宿主精确校验）；LF/CRLF 转 CR，SDK 额外追加一个尾 CR；整框重写重置字符样式；当前 SDK 无法清空。" };
    if (selected.index) selected.index = { type: "integer", minimum: 0, description: "最新已核对文字的 UTF-16 起点；省略为0。改写后必须按新文字确定范围。" };
    if (selected.count) selected.count = { type: "integer", minimum: 1, description: "最新文字的 UTF-16 长度；省略为整框长度（含尾 CR），不支持 -1。index/count 须完整落在当前文字中。" };
    if (selected.color) selected.color = { type: "string", pattern: "^#?[0-9A-Fa-f]{6}$", description: "六位 RGB，允许 # 前缀。" };
    if (selected.font_size) selected.font_size = { type: "number", exclusiveMinimum: 0, maximum: 400, multipleOf: 0.01, description: "字号 pt，(0,400]，最多两位小数。" };
    for (const key of ["x", "y", "w", "h"]) if (selected[key]) selected[key] = { type: "integer", minimum: key === "x" || key === "y" ? 0 : 1, description: "仅接受整数 pt；原生对象 getter 仅返回整数 pt，无法证明亚 pt 保真或检测同取整值内的跨对象亚 pt 误改。目标框须完整位于按 EMU 派生的页边界内。" };
    adapted.inputSchema.additionalProperties = false;
    adapted.inputSchema.required = [...(tool.name === "slide_get_page_info" ? [] : ["shape_id"]), ...(tool.name === "slide_set_text" ? ["text"] : [])];
    adapted.description = "单页固定引用。file_id/page_index 可省略由宿主绑定；只接受当前已核对对象目录中的单个 shape_id，不支持批量。" + ({
      slide_get_page_info: "返回整页公开布局、对象身份及可编辑/保留目录；详情和完整 runs 分别用 get_shape_info/get_text 读取。",
      slide_get_shape_info: "返回公开完整对象详情；简单表格附完整网格，组合附子项。复杂对象只保留。",
      slide_get_text: "返回普通框完整 UTF-16 text/length/runs/paragraphs/hyperlinks；表格返回全部 cells。无 index/count/row/col 参数。",
      slide_set_text: "整框改写普通顶层非旋转文本框，最多4096 UTF-16，LF/CRLF 转 CR，原生追加尾 CR（输入尾 CR 保留为空段）。重置该框字符样式，随后读取新坐标再设样式。当前 SDK 不接受空字符串，清空暂不支持。页引用可连续使用。",
      slide_set_text_property: "只支持 bold/italic/color/font_size；省略 index/count 则按最新 baseline 绑定整框（含尾 CR），显式范围须处于当前文字。字号 (0,400] 且百分之一磅精度，颜色六位 RGB。",
      slide_set_shape_properties: "只允许普通顶层非旋转文本框的整数 pt x/y/w/h；x/y>=0、w/h>0且整个框必须在页内。公开几何证明仅覆盖整数 pt，无法检测同一取整值内的跨对象亚 pt 误改或保证亚 pt 保真。不含视觉、旋转、批量属性。对齐分布需先读位置计算目标再逐框设置。",
    }[tool.name] ?? "");
    return adapted;
  }
  if (tool.name !== "doc_replace_text") return tool;
  const adapted = structuredClone(tool);
  adapted.description = "替换本轮固定 Word 选区中的正文。可省略 ranges，由宿主绑定；跨段改写必须保留原有段数（含空段），text 按原段落顺序用换行分隔，每段最多 200 个 UTF-16 码元。office.selection 的 contents 提供完整所选段落。宿主按段精确替换并保留段落及未选正文；暂不支持合并或拆分段落。修改后须重新选择。";
  const properties = adapted.inputSchema.properties as Record<string, unknown>;
  properties.text = { ...(properties.text as object), description: "替换文字；跨段时按 contents.ranges[].paragraphs 的段数提供换行分隔内容，包含空段；支持 LF、CRLF、CR。" };
  adapted.inputSchema.required = (adapted.inputSchema.required as string[]).filter((key) => key !== "ranges" && key !== "file_id");
  return adapted;
}

/** 范围解析结果；进入原生调用前仍须核对引用归属、模型代次及完整内容证明。 */
export interface OfficeSelectionToolPlan {
  args: Record<string, unknown>;
  effect: "read" | "content" | "coordinates";
}

function invalid(message = "修改范围超出了固定选区，请重新选择要修改的内容"): never {
  throw new ApiError(409, "office_selection_out_of_bounds", message);
}

function index(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function fields(input: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(input).some((key) => key !== "file_id" && !keys.includes(key)))
    invalid("选区工具包含尚未适配的参数，不能扩大修改范围");
}

/** 身份缺省时由宿主补齐；显式冲突即拒绝，不能静默修正到另一文件或子表。 */
function bind(input: Record<string, unknown>, key: string, identity: string | number): void {
  if (Object.hasOwn(input, key) && input[key] !== identity)
    invalid("工具目标与固定选区不一致");
  input[key] = identity;
}

function textRanges(value: unknown, allowed: OfficeTextRange[]): OfficeTextRange[] {
  if (!Array.isArray(value) || !value.length) invalid();
  const ranges = value.map((range) => {
    if (!record(range)) invalid();
    if (Object.keys(range).some((key) => key !== "begin" && key !== "end")) invalid();
    const { begin, end } = range;
    if (!index(begin) || !index(end) || end <= begin) invalid();
    if (!allowed.some((outer) => begin >= outer.begin && end <= outer.end)) invalid();
    return { begin, end };
  });
  const sorted = [...ranges].sort((left, right) => left.begin - right.begin);
  if (sorted.some((range, i) => i > 0 && range.begin < sorted[i - 1].end)) invalid();
  return ranges;
}

function gridRange(input: Record<string, unknown>, allowed: OfficeGridRange[]): void {
  const present = GRID_KEYS.filter((key) => Object.hasOwn(input, key));
  if (!present.length && allowed.length === 1) {
    const range = allowed[0];
    Object.assign(input, {
      start_row: range.startRow, end_row: range.endRow,
      start_col: range.startCol, end_col: range.endCol,
    });
  } else if (present.length !== GRID_KEYS.length) invalid();
  const { start_row: startRow, end_row: endRow, start_col: startCol, end_col: endCol } = input;
  if (!index(startRow) || !index(endRow) || endRow < startRow ||
      !index(startCol) || !index(endCol) || endCol < startCol) invalid();
  // TIPS: 必须完整包含于某一个所选矩形；不能用多块选区的包围框授权中间空隙。
  if (!allowed.some((range) => startRow >= range.startRow && endRow <= range.endRow &&
      startCol >= range.startCol && endCol <= range.endCol)) invalid();
}

function textStyleRange(input: Record<string, unknown>, start: number, count: number): void {
  if (!Object.hasOwn(input, "index")) input.index = start;
  if (!Object.hasOwn(input, "count")) input.count = count;
  if (!index(input.index) || !index(input.count) || !input.count ||
      !Number.isSafeInteger(input.index + input.count) ||
      input.index < start || input.index + input.count > start + count) invalid();
}

/**
 * 列出已建立明确坐标映射的工具；不代表内容证明、回读或 UI 能力已经开放。
 * @param locator 宿主已规范化的固定定位，未知对象不能回退为整篇或整页编辑
 */
export function officeSelectionToolNames(locator: OfficeSelectionLocator): readonly string[] {
  switch (locator.kind) {
    case "doc-text":
      return ["doc_replace_text", "doc_update_text_property", "doc_get_text_property"];
    case "doc-caret":
      return ["doc_insert_text"];
    case "sheet-cells":
      return ["sheet_set_cell_value", "sheet_set_cell_style", "sheet_get_cell_data"];
    case "sheet-rows":
    case "sheet-columns":
      return ["sheet_delete_dimension"];
    case "slide-shapes":
      return ["slide_set_text", "slide_get_text"];
    case "slide-text":
      return ["slide_set_text_property", "slide_get_text"];
    case "slide-pages":
      if (locator.pageIndices.length !== 1) return [];
      return ["slide_get_page_info", "slide_get_shape_info", "slide_get_text", "slide_set_text", "slide_set_text_property", "slide_set_shape_properties"];
  }
}

/**
 * 从固定定位派生配套 SDK 参数，允许显式更小范围，拒绝冲突及未知扩大范围的参数。
 * @param locator 宿主持有的规范化选区；完整正文边界、合并区域及页顺序需由引用证明核对
 * @param fileId 宿主绑定的真实模型 ID，不能使用页面预览 ID
 * @param tool 已适配的原生内容工具名
 * @param input Agent 提供的新内容、样式及可选的选区内定位
 * @returns 只负责范围解析的计划；调用方必须另行完成写前证明和写后确认
 */
export function planOfficeSelectionTool(
  locator: OfficeSelectionLocator,
  fileId: string,
  tool: string,
  input: Record<string, unknown>,
  proofState?: Record<string, unknown>,
): OfficeSelectionToolPlan {
  if (!fileId || !record(input)) invalid("选区所属模型不可用");
  if (!officeSelectionToolNames(locator).includes(tool))
    throw new ApiError(409, "office_selection_tool_unavailable", "该选区尚不支持此操作");
  const args = structuredClone(input);
  bind(args, "file_id", fileId);
  if (Object.hasOwn(args, "color")) {
    if (typeof args.color !== "string" || !/^#?(?:[\da-f]{6}|[\da-f]{8})$/i.test(args.color)) invalid("请选择有效的十六进制文字颜色");
    args.color = args.color.replace(/^#/, "").toUpperCase();
  }
  let effect: OfficeSelectionToolPlan["effect"] = "content";
  switch (locator.kind) {
    case "doc-text": {
      if (tool === "doc_get_text_property") {
        fields(args, ["idx"]);
        const idx = args.idx;
        if (!index(idx) || !locator.ranges.some((range) => idx >= range.begin && idx < range.end)) invalid();
        effect = "read";
        break;
      }
      fields(args, ["ranges", ...(tool === "doc_replace_text" ? ["text"] : DOC_STYLE_KEYS)]);
      args.ranges = textRanges(Object.hasOwn(args, "ranges") ? args.ranges : locator.ranges, locator.ranges);
      if (tool === "doc_replace_text") {
        if (typeof args.text !== "string") invalid("请输入替换后的文字");
        if ((args.ranges as OfficeTextRange[]).length !== 1)
          invalid("多个文字范围的替换请拆分执行");
        // 即使可见字符数相等，DOC 结构坐标也不能据此推定不变。
        effect = "coordinates";
      } else if (!DOC_STYLE_KEYS.some((key) => Object.hasOwn(args, key)))
        invalid("请选择要修改的文字样式");
      break;
    }
    case "doc-caret":
      fields(args, ["idx", "text"]);
      bind(args, "idx", locator.idx);
      if (typeof args.text !== "string" || !args.text.length) invalid("请输入要插入的文字");
      effect = "coordinates";
      break;
    case "sheet-cells": {
      bind(args, "sheet_id", locator.sheetId);
      if (tool === "sheet_set_cell_value") {
        fields(args, ["sheet_id", "cell"]);
        if (!record(args.cell)) invalid("请指定选区内要修改的单元格");
        const { row, col } = args.cell;
        if (!index(row) || !index(col) || !locator.ranges.some((range) =>
          row >= range.startRow && row <= range.endRow && col >= range.startCol && col <= range.endCol)) invalid();
        if (Object.keys(args.cell).some((key) => ![
          "row", "col", "value_type", "number_value", "string_value", "bool_value", "formula",
        ].includes(key))) invalid();
        const valueKeys = { NUMBER: "number_value", STRING: "string_value", BOOL: "bool_value", FORMULA: "formula" } as const;
        const type = args.cell.value_type as keyof typeof valueKeys, key = valueKeys[type];
        if (!key || typeof args.cell[key] !== (type === "NUMBER" ? "number" : type === "BOOL" ? "boolean" : "string") ||
          (type === "NUMBER" && !Number.isFinite(args.cell[key])) || Object.values(valueKeys).some((other) => other !== key && Object.hasOwn(args.cell as object, other))) invalid("请提供单一且类型匹配的单元格内容");
      } else {
        fields(args, ["sheet_id", ...GRID_KEYS, ...(tool === "sheet_get_cell_data"
          ? ["return_csv", "include_formula", "return_formula"] : ["format", "is_clear"])]);
        gridRange(args, locator.ranges);
        if (tool === "sheet_get_cell_data") effect = "read";
        else if (!record(args.format) || !Object.keys(args.format).length)
          invalid("请选择要修改的单元格样式");
        else {
          for (const [key, value] of Object.entries(args.format)) {
            if (!Object.hasOwn(SHEET_STYLE_TYPES, key) || typeof value !== SHEET_STYLE_TYPES[key as keyof typeof SHEET_STYLE_TYPES]) invalid("该单元格样式参数尚未适配");
            if (key === "font_size" && (!index(value) || value === 0)) invalid("字号必须为正整数");
            if (key === "background_color" || key === "font_color") {
              if (typeof value !== "string" || !/^#?[\da-f]{8}$/i.test(value)) invalid("表格颜色必须是八位 ARGB 十六进制值");
              args.format[key] = value.replace(/^#/, "").toUpperCase();
            }
          }
        }
      }
      break;
    }
    case "sheet-rows":
    case "sheet-columns": {
      fields(args, ["sheet_id", "dimension_type", "index", "count"]);
      bind(args, "sheet_id", locator.sheetId);
      bind(args, "dimension_type", locator.kind === "sheet-rows" ? "row" : "col");
      if (!Object.hasOwn(args, "index") && !Object.hasOwn(args, "count") && locator.ranges.length === 1) {
        args.index = locator.ranges[0].start;
        args.count = locator.ranges[0].end - locator.ranges[0].start + 1;
      }
      if (!index(args.index) || !index(args.count) || !args.count ||
          !Number.isSafeInteger(args.index + args.count) ||
          !locator.ranges.some((range) => (args.index as number) >= range.start &&
            (args.index as number) + (args.count as number) - 1 <= range.end)) invalid();
      effect = "coordinates";
      break;
    }
    case "slide-shapes":
    case "slide-text": {
      bind(args, "page_index", locator.pageIndex);
      const shapeIds = locator.kind === "slide-text" ? [locator.shapeId] : locator.shapeIds;
      if (!Object.hasOwn(args, "shape_id") && shapeIds.length === 1) args.shape_id = shapeIds[0];
      if (typeof args.shape_id !== "string" || !shapeIds.includes(args.shape_id)) invalid();
      if (tool === "slide_get_text") {
        fields(args, ["page_index", "shape_id"]);
        effect = "read";
      } else if (tool === "slide_set_text") {
        fields(args, ["page_index", "shape_id", "text"]);
        if (typeof args.text !== "string") invalid("请输入替换后的文字");
        // 重写整框后，框内旧 UTF-16 子范围也必须失效，不能仅推进内容基线。
        effect = "coordinates";
      } else {
        fields(args, ["page_index", "shape_id", "index", "count", ...SLIDE_STYLE_KEYS]);
        if (locator.kind !== "slide-text") invalid();
        textStyleRange(args, locator.start, locator.count);
        if (!SLIDE_STYLE_KEYS.some((key) => key !== "hyperlink_tooltip" && Object.hasOwn(args, key)))
          invalid("请选择要修改的文字样式");
      }
      break;
    }
    case "slide-pages": {
      const state = slidePageScope(proofState, locator);
      bind(args, "page_index", state.pageIndex);
      if (tool === "slide_get_page_info") { fields(args, ["page_index"]); effect = "read"; break; }
      const shape = state.shapes.find((item) => item.id === args.shape_id);
      if (!shape) invalid("shape_id 不属于当前已核对整页对象目录");
      if (tool === "slide_get_shape_info" || tool === "slide_get_text") {
        fields(args, ["page_index", "shape_id"]); effect = "read"; break;
      }
      if (!shape.editable) invalid("该对象只保留；仅可修改普通顶层非组合非旋转文本框");
      if (tool === "slide_set_text") {
        fields(args, ["page_index", "shape_id", "text"]);
        if (typeof args.text !== "string") invalid("请输入替换文字");
        args.text = args.text.replace(/\r\n|\n/g, "\r");
        if (!(args.text as string).length) invalid("当前 SDK 不接受空字符串，暂不支持清空文本框；请在原生编辑器中清空");
        if ((args.text as string).length > 4096 || /[\u0000\ufffc]/.test(args.text as string)) invalid("整框文字不能超过 4096 UTF-16，不能包含嵌入对象或 NUL");
      } else if (tool === "slide_set_text_property") {
        fields(args, ["page_index", "shape_id", "index", "count", "bold", "italic", "color", "font_size"]);
        const text = state.texts.find((item) => item.shapeId === shape.id);
        if (!text || typeof text.length !== "number") invalid();
        textStyleRange(args, 0, text.length);
        if (!["bold", "italic", "color", "font_size"].some((key) => Object.hasOwn(args, key))) invalid("请选择文字样式");
        for (const key of ["bold", "italic"]) if (Object.hasOwn(args, key) && typeof args[key] !== "boolean") invalid();
        if (Object.hasOwn(args, "color") && !/^[\dA-F]{6}$/.test(String(args.color))) invalid("PPT 颜色须为六位 RGB");
        if (Object.hasOwn(args, "font_size") && (typeof args.font_size !== "number" || !Number.isFinite(args.font_size) || args.font_size <= 0 || args.font_size > 400 || Math.abs(args.font_size * 100 - Math.round(args.font_size * 100)) > 1e-8)) invalid("字号须为 (0,400] 的正有限磅值，最多两位小数");
      } else {
        fields(args, ["page_index", "shape_id", "x", "y", "w", "h"]);
        if (!["x", "y", "w", "h"].some((key) => Object.hasOwn(args, key))) invalid("请提供位置或尺寸");
        const bounds = { ...(shape.detail.bounds as Record<string, unknown>) };
        for (const key of ["x", "y", "w", "h"]) if (Object.hasOwn(args, key)) {
          const value = args[key];
          if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || (["w", "h"].includes(key) && !value)) invalid("geometry 仅接受整数 pt，宽高须为正，x/y 可为零；原生 getter 无法证明亚 pt 几何");
          bounds[key] = value;
        }
        if ((bounds.x as number) < 0 || (bounds.y as number) < 0 || (bounds.x as number) + (bounds.w as number) > state.size.w || (bounds.y as number) + (bounds.h as number) > state.size.h) invalid("文本框须完整位于幻灯片边界内");
      }
      validateSlidePageBudget(state, tool, args);
      break;
    }
  }
  return { args, effect };
}

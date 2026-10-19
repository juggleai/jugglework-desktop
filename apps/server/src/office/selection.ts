import type {
  OfficeSelection,
  OfficeSelectionLocator,
  OfficeTextRange,
} from "@jugglework/types/office";
import { ApiError } from "../errors.js";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function index(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/** 重叠或重复的半开文字区间不能被当作多次独立修改；相邻区间仍各自保留。 */
function disjointTextRanges(ranges: OfficeTextRange[]): boolean {
  const sorted = [...ranges].sort((left, right) => left.begin - right.begin);
  return sorted.every(
    (range, position) =>
      range.end > range.begin &&
      (!position || sorted[position - 1].end <= range.begin),
  );
}

/**
 * 解析已适配页面的三种选区快照；页面 fileId、标题和提示词不参与目标选择。
 * @param kind 宿主确定的当前文档模型类型
 * @param value 宿主实时读取的页面快照；null 或空选区表示无可用选区
 */
export function parseOfficeSelection(
  kind: OfficeSelection["kind"],
  value: unknown,
): OfficeSelection | null {
  if (value === null) return null;
  const invalid = () =>
    new ApiError(400, "invalid_office_selection", "选区数据不符合当前文档格式");
  if (!record(value)) throw invalid();
  const description =
    typeof value.description === "string"
      ? value.description
      : typeof value.selectedText === "string"
        ? value.selectedText
        : "";
  let data: Record<string, unknown>;
  let locator: OfficeSelectionLocator | null = null;
  // TIPS: Word 使用 begin/end 字符坐标，表格使用行列范围，PPT 使用页和对象身份，不能互相猜测转换。
  if (kind === "doc") {
    if (
      !Array.isArray(value.ranges) ||
      !value.ranges.every(
        (range) =>
          record(range) &&
          index(range.begin) &&
          index(range.end) &&
          range.end >= range.begin &&
          range.length === range.end - range.begin,
      )
    )
      throw invalid();
    if (!value.ranges.length) return null;
    data = {
      ranges: value.ranges.map(({ begin, end, length }) => ({
        begin,
        end,
        length,
      })),
      description,
    };
    const ranges = value.ranges.map(({ begin, end }) => ({ begin, end }));
    if (ranges.length === 1 && ranges[0].begin === ranges[0].end)
      locator = { kind: "doc-caret", idx: ranges[0].begin };
    else if (disjointTextRanges(ranges))
      locator = { kind: "doc-text", ranges };
  } else if (kind === "sheet") {
    if (
      typeof value.sheetId !== "string" ||
      !value.sheetId ||
      !Array.isArray(value.ranges) ||
      !value.ranges.every(
        (range) =>
          record(range) &&
          range.sheetId === value.sheetId &&
          index(range.startRowIndex) &&
          index(range.endRowIndex) &&
          range.endRowIndex >= range.startRowIndex &&
          index(range.startColIndex) &&
          index(range.endColIndex) &&
          range.endColIndex >= range.startColIndex,
      ) ||
      (value.drawingIds !== undefined && !strings(value.drawingIds))
      || (value.selectionKind !== undefined && !["rows", "columns", "cells"].includes(String(value.selectionKind)))
    )
      throw invalid();
    if (
      !value.ranges.length &&
      !(value.drawingIds as string[] | undefined)?.length
    )
      return null;
    data = {
      sheetId: value.sheetId,
      ranges: value.ranges.map(
        ({
          sheetId,
          startRowIndex,
          endRowIndex,
          startColIndex,
          endColIndex,
        }) => ({
          sheetId,
          startRowIndex,
          endRowIndex,
          startColIndex,
          endColIndex,
        }),
      ),
      drawingIds: value.drawingIds ?? [],
      description,
    };
    // TIPS: 完整行列只接受已适配采集器的原生维度意图，有限全网格矩形不能自行升级。
    if (value.ranges.length && !(value.drawingIds as string[] | undefined)?.length)
      locator = value.selectionKind === "rows" || value.selectionKind === "columns" ? {
        kind: value.selectionKind === "rows" ? "sheet-rows" : "sheet-columns", sheetId: value.sheetId,
        ranges: value.ranges.map((range) => value.selectionKind === "rows" ? { start: range.startRowIndex, end: range.endRowIndex } : { start: range.startColIndex, end: range.endColIndex }),
      } : {
        kind: "sheet-cells",
        sheetId: value.sheetId,
        ranges: value.ranges.map((range) => ({
          startRow: range.startRowIndex,
          endRow: range.endRowIndex,
          startCol: range.startColIndex,
          endCol: range.endColIndex,
        })),
      };
    if (locator?.kind === "sheet-rows" || locator?.kind === "sheet-columns") {
      data.selectionKind = value.selectionKind;
      const ranges = [...locator.ranges].sort((a, b) => a.start - b.start);
      if (ranges.some((range, i) => i > 0 && range.start <= ranges[i - 1].end)) locator = null;
    }
  } else {
    if (
      !(
        index(value.pageIndex) ||
        (Array.isArray(value.pageIndex) &&
          value.pageIndex.length > 0 &&
          value.pageIndex.every(index))
      ) ||
      !strings(value.shapeIds)
    )
      throw invalid();
    let textSelection:
      | { shapeId: string; start: number; count: number; selectedText?: string }
      | undefined;
    if (value.textSelection !== undefined) {
      const text = value.textSelection;
      if (
        !index(value.pageIndex) ||
        value.shapeIds.length !== 1 ||
        !record(text) ||
        text.shapeId !== value.shapeIds[0] ||
        !index(text.start) ||
        !index(text.count) ||
        !Number.isSafeInteger(text.start + text.count) ||
        (text.selectedText !== undefined &&
          (typeof text.selectedText !== "string" ||
            text.selectedText.length !== text.count))
      )
        throw invalid();
      textSelection = {
        shapeId: text.shapeId,
        start: text.start,
        count: text.count,
        ...(text.selectedText !== undefined
          ? { selectedText: text.selectedText }
          : {}),
      };
    }
    data = {
      pageIndex: value.pageIndex,
      shapeIds: value.shapeIds,
      ...(record(value.range) ? { range: value.range } : {}),
      ...(textSelection ? { textSelection } : {}),
      description,
    };
    const pageIndices = Array.isArray(value.pageIndex)
      ? [...value.pageIndex]
      : [value.pageIndex];
    const uniquePages = new Set(pageIndices).size === pageIndices.length;
    const uniqueShapes =
      value.shapeIds.every((id) => id.length > 0) &&
      new Set(value.shapeIds).size === value.shapeIds.length;
    if (textSelection && index(value.pageIndex)) {
      if (uniqueShapes && textSelection.count > 0)
        locator = {
          kind: "slide-text",
          pageIndex: value.pageIndex,
          shapeId: textSelection.shapeId,
          start: textSelection.start,
          count: textSelection.count,
        };
    } else if (uniquePages && uniqueShapes) {
      if (!value.shapeIds.length)
        locator = { kind: "slide-pages", pageIndices };
      else if (index(value.pageIndex))
        locator = {
          kind: "slide-shapes",
          pageIndex: value.pageIndex,
          shapeIds: [...value.shapeIds],
        };
    }
  }
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, "utf8") > 32_768)
    throw new ApiError(
      400,
      "office_selection_too_large",
      "选区过大，请缩小选择范围",
    );
  return { kind, data: JSON.parse(json), locator, capturedAt: Date.now() };
}

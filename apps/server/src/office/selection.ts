import type { OfficeSelection } from "@jugglework/types/office";
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
    let textSelection: Record<string, unknown> | undefined;
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
  }
  const json = JSON.stringify(data);
  if (Buffer.byteLength(json, "utf8") > 32_768)
    throw new ApiError(
      400,
      "office_selection_too_large",
      "选区过大，请缩小选择范围",
    );
  return { kind, data: JSON.parse(json), capturedAt: Date.now() };
}

/**
 * 按已绑定格式读取配套 SDK 当前选区，不触发内部 AI 浮层或改变编辑焦点。
 * @param {string} kind 宿主确定的模型类型
 * @param {any} scope 配套编辑页面全局对象；参数供契约回归使用
 * @returns {object | null} 只返回已确认的坐标，未知或暂不支持的选区返回空
 */
export function readOfficePageSelection(kind, scope = window) {
  if (kind === "doc") {
    const app = scope.pad?.editor;
    const selection = app?.service?.getSelection?.();
    const range = app?.selection?.gcpRange;
    if (
      typeof range?.begin !== "function" ||
      typeof range?.end !== "function" ||
      typeof selection?.getTableSelectionArea !== "function"
    )
      return null;
    // TIPS: 跨单元格选择可能不是连续字符，不能用外包范围替代真实选区。
    if (selection.getTableSelectionArea()?.cellRanges?.length) return null;
    const begin = range.begin();
    const end = range.end();
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end < begin
    )
      return null;
    return {
      ranges: [{ begin, end, length: end - begin }],
      selectedText:
        end - begin <= 4096 && typeof app.getRefText === "function"
          ? app.getRefText(range)
          : "",
    };
  }
  if (kind === "sheet") {
    const app = scope.SpreadsheetApp;
    const sheet = app?.workbook?.activeSheet;
    const view = app?.view;
    // 配套 SDK 的 NORMAL=1；图片、图表等浮动对象不能回退成上一次单元格选区。
    if (
      view?.getSelectionType?.() !== 1 ||
      typeof view.getSelectionRanges !== "function" ||
      typeof sheet?.getSheetId !== "function" ||
      typeof sheet.getRowCount !== "function" ||
      typeof sheet.getColCount !== "function"
    )
      return null;
    const sheetId = sheet.getSheetId();
    const ranges = view.getSelectionRanges();
    const rows = sheet.getRowCount();
    const cols = sheet.getColCount();
    if (
      !Number.isSafeInteger(rows) ||
      rows <= 0 ||
      !Number.isSafeInteger(cols) ||
      cols <= 0 ||
      !Array.isArray(ranges) ||
      !ranges.every(
        (range) =>
          typeof range?.endRowIndex === "number" &&
          typeof range?.endColIndex === "number",
      )
    )
      return null;
    return {
      sheetId,
      ranges: ranges.map((range) => ({
        sheetId: range.sheetId,
        startRowIndex: range.startRowIndex,
        endRowIndex: Math.min(range.endRowIndex, rows - 1),
        startColIndex: range.startColIndex,
        endColIndex: Math.min(range.endColIndex, cols - 1),
      })),
      drawingIds: [],
    };
  }
  if (kind === "slide") {
    const selection = scope.pray?.()?.getSelectionService?.();
    if (
      !selection ||
      selection.lastMouseDownRegion === "note" ||
      selection.selectedBlank?.enabled ||
      typeof selection.selectedSlides?.selectedArray?.slice !== "function" ||
      typeof selection.selectedElements?.selectedArrayForType !== "function"
    )
      return null;
    // SDK 的 MobX 数组可能不满足 Array.isArray；使用其 slice 获取普通值数组再校验。
    const pages = selection.selectedSlides.selectedArray.slice();
    // TIPS: 只采集普通页面和形状身份；组内对象、框选区域和备注不冒充整页选区。
    const groups = selection.selectedElements
      .selectedArrayForType("SelectedEleMgrType_GROUP")
      ?.slice();
    const shapes = selection.selectedElements
      .selectedArrayForType("SelectedEleMgrType_SLIDE")
      ?.slice();
    const smartArt = selection.selectedElements
      .selectedArrayForType("SelectedEleMgrType_SMART_ART")
      ?.slice();
    if (
      !Array.isArray(pages) ||
      !Array.isArray(groups) ||
      groups.length ||
      !Array.isArray(smartArt) ||
      smartArt.length ||
      !Array.isArray(shapes)
    )
      return null;
    let textSelection;
    if (
      pages.length <= 1 &&
      shapes.length === 1 &&
      shapes[0].editorInstance?.isEditing
    ) {
      const shape = shapes[0];
      const selected = shape.editorInstance.getSelection?.();
      const paragraphs = shape.paragraphList?.slice();
      if (!selected?.anchor || !selected.focus || !Array.isArray(paragraphs))
        return null;
      const texts = [];
      for (const paragraph of paragraphs) {
        const runs = paragraph.textRuns?.slice();
        if (
          !Array.isArray(runs) ||
          !runs.every((run) => typeof run.text === "string")
        )
          return null;
        texts.push(runs.map((run) => run.text).join(""));
      }
      const offset = (point) => {
        const index = point.path?.[0];
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= texts.length ||
          !Number.isSafeInteger(point.offset) ||
          point.offset < 0 ||
          point.offset > texts[index].length
        )
          return null;
        // TIPS: 配套 SDK 按 UTF-16 码元计数，每个前置段落额外占一个 \r；不能用码点数或只用段内偏移。
        return (
          texts
            .slice(0, index)
            .reduce((size, text) => size + text.length + 1, 0) + point.offset
        );
      };
      const anchor = offset(selected.anchor);
      const focus = offset(selected.focus);
      if (anchor === null || focus === null) return null;
      const start = Math.min(anchor, focus);
      const count = Math.abs(focus - anchor);
      textSelection = {
        shapeId: shape.id,
        start,
        count,
        ...(count <= 4096
          ? { selectedText: texts.join("\r").slice(start, start + count) }
          : {}),
      };
    }
    return {
      pageIndex:
        pages.length > 1
          ? pages.map((page) => page.listIndex)
          : selection.currentSlideIndex,
      shapeIds: pages.length > 1 ? [] : shapes.map((shape) => shape.id),
      ...(textSelection ? { textSelection } : {}),
    };
  }
  return null;
}

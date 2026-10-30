/**
 * 按已绑定格式读取配套 SDK 当前选区，不触发内部 AI 浮层或改变编辑焦点。
 * @param {string} kind 宿主确定的模型类型
 * @param {any} scope 配套编辑页面全局对象；参数供契约回归使用
 * @param {{picturePage?: boolean}} options 仅显式图片 AI 页入口使用当前图片所属单页；普通选区查询不扩大范围
 * @returns {object | null} 只返回已确认的坐标，未知或暂不支持的选区返回空
 */
export function readOfficePageSelection(kind, scope = window, options = {}) {
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
    let end = range.end();
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end < begin
    )
      return null;
    let selectedText = end - begin <= 4096 && typeof app.getRefText === "function"
      ? app.getRefText(range) : "";
    // TIPS: Word 将段尾结构标记 \r 包含在 GCP 范围中，但界面字数不包含它。
    // 单段和跨段都只排除最后一个结构回车；中间段落边界与空段完整保留，不 trim 或猜测展开占位符长度。
    if (typeof selectedText === "string" && selectedText.length === end - begin && selectedText.endsWith("\r") &&
        !selectedText.includes("\n")) {
      end--;
      selectedText = selectedText.slice(0, -1);
    }
    return {
      ranges: [{ begin, end, length: end - begin }],
      selectedText,
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
      // 配套 SDK 的行/列选择 API 用精确哨兵表达维度意图；有限全网格矩形仍是 cells。
      ...(ranges.length && ranges.every((range) => range.startColIndex === 0 && range.endColIndex === 2147483647 && Number.isSafeInteger(range.endRowIndex) && range.endRowIndex < rows) ? { selectionKind: "rows" }
        : ranges.length && ranges.every((range) => range.startRowIndex === 0 && range.endRowIndex === 2147483647 && Number.isSafeInteger(range.endColIndex) && range.endColIndex < cols) ? { selectionKind: "columns" } : {}),
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
      !["editor", "slidelist"].includes(selection.lastMouseDownRegion) ||
      selection.selectedBlank?.enabled ||
      typeof selection.selectedSlides?.selectedArray?.slice !== "function"
    )
      return null;
    // SDK 的 MobX 数组可能不满足 Array.isArray；使用其 slice 获取普通值数组再校验。
    const pages = selection.selectedSlides.selectedArray.slice();
    if (selection.lastMouseDownRegion === "slidelist") {
      // 原生验收确认 id/uniqueID 对应引擎 page_id；key 只用于 DOM 渲染，不能用于授权。
      if (!Array.isArray(pages) || !pages.length || pages.some((page) =>
        !Number.isSafeInteger(page?.listIndex) || page.listIndex < 0 ||
        typeof page.id !== "string" || !page.id.length || page.id.trim() !== page.id ||
        page.uniqueID !== page.id || selection.slides?.[page.listIndex]?.id !== page.id ||
        selection.slides[page.listIndex].uniqueID !== page.id) ||
        new Set(pages.map((page) => page.listIndex)).size !== pages.length ||
        new Set(pages.map((page) => page.id)).size !== pages.length) return null;
      return { pageIndex: pages.map((page) => page.listIndex), shapeIds: [], nativeSlideIds: pages.map((page) => page.id) };
    }
    if (typeof selection.selectedElements?.selectedArrayForType !== "function") return null;
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
    // 图片上的 AI 入口明确标记为“当前页”；只允许已验证的当前页直接图片，不能从组、媒体或旧页推测。
    if (options.picturePage && shapes.length === 1 && shapes[0].type === "Image") {
      const image = shapes[0], page = selection.currentSlide, index = selection.currentSlideIndex;
      if (typeof image.isImage !== "function" || image.isImage() !== true ||
          !Number.isSafeInteger(index) || index < 0 || selection.slides?.[index] !== page || page?.type !== "Slide" ||
          page.listIndex !== index || typeof page.id !== "string" || !page.id || page.id.trim() !== page.id || page.uniqueID !== page.id ||
          typeof image.id !== "string" || !image.id || image.uniqueID !== image.id || image.parent !== page ||
          typeof page.children?.slice !== "function") return null;
      const children = page.children.slice();
      if (!Array.isArray(children) || children.filter((child) => child.id === image.id).length !== 1 ||
          !children.includes(image) || pages.length > 1 || (pages.length === 1 && pages[0] !== page)) return null;
      return { pageIndex: [index], shapeIds: [], nativeSlideIds: [page.id] };
    }
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

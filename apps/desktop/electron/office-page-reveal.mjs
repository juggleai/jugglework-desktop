/**
 * 在已核对的存活页面恢复准确选择；不搜索同文案，不扩大不支持的选区。
 * @param {any} locator Server 持有且已核对内容的定位
 * @param {any} scope 配套 SDK 页面对象
 */
export async function revealOfficePageSelection(locator, scope = window) {
  if (locator.kind === "doc-text" || locator.kind === "doc-caret") {
    const editor = scope.pad?.editor, Range = editor?.selection?.gcpRange?.constructor;
    if (typeof editor?.setRangeTo !== "function" || typeof Range?.createByEnd !== "function") throw new Error("当前页面暂不支持定位文档选区");
    const ranges = locator.kind === "doc-text" ? locator.ranges : [{ begin: locator.idx, end: locator.idx }];
    editor.setRangeTo(ranges.map((range) => Range.createByEnd(range.begin, range.end)), { forceNotify: true });
    return;
  }
  if (locator.kind.startsWith("sheet-")) {
    const app = scope.SpreadsheetApp, view = app?.view;
    if (app?.workbook?.activeSheet?.getSheetId?.() !== locator.sheetId) throw new Error("请先切换到选区所属工作表，再定位");
    if (locator.ranges.length !== 1) throw new Error("当前页面暂不支持恢复不相邻的多块选区");
    const range = locator.ranges[0];
    if (locator.kind === "sheet-cells") view.setCurrentSelection({ xRange: [range.startCol, range.endCol], yRange: [range.startRow, range.endRow] });
    else if (locator.kind === "sheet-rows") view.canvas.selectApi.selectRows(view.canvas.normalSelectData, [range.start, range.end]);
    else view.canvas.selectApi.selectCols(view.canvas.normalSelectData, [range.start, range.end]);
    return;
  }
  if (locator.kind === "slide-shapes") {
    const selection = scope.pray?.()?.getSelectionService?.();
    if (selection?.currentSlideIndex !== locator.pageIndex) throw new Error("请先切换到选区所属幻灯片，再定位");
    const shapes = locator.shapeIds.map((id) => selection.currentSlide.children.find((shape) => shape.id === id));
    if (shapes.some((shape) => !shape)) throw new Error("选区文本框已变化，请重新选择");
    selection.selectedElements.clear(); selection.selectedElements.add(...shapes);
    return;
  }
  throw new Error("当前页面暂不支持恢复该类型的精确选区，请在文档中重新选择");
}

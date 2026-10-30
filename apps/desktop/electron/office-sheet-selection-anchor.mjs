/**
 * 按范围顺序读取首个真实可见左上角单元格的锚点，不改变完整选区、滚动或 SDK 布局。
 * @param {object} selection 当前原生逻辑选区
 * @param {any} scope 配套页面全局对象
 * @returns {{x: number, y: number, top: number, minY: number, maxY: number} | null} 单元格锚点与网格垂直边界，未知或不可见时返回空
 */
export function readOfficeSheetSelectionAnchor(selection, scope = window) {
  const app = scope.SpreadsheetApp;
  const sheet = app?.workbook?.activeSheet;
  const view = app?.view;
  const canvas = view?.canvas;
  if (!selection || typeof selection.sheetId !== "string" || !selection.sheetId.trim() ||
      !Array.isArray(selection.ranges) || !selection.ranges.length ||
      sheet?.getSheetId?.() !== selection.sheetId ||
      view?.renderedSheetId !== selection.sheetId) return null;
  const rows = sheet.getRowCount?.(), cols = sheet.getColCount?.();
  // 定位只消费一个范围，但必须先确认完整选择均属于当前网格，不能跳过无效授权范围。
  if (!Number.isSafeInteger(rows) || rows <= 0 || !Number.isSafeInteger(cols) || cols <= 0) return null;
  for (const range of selection.ranges) {
    if (range?.sheetId !== selection.sheetId ||
        ![range.startRowIndex, range.endRowIndex, range.startColIndex, range.endColIndex].every(Number.isSafeInteger) ||
        range.startRowIndex < 0 || range.endRowIndex < range.startRowIndex || range.endRowIndex >= rows ||
        range.startColIndex < 0 || range.endColIndex < range.startColIndex || range.endColIndex >= cols) return null;
  }
  const infos = canvas?.viewManager?.getActiveCanvasInfos?.();
  if (!Array.isArray(infos) || infos.length !== 1 || infos[0].canvasType !== "single") return null;
  const container = canvas.clientRect?.container;
  if (!container?.isConnected) return null;
  const rect = container.getBoundingClientRect();
  const headX = canvas.headSize?.displayRowHeadWidth;
  const headY = canvas.headSize?.displayColHeadHeight;
  const area = canvas.areaData;
  if (![rect.left, rect.top, rect.width, rect.height, headX, headY].every(Number.isFinite) ||
      headX < 0 || headY < 0 || rect.width <= headX || rect.height <= headY ||
      !area?.row?.frozen || !area.row.flow || !area.col?.frozen || !area.col.flow) return null;
  const visibleAxis = (index, dimension, start, end, size) => {
    const frozen = index <= dimension.frozen.to;
    const pane = dimension[frozen ? "frozen" : "flow"];
    const min = frozen ? 0 : dimension.frozen.displayViewSize;
    const max = Math.min(size, min + pane.displayViewSize);
    if (![start, end, min, max, pane.renderFrom, pane.renderTo].every(Number.isFinite) ||
        index < pane.renderFrom || index > pane.renderTo || end <= start || start < min || start >= max) return null;
    // 左上角必须真实可见；只裁剪末端，不能把被滚入冻结区的起点夹到窗格边界。
    return Math.min(end, max);
  };
  for (const range of selection.ranges) {
    const row = range.startRowIndex, col = range.startColIndex;
    if (!area.isCellVisiable(row, col)) continue;
    const left = area.getDisplayViewLeftByCol(col), right = area.getDisplayViewRightByCol(col);
    const top = area.getDisplayViewTopByRow(row), bottom = area.getDisplayViewBottomByRow(row);
    const visibleRight = visibleAxis(col, area.col, left, right, rect.width - headX);
    const visibleBottom = visibleAxis(row, area.row, top, bottom, rect.height - headY);
    if (visibleRight === null || visibleBottom === null) continue;
    const x = rect.left + headX + left, cellTop = rect.top + headY + top;
    const y = Math.min(rect.top + headY + visibleBottom, scope.innerHeight);
    if (x < 0 || x >= scope.innerWidth || cellTop < 0 || cellTop >= scope.innerHeight) continue;
    return { x, y, top: cellTop, minY: Math.max(12, rect.top + headY), maxY: Math.min(scope.innerHeight - 12, rect.top + rect.height) };
  }
  return null;
}

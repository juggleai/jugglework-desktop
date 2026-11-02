/**
 * 读取 Word 当前模型中指定的普通正文范围，不改变真实选区或提交输入。
 * @param {{ranges: {begin: number, end: number}[], version: number}} input 宿主限定的 UTF-16 范围及原生版本
 * @param {any} scope 配套编辑页面全局对象
 * @returns {Promise<string[] | null>} 完整原文；接口、版本或坐标不匹配时拒绝
 */
export async function readOfficePageText({ ranges, version }, scope = window) {
  const editor = scope.pad?.editor;
  const current = editor?.selection?.gcpRange;
  if (typeof editor?.getRefText !== "function" || typeof current?.begin !== "function" ||
      typeof current?.end !== "function" || !Number.isSafeInteger(version) || version < 0 || !Array.isArray(ranges) || ranges.length > 256 ||
      ranges.some((range) => !Number.isSafeInteger(range?.begin) || !Number.isSafeInteger(range?.end) ||
        range.begin < 0 || range.end < range.begin || range.end > 16384)) return null;
  const service = scope.getLocalEditManager?.()?.getLocalEditService?.();
  const changes = scope.App?.changesetManager;
  const synchronized = () => service && changes && service.isCommitting === false && service.committingQueue?.length === 0 &&
    changes.composeCommands?.length === 0 && changes.localEditCommands?.length === 0 && changes.inFlightCommands?.size === 0 &&
    service.docVersion === version - 1 && service.isGapFilling !== true &&
    scope.App?.GlobalConfig?.isLocalEditChunkFinish === true;
  // TIPS: 原生工具修改通过 SSE 回到页面；等页面确认同一版本，不能将旧页面尾部当作新模型原文。
  // SDK docVersion 是最后应用命令的零基 base_version，MCP version 是应用后的版本号，二者相差 1。
  const deadline = Date.now() + 1000;
  while (!synchronized()) {
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const texts = [];
  for (const { begin, end } of ranges) {
    // TIPS: 构造独立范围后回读端点；绝不移动真实选区，也不猜测结构预览省略的控制字符。
    const range = new current.constructor(begin, end - begin);
    if (range === current || range.begin?.() !== begin || range.end?.() !== end) return null;
    const text = editor.getRefText(range);
    if (typeof text !== "string" || text.length !== end - begin || /[\r\uFFFC]/.test(text)) return null;
    texts.push(text);
  }
  return synchronized() ? texts : null;
}

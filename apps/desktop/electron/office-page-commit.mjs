/**
 * 等待配套 Word 页面已合并的输入获得原生模型确认，不修改页面内容或输入队列。
 * @param {any} scope 原生页面全局对象；参数仅供契约回归使用
 * @param {number} timeoutMs 页面提交的最长等待时间
 */
export async function waitForWordPageCommit(
  scope = window,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const changes = scope.App?.changesetManager;
    const service = scope.getLocalEditManager?.()?.getLocalEditService?.();
    // TIPS: SDK 先合并 500ms 输入，再排队提交并等待确认；只检查模型 dirty 会漏掉这段输入。
    const known =
      changes &&
      service &&
      Array.isArray(changes.composeCommands) &&
      Array.isArray(changes.localEditCommands) &&
      changes.inFlightCommands instanceof Map &&
      Array.isArray(service.committingQueue) &&
      typeof service.isCommitting === "boolean";
    if (
      known &&
      changes.composeCommands.length === 0 &&
      changes.localEditCommands.length === 0 &&
      changes.inFlightCommands.size === 0 &&
      !service.isCommitting &&
      service.committingQueue.length === 0
    )
      return;
    if (Date.now() >= deadline)
      throw new Error(
        known
          ? "文字尚未提交完成，请稍后重试保存"
          : "Word 页面提交状态不可用，请等待编辑器就绪",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 保存表格前等待输入法结束，并将仍在编辑的单元格提交到同一个原生模型。
 * @param {any} scope 配套表格页面全局对象；参数仅供契约回归使用
 * @param {number} timeoutMs 页面提交的最长等待时间
 */
export async function waitForSheetPageCommit(
  scope = window,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const input = scope.SpreadsheetApp?.view?.canvas?.inputManager;
    const known =
      input &&
      typeof input.isComposing === "function" &&
      typeof input.isInputtingState === "function" &&
      typeof input.commitTableInputData === "function" &&
      typeof input.handleExitInput === "function";
    if (known && !input.isComposing() && !input.isEditPending) {
      if (!input.isInputtingState()) return;
      let timer;
      try {
        await Promise.race([
          input.commitTableInputData(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("单元格尚未提交完成，请稍后重试保存")),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (scope.SpreadsheetApp?.view?.canvas?.inputManager !== input)
        throw new Error("表格编辑页面已失效，不能确认保存");
      if (input.isComposing() || input.isEditPending)
        throw new Error("单元格正在输入，请完成输入后重试保存");
      // TIPS: 原生提交已成功后才退出编辑；discard 只跳过 handleExitInput 内部的重复提交。
      // 提交失败或超时不退出，不清空编辑内容，也不写盘。
      if (input.isInputtingState()) input.handleExitInput({ discard: true });
      if (input.isInputtingState())
        throw new Error("单元格仍在编辑，文档尚未保存");
      return;
    }
    if (Date.now() >= deadline)
      throw new Error(
        known
          ? "单元格正在输入，请完成输入后重试保存"
          : "表格页面提交状态不可用，请等待编辑器就绪",
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 将配套幻灯片页面的文字缓冲提交到当前模型，并等待其原生提交队列完成。
 * @param {any} scope 配套幻灯片页面全局对象；参数仅供契约回归使用
 * @param {number} timeoutMs 页面提交的最长等待时间
 */
export async function waitForSlidePageCommit(
  scope = window,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  const local = scope.pray?.()?._?.LocalEditServices;
  const manager = local?.LocalEditManager?.();
  const converter = local?.LocalEditDataConverter?.();
  if (
    typeof manager?.getEditorInstance !== "function" ||
    typeof manager?.getEditingStateManager !== "function" ||
    typeof manager.getEditingStateManager()?.hasUnsavedTextContent !==
      "boolean" ||
    typeof converter?.commitQueue?.then !== "function"
  )
    throw new Error("幻灯片页面提交状态不可用，请等待编辑器就绪");
  for (;;) {
    const editor = manager.getEditorInstance();
    if (
      editor &&
      (typeof editor.triggerSave !== "function" ||
        typeof editor.editor?.isComposing !== "boolean")
    )
      throw new Error("幻灯片文字输入状态不可用，不能确认保存");
    if (!editor?.editor.isComposing) {
      // TIPS: triggerSave 只将文字缓冲提交页面模型；commitQueue 完成后才允许宿主写盘。
      // SDK 的队列会吞掉提交异常，宿主还必须核对 HTTP 提交响应，不能仅凭此队列宣称成功。
      editor?.triggerSave();
      const queue = converter.commitQueue;
      let timer;
      try {
        await Promise.race([
          queue,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("幻灯片文字尚未提交完成，请稍后重试保存")),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (
        local.LocalEditManager() !== manager ||
        local.LocalEditDataConverter() !== converter
      )
        throw new Error("幻灯片编辑页面已失效，不能确认保存");
      if (
        converter.commitQueue === queue &&
        !manager.getEditingStateManager().hasUnsavedTextContent &&
        !manager.getEditorInstance()?.editor.isComposing
      )
        return;
    }
    if (Date.now() >= deadline)
      throw new Error("幻灯片正在输入，请完成输入后重试保存");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * 查询配套 PPT 的真实文字组合状态；按键事件未携带组合标志时仍使用页面输入状态。
 * @param {any} scope 配套幻灯片页面全局对象
 */
export function isSlidePageComposing(scope = window) {
  const manager = scope.pray?.()?._?.LocalEditServices?.LocalEditManager?.();
  if (typeof manager?.getEditorInstance !== "function")
    throw new Error("幻灯片文字输入状态不可用，请等待编辑器就绪");
  const editor = manager.getEditorInstance();
  if (!editor) return false;
  if (typeof editor.editor?.isComposing !== "boolean")
    throw new Error("幻灯片文字输入状态不可用，不能执行快捷键");
  return editor.editor.isComposing;
}

/**
 * 在 PPT 页面捕获文档快捷键，阻止 SDK 自身在组合期间调用保存并失焦。
 * @param {any} scope 配套幻灯片页面全局对象
 */
export function installSlideKeyboardGuard(scope = window) {
  scope.addEventListener(
    "keydown",
    (event) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        !["s", "o", "w"].includes(event.key.toLowerCase())
      )
        return;
      const editor = scope
        .pray?.()
        ?._?.LocalEditServices?.LocalEditManager?.()
        ?.getEditorInstance?.();
      if (event.isComposing || editor?.editor?.isComposing) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
}

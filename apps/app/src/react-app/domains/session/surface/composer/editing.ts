/**
 * 订阅主会话输入框的真实聚焦状态，供桌面宠物展示使用；草稿存在本身不代表正在编辑。
 * @param onChange 编辑状态变化回调
 * @param sourceDocument 输入框所在文档
 * @param sourceWindow 输入框所在窗口
 * @returns 释放焦点及可见性监听的函数
 */
export function subscribeComposerEditing(onChange: (editing: boolean) => void, sourceDocument = document, sourceWindow = window) {
  const refresh = () => onChange(sourceDocument.hasFocus() && sourceDocument.visibilityState !== "hidden" &&
    sourceDocument.activeElement?.matches('[data-session-composer-input][contenteditable="true"]') === true);
  const blur = () => onChange(false);
  sourceDocument.addEventListener("focusin", refresh);
  sourceDocument.addEventListener("focusout", refresh);
  sourceDocument.addEventListener("visibilitychange", refresh);
  sourceWindow.addEventListener("focus", refresh);
  sourceWindow.addEventListener("blur", blur);
  refresh();
  return () => {
    sourceDocument.removeEventListener("focusin", refresh);
    sourceDocument.removeEventListener("focusout", refresh);
    sourceDocument.removeEventListener("visibilitychange", refresh);
    sourceWindow.removeEventListener("focus", refresh);
    sourceWindow.removeEventListener("blur", blur);
  };
}

import type { MessageWithParts } from "../../../../app/types";

export type RedoHistoryStep = {
  next: MessageWithParts | null;
  prior: MessageWithParts | null;
};

function messageRole(message: MessageWithParts) {
  return (message.info as { role?: string }).role;
}

/**
 * 按消息时间序列的位置解析 redo 的下一步。
 *
 * TIPS: 消息 ID 只用于精确定位，不参与大小比较。OpenCode 旧 ID 的时间字段会
 * 回卷（如新的 msg_00d... 字典序小于旧的 msg_fff...），因此 redo 必须依赖
 * 已按 time.created 排列的 transcript 位置。
 *
 * @param messages 已按创建时间排列的完整消息序列
 * @param revertMessageID 当前 revert cursor，表示第一条被回退的消息
 * @param messageIdFromInfo 从消息中读取持久化 ID 的方法
 * @returns cursor 不存在时返回 null；next 为空表示应执行 unrevert
 */
export function resolveRedoHistoryStep(
  messages: MessageWithParts[],
  revertMessageID: string,
  messageIdFromInfo: (message: MessageWithParts) => string,
): RedoHistoryStep | null {
  const cursorIndex = messages.findIndex(
    (message) => messageIdFromInfo(message) === revertMessageID,
  );
  if (cursorIndex < 0) return null;

  let nextIndex = -1;
  for (let index = cursorIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate && messageRole(candidate) === "user" && messageIdFromInfo(candidate)) {
      nextIndex = index;
      break;
    }
  }

  if (nextIndex < 0) return { next: null, prior: null };

  let prior: MessageWithParts | null = null;
  for (let index = nextIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate && messageRole(candidate) === "user" && messageIdFromInfo(candidate)) {
      prior = candidate;
      break;
    }
  }

  return { next: messages[nextIndex] ?? null, prior };
}

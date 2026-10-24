import type { UIMessage } from "ai";

import type { JuggleWorkSessionSnapshot } from "../../../../app/lib/jugglework-server";
import { SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX } from "../../../../app/types";
import { mergeSnapshotAndLiveMessages } from "../sync/message-merge";
import { applyRevertCursor } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { toCompactionPresentationMessage } from "../../../../app/lib/session-compaction";

export function resolveRenderedSessionSnapshot(input: {
  sessionId: string;
  currentSnapshot: JuggleWorkSessionSnapshot | null | undefined;
  cachedRendered: { sessionId: string; snapshot: JuggleWorkSessionSnapshot } | null | undefined;
}) {
  if (input.currentSnapshot?.session.id === input.sessionId) {
    return input.currentSnapshot;
  }
  if (
    input.cachedRendered?.sessionId === input.sessionId &&
    input.cachedRendered.snapshot.session.id === input.sessionId
  ) {
    return input.cachedRendered.snapshot;
  }
  return null;
}

/** 生成聊天展示消息，失效快照不能覆盖同步层保留的实时结果。 */
export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: JuggleWorkSessionSnapshot | null | undefined;
  snapshotCurrent?: boolean;
}) {
  return deriveContextEstimationMessages(input).map(toCompactionPresentationMessage);
}

/**
 * 合并快照与实时 Transcript，同时保留压缩摘要正文供上下文估算使用。
 * @param input.transcriptState 当前会话的实时消息缓存
 * @param input.snapshot 当前会话快照
 * @param input.snapshotCurrent 快照是否覆盖当前实时版本，失效时只使用已恢复历史的实时缓存
 * @returns 已应用回退边界但尚未做展示层压缩脱敏的消息
 */
export function deriveContextEstimationMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: JuggleWorkSessionSnapshot | null | undefined;
  snapshotCurrent?: boolean;
}) {
  const revertMessageId = input.snapshotCurrent === false ? null : (input.snapshot?.session as any)?.revert?.messageID ?? null;
  const liveMessages = input.transcriptState ?? [];

  // TIPS: 失效快照的缺失历史已由同步层补入缓存；展示层不能再次合并旧元数据而丢失停止和完成时间。
  const snapshotMessages = input.snapshotCurrent !== false && input.snapshot && input.snapshot.messages.length > 0
    ? snapshotToUIMessages(input.snapshot)
    : [];

  // Render the server snapshot as the history floor and layer live stream
  // updates on top. During prompt submission the live cache can briefly contain
  // only the new turn; it must not replace the older persisted transcript.
  const messages = snapshotMessages.length > 0
    ? mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, { appendLiveOnlyMessages: true })
    : liveMessages;

  // Older clients may have left synthetic completion diagnostics in the live
  // cache. They are structured activity state, not assistant transcript, and
  // would otherwise displace the real final summary during message grouping.
  return applyRevertCursor(
    messages
      .filter((message) => !message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX)),
    revertMessageId,
  );
}

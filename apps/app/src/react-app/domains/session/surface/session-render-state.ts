import type { UIMessage } from "ai";

import type { JuggleWorkSessionMessagesResponse, JuggleWorkSessionSnapshot } from "../../../../app/lib/jugglework-server";
import { SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX } from "../../../../app/types";
import { mergeSnapshotAndLiveMessages } from "../sync/message-merge";
import { applyRevertCursor, placeSessionErrorsWithParent } from "../sync/transcript-reconcile";
import { snapshotToUIMessages } from "../sync/usechat-adapter";
import { toCompactionPresentationMessage } from "../../../../app/lib/session-compaction";
import { applyRawMessageRevertCursor, mergeHistoricalSessionMessages } from "../sync/session-history";

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

/** Capture the persisted tail when editing starts, including assistant errors with no renderable parts. */
export function captureSessionHistoryEdit(snapshot: JuggleWorkSessionSnapshot | null, workspaceId: string, messageId: string, text: string) {
  const lastMessageId = snapshot?.messages.at(-1)?.info.id;
  if (!snapshot || !lastMessageId) return null;
  return { workspaceId, sessionId: snapshot.session.id, messageId, lastMessageId, text };
}

/** 生成聊天展示消息，失效快照不能覆盖同步层保留的实时结果。 */
export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: JuggleWorkSessionSnapshot | null | undefined;
  snapshotCurrent?: boolean;
  historyPages?: JuggleWorkSessionMessagesResponse[];
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
  historyPages?: JuggleWorkSessionMessagesResponse[];
}) {
  const revertMessageId = input.snapshotCurrent === false ? null : (input.snapshot?.session as any)?.revert?.messageID ?? null;
  const liveMessages = input.transcriptState ?? [];

  // TIPS: 失效快照的缺失历史已由同步层补入缓存；展示层不能再次合并旧元数据而丢失停止和完成时间。
  const currentRawMessages = input.snapshotCurrent !== false ? input.snapshot?.messages ?? [] : [];
  const historicalRawMessages = mergeHistoricalSessionMessages(input.historyPages ?? [], currentRawMessages);
  const oldestPage = input.historyPages?.at(-1)?.page ?? input.snapshot?.messagePage;
  const revertFallsBeforeLoadedWindow = Boolean(
    revertMessageId
    && oldestPage?.hasOlder !== false
    && !historicalRawMessages.some((message) => message.info.id === revertMessageId),
  );
  if (revertFallsBeforeLoadedWindow) return [];
  const visibleRawMessages = applyRawMessageRevertCursor(historicalRawMessages, revertMessageId, oldestPage?.hasOlder === true);
  // An authoritative revert can legitimately remove the full loaded raw
  // window. Do not then fall back to a stale live-only tail.
  if (revertMessageId && visibleRawMessages.length === 0) return [];
  const snapshotMessages = visibleRawMessages.length > 0
    ? snapshotToUIMessages({
        ...(input.snapshot ?? { session: { id: "history" }, todos: [], status: { type: "idle" } }),
        messages: visibleRawMessages,
      } as JuggleWorkSessionSnapshot)
    : [];

  // Render the server snapshot as the history floor and layer live stream
  // updates on top. During prompt submission the live cache can briefly contain
  // only the new turn; it must not replace the older persisted transcript.
  const messages = mergeSnapshotAndLiveMessages(snapshotMessages, liveMessages, {
    // A live-only record has no provable position relative to an active
    // revert boundary. Overlapping live records can still update retained
    // messages, but stale tail records must not be appended.
    appendLiveOnlyMessages: !revertMessageId,
    preserveLiveMessages: input.snapshotCurrent === false || (input.historyPages?.length ?? 0) > 0,
  });

  // Older clients may have left synthetic completion diagnostics in the live
  // cache. They are structured activity state, not assistant transcript, and
  // would otherwise displace the real final summary during message grouping.
  return placeSessionErrorsWithParent(applyRevertCursor(
    messages
      .filter((message) => !message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX)),
    revertMessageId,
  ));
}

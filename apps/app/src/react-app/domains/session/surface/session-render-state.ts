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

export function deriveRenderedSessionMessages(input: {
  transcriptState: UIMessage[] | null | undefined;
  snapshot: JuggleWorkSessionSnapshot | null | undefined;
}) {
  const revertMessageId = (input.snapshot?.session as any)?.revert?.messageID ?? null;
  const liveMessages = input.transcriptState ?? [];

  const snapshotMessages = input.snapshot && input.snapshot.messages.length > 0
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
      .filter((message) => !message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX))
      .map(toCompactionPresentationMessage),
    revertMessageId,
  );
}

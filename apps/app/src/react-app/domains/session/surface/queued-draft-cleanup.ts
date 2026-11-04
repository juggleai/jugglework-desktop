import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { releasableOfficeReferences, useComposerStateStore } from "./composer-state-store";

/** 停止任务时清理原会话队列，并释放队列独占的附件预览和Office引用。 */
export function clearQueuedSessionDrafts(client: JuggleWorkServerClient | null, workspaceId: string, sessionId: string) {
  const store = useComposerStateStore.getState();
  const items = store.queuedDrafts[sessionId] ?? [];
  store.clearQueuedDrafts(sessionId);
  const current = useComposerStateStore.getState();
  const retainedPreviews = new Set([
    ...Object.values(current.sessions).flatMap((session) => session.attachments),
    ...Object.values(current.queuedDrafts).flatMap((queue) => queue.flatMap((item) => item.draft.attachments)),
  ].map((attachment) => attachment.previewUrl));
  for (const item of items) for (const attachment of item.draft.attachments) {
    if (attachment.previewUrl && !retainedPreviews.has(attachment.previewUrl)) URL.revokeObjectURL(attachment.previewUrl);
  }
  const cancelled = items.flatMap((item) => item.draft.parts.flatMap((part) => part.type === "office-selection" ? part.references.map((ref) => ref.referenceId) : []));
  const ids = releasableOfficeReferences(useComposerStateStore.getState(), sessionId, cancelled);
  if (ids.length && client) void client.releaseOfficeSelections(workspaceId, sessionId, ids).catch(() => {});
}

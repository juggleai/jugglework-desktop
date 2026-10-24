import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { releasableOfficeReferences, useComposerStateStore } from "./composer-state-store";

/** 停止任务时清理原会话队列，并释放队列独占的附件预览和Office引用。 */
export function clearQueuedSessionDrafts(client: JuggleWorkServerClient, workspaceId: string, sessionId: string) {
  const store = useComposerStateStore.getState();
  const items = store.queuedDrafts[sessionId] ?? [];
  for (const item of items) for (const attachment of item.draft.attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  store.clearQueuedDrafts(sessionId);
  const cancelled = items.flatMap((item) => item.draft.parts.flatMap((part) => part.type === "office-selection" ? part.references.map((ref) => ref.referenceId) : []));
  const ids = releasableOfficeReferences(useComposerStateStore.getState(), sessionId, cancelled);
  if (ids.length) void client.releaseOfficeSelections(workspaceId, sessionId, ids).catch(() => {});
}

import type { ComposerDraft } from "@/app/types";
import type { PetActionResult } from "@/app/lib/desktop-pet-types";
import { useComposerStateStore } from "../session/surface/composer-state-store";
import { isSessionBusyError } from "../session/surface/session-run-recovery";

/**
 * 宠物跟进沿用原会话FIFO；旧队首未处理时，新消息只能排在其后。
 * @param input 固定项目、会话、完整草稿及原发送入口；显式继续不把busy错误降级为排队
 */
export async function submitPetFollowUp(input: {
  workspaceId: string; sessionId: string; draft: ComposerDraft; active: boolean;
  queueOnBusy: boolean; send: () => Promise<void>;
}): Promise<PetActionResult> {
  const store = useComposerStateStore.getState();
  const enqueue = (): PetActionResult => {
    const item = store.appendQueuedDraft(input.sessionId, input.draft);
    store.markPetQueuedDraft(input.sessionId, item.id, input.workspaceId);
    return { delivery: "queued" };
  };
  // TIPS: idle只说明没有活动运行，不代表旧队列已清空；阻塞项保持原位和失败原因。
  if (input.active || store.queuedDrafts[input.sessionId]?.length) return enqueue();
  try { await input.send(); }
  catch (error) {
    if (input.queueOnBusy && isSessionBusyError(error)) return enqueue();
    throw error;
  }
  return { delivery: "sent" };
}

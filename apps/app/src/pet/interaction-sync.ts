import type { PetInteraction } from "@/app/lib/desktop-pet-types";

/** 输入法组词期间只暂缓当前草稿；其他交互变化仍可写入主进程。 */
export function interactionForBridge(value: PetInteraction, composing: { key: string; persistedDraft: string } | null): PetInteraction {
  if (!composing) return value;
  return { ...value, drafts: { ...value.drafts, [composing.key]: composing.persistedDraft } };
}

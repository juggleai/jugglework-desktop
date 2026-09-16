import type { ComposerDraft } from "@/app/types";

export type ComposerSubmitAction = "send" | "queue";

export function resolveComposerSubmitAction(busy: boolean): ComposerSubmitAction {
  return busy ? "queue" : "send";
}

export function canSteerQueuedDraft(draft: ComposerDraft): boolean {
  return draft.mode === "prompt" && !draft.command;
}

export function shouldDrainQueuedTask(input: {
  queuedCount: number;
  chatStreaming: boolean;
  liveStatus: string;
  waitingForIdle: boolean;
  draining: boolean;
  blocked: boolean;
}) {
  return (
    input.queuedCount > 0 &&
    !input.chatStreaming &&
    input.liveStatus === "idle" &&
    input.waitingForIdle &&
    !input.draining &&
    !input.blocked
  );
}

import type { ComposerDraft, ComposerSubmissionOptions } from "@/app/types";
import { createPresentationDraft, createPresentationTurnId, type PresentationRequest } from "./presentation-request";

type PresentationSendResult = { outcome: "sent" | "accepted" | "blocked" | "cancelled" };

export async function submitPresentationCreation(
  request: PresentationRequest,
  sendDraft: (draft: ComposerDraft, submission: ComposerSubmissionOptions) => Promise<PresentationSendResult>,
  turnId = createPresentationTurnId(),
): Promise<string | null> {
  const result = await sendDraft(createPresentationDraft(request), {
    delivery: "start",
    messageID: turnId,
    intent: "presentation-creation",
  });
  if (result.outcome !== "sent" && result.outcome !== "accepted") {
    throw new Error("The presentation request was not accepted. Try again when the session is ready.");
  }
  return turnId;
}

import type { ComposerDraft, ComposerSubmissionOptions } from "@/app/types";
import type { CloudMcpSubmissionResult } from "../../connections/cloud-mcp-submit-readiness";
import { submitSessionDraft, type SessionDraftSubmissionInput } from "./draft-submission";
import { useComposerStateStore } from "../surface/composer-state-store";
import { t } from "@/i18n";

type SenderHost = Omit<SessionDraftSubmissionInput, "draft" | "sessionId" | "submission" | "isCurrent" | "validateGeneration"> & {
  sessionId: string;
  canSubmit: () => boolean;
  captureContext: (sessionId: string) => { isCurrent: () => boolean; validateGeneration: (draft: ComposerDraft) => boolean; prepare?: SessionDraftSubmissionInput["prepare"] };
};

/** 两个入口共用发送装配；每次提交固定宿主上下文并走同一 admission/parts/错误链路。 */
export function createSessionDraftSender(host: SenderHost) {
  const { canSubmit, captureContext, ...submissionHost } = host;
  return async (draft: ComposerDraft, sessionId: string, submission: ComposerSubmissionOptions = { delivery: "start" }): Promise<CloudMcpSubmissionResult> => {
    const targetSessionId = sessionId.trim() || host.sessionId;
    if (!targetSessionId || !canSubmit()) return { outcome: "cancelled", reason: "context_changed" };
    if (host.hostKind === "file" && targetSessionId !== host.sessionId) throw new Error(t("file_window.operation_unavailable"));
    const context = captureContext(targetSessionId);
    return submitSessionDraft({
      ...submissionHost,
      draft, sessionId: targetSessionId, submission,
      prepare: context.prepare ?? host.prepare,
      isCurrent: () => canSubmit() && context.isCurrent() &&
        (submission.claimId === undefined || useComposerStateStore.getState().queueClaims[targetSessionId] === submission.claimId),
      validateGeneration: () => context.validateGeneration(draft),
    });
  };
}

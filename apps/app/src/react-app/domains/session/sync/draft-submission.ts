import type { Client, ComposerDraft, ComposerSubmissionOptions, ModelRef } from "@/app/types";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { CloudMcpSubmitReadiness } from "../../connections/use-cloud-mcp-submit-readiness";
import type { CloudMcpSubmissionResult } from "../../connections/cloud-mcp-submit-readiness";
import { compactSession, isCompactSessionCommand, shellInSession } from "@/app/lib/opencode-session";
import { isNewSessionCommand } from "../surface/composer/slash-command";
import { officeSubmissionFromDraft } from "../surface/composer/office-selection-draft";
import { useComposerStateStore } from "../surface/composer-state-store";
import { mergeImageGenerationSystemContext } from "../surface/composer/image-generation";
import { mergeVideoGenerationSystemContext } from "../surface/composer/video-generation";
import { buildJuggleWorkEnvSystemContext } from "./env-context";
import { draftToParts } from "./draft-parts";
import { claimSessionSubmission } from "./submission-guard";
import { detectResponseLanguage } from "./response-language";
import { readSessionAgentChoice } from "@/react-app/kernel/session-agent-store";
import { currentLocale } from "@/i18n";
import { captureAnalyticsEvent, markTaskRunStart } from "@/app/lib/analytics";
import { trackSessionActive, trackTaskStarted } from "@/app/lib/den-telemetry";
import { readWorkspaceProjectDimension } from "@/react-app/shell/session-memory";

type Input = {
  draft: ComposerDraft; sessionId: string; workspaceId: string; workspaceRoot: string;
  client: Client; host: JuggleWorkServerClient; endpoint: ResolvedWorkspaceEndpoint | null;
  runtimeKey?: string; workspaceType?: string; submission?: ComposerSubmissionOptions;
  isCurrent: () => boolean;
  /** 目标项目的模型可用性、Connect恢复及插件准备。 */
  prepare: () => Promise<{ model: ModelRef | null; variant: string | null } | CloudMcpSubmissionResult>;
  cloudSubmit: CloudMcpSubmitReadiness["submit"];
  validateGeneration: () => boolean;
};

/** POST发出后的传输中断无法证明服务端未接收；保留待确认状态，避免用户重复提交。 */
function isUnconfirmedSubmissionError(error: unknown) {
  const value = error && typeof error === "object" ? error as { name?: unknown; message?: unknown; code?: unknown; status?: unknown; cause?: unknown } : undefined;
  const cause = value?.cause && typeof value.cause === "object" ? value.cause as { message?: unknown; code?: unknown } : undefined;
  const details = [typeof error === "string" ? error : undefined, value?.name, value?.message, value?.code, cause?.message, cause?.code].filter((part) => typeof part === "string").join(" ");
  return (typeof value?.status === "number" && value.status >= 500) ||
    /timeout|timed out|network|fetch failed|failed to fetch|load failed|AbortError|ECONN|EPIPE|ENET|EHOST|UND_ERR_|net::ERR_|status[ :=]+5\d\d/i.test(details);
}

/** 主输入栏与后台队列共用完整提交链路；异步准备期间目标项目和原会话固定。 */
export async function submitSessionDraft(input: Input) {
  const { draft, sessionId, workspaceId, client, host } = input;
  const submission = input.submission ?? { delivery: "start" };
  const release = claimSessionSubmission(input.endpoint?.workspaceId ?? workspaceId, sessionId);
  let finishOffice: () => string[] = () => [];
  try {
    const text = (draft.resolvedText ?? draft.text).trim();
    if (!input.isCurrent() || (!text && !draft.attachments.length)) return { outcome: "cancelled", reason: "context_changed" } as const;
    if (isNewSessionCommand(draft.command)) throw new Error("/new must be handled by the session interface.");
    if (submission.delivery === "steer" && (draft.mode !== "prompt" || draft.command)) throw new Error("Commands and shell tasks cannot steer an active task.");
    const office = officeSubmissionFromDraft(draft);
    if (office.officeInstructions?.length && (draft.mode !== "prompt" || draft.command)) throw new Error("选区修改要求请作为普通消息发送");
    // TIPS: 后台队列同样持有并验证Office引用；预检失败保留完整草稿，不降级成纯文本。
    finishOffice = useComposerStateStore.getState().holdOfficeSubmission(sessionId, office.officeSelectionRefs ?? []);
    if (office.officeSelectionRefs?.length) await host.validateOfficeSelections(input.endpoint?.workspaceId ?? workspaceId, sessionId, office.officeSelectionRefs);
    const prepared = await input.prepare();
    if ("outcome" in prepared) return prepared;
    const { model, variant } = prepared;
    if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" } as const;
    const compact = isCompactSessionCommand(draft.command);
    if (compact && !model) throw new Error("Choose a model before compacting this session.");
    return await input.cloudSubmit({
      skipGate: !draft.parts.some((part) => part.type === "capability" && ["cloud-skill", "cloud-mcp", "extension"].includes(part.kind)),
      sessionId, providerModel: model ? { provider: model.providerID, model: model.modelID } : undefined,
      validateBeforeSend: () => input.isCurrent() && input.validateGeneration(),
      send: async () => {
        let parts: Awaited<ReturnType<typeof draftToParts>> = [];
        let system: string | undefined;
        if (draft.mode !== "shell" && !compact && !draft.command) {
          parts = await draftToParts(draft, input.workspaceRoot, sessionId, input.endpoint);
          system = mergeVideoGenerationSystemContext(draft, mergeImageGenerationSystemContext(draft,
            await buildJuggleWorkEnvSystemContext(host, { cacheKey: sessionId, runtimeKey: input.runtimeKey })));
        }
        // TIPS: 文件上传或环境准备期间供应商可能变化，紧邻POST再次检查，避免发送已失效的生成模型。
        if (!input.isCurrent() || !input.validateGeneration()) return false;
        captureAnalyticsEvent("task_message_sent", { mode: draft.mode ?? "prompt", delivery: submission.delivery ?? "start", is_command: Boolean(draft.command), attachment_count: draft.attachments.length, text_length: text.length, workspace_type: input.workspaceType ?? "unknown", provider_id: model?.providerID ?? null, model_id: model?.modelID ?? null });
        const dimension = readWorkspaceProjectDimension(workspaceId);
        const dimensions = dimension ? [{ type: "project", label: dimension.label }] : undefined;
        trackSessionActive(sessionId, dimensions);
        if (submission.delivery !== "steer") { markTaskRunStart(sessionId); trackTaskStarted(sessionId, dimensions); }
        try {
          if (draft.mode === "shell") { await shellInSession(client, sessionId, text); return; }
          if (compact && model) { await compactSession(client, sessionId, model, { directory: input.workspaceRoot || undefined, variant: variant ?? undefined }); return; }
          if (draft.command) {
            const result = await client.session.command({ sessionID: sessionId, command: draft.command.name, arguments: draft.command.arguments });
            if (result.error) throw result.error;
            return;
          }
          const request = {
            sessionID: sessionId, parts, juggleworkOfficeSelections: office,
            ...(submission.delivery !== "steer" && submission.messageID ? { messageID: submission.messageID } : {}),
            juggleworkDetectedResponseLanguage: detectResponseLanguage(draft) ?? undefined,
            juggleworkDefaultResponseLanguage: currentLocale() === "zh" ? "zh" as const : "en" as const,
            model: model ?? undefined, variant: variant ?? undefined,
            agent: readSessionAgentChoice(workspaceId, sessionId) ?? undefined,
            ...(system ? { system } : {}),
            ...(submission.delivery === "steer" ? { juggleworkDelivery: "steer" as const, juggleworkAdmissionId: submission.admissionId } : {}),
          };
          const result = await client.session.promptAsync(request);
          if (result.error) throw result.error;
        } catch (error) {
          const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
          if (isUnconfirmedSubmissionError(error)) throw new Error("发送结果待确认，请先打开原任务核对，再决定是否重试");
          throw error instanceof Error ? error : new Error(message);
        }
      },
    });
  } finally {
    const ids = finishOffice();
    if (ids.length) void host.releaseOfficeSelections(input.endpoint?.workspaceId ?? workspaceId, sessionId, ids).catch(() => {});
    release();
  }
}

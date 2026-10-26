/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JuggleWorkSessionMessage } from "@/app/lib/jugglework-server";
import type { ComposerAttachment, ModelRef } from "@/app/types";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { buildJuggleWorkWorkspaceBaseUrl } from "@/app/lib/jugglework-server";
import { createClient } from "@/app/lib/opencode";
import { ReactSessionComposer } from "@/react-app/domains/session/surface/composer/composer";
import { PermissionModeSelect } from "@/react-app/domains/session/surface/composer/permission-mode-select";
import { useSessionPermissionMode } from "@/react-app/domains/session/sync/use-session-permission-mode";
import { composerAttachmentToFilePart, resolveAttachmentFileMetadata } from "@/react-app/domains/session/sync/attachment-file-part";
import { useOrgRestrictions } from "@/react-app/domains/cloud/desktop-config-provider";
import { readStoredDefaultModel, writeStoredDefaultModel } from "@/react-app/kernel/model-config";
import { readSessionChoices, setSessionModelChoice, setSessionVariantChoice } from "@/react-app/kernel/session-model-store";
import { currentLocale } from "@/i18n";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";

const EMPTY_LIST = async () => [];
const text = (en: string, zh: string) => currentLocale() === "zh" ? zh : en;

function initialChoice(workspaceId: string, sessionId: string) {
  const session = readSessionChoices(workspaceId)[sessionId];
  return {
    model: session?.model ?? readStoredDefaultModel(),
    variant: Object.prototype.hasOwnProperty.call(session ?? {}, "variant") ? session?.variant ?? null : null,
  };
}

function variantLabel(value: string | null) {
  if (!value) return "Default";
  return value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");
}

export function ReviewSessionComposer(props: {
  endpoint: ResolvedWorkspaceEndpoint;
  workspaceId: string;
  sessionId: string;
  messages: JuggleWorkSessionMessage[];
  systemPrompt: string;
  busy: boolean;
  disabled?: boolean;
  compact?: boolean;
  compactJoined?: boolean;
  onComposerFocus?: () => void;
  onStopReview?: () => Promise<void>;
  onSubmitted: () => void | Promise<void>;
}) {
  const { endpoint, workspaceId, sessionId } = props;
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [choice, setChoice] = useState(() => initialChoice(workspaceId, sessionId));
  const [submitting, setSubmitting] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [queued, setQueued] = useState<Array<{ text: string; attachments: ComposerAttachment[] }>>([]);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const orgRestrictions = useOrgRestrictions();
  const catalogOpencodeBaseUrl = endpoint.opencodeBaseUrl;
  const catalogOpencodeClient = useMemo(() => createClient(catalogOpencodeBaseUrl, undefined, {
    mode: "jugglework",
    token: endpoint.token || undefined,
  }), [catalogOpencodeBaseUrl, endpoint.token]);
  const permission = useSessionPermissionMode({ client: endpoint.client, workspaceId, sessionId });
  const dependencies = useMemo(() => endpoint.client.listAutomationDependencies(endpoint.workspaceId), [endpoint.client, endpoint.workspaceId]);
  const [dependencyModels, setDependencyModels] = useState<Awaited<typeof dependencies>["models"]>([]);

  useEffect(() => {
    setDraft("");
    setAttachments([]);
    setQueued([]);
    setInputHistory([]);
    setError(null);
    setChoice(initialChoice(workspaceId, sessionId));
  }, [sessionId, workspaceId]);
  useEffect(() => {
    let alive = true;
    void dependencies.then((result) => { if (alive) setDependencyModels(result.models); }).catch(() => { if (alive) setDependencyModels([]); });
    return () => { alive = false; };
  }, [dependencies]);

  const fallbackModel = dependencyModels[0]
    ? { providerID: dependencyModels[0].providerId, modelID: dependencyModels[0].modelId }
    : null;
  const selectedModel: ModelRef = choice.model ?? fallbackModel ?? { providerID: "", modelID: "" };
  const modelEntry = dependencyModels.find((item) => item.providerId === selectedModel.providerID && item.modelId === selectedModel.modelID);
  const behaviorOptions = modelEntry?.variants.map((value) => ({ value, label: variantLabel(value) })) ?? [];
  const effectiveVariant = choice.variant ?? (modelEntry?.variants.includes("medium") ? "medium" : modelEntry?.variants[0] ?? null);

  const attachFiles = useCallback((files: File[]) => {
    const next = files.map((file) => {
      const metadata = resolveAttachmentFileMetadata(file);
      return {
        id: `review-att-${crypto.randomUUID()}`,
        name: file.name,
        mimeType: metadata.mime,
        size: file.size,
        kind: metadata.kind,
        file,
        previewUrl: metadata.kind === "image" ? URL.createObjectURL(file) : undefined,
      } satisfies ComposerAttachment;
    });
    setAttachments((current) => [...current, ...next]);
  }, []);
  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((item) => item.id !== id);
    });
    setDraft((current) => current.replaceAll(`[attachment ${id}]`, ""));
  }, []);

  const sendDraft = useCallback(async (pending: { text: string; attachments: ComposerAttachment[] }, whenBusy: "reject" | "steer") => {
    if ((!pending.text && pending.attachments.length === 0) || !selectedModel.providerID || !selectedModel.modelID || submitting) return false;
    setSubmitting(true);
    setError(null);
    try {
      const fileParts = await Promise.all(pending.attachments.map(composerAttachmentToFilePart));
      await endpoint.client.startSessionRun(workspaceId, sessionId, {
        origin: "local-renderer",
        startCommandCorrelationId: crypto.randomUUID(),
        whenBusy,
        prompt: {
          model: selectedModel,
          system: props.systemPrompt,
          ...(effectiveVariant ? { variant: effectiveVariant } : {}),
          ...(selectedAgent ? { agent: selectedAgent } : {}),
          parts: [...(pending.text ? [{ type: "text" as const, text: pending.text }] : []), ...fileParts],
        },
      });
      pending.attachments.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
      if (pending.text) setInputHistory((current) => [...current.filter((item) => item !== pending.text), pending.text].slice(-100));
      await props.onSubmitted();
      return true;
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
      return false;
    } finally {
      setSubmitting(false);
    }
  }, [effectiveVariant, endpoint.client, props, selectedAgent, selectedModel, sessionId, submitting, workspaceId]);

  const currentDraft = useCallback(() => ({
    text: draft.replace(/\[attachment review-att-[^\]]+\]/g, "").trim(),
    attachments,
  }), [attachments, draft]);
  const submit = useCallback(async (whenBusy: "reject" | "steer") => {
    const pending = currentDraft();
    const sent = await sendDraft(pending, whenBusy);
    if (!sent) return;
    setDraft("");
    setAttachments([]);
  }, [currentDraft, sendDraft]);
  const queueCurrent = useCallback(() => {
    const pending = currentDraft();
    if (!pending.text && pending.attachments.length === 0) return;
    setQueued((current) => [...current, pending]);
    setDraft("");
    setAttachments([]);
  }, [currentDraft]);
  useEffect(() => {
    if (props.busy || submitting || queued.length === 0) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    void sendDraft(next!, "reject").then((sent) => {
      if (!sent) setQueued((current) => [next!, ...current]);
    });
  }, [props.busy, queued, sendDraft, submitting]);

  const stop = useCallback(async () => {
    setError(null);
    try {
      if (props.onStopReview) {
        await props.onStopReview();
        await props.onSubmitted();
        return;
      }
      const active = await endpoint.client.listActiveSessionRuns(workspaceId);
      const run = active.items.find((item) => item.sessionId === sessionId);
      if (!run) return;
      await endpoint.client.abortSessionRun(workspaceId, sessionId, run.runId, { abortCommandCorrelationId: crypto.randomUUID() });
      await props.onSubmitted();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    }
  }, [endpoint.client, props, sessionId, workspaceId]);

  return <WorkspaceProvider client={catalogOpencodeClient} opencodeBaseUrl={catalogOpencodeBaseUrl} selectedWorkspaceRoot="">
  <ReactSessionComposer
    sessionId={sessionId}
    createVoiceRealtimeSession={endpoint.client.createVoiceRealtimeSession}
    getVoiceRealtimeStatus={endpoint.client.getVoiceRealtimeStatus}
    focusEligible={!props.compact}
    compact={props.compact}
    compactJoined={props.compactJoined}
    onFocusCapture={props.onComposerFocus}
    compactPlaceholder={text("Use JuggleWork", "使用 JuggleWork")}
    draft={draft}
    mentions={{}}
    onDraftChange={setDraft}
    onSend={() => submit("reject")}
    onSteer={() => submit("steer")}
    onQueue={queueCurrent}
    onStop={stop}
    busy={props.busy}
    steering={submitting && props.busy}
    submissionPreparing={submitting}
    submissionPreparingLabel={submitting ? text("Sending…", "正在发送…") : null}
    submissionDisabled={!sessionId}
    queuedCount={queued.length}
    disabled={Boolean(props.disabled) || !selectedModel.providerID || !selectedModel.modelID}
    statusLabel={props.busy ? text("Working", "运行中") : text("Ready", "就绪")}
    modelPickerOpen={modelPickerOpen}
    selectedModel={selectedModel}
    contextUsageMessages={props.messages}
    contextUsageTranscript={[]}
    contextWindowTokens={0}
    onModelPickerOpenChange={setModelPickerOpen}
    onModelChange={(model) => {
      setChoice({ model, variant: null });
      setSessionModelChoice(workspaceId, sessionId, model);
      writeStoredDefaultModel(model);
    }}
    attachments={attachments}
    onAttachFiles={attachFiles}
    onRemoveAttachment={removeAttachment}
    attachmentsEnabled
    attachmentsDisabledReason={null}
    imageGenerationModels={[]}
    imageGenerationLoading={false}
    imageGeneration={null}
    onEnableImageGeneration={() => undefined}
    onImageGenerationChange={() => undefined}
    onDisableImageGeneration={() => undefined}
    onRefreshImageGenerationModels={async () => undefined}
    videoGenerationModels={[]}
    videoGenerationLoading={false}
    videoGeneration={null}
    onEnableVideoGeneration={() => undefined}
    onVideoGenerationChange={() => undefined}
    onDisableVideoGeneration={() => undefined}
    onRefreshVideoGenerationModels={async () => undefined}
    modelVariantLabel={variantLabel(effectiveVariant)}
    modelVariant={effectiveVariant}
    modelBehaviorOptions={behaviorOptions}
    onModelVariantChange={(variant) => {
      setChoice((current) => ({ ...current, variant }));
      setSessionVariantChoice(workspaceId, sessionId, variant);
    }}
    permissionModeSelector={<PermissionModeSelect
      requestedMode={permission.state?.requestedMode ?? null}
      effectiveMode={permission.state?.effectiveMode ?? null}
      grants={permission.grants}
      disabledReason={!permission.supported ? text("Permission modes are unavailable", "当前会话不支持权限模式") : null}
      busy={permission.updating}
      running={props.busy}
      desktopConfig={orgRestrictions}
      onSelectRequestApproval={() => { void permission.requestApproval(); }}
      onSelectFullAccess={() => { void permission.enableFullAccess(); }}
      compact={props.compact}
    />}
    agentLabel={text("Agent", "智能体")}
    selectedAgent={selectedAgent}
    listAgents={EMPTY_LIST}
    onSelectAgent={setSelectedAgent}
    listCommands={EMPTY_LIST}
    recentFiles={[]}
    searchFiles={EMPTY_LIST}
    onInsertMention={(_kind, value) => setDraft((current) => `${current}${value}`)}
    inputHistory={inputHistory}
    onPasteText={(value) => setDraft((current) => `${current}${value}`)}
    onUnsupportedFileLinks={() => undefined}
    pastedText={[]}
    onExpandPastedText={() => undefined}
    onRemovePastedText={() => undefined}
    isRemoteWorkspace={false}
    isSandboxWorkspace={false}
    draftScopeKey={`review:${workspaceId}:${sessionId}`}
    topAccessory={error ? <div role="alert" className="border-b border-red-6 bg-red-3 px-4 py-2 text-xs text-red-11">{error}</div> : null}
  />
  </WorkspaceProvider>;
}

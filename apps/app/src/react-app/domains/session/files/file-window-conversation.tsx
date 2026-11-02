import * as React from "react";
import { createClient, unwrap } from "@/app/lib/opencode";
import { buildJuggleWorkWorkspaceBaseUrl, type JuggleWorkServerClient, type JuggleWorkSessionSnapshot } from "@/app/lib/jugglework-server";
import { useQueryCacheState } from "@/react-app/infra/query-cache-state";
import { reconcileWorkspaceInteractionRoots, snapshotKey } from "../sync/session-sync";
import type { FileWindowBridge, FileWindowState, FileWindowConversationOptions } from "@jugglework/types/file-window";
import type { ModelRef } from "@/app/types";
import type { DenDesktopConfig } from "@/app/lib/den";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import { SessionShellConfigProvider } from "@/react-app/shell/shell-config";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { SessionDesktopConfigProvider } from "../../cloud/desktop-config-provider";
import { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE } from "../../connections/cloud-mcp-submit-readiness";
import { submitWithoutCloudMcpGate } from "../../connections/use-cloud-mcp-submit-readiness";
import { getConnectedProviderItems, isModelAvailableInConnectedProviders, resolveConnectedProviderModel, useProviderListQuery } from "@/react-app/infra/provider-list-query";
import { isDesktopModelBlocked, checkDesktopAppRestriction } from "@/app/cloud/desktop-app-restrictions";
import { ReactSessionRuntime } from "../sync/runtime-sync";
import { createSessionDraftSender } from "../sync/session-draft-sender";
import { SessionSurface } from "../surface/session-surface";
import { useModelBehavior } from "../surface/use-model-behavior";
import { t } from "@/i18n";

/** Main 仅给已登记真实会话提供 conversation，包含默认工作区中的外部文件会话。 */
export function hasFileWindowConversation(state: FileWindowState | null): state is FileWindowState & { conversation: NonNullable<FileWindowState["conversation"]> } {
  return Boolean(state?.conversation?.desktopConfig && state.workspaceRoot && state.workspaceId && state.sessionId && state.sessionId !== "file-browser" && !state.workspaceId.startsWith("rem_"));
}

/** 普通文件上下文不是选区权限；提交时捕获，之后切标签不改绑。 */
export function fileWindowSubmissionContext(state: FileWindowState): string | undefined {
  const tab = state.tabs.find((item) => item.path === state.activePath);
  if (!tab) return undefined;
  return `Current file: ${JSON.stringify({ path: tab.path, name: tab.name })}. This identifies the file only; it does not authorize editing an Office selection. Use only a valid selection reference attached to this message for selection-scoped edits.`;
}

const emptyCommands = async () => [];
const noDraftChange = () => {};
const noNewSession = async () => null;
const DEFAULT_POLICY: DenDesktopConfig = {};

/** 文件入口的最小装配：只注入绑定 transport/导航/上下文，不装载 SessionRoute。 */
export function FileWindowConversation({ state, client, bridge, visible, options, onOptionsChange }: {
  state: FileWindowState;
  client: JuggleWorkServerClient;
  bridge: FileWindowBridge;
  visible: boolean;
  options: FileWindowConversationOptions;
  onOptionsChange: React.Dispatch<React.SetStateAction<FileWindowConversationOptions>>;
}) {
  React.useEffect(() => {
    // A new child's first event can precede Main's ancestry proof. Read the
    // existing root snapshot even while SSE stays healthy; never trust that event.
    let disposed = false;
    const reconcile = async () => {
      try {
        await reconcileWorkspaceInteractionRoots(client, state.workspaceId, [state.sessionId]);
      } finally {
        if (!disposed) timer = window.setTimeout(reconcile, 5000);
      }
    };
    let timer = window.setTimeout(reconcile, 5000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [client, state.workspaceId, state.sessionId]);

  const mountedBaseUrl = buildJuggleWorkWorkspaceBaseUrl(client.baseUrl, state.workspaceId)!;
  const opencodeBaseUrl = `${mountedBaseUrl}/opencode`;
  const sdk = React.useMemo(() => createClient(opencodeBaseUrl, state.workspaceRoot, { mode: "jugglework" }), [opencodeBaseUrl, state.workspaceRoot]);
  const providers = useProviderListQuery({ client: sdk, baseUrl: opencodeBaseUrl, directory: state.workspaceRoot });
  const snapshot = useQueryCacheState<JuggleWorkSessionSnapshot | null>(snapshotKey(state.workspaceId, state.sessionId), null);
  const { model: choice, agent: agentChoice, variant } = options;
  const setAgent = (agent: string | null) => onOptionsChange((current) => ({ ...current, agent }));
  const setVariant = (variant: string | null) => onOptionsChange((current) => ({ ...current, variant }));
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const config = state.conversation?.desktopConfig ?? DEFAULT_POLICY;
  const isAllowed = (model: ModelRef) => !isDesktopModelBlocked({
    model, allowedModels: config.allowedModels,
    checkRestriction: (input) => checkDesktopAppRestriction({ config, ...input }),
    providerSource: providers.data?.all.find((provider) => provider.id === model.providerID)?.source,
  });
  const lastUser = snapshot?.messages.findLast((message) => message.info.role === "user")?.info;
  const agent = agentChoice !== undefined ? agentChoice : lastUser?.role === "user" ? lastUser.agent : null;
  // TIPS: 历史模型可能附带 variant；身份字段和档位分别提交，不能把历史扩展字段透传到受限桥。
  const historyModel = lastUser?.role === "user" ? lastUser.model : null;
  const preferred = choice ?? (historyModel ? { providerID: historyModel.providerID, modelID: historyModel.modelID } : null);
  const model = preferred ?? resolveConnectedProviderModel(providers.data, null, { isAllowed: ({ model }) => isAllowed(model) });
  const { modelVariantValue, modelVariantLabel, modelBehaviorOptions } = useModelBehavior({
    providerList: providers.data, defaultModel: model, modelVariant: variant === undefined ? historyModel?.variant ?? null : variant,
  });
  const selectModel = React.useCallback((next: ModelRef) => {
    const changed = next.providerID !== model?.providerID || next.modelID !== model?.modelID;
    onOptionsChange((current) => ({ ...current, model: next, ...(changed ? { variant: null } : {}) }));
  }, [model?.providerID, model?.modelID, onOptionsChange]);
  const unavailable = !model || !isAllowed(model) || !isModelAvailableInConnectedProviders(providers.data, model);
  const current = React.useRef({ state, providers: providers.data, isAllowed });
  current.current = { state, providers: providers.data, isAllowed };
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onSendDraft = React.useMemo(() => createSessionDraftSender({
    sessionId: state.sessionId, workspaceId: state.workspaceId, workspaceRoot: state.workspaceRoot,
    client: sdk, host: client, endpoint: null, hostKind: "file", workspaceType: "local",
    agent, systemContext: fileWindowSubmissionContext(state),
    canSubmit: () => mounted.current && hasFileWindowConversation(current.current.state) && Boolean(model && current.current.isAllowed(model) && isModelAvailableInConnectedProviders(current.current.providers, model)),
    prepare: async () => ({ model, variant: modelVariantValue }),
    cloudSubmit: async (input) => {
      if (!input.skipGate) throw new Error(t("file_window.operation_unavailable"));
      if (input.validateBeforeSend && !await input.validateBeforeSend()) return { outcome: "cancelled", reason: "context_changed" };
      return submitWithoutCloudMcpGate(input.send);
    },
    captureContext: () => ({
      isCurrent: () => mounted.current && current.current.state.workspaceId === state.workspaceId && current.current.state.sessionId === state.sessionId,
      validateGeneration: (draft) => !draft.imageGeneration && !draft.videoGeneration,
    }),
  }), [state, sdk, client, model, agent, modelVariantValue]);
  const listAgents = React.useCallback(async () => unwrap(await sdk.app.agents()).filter((agent) => !agent.hidden && agent.mode !== "subagent"), [sdk]);
  const searchFiles = React.useCallback(async (query: string) => current.current.state.tabs.filter((tab) => tab.path.toLowerCase().includes(query.toLowerCase())).map((tab) => tab.path), []);
  const navigateMain = () => { void bridge.action("open-session"); };
  const selectedInfo = providers.data?.all.find((provider) => provider.id === model?.providerID)?.models[model?.modelID ?? ""];
  return (
    <LocalProvider persist={false}>
      <SessionShellConfigProvider>
        <SessionDesktopConfigProvider config={config}>
          <WorkspaceProvider client={sdk} opencodeBaseUrl={opencodeBaseUrl} selectedWorkspaceRoot={state.workspaceRoot}>
            <ReactSessionRuntime workspaceId={state.workspaceId} sessionId={state.sessionId} opencodeBaseUrl={opencodeBaseUrl} juggleworkToken="" interactionClient={client} />
            <SessionSurface
              hostKind="file" visible={visible} client={client} workspaceId={state.workspaceId} workspaceRoot={state.workspaceRoot} sessionId={state.sessionId}
              isControlTarget={visible} opencodeBaseUrl={opencodeBaseUrl} juggleworkToken="" developerMode={false}
              modelLabel={selectedInfo?.name ?? model?.modelID ?? t("session.default_model")} onModelClick={() => setPickerOpen(true)}
              modelPickerOpen={pickerOpen} onModelPickerOpenChange={setPickerOpen} selectedModel={model ?? { providerID: "", modelID: "" }}
              modelUnavailable={unavailable} taskSubmissionDisabled={!snapshot || providers.isPending || providers.isError || unavailable}
              contextWindowTokens={selectedInfo?.limit.context ?? 0} onModelChange={selectModel} onChangeModel={selectModel}
              modelVariant={modelVariantValue} modelVariantLabel={modelVariantLabel} modelBehaviorOptions={modelBehaviorOptions} onModelVariantChange={setVariant}
              agentLabel={agent ?? t("session.default_agent")} selectedAgent={agent} onSelectAgent={setAgent} listAgents={listAgents}
              onSendDraft={onSendDraft} onCreateNewSession={noNewSession} onDraftChange={noDraftChange}
              cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE} onOpenConnect={navigateMain}
              attachmentsEnabled={false} attachmentsDisabledReason={t("file_window.operation_unavailable")}
              listCommands={emptyCommands} recentFiles={state.tabs.map((tab) => tab.path)} searchFiles={searchFiles}
              isRemoteWorkspace={false} isSandboxWorkspace={false} providerConnectedCount={getConnectedProviderItems(providers.data).length}
              onOpenSettingsSection={navigateMain} onOpenTarget={(target) => { if (target.kind === "file" && state.tabs.some((tab) => tab.path === target.value)) void bridge.action("select", target.value); }}
            />
          </WorkspaceProvider>
        </SessionDesktopConfigProvider>
      </SessionShellConfigProvider>
    </LocalProvider>
  );
}

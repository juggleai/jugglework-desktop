/** Smoke-only composition, deliberately NOT the full SessionRoute. No UI doubles. */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { PlatformProvider, createDefaultPlatform } from "@/react-app/kernel/platform";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import { SessionShellConfigProvider } from "@/react-app/shell/shell-config";
import { SessionDesktopConfigProvider } from "@/react-app/domains/cloud/desktop-config-provider";
import { SessionSurface } from "@/react-app/domains/session/surface/session-surface";
import { installFileWindowSessionStopBridge } from "@/react-app/domains/session/surface/file-window-session-stop";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { createSessionDraftSender } from "@/react-app/domains/session/sync/session-draft-sender";
import { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE } from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { submitWithoutCloudMcpGate } from "@/react-app/domains/connections/use-cloud-mcp-submit-readiness";
import { createJuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { createClient } from "@/app/lib/opencode";
import "@/app/index.css";

const params = new URLSearchParams(location.search);
const baseUrl = params.get("backend")!;
const workspaceRoot = params.get("root")!;
const workspaceId = "smoke-workspace";
const sessionId = "smoke-session";
const opencodeBaseUrl = `${baseUrl}/workspace/${workspaceId}/opencode`;
const client = createJuggleWorkServerClient({ baseUrl });
const disposeSessionStopBridge = installFileWindowSessionStopBridge(client);
if (import.meta.hot) import.meta.hot.dispose(disposeSessionStopBridge);
const sdk = createClient(opencodeBaseUrl, workspaceRoot, { mode: "jugglework" });
const model = { providerID: "fixture", modelID: "synthetic" };
const noop = () => {};
const empty = async () => [];
const onSendDraft = createSessionDraftSender({
  sessionId, workspaceId, workspaceRoot, client: sdk, host: client, endpoint: null,
  hostKind: "main", workspaceType: "local", agent: "build",
  canSubmit: () => true,
  prepare: async () => ({ model, variant: null }),
  captureContext: () => ({ isCurrent: () => true, validateGeneration: () => true }),
  cloudSubmit: async (input) => {
    if (!input.skipGate) throw new Error("Fixture only supports plain text");
    if (input.validateBeforeSend && !await input.validateBeforeSend()) return { outcome: "cancelled", reason: "context_changed" };
    return submitWithoutCloudMcpGate(input.send);
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={getReactQueryClient()}><TooltipProvider>
    <PlatformProvider value={createDefaultPlatform()}><LocalProvider persist={false}>
      <SessionShellConfigProvider><SessionDesktopConfigProvider config={{}}>
        <WorkspaceProvider client={sdk} opencodeBaseUrl={opencodeBaseUrl} selectedWorkspaceRoot={workspaceRoot}>
          <ReactSessionRuntime workspaceId={workspaceId} sessionId={sessionId} opencodeBaseUrl={opencodeBaseUrl} juggleworkToken="" interactionClient={client} />
          <SessionSurface hostKind="main" client={client} workspaceId={workspaceId} workspaceRoot={workspaceRoot} sessionId={sessionId}
            isControlTarget={false} opencodeBaseUrl={opencodeBaseUrl} juggleworkToken="" developerMode={false}
            modelLabel="Synthetic fixture" onModelClick={noop} modelPickerOpen={false} selectedModel={model} contextWindowTokens={32000}
            onModelPickerOpenChange={noop} onModelChange={noop} onChangeModel={noop} onSendDraft={onSendDraft}
            onCreateNewSession={async () => null} cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE}
            onOpenConnect={noop} onDraftChange={noop} attachmentsEnabled={false} attachmentsDisabledReason={null}
            modelVariantLabel="Default" modelVariant={null} onModelVariantChange={noop} agentLabel="build" selectedAgent="build"
            listAgents={empty} onSelectAgent={noop} listCommands={empty} recentFiles={[]} searchFiles={empty}
            isRemoteWorkspace={false} isSandboxWorkspace={false} providerConnectedCount={1} />
        </WorkspaceProvider>
      </SessionDesktopConfigProvider></SessionShellConfigProvider>
    </LocalProvider></PlatformProvider><Toaster />
  </TooltipProvider></QueryClientProvider>,
);

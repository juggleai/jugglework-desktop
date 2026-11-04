/** @jsxImportSource react */
import * as React from "react";
import { expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactSessionComposer } from "../src/react-app/domains/session/surface/composer/composer";
import { QueuedMessagesPanel } from "../src/react-app/domains/session/modals/queued-messages-panel";

// Exercise the main-host Surface and shared sender; only DOM leaves are replaced.
function Composer(props: React.ComponentProps<typeof ReactSessionComposer>) { return <div>{props.topAccessory}</div>; }
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer: Composer }));
mock.module("../src/components/chat/message-list", () => ({ MessageList: () => null }));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/ui/tooltip", () => ({ Tooltip: ({ children }: React.PropsWithChildren) => children, TooltipTrigger: ({ children }: React.PropsWithChildren) => children, TooltipContent: () => null }));

const { SessionSurface } = await import("../src/react-app/domains/session/surface/session-surface");
const { createSessionDraftSender } = await import("../src/react-app/domains/session/sync/session-draft-sender");
const { createClient } = await import("../src/app/lib/opencode");
const { createJuggleWorkServerClient } = await import("../src/app/lib/jugglework-server");
const { getReactQueryClient } = await import("../src/react-app/infra/query-client");
const { LocalProvider } = await import("../src/react-app/kernel/local-provider");
const { SessionShellConfigProvider } = await import("../src/react-app/shell/shell-config");
const { SessionDesktopConfigProvider } = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
const { IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE } = await import("../src/react-app/domains/connections/cloud-mcp-submit-readiness");
const { submitWithoutCloudMcpGate } = await import("../src/react-app/domains/connections/use-cloud-mcp-submit-readiness");
const { isSessionSubmissionPreparing } = await import("../src/react-app/domains/session/sync/submission-guard");
const { installFileWindowSessionStopBridge } = await import("../src/react-app/domains/session/surface/file-window-session-stop");
const { useSessionActivityStore } = await import("../src/react-app/domains/session/status/session-activity-store");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test.each(["prepare", "post"] as const)("main shared sender preserves drafts across a delayed %s", async (stage) => {
  const previousWindow = globalThis.window;
  const nativeFetch = globalThis.fetch;
  const entered = deferred(), release = deferred();
  const workspaceId = `ws_sender_${stage}`, first = `ses_sender_${stage}`, second = `${first}_other`;
  let currentSession = first;
  let busy = false;
  const requests: Array<{ sessionId: string; prompt: { parts: Array<{ type: string; text?: string }> } }> = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const sessionId = /\/sessions\/([^/]+)/.exec(path)?.[1] ?? first;
    if (path.endsWith("/interactions/snapshot")) return Response.json({ item: { rootSessionId: sessionId, permissions: [], questions: [], revision: 1 } });
    if (path.endsWith("/snapshot")) return Response.json({ item: { session: { id: sessionId, title: "Sender", time: { created: 1, updated: 1 } }, messages: [], status: { type: busy ? "busy" : "idle" }, todos: [] } });
    if (path.endsWith("/permission-mode")) return Response.json({ state: null, grants: [], supported: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: busy ? [{ sessionId: first, runId: "run_sender", generation: 1 }] : [] });
    if (path.endsWith("/runs/start")) {
      const body = await request.json() as { prompt: typeof requests[number]["prompt"] };
      requests.push({ sessionId, prompt: body.prompt });
      entered.resolve();
      await release.promise;
      return Response.json({ run: { sessionId, runId: "run_sender", generation: 1 } });
    }
    throw new Error(`Unexpected sender request: ${request.method} ${path}`);
  } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/index.html" }, localStorage: { getItem: () => null },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout,
    __JUGGLEWORK_ELECTRON__: { invokeDesktop: async (command: string, url: string, init: RequestInit) => {
      expect(command).toBe("__fetch");
      const response = await nativeFetch(url, init);
      return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
    } },
  } });
  const base = server.url.href.replace(/\/$/, "");
  const client = createJuggleWorkServerClient({ baseUrl: base });
  client.callExtensionAction = mock(async () => ({ models: [] }));
  client.listUserEnvKeys = mock(async () => ({ keys: [] }));
  const opencodeBaseUrl = `${base}/workspace/${workspaceId}/opencode`;
  const sdk = createClient(opencodeBaseUrl, "/project", { mode: "jugglework" });
  const queryClient = getReactQueryClient();
  queryClient.clear();
  let view: TestRenderer.ReactTestRenderer | undefined;
  let pending: Promise<void> | undefined;
  const composer = () => view!.root.findByType(Composer).props as React.ComponentProps<typeof ReactSessionComposer>;
  const noop = () => {};
  const render = (sessionId: string) => {
    const sender = createSessionDraftSender({
      sessionId, workspaceId, workspaceRoot: "/project", client: sdk, host: client, endpoint: null,
      canSubmit: () => true,
      prepare: async () => { throw new Error("Expected captured target preparation"); },
      captureContext: () => {
        const captured = currentSession;
        return {
          isCurrent: () => currentSession === captured, validateGeneration: () => true,
          prepare: async () => {
            if (stage === "prepare") { entered.resolve(); await release.promise; }
            return { model: { providerID: "provider", modelID: "model" }, variant: "medium" };
          },
        };
      },
      cloudSubmit: async ({ send, validateBeforeSend }) => {
        if (validateBeforeSend && !await validateBeforeSend()) return { outcome: "cancelled", reason: "context_changed" };
        return submitWithoutCloudMcpGate(send);
      },
    });
    return <QueryClientProvider client={queryClient}><PlatformProvider value={createDefaultPlatform()}><LocalProvider persist={false}><SessionShellConfigProvider><SessionDesktopConfigProvider config={{}}>
      <SessionSurface client={client} workspaceId={workspaceId} workspaceRoot="/project" sessionId={sessionId}
        opencodeBaseUrl={opencodeBaseUrl} juggleworkToken="" isControlTarget={false} developerMode={false}
        modelLabel="Model" selectedModel={{ providerID: "provider", modelID: "model" }} contextWindowTokens={10000}
        onModelClick={noop} modelPickerOpen={false} onModelPickerOpenChange={noop} onModelChange={noop}
        modelVariant="medium" modelVariantLabel="Medium" onModelVariantChange={noop}
        selectedAgent={null} agentLabel="Default" onSelectAgent={noop} listAgents={async () => []}
        onSendDraft={sender} onCreateNewSession={async () => null} onDraftChange={noop}
        cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE} onOpenConnect={noop}
        attachmentsEnabled={false} attachmentsDisabledReason={null} listCommands={async () => []}
        recentFiles={[]} searchFiles={async () => []} isRemoteWorkspace={true} isSandboxWorkspace={false} />
    </SessionDesktopConfigProvider></SessionShellConfigProvider></LocalProvider></PlatformProvider></QueryClientProvider>;
  };
  try {
    await act(async () => { view = TestRenderer.create(render(first)); });
    await act(async () => { composer().onDraftChange("original draft"); });
    await act(async () => { pending = composer().onSend(); await entered.promise; });
    expect(composer().draft).toBe("original draft");
    if (stage === "prepare") {
      currentSession = second;
      await act(async () => { view!.update(render(second)); });
      await act(async () => { composer().onDraftChange("other session draft"); });
    } else {
      await act(async () => { composer().onDraftChange("new draft typed during POST"); });
    }
    await act(async () => { release.resolve(); await pending; });
    expect(isSessionSubmissionPreparing(workspaceId, first)).toBe(false);
    if (stage === "prepare") {
      expect(requests).toEqual([]);
      expect(composer().draft).toBe("other session draft");
      expect(useComposerStateStore.getState().sessions[first]?.draft).toBe("original draft");
      currentSession = first;
      await act(async () => { view!.update(render(first)); });
      expect(composer().draft).toBe("original draft");
      expect(useComposerStateStore.getState().history[first]).toBeUndefined();
    } else {
      expect(requests).toEqual([{ sessionId: first, prompt: expect.objectContaining({ parts: [{ type: "text", text: "original draft" }] }) }]);
      expect(composer().draft).toBe("new draft typed during POST");
      expect(useComposerStateStore.getState().history[first]).toEqual(["original draft"]);
      // The real Main Surface must not drain after a file-window Stop preparation.
      let stopRequest!: (input: { workspaceId: string; sessionId: string }) => Promise<{ ok: true }>;
      window.__JUGGLEWORK_ELECTRON__!.fileWindow = { onSessionStopRequest: (callback) => { stopRequest = callback; return () => {}; } } as any;
      const uninstall = installFileWindowSessionStopBridge(client);
      const revoke = URL.revokeObjectURL;
      const revoked: string[] = [];
      URL.revokeObjectURL = (url) => { revoked.push(url); };
      const attachment = (id: string) => ({ id, name: `${id}.txt`, mimeType: "text/plain", kind: "file" as const, size: 1, previewUrl: `blob:${id}` });
      const kept = attachment("kept"), queued = attachment("queued");
      const cleanupEntered = deferred(), cleanupReleased = deferred();
      client.releaseOfficeSelections = mock(async () => { cleanupEntered.resolve(); await cleanupReleased.promise; return { released: 1 }; });
      try {
        busy = true;
        await act(async () => {
          queryClient.setQueryData(["react-session-status", workspaceId, first], { type: "busy" });
          useSessionActivityStore.getState().setRunStatus(workspaceId, first, { type: "busy" });
        });
        // Queue through the actual Main composer while its run is busy.
        await act(async () => { composer().onDraftChange("queued by Main composer"); });
        await act(async () => { await composer().onQueue(); });
        expect(useComposerStateStore.getState().queuedDrafts[first]?.[0]?.draft.text).toBe("queued by Main composer");
        expect(composer().draft).toBe("");
        await act(async () => {
          composer().onDraftChange("new draft typed during POST");
          useComposerStateStore.getState().setAttachments(first, [kept]);
          useComposerStateStore.getState().appendQueuedDraft(first, {
            mode: "prompt", text: "must not restart", attachments: [queued, kept], parts: [{ type: "text", text: "must not restart" }, { type: "office-selection", instruction: "queued edit", references: [{ referenceId: "queued-reference" }] } as any],
          });
          useComposerStateStore.getState().appendQueuedDraft(second, { text: "another session", parts: [{ type: "text", text: "another session" }], attachments: [] });
        });
        expect(requests).toHaveLength(1);
        let acknowledged = false;
        let stopping!: Promise<{ ok: true }>;
        await act(async () => {
          stopping = stopRequest({ workspaceId, sessionId: first }).then((ack) => { acknowledged = true; return ack; });
          await cleanupEntered.promise;
        });
        expect(acknowledged).toBe(true);
        expect(useComposerStateStore.getState().queuedDrafts[first]).toBeUndefined();
        expect(useComposerStateStore.getState().queuedDrafts[second]).toHaveLength(1);
        expect(client.releaseOfficeSelections).toHaveBeenCalledWith(workspaceId, first, ["queued-reference"]);
        expect(revoked).toEqual(["blob:queued"]);
        busy = false;
        await act(async () => {
          useSessionActivityStore.getState().setRunStatus(workspaceId, first, { type: "idle" });
          queryClient.setQueryData(["react-session-status", workspaceId, first], { type: "idle" });
          await queryClient.invalidateQueries({ queryKey: ["session-active-runs", workspaceId] });
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(requests).toHaveLength(1);
        expect(acknowledged).toBe(true);
        await act(async () => { cleanupReleased.resolve(); expect(await stopping).toEqual({ ok: true }); });
        expect(acknowledged).toBe(true);
        expect(composer().draft).toBe("new draft typed during POST");
        expect(composer().attachments).toEqual([kept]);
      } finally { cleanupReleased.resolve(); uninstall(); URL.revokeObjectURL = revoke; }
    }
  } finally {
    release.resolve();
    await act(async () => { await pending; view?.unmount(); });
    queryClient.clear();
    useComposerStateStore.getState().clearSession(first);
    useComposerStateStore.getState().clearSession(second);
    useComposerStateStore.getState().clearQueuedDrafts(first);
    useComposerStateStore.getState().clearQueuedDrafts(second);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
    server.stop(true);
  }
});

for (const delivery of ["start", "steer"] as const) test.each(["prepare", "parts", "cloud-gate"] as const)(`Stop cancels queued ${delivery} during %s without restoring or sending it`, async (stage) => {
  const previousWindow = globalThis.window;
  const nativeFetch = globalThis.fetch;
  const entered = deferred(), release = deferred();
  const workspaceId = `ws_cancel_${delivery}_${stage}`, sessionId = `ses_cancel_${delivery}_${stage}`;
  const requests: any[] = [];
  const busy = delivery === "steer";
  let pause = true;
  const waitAt = async (point: string) => { if (pause && stage === point) { entered.resolve(); await release.promise; } };
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/interactions/snapshot")) return Response.json({ item: { rootSessionId: sessionId, permissions: [], questions: [], revision: 1 } });
    if (path.endsWith("/snapshot")) return Response.json({ item: { session: { id: sessionId, title: "Cancel", time: { created: 1, updated: 1 } }, messages: [], status: { type: busy ? "busy" : "idle" }, todos: [] } });
    if (path.endsWith("/permission-mode")) return Response.json({ state: null, grants: [], supported: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: busy ? [{ sessionId, runId: "run_cancel", generation: 1 }] : [] });
    if (path.endsWith("/runs/start")) { requests.push(await request.json()); return Response.json({ run: { sessionId, runId: "run_cancel", generation: 1 } }); }
    throw new Error(`Unexpected cancellation request: ${path}`);
  } });
  let stopRequest!: (input: { workspaceId: string; sessionId: string }) => Promise<{ ok: boolean }>;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/index.html" }, localStorage: { getItem: () => null },
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout,
    __JUGGLEWORK_ELECTRON__: {
      fileWindow: { onSessionStopRequest: (callback: typeof stopRequest) => { stopRequest = callback; return () => {}; } },
      invokeDesktop: async (_command: string, url: string, init: RequestInit) => {
        const response = await nativeFetch(url, init);
        return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
      },
    },
  } });
  const client = createJuggleWorkServerClient({ baseUrl: server.url.href.replace(/\/$/, "") });
  client.callExtensionAction = mock(async () => ({ models: [] }));
  client.listUserEnvKeys = mock(async () => { await waitAt("parts"); return { keys: [] }; });
  const sdk = createClient(`${client.baseUrl}/workspace/${workspaceId}/opencode`, "/project", { mode: "jugglework" });
  const sender = createSessionDraftSender({
    sessionId, workspaceId, workspaceRoot: "/project", client: sdk, host: client, endpoint: null,
    canSubmit: () => true, captureContext: () => ({ isCurrent: () => true, validateGeneration: () => true }),
    prepare: async () => { await waitAt("prepare"); return { model: { providerID: "provider", modelID: "model" }, variant: null }; },
    cloudSubmit: async ({ send, validateBeforeSend }) => {
      await waitAt("cloud-gate");
      if (validateBeforeSend && !await validateBeforeSend()) return { outcome: "cancelled", reason: "context_changed" };
      return submitWithoutCloudMcpGate(send);
    },
  });
  const queryClient = getReactQueryClient(); queryClient.clear();
  const uninstall = installFileWindowSessionStopBridge(client);
  const noop = () => {};
  let view: TestRenderer.ReactTestRenderer | undefined, steering: Promise<void> | undefined;
  const store = useComposerStateStore.getState();
  const enqueue = (text: string) => store.appendQueuedDraft(sessionId, { mode: "prompt", text, parts: [{ type: "text", text }], attachments: [] });
  const composer = () => view!.root.findByType(Composer).props as React.ComponentProps<typeof ReactSessionComposer>;
  try {
    await act(async () => { view = TestRenderer.create(
      <QueryClientProvider client={queryClient}><PlatformProvider value={createDefaultPlatform()}><LocalProvider persist={false}><SessionShellConfigProvider><SessionDesktopConfigProvider config={{}}>
        <SessionSurface client={client} workspaceId={workspaceId} workspaceRoot="/project" sessionId={sessionId}
          opencodeBaseUrl={`${client.baseUrl}/workspace/${workspaceId}/opencode`} juggleworkToken="" isControlTarget={false} developerMode={false}
          modelLabel="Model" selectedModel={{ providerID: "provider", modelID: "model" }} contextWindowTokens={10000}
          onModelClick={noop} modelPickerOpen={false} onModelPickerOpenChange={noop} onModelChange={noop}
          modelVariant={null} modelVariantLabel="Default" onModelVariantChange={noop}
          selectedAgent={null} agentLabel="Default" onSelectAgent={noop} listAgents={async () => []}
          onSendDraft={sender} onCreateNewSession={async () => null} onDraftChange={noop}
          cloudMcpSubmissionState={IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE} onOpenConnect={noop}
          attachmentsEnabled={false} attachmentsDisabledReason={null} listCommands={async () => []}
          recentFiles={[]} searchFiles={async () => []} isRemoteWorkspace={true} isSandboxWorkspace={false} />
      </SessionDesktopConfigProvider></SessionShellConfigProvider></LocalProvider></PlatformProvider></QueryClientProvider>
    ); });
    for (let i = 0; i < 30 && !queryClient.getQueryData(["session-active-runs", workspaceId]); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    await act(async () => { composer().onDraftChange("keep input"); });
    let id = "";
    await act(async () => { id = enqueue("cancelled queued turn").id; });
    if (delivery === "steer") await act(async () => { steering = view!.root.findByType(QueuedMessagesPanel).props.onSteer(id); });
    await entered.promise;
    expect(isSessionSubmissionPreparing(workspaceId, sessionId)).toBe(true);
    expect(useComposerStateStore.getState().queueClaims[sessionId]).toBe(id);
    expect(requests).toEqual([]);
    await act(async () => { expect(await stopRequest({ workspaceId, sessionId })).toEqual({ ok: true }); });
    expect(useComposerStateStore.getState().queueClaims[sessionId]).toBeUndefined();
    // Cancellation is local and acknowledged while the async stage is still pending.
    expect(isSessionSubmissionPreparing(workspaceId, sessionId)).toBe(true);
    expect(requests).toEqual([]);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
    await act(async () => { release.resolve(); await steering; });
    for (let i = 0; i < 30 && isSessionSubmissionPreparing(workspaceId, sessionId); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(isSessionSubmissionPreparing(workspaceId, sessionId)).toBe(false);
    expect(useComposerStateStore.getState().queueClaims[sessionId]).toBeUndefined();
    expect(requests).toEqual([]);
    expect(useComposerStateStore.getState().queuedDrafts[sessionId]).toBeUndefined();
    expect(useComposerStateStore.getState().history[sessionId]).toBeUndefined();
    expect(composer().draft).toBe("keep input");
    // Clearing a claim cancels only that submission; the next queue item still works.
    pause = false;
    await act(async () => { id = enqueue("fresh queued turn").id; });
    if (delivery === "steer") await act(async () => { await view!.root.findByType(QueuedMessagesPanel).props.onSteer(id); });
    for (let i = 0; i < 30 && !requests.length; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt.parts).toEqual([{ type: "text", text: "fresh queued turn" }]);
    expect(requests[0].whenBusy).toBe(delivery === "steer" ? "steer" : undefined);
    expect(requests[0]).not.toHaveProperty("claimId");
  } finally {
    release.resolve(); await steering;
    await act(async () => { view?.unmount(); });
    uninstall(); queryClient.clear(); store.clearSession(sessionId); store.clearQueuedDrafts(sessionId);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
    server.stop(true);
  }
});

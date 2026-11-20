/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactSessionComposer } from "../src/react-app/domains/session/surface/composer/composer";
import type { Event } from "@opencode-ai/sdk/v2/client";
import { currentLocale, setLocale, t } from "../src/i18n";
import { singleSourceState } from "./fixtures/file-window-state";
const toastInfo = mock();
const sonner = await import("../src/components/ui/sonner");
mock.module("../src/components/ui/sonner", () => ({ ...sonner, toast: Object.assign(() => {}, sonner.toast, { info: toastInfo }) }));

// Keep the real surface, runtime, providers, SDK and sender; replace DOM-only leaves.
function Composer(props: React.ComponentProps<typeof ReactSessionComposer>) { return <div>{props.topAccessory}</div>; }
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer: Composer }));
function Messages({ messages }: any) { return <div data-history={JSON.stringify(messages)} />; }
mock.module("../src/components/chat/message-list", () => ({ MessageList: Messages }));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => children, TooltipTrigger: ({ children }: any) => children, TooltipContent: () => null }));
function Viewer(props: any) { return <div data-viewer-workspace={props.workspaceId} data-viewer-session={props.sessionId} />; }
mock.module("../src/react-app/domains/session/files/file-viewer", () => ({ FileViewer: Viewer }));
mock.module("../src/react-app/domains/session/files/file-editor-toolbar", () => ({ FileEditorToolbar: ({ trailingActions }: any) => <div>{trailingActions}</div>, getOfficeEditorStatus: () => "saved" }));
const Box = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module("../src/components/ui/dropdown-menu", () => Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuGroup", "DropdownMenuItem", "DropdownMenuLabel", "DropdownMenuSeparator", "DropdownMenuSub", "DropdownMenuSubContent", "DropdownMenuSubTrigger", "DropdownMenuTrigger"].map((name) => [name, Box])));

const { FileWindowConversation, hasFileWindowConversation } = await import("../src/react-app/domains/session/files/file-window-conversation");
const { FileWindowApp } = await import("../src/react-app/domains/session/files/file-window-app");
const { createJuggleWorkServerClient } = await import("../src/app/lib/jugglework-server");
const { getReactQueryClient } = await import("../src/react-app/infra/query-client");
const { createDefaultPlatform, PlatformProvider } = await import("../src/react-app/kernel/platform");
const { useComposerStateStore } = await import("../src/react-app/domains/session/surface/composer-state-store");
const { PermissionApprovalPanel } = await import("../src/react-app/domains/session/chat/permission-approval-modal");
// @ts-expect-error Exercise the actual Main bridge authorization/projection with the mounted App.
const { fetchFileWindowResponse } = await import("../../desktop/electron/file-window-fetch.mjs");
// @ts-expect-error Main JS is checked by the desktop project.
const { fileWindowSessionEvent } = await import("../../desktop/electron/file-window-conversation.mjs");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each([
  { seedAgent: "plan", seedVariant: "high", effectiveVariant: "high", recoveryAgent: "custom", locale: "en" as const, fromHistory: false },
  { seedAgent: null, seedVariant: null, effectiveVariant: "medium", recoveryAgent: null, locale: "zh" as const, fromHistory: false },
  { seedAgent: "plan", seedVariant: "removed", effectiveVariant: "medium", recoveryAgent: "team/reviewer", locale: "en" as const, fromHistory: false },
  { seedAgent: null, seedVariant: undefined, effectiveVariant: "low", recoveryAgent: null, locale: "zh" as const, fromHistory: true },
])("file host seeds choices once (%j), mounts the shared runtime and surface, preserves a busy draft and unsubscribes", async ({ seedAgent, seedVariant, effectiveVariant, recoveryAgent, locale, fromHistory }) => {
  const originalLocale = currentLocale();
  setLocale(locale);
  toastInfo.mockClear();
  const previousWindow = globalThis.window;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  let emit!: (event: Event) => void;
  let catalogChanged: (() => void) | undefined;
  let managedAvailable = false;
  let subscriptions = 0, releases = 0, busy = false, failSubmission = false;
  const nativeFetch = globalThis.fetch;
  const session = { id: `ses_mount_${seedAgent ?? "default"}_${seedVariant ?? "default"}${fromHistory ? "_history" : ""}`, title: "Existing session", time: { created: 1, updated: 1 } };
  const model = { id: "model", name: "Model", providerID: "provider", limit: { context: 10000, output: 1000 }, capabilities: {}, variants: { low: {}, medium: {}, high: {} } };
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : undefined;
    calls.push({ path, method: request.method, body });
    if (path.endsWith("/provider")) return Response.json({ all: [{ id: "provider", name: "Provider", models: { fallback: { ...model, id: "fallback", variants: { low: {}, medium: {} } }, standard: { ...model, id: "standard", variants: {} }, model } }, ...(managedAvailable ? [{ id: "lpr_fixture", name: "Managed", models: { model: { ...model, providerID: "lpr_fixture" } } }] : [])], connected: managedAvailable ? ["provider", "lpr_fixture"] : ["provider"], default: { provider: "fallback" } });
    if (path.endsWith("/snapshot") && !path.includes("/interactions/")) return Response.json({ item: { session, messages: [{ info: { id: "old-user", sessionID: session.id, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "provider", modelID: "fallback", variant: "low" } }, parts: [] }], status: { type: busy ? "busy" : "idle" }, todos: [] } });
    if (path.endsWith("/interactions/snapshot")) return Response.json({ item: { rootSessionId: session.id, permissions: [], questions: [], revision: 1 } });
    if (path.endsWith("/permission-mode")) return Response.json({ state: null, grants: [], supported: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: busy ? [{ sessionId: session.id, runId: "run_mount", generation: 1 }] : [] });
    if (path.endsWith("/runs/start")) {
      if (failSubmission) return Response.json({ message: "upstream unavailable" }, { status: 503 });
      return busy ? Response.json({ code: "session_busy", message: "Session is already running" }, { status: 409 }) : Response.json({ run: { sessionId: session.id, runId: "run_mount", generation: 1 } });
    }
    if (path.endsWith("/runs/run_mount/abort")) { busy = false; return Response.json({ abortRequested: true }); }
    throw new Error(`Unexpected file host request: ${request.method} ${path}`);
  } });
  let changed!: (state: any) => void;
  const bridge = {
    state: async () => ({ ...state, baseUrl: server.url.href.replace(/\/$/, "") }),
    onChanged: (listener: typeof changed) => { changed = (next: any) => listener(singleSourceState(next)); return () => {}; },
    onProviderCatalogChanged: (listener: () => void) => { catalogChanged = listener; return () => { catalogChanged = undefined; }; },
    action: mock(async () => {}), subscribeSessionEvents(input: { workspaceId: string }, listener: typeof emit) { expect(input.workspaceId).toBe("ws_mount"); subscriptions++; emit = listener; return () => { releases++; }; },
  };
  const windowStub = {
    location: { pathname: "/file-window.html" },
    localStorage: { getItem: () => null },
    addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout,
    __JUGGLEWORK_ELECTRON__: { fileWindow: bridge, invokeDesktop: async (command: string, url: string, init: RequestInit) => {
      expect(command).toBe("__fetch");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      const response = await nativeFetch(url, init);
      return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
    } },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const expectedModel = { providerID: "provider", modelID: fromHistory ? "fallback" : "model" };
  const state = singleSourceState({ workspaceId: "ws_mount", sessionId: session.id, workspaceRoot: "/project", local: seedVariant === "high" || fromHistory, platform: "darwin", tabs: [{ path: "first.docx", name: "First" }, { path: "second.docx", name: "Second" }], activePath: "first.docx", recent: [], conversation: { model: fromHistory ? undefined : expectedModel, agent: seedAgent, variant: seedVariant, desktopConfig: {} } });
  let view: TestRenderer.ReactTestRenderer | undefined;
  const render = () => <QueryClientProvider client={queryClient}><PlatformProvider value={createDefaultPlatform()}><FileWindowApp /></PlatformProvider></QueryClientProvider>;
  const toggle = () => view!.root.findAllByType("button").find((item) => item.props["aria-controls"] === "file-window-conversation" || item.props["aria-label"] === t("file_window.show_document"))!.props.onClick();
  const composer = () => view!.root.findByType(Composer).props as React.ComponentProps<typeof ReactSessionComposer>;
  try {
    expect(hasFileWindowConversation({ ...state, local: true })).toBe(true);
    expect(hasFileWindowConversation(singleSourceState({ ...state, local: true, sessionId: "file-browser" }))).toBe(false);
    expect(hasFileWindowConversation(singleSourceState({ ...state, workspaceId: "rem_remote" }))).toBe(false);
    expect(hasFileWindowConversation(singleSourceState({ ...state, conversation: undefined }))).toBe(false);
    const queued = useComposerStateStore.getState().appendQueuedDraft(session.id, { text: "main-only follow-up", mode: "prompt", parts: [{ type: "text", text: "main-only follow-up" }], attachments: [] });
    await act(async () => { view = TestRenderer.create(render()); });
    await act(async () => { toggle(); });
    for (let i = 0; i < 20 && composer().submissionDisabled; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(composer().submissionDisabled).toBe(false);
    expect(composer().selectedModel).toEqual(expectedModel);
    expect(composer().selectedAgent).toBe(seedAgent);
    expect(composer().modelVariant).toBe(effectiveVariant);
    expect(composer().modelVariantLabel).toBe(effectiveVariant === "high" ? "High" : effectiveVariant === "low" ? "Low" : "Medium");
    expect(composer().modelBehaviorOptions?.map((option) => option.value)).toEqual(fromHistory ? ["low", "medium"] : ["low", "medium", "high"]);
    expect(subscriptions).toBe(1);
    expect(composer().restrictedHost).toBe(true);
    expect(composer().queuedCount).toBe(0);
    expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(0);
    expect(useComposerStateStore.getState().queuedDrafts[session.id]?.[0]?.id).toBe(queued.id);
    if (seedVariant === "high") {
      const managed = { providerID: "lpr_fixture", modelID: "model" };
      managedAvailable = true;
      await act(async () => { composer().onModelChange(managed); catalogChanged!(); });
      for (let i = 0; i < 20 && composer().selectedModel.providerID !== managed.providerID; i++) await act(async () => { await Bun.sleep(10); });
      expect(composer().selectedModel).toEqual(managed);
      await act(async () => { composer().onDraftChange("keep this draft through the scope switch"); });
      const staleSend = composer().onSend;
      managedAvailable = false;
      await act(async () => { catalogChanged!(); await staleSend(); });
      expect(composer().selectedModel.providerID).not.toBe(managed.providerID);
      expect(composer().draft).toBe("keep this draft through the scope switch");
      expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(0);
      await act(async () => { composer().onModelChange(expectedModel); composer().onModelVariantChange("high"); });
    }
    // Even a stale callback cannot create a new mention or switch agents here.
    for (const kind of ["file", "agent", "app"] as const) {
      await act(async () => { composer().onDraftChange("@"); });
      await act(async () => { composer().onInsertMention(kind, "unsupported"); });
      expect(composer().draft).toBe("@");
      expect(composer().mentions).toEqual({});
      expect(composer().selectedAgent).not.toBe("unsupported");
    }
    // A structured mention restored in the shared draft must error, not be flattened or dropped.
    for (const kind of ["file", "agent", "app"] as const) {
      await act(async () => {
        useComposerStateStore.getState().setMentions(session.id, { unsupported: kind });
        composer().onDraftChange("keep @unsupported");
      });
      await act(async () => { await composer().onSend(); });
      expect(composer().draft).toBe("keep @unsupported");
      expect(composer().mentions).toEqual({ unsupported: kind });
      expect(JSON.stringify(view!.toJSON())).toContain(t("file_window.mentions_unavailable"));
      expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(0);
    }
    await act(async () => { useComposerStateStore.getState().setMentions(session.id, {}); });
    await act(async () => { composer().onDraftChange("edit this file @plain-text"); });
    busy = true;
    await act(async () => { await composer().onSend(); });
    expect(composer().draft).toBe("edit this file @plain-text");
    expect(toastInfo).toHaveBeenLastCalledWith(t("file_window.session_busy"));
    expect(useComposerStateStore.getState().history[session.id]).toBeUndefined();
    expect(useComposerStateStore.getState().queuedDrafts[session.id]?.map((item) => item.id)).toEqual([queued.id]);
    busy = false;
    failSubmission = true;
    const beforeFailure = calls.filter((call) => call.path.endsWith("/runs/start")).length;
    await act(async () => { await composer().onSend(); });
    expect(composer().draft).toBe("edit this file @plain-text");
    expect(JSON.stringify(view!.toJSON())).toContain(t("file_window.submission_unconfirmed"));
    expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(beforeFailure + 1);
    expect(useComposerStateStore.getState().history[session.id]).toBeUndefined();
    failSubmission = false;
    await act(async () => { changed({ ...state, activePath: "second.docx" }); });
    await act(async () => { await composer().onSend(); });
    const sent = calls.filter((call) => call.path.endsWith("/runs/start")).at(-1)!.body;
    expect(sent.prompt.model).toEqual(expectedModel);
    expect(sent.prompt.agent ?? null).toBe(seedAgent);
    expect(sent.prompt.variant).toBe(effectiveVariant);
    expect(sent.prompt.system).toContain("second.docx");
    expect(sent.prompt.system).toContain("does not authorize editing an Office selection");
    expect(sent.prompt.parts.every((part: { type: string }) => part.type === "text")).toBe(true);
    // 历史恢复用例已通过真实 Main 白名单发送；其余用例继续核对用户主动切换选项和策略恢复。
    if (fromHistory) return;
    expect(sent.prompt.parts.map((part: { text: string }) => part.text).join("")).toBe("edit this file @plain-text");
    expect(composer().draft).toBe("");
    await act(async () => { composer().onModelVariantChange("high"); });
    await act(async () => { composer().onModelChange(expectedModel); });
    expect(composer().modelVariant).toBe("high");
    await act(async () => {
      composer().onModelChange({ providerID: "provider", modelID: "fallback" });
      composer().onSelectAgent("custom");
    });
    expect(composer().modelVariant).toBe("medium");
    expect(composer().modelVariantLabel).toBe("Medium");
    expect(composer().modelBehaviorOptions?.map((option) => option.value)).toEqual(["low", "medium"]);
    await act(async () => { composer().onDraftChange("send with new model"); });
    await act(async () => { await composer().onSend(); });
    expect(calls.filter((call) => call.path.endsWith("/runs/start")).at(-1)!.body.prompt).toMatchObject({ model: { providerID: "provider", modelID: "fallback" }, variant: "medium" });
    // Switching back must not resurrect the old model's explicit high choice.
    await act(async () => { composer().onModelChange(state.conversation.model); });
    expect(composer().modelVariant).toBe("medium");
    await act(async () => { composer().onModelChange({ providerID: "provider", modelID: "standard" }); });
    expect(composer().modelVariant).toBeNull();
    expect(composer().modelBehaviorOptions).toEqual([]);
    await act(async () => { composer().onDraftChange("send without variants"); });
    await act(async () => { await composer().onSend(); });
    expect(calls.filter((call) => call.path.endsWith("/runs/start")).at(-1)!.body.prompt.variant).toBeUndefined();
    await act(async () => { composer().onModelChange({ providerID: "provider", modelID: "fallback" }); });
    await act(async () => { composer().onDraftChange("keep local draft"); toggle(); });
    expect(composer().selectedModel.modelID).toBe("fallback");
    expect(composer().selectedAgent).toBe("custom");
    expect(composer().modelVariant).toBe("medium");
    expect(composer().focusEligible).toBe(false);
    expect(composer().draft).toBe("keep local draft");
    expect(releases).toBe(0);
    // A real FileWindowApp fail-closed unmount releases the runtime, but owns the choices once.
    await act(async () => { composer().onModelVariantChange("low"); composer().onSelectAgent(recoveryAgent); });
    await act(async () => { changed({ ...state, conversation: undefined }); });
    expect(view!.root.findAllByType(Composer)).toHaveLength(0);
    expect(releases).toBe(1);
    expect(useComposerStateStore.getState().sessions[session.id]?.draft).toBe("keep local draft");
    // Recovery still uses the current policy, never the retained choices as authority.
    await act(async () => { changed({ ...state, conversation: { ...state.conversation, desktopConfig: { allowedModels: ["provider/model"] } } }); });
    expect(composer().selectedModel).toEqual({ providerID: "provider", modelID: "fallback" });
    expect(composer().submissionDisabled).toBe(true);
    const startsBeforeBlockedSend = calls.filter((call) => call.path.endsWith("/runs/start")).length;
    await act(async () => { await composer().onSend(); });
    expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(startsBeforeBlockedSend);
    expect(composer().draft).toBe("keep local draft");
    await act(async () => { changed(state); });
    for (let i = 0; i < 20 && composer().submissionDisabled; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(subscriptions).toBe(2);
    expect(composer().selectedModel).toEqual({ providerID: "provider", modelID: "fallback" });
    expect(composer().selectedAgent).toBe(recoveryAgent);
    expect(composer().modelVariant).toBe("low");
    expect(composer().draft).toBe("keep local draft");
    await act(async () => { await composer().onSend(); });
    const recoveredPrompt = calls.filter((call) => call.path.endsWith("/runs/start")).at(-1)!.body.prompt;
    expect(recoveredPrompt).toMatchObject({ model: { providerID: "provider", modelID: "fallback" }, variant: "low", parts: [{ type: "text", text: "keep local draft" }] });
    expect(recoveredPrompt.agent ?? null).toBe(recoveryAgent);
    await act(async () => { composer().onDraftChange("keep local draft"); });
    await act(async () => { emit({ type: "server.connected", properties: {} }); });
    busy = true;
    await act(async () => {
      emit({ type: "session.status", properties: { sessionID: session.id, status: { type: "busy" } } });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(composer().busy).toBe(true);
    await act(async () => { await composer().onStop(); });
    expect(calls.some((call) => call.path.endsWith("/runs/run_mount/abort"))).toBe(true);
    expect(composer().draft).toBe("keep local draft");
    expect(calls.some((call) => /\/config|\/env|\/observations|\/media|\/event$/.test(call.path))).toBe(false);
  } finally {
    await act(async () => { view?.unmount(); });
    queryClient.clear();
    useComposerStateStore.getState().clearSession(session.id);
    useComposerStateStore.getState().clearQueuedDrafts(session.id);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
    server.stop(true);
    setLocale(originalLocale);
  }
  expect(releases).toBe(2);
});

test("mounted file host discovers a new unproved child via periodic snapshot and replies through Main", async () => {
  const previousWindow = globalThis.window;
  const queryClient = getReactQueryClient();
  queryClient.clear();
  const timers = new Map<number, () => Promise<void>>();
  let timerId = 0, snapshots = 0, pending = false, replies = 0;
  let emit!: (event: Event) => void;
  const session = { id: "ses_new_child", title: "Root", time: { created: 1, updated: 1 } };
  const state = singleSourceState({ workspaceId: "ws_new_child", sessionId: session.id, workspaceRoot: "/project", platform: "darwin", tabs: [{ path: "file.docx", name: "File" }], activePath: "file.docx", recent: [], conversation: { desktopConfig: {} } });
  const entry: any = { ...state };
  const access = { baseUrl: "http://127.0.0.1:1234", clientToken: "synthetic-test-only" };
  const child = { id: "permission_child", sessionID: "child", targetSessionId: "child", rootSessionId: session.id, parentSessionId: session.id, ancestryPath: [session.id, "child"], protocol: "v2", action: "file.edit", resources: ["notes.md"], metadata: {} };
  const transport = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/provider")) return Response.json({ all: [], connected: [], default: {} });
    if (path.endsWith("/interactions/snapshot")) {
      snapshots++;
      return Response.json({ item: { snapshotStartedAt: Date.now(), rootSessionId: session.id, includeDescendants: true, permissions: pending ? [child] : [], questions: [] } });
    }
    if (path.endsWith("/permission/reply")) {
      expect(path).toBe(`/workspace/${state.workspaceId}/sessions/child/interactions/${child.id}/permission/reply`);
      expect(JSON.parse(init.body as string)).toMatchObject({ origin: "local-renderer", response: "allow_once" });
      replies++; pending = false;
      return Response.json({ interactionId: child.id, status: "resolved" });
    }
    if (path.endsWith("/snapshot")) return Response.json({ item: { session, messages: [], todos: [], status: { type: "idle" } } });
    if (path.endsWith("/permission-mode")) return Response.json({ state: null, grants: [], supported: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: [] });
    throw new Error(`Unexpected request: ${path}`);
  };
  const bridge = { action: async () => {}, subscribeSessionEvents(_input: { workspaceId: string }, listener: typeof emit) { emit = listener; return () => {}; } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/file-window.html" }, localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {},
    setTimeout: (callback: () => Promise<void>, delay: number) => {
      if (delay !== 5000) return setTimeout(callback, delay);
      timers.set(--timerId, callback); return timerId;
    },
    clearTimeout: (id: number) => { if (!timers.delete(id)) clearTimeout(id); }, setInterval, clearInterval,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout,
    __JUGGLEWORK_ELECTRON__: { fileWindow: bridge, invokeDesktop: async (command: string, url: string, init: RequestInit) => {
      expect(command).toBe("__fetch");
      return fetchFileWindowResponse(entry, access, url, init, transport);
    } },
  } });
  const client = createJuggleWorkServerClient({ baseUrl: access.baseUrl });
  let view: TestRenderer.ReactTestRenderer | undefined;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
  const poll = async () => {
    expect(timers.size).toBe(1);
    const [id, callback] = [...timers][0]!;
    timers.delete(id);
    await act(async () => { await callback(); await settle(); });
  };
  try {
    await act(async () => {
      view = TestRenderer.create(<QueryClientProvider client={queryClient}><PlatformProvider value={createDefaultPlatform()}><FileWindowConversation state={state} options={{}} onOptionsChange={() => {}} client={client} bridge={bridge as any} visible /></PlatformProvider></QueryClientProvider>);
      await settle();
    });
    await act(async () => { emit({ type: "server.connected", properties: {} }); await settle(); });
    expect(snapshots).toBeGreaterThan(0);
    expect(view!.root.findAllByType(PermissionApprovalPanel)).toHaveLength(0);
    // The child did not exist at mount/connection. Its first event stays denied.
    pending = true;
    expect(fileWindowSessionEvent(entry, { type: "permission.v2.asked", properties: child })).toBeNull();
    await act(async () => { emit({ type: "server.heartbeat", properties: {} }); });
    await poll();
    expect(entry.verifiedDescendants.has("child")).toBe(true);
    const panel = view!.root.findByType(PermissionApprovalPanel);
    expect(panel.props.permission.targetSessionId).toBe("child");
    await act(async () => { await panel.props.respondPermission(child.id, "once"); await settle(); });
    expect(replies).toBe(1);
    expect(view!.root.findAllByType(PermissionApprovalPanel)).toHaveLength(0);
    // A failed reconciliation remains fail-closed and does not stop later reads.
    entry.conversation = undefined;
    await poll();
    expect(timers.size).toBe(1);
    entry.conversation = state.conversation;
    await poll();
    await act(async () => { view!.unmount(); });
    expect(timers.size).toBe(0);
  } finally {
    await act(async () => { view?.unmount(); });
    queryClient.clear();
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test("multi-source file assistant restores real drafts/history/choices, routes Office while collapsed and never replays an accepted run", async () => {
  const previousWindow = globalThis.window;
  const query = getReactQueryClient(); query.clear();
  const nativeFetch = globalThis.fetch;
  const sources = ["a", "b"].map((id) => ({ workspaceId: `ws_${id}`, sessionId: `ses_${id}`, workspaceRoot: `/file-${id}` }));
  const model = { id: "model", name: "Model", providerID: "p", limit: { context: 10000, output: 1000 }, capabilities: {}, variants: { low: {}, high: {} } };
  const calls: string[] = [], subscriptions: string[] = [], releases: string[] = [];
  let accept!: () => void;
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname; calls.push(path);
    const id = path.includes("/ws_a/") ? "a" : "b", sessionId = `ses_${id}`;
    if (path.endsWith("/office/doc-b")) return Response.json({ document: { documentId: "doc-b", state: "ready" } });
    if (path.endsWith("/provider")) return Response.json({ all: [{ id: "p", name: "P", models: { model, other: { ...model, id: "other" } } }], connected: ["p"], default: { p: "model" } });
    if (path.endsWith("/interactions/snapshot")) return Response.json({ item: { rootSessionId: sessionId, permissions: [], questions: [], revision: 1 } });
    if (path.endsWith("/snapshot")) return Response.json({ item: { session: { id: sessionId, title: id, time: { created: 1, updated: 1 } }, messages: [{ info: { id: `history_${id}`, sessionID: sessionId, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "p", modelID: "model" } }, parts: [{ id: `text_${id}`, type: "text", text: `history-${id}`, sessionID: sessionId, messageID: `history_${id}` }] }], status: { type: "idle" }, todos: [] } });
    if (path.endsWith("/permission-mode")) return Response.json({ state: null, grants: [], supported: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: [] });
    if (path.endsWith("/runs/start")) { await new Promise<void>((resolve) => { accept = resolve; }); return Response.json({ run: { sessionId, runId: "run-a", generation: 1 } }); }
    throw new Error(`Unexpected request ${path}`);
  } });
  const tabs = [
    { tabId: "a1", source: sources[0]!, path: "same.txt", name: "A", conversation: { desktopConfig: {}, model: { providerID: "p", modelID: "model" }, agent: "plan", variant: "high" } },
    { tabId: "a2", source: sources[0]!, path: "second.txt", name: "A2", conversation: { desktopConfig: {}, model: { providerID: "p", modelID: "other" } } },
    { tabId: "b1", source: sources[1]!, path: "same.txt", name: "B", documentId: "doc-b", conversation: { desktopConfig: {}, model: { providerID: "p", modelID: "model" }, agent: "build", variant: "low" } },
  ];
  let state: import("@jugglework/types/file-window").FileWindowState = { group: { kind: "file-assistant" }, activeTabId: "a1", ...sources[0]!, tabs, activePath: "same.txt", recent: [], platform: "darwin", local: true };
  let changed!: (state: typeof state) => void, office!: (input: any) => Promise<any>;
  let bridgeInstalls = 0, bridgeReleases = 0;
  let closed!: (input: any) => void, documentChanged!: (input: any) => void;
  let cancelSelection = false;
  const actions: Array<[string, string | undefined]> = [];
  const publish = (id: string) => { state = { ...state, activeTabId: id }; changed(state); };
  const bridge = {
    state: async () => ({ ...state, baseUrl: server.url.href.replace(/\/$/, "") }),
    onChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
    action: async (action: string, tabId?: string) => { actions.push([action, tabId]); if (action === "select" && !cancelSelection) publish(tabId!); },
    subscribeSessionEvents: ({ workspaceId }: { workspaceId: string }, _listener: unknown) => { subscriptions.push(workspaceId); return () => releases.push(workspaceId); },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/file-window.html" }, localStorage: { getItem: () => null }, addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0), cancelAnimationFrame: clearTimeout,
    __JUGGLEWORK_ELECTRON__: { fileWindow: bridge, office: {
      onComposerRequest: (listener: typeof office) => { bridgeInstalls++; office = listener; return () => { bridgeReleases++; }; },
      onClosed: (listener: typeof closed) => { closed = listener; return () => { bridgeReleases++; }; },
      onDocumentChanged: (listener: typeof documentChanged) => { documentChanged = listener; return () => { bridgeReleases++; }; },
    }, invokeDesktop: async (_command: string, url: string, init: RequestInit) => {
      const response = await nativeFetch(url, init); return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
    } },
  } });
  let view: TestRenderer.ReactTestRenderer | undefined;
  const composer = () => view!.root.findByType(Composer).props as React.ComponentProps<typeof ReactSessionComposer>;
  const history = () => view!.root.findByType(Messages).props.messages;
  const settle = async () => { for (let i = 0; i < 30 && composer().submissionDisabled; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  try {
    await act(async () => { view = TestRenderer.create(<QueryClientProvider client={query}><PlatformProvider value={createDefaultPlatform()}><FileWindowApp /></PlatformProvider></QueryClientProvider>); });
    expect(await office({ action: "prepare", ...sources[1] })).toEqual({ epoch: 0 });
    await act(async () => { view!.root.findByProps({ "aria-controls": "file-window-conversation" }).props.onClick(); });
    await settle();
    expect(JSON.stringify(history())).toContain("history-a");
    await act(async () => { composer().onDraftChange("draft-a"); composer().onModelChange({ providerID: "p", modelID: "other" }); composer().onSelectAgent("custom"); composer().onModelVariantChange("low"); });
    await act(async () => { publish("a2"); });
    expect(composer().draft).toBe("draft-a"); expect(composer().selectedModel.modelID).toBe("other");
    expect(subscriptions).toEqual(["ws_a"]);
    await act(async () => { publish("b1"); }); await settle();
    expect(view!.root.findByType(Viewer).props).toMatchObject({ workspaceId: "ws_b", sessionId: "ses_b", path: "same.txt" });
    expect(composer().draft).toBe(""); expect(composer().selectedAgent).toBe("build"); expect(composer().modelVariant).toBe("low");
    expect(JSON.stringify(history())).toContain("history-b"); expect(JSON.stringify(history())).not.toContain("history-a");
    await act(async () => { composer().onDraftChange("draft-b"); publish("a1"); }); await settle();
    expect(composer().draft).toBe("draft-a"); expect(composer().selectedModel.modelID).toBe("other"); expect(composer().selectedAgent).toBe("custom"); expect(composer().modelVariant).toBe("low");
    let sending!: Promise<unknown>;
    await act(async () => { sending = composer().onSend(); await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(accept).toBeFunction();
    await act(async () => { publish("b1"); }); await settle();
    await act(async () => { accept(); await sending; });
    expect(composer().draft).toBe("draft-b");
    expect(useComposerStateStore.getState().sessions.ses_a?.draft ?? "").toBe("");
    expect(calls.filter((path) => path.endsWith("/runs/start"))).toEqual(["/workspace/ws_a/sessions/ses_a/runs/start"]);
    expect(calls.some((path) => path.endsWith("/abort"))).toBe(false);
    await act(async () => { publish("a1"); }); await settle();
    const ref = { referenceId: "rb", captureId: "cb", workspaceId: "ws_b", ownerSessionId: "ses_b", documentId: "doc-b", sourcePageId: "page-b", modelGeneration: "generation-b", contentStamp: "stamp-b", capturedAt: 1, locator: { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] }, preview: { name: "B", path: "same.txt", text: "正文" } };
    useComposerStateStore.getState().appendOfficeSelection({ sessionId: "ses_b", reference: ref as any, instructionId: "ib", epoch: 0, text: "keep-b", mode: "add" });
    const cross = await office({ action: "guard", ...sources[1], path: "another.txt" });
    expect(cross.needsConfirmation).toBe(false);
    const closing = await office({ action: "guard", ...sources[1], closingDocumentId: "doc-b" });
    expect(closing.needsConfirmation).toBe(true);
    const backgroundDraft = useComposerStateStore.getState().sessions.ses_b?.draft;
    await act(async () => { expect(await office({ ...closing, action: "clear", ...sources[1] })).toMatchObject({ ok: true, releaseIds: ["rb"] }); });
    expect(state.activeTabId).toBe("a1");
    expect(useComposerStateStore.getState().sessions.ses_b?.draft).toBe(backgroundDraft);
    expect(useComposerStateStore.getState().sessions.ses_b?.officeGroups[0]?.instruction.bindingState).toBe("needs-selection");
    expect(actions).toEqual([]);
    await act(async () => { view!.root.findByProps({ "aria-label": t("file_window.show_document") }).props.onClick(); });
    const prepared = await office({ action: "prepare", ...sources[1] });
    cancelSelection = true;
    await act(async () => { await expect(office({ action: "append", ...sources[1], reference: ref, instructionId: "cancelled", epoch: prepared.epoch, text: "must not append", mode: "add" })).rejects.toThrow("切换已取消"); });
    expect(view!.root.findByType("aside").props.hidden).toBe(true);
    expect(useComposerStateStore.getState().sessions.ses_b?.officeGroups.some((group) => group.instruction.instructionId === "cancelled")).toBe(false);
    actions.length = 0;
    cancelSelection = false;
    await act(async () => { await office({ action: "append", ...sources[1], reference: ref, instructionId: "ib2", epoch: prepared.epoch, text: "append-b", mode: "add" }); }); await settle();
    expect(actions).toEqual([["select", "b1"]]);
    expect(view!.root.findByType("aside").props.hidden).toBe(false);
    expect(composer().draft).toContain("draft-b");
    expect((await office({ action: "guard", ...sources[1], path: "another.txt" })).needsConfirmation).toBe(true);
    expect(bridgeInstalls).toBe(1);
    await act(async () => { publish("a1"); }); await settle();
    await act(async () => { documentChanged({ workspaceId: "ws_b", ownerSessionId: "ses_b", documentId: "doc-b", pageId: "recovered-page", state: "ready" }); });
    expect(state.activeTabId).toBe("a1");
    expect((await office({ action: "guard", ...sources[1], closingDocumentId: "doc-b" })).needsConfirmation).toBe(false);
    await act(async () => { closed({ workspaceId: "ws_b", sessionId: "ses_b", documentId: "doc-b" }); });
    expect(state.activeTabId).toBe("a1");
    // A policy retry does not remove a registered source's close/clear responder.
    await act(async () => { changed({ ...state, tabs: state.tabs.map((tab) => tab.tabId === "b1" ? { ...tab, conversation: undefined } : tab) }); });
    expect(await office({ action: "prepare", ...sources[1] })).toMatchObject({ epoch: expect.any(Number) });
    await act(async () => { changed({ ...state, activeTabId: null, tabs: [], conversation: { desktopConfig: {} } }); });
    expect(view!.root.findAllByType(Composer)).toHaveLength(0);
    expect(view!.root.findAllByType(Viewer)).toHaveLength(0);
    expect(subscriptions.length).toBe(releases.length);
    await expect(office({ action: "prepare", ...sources[1] })).rejects.toThrow("不属于");
    await act(async () => { view!.unmount(); view = undefined; });
    expect(bridgeReleases).toBe(3);
  } finally {
    accept?.(); await act(async () => view?.unmount()); query.clear(); server.stop(true);
    for (const source of sources) useComposerStateStore.getState().clearSession(source.sessionId);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

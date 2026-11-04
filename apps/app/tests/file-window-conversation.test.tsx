/** @jsxImportSource react */
import { expect, mock, test } from "bun:test";
import * as React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactSessionComposer } from "../src/react-app/domains/session/surface/composer/composer";
import type { Event } from "@opencode-ai/sdk/v2/client";
import { currentLocale, setLocale, t } from "../src/i18n";
const toastInfo = mock();
const sonner = await import("../src/components/ui/sonner");
mock.module("../src/components/ui/sonner", () => ({ ...sonner, toast: Object.assign(() => {}, sonner.toast, { info: toastInfo }) }));

// Keep the real surface, runtime, providers, SDK and sender; replace DOM-only leaves.
function Composer(props: React.ComponentProps<typeof ReactSessionComposer>) { return <div>{props.topAccessory}</div>; }
mock.module("../src/react-app/domains/session/surface/composer/composer", () => ({ ReactSessionComposer: Composer }));
mock.module("../src/components/chat/message-list", () => ({ MessageList: () => null }));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => children, TooltipTrigger: ({ children }: any) => children, TooltipContent: () => null }));
mock.module("../src/react-app/domains/session/files/file-viewer", () => ({ FileViewer: () => null }));
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
  let subscriptions = 0, releases = 0, busy = false, failSubmission = false;
  const nativeFetch = globalThis.fetch;
  const session = { id: `ses_mount_${seedAgent ?? "default"}_${seedVariant ?? "default"}${fromHistory ? "_history" : ""}`, title: "Existing session", time: { created: 1, updated: 1 } };
  const model = { id: "model", name: "Model", providerID: "provider", limit: { context: 10000, output: 1000 }, capabilities: {}, variants: { low: {}, medium: {}, high: {} } };
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : undefined;
    calls.push({ path, method: request.method, body });
    if (path.endsWith("/provider")) return Response.json({ all: [{ id: "provider", name: "Provider", models: { fallback: { ...model, id: "fallback", variants: { low: {}, medium: {} } }, standard: { ...model, id: "standard", variants: {} }, model } }], connected: ["provider"], default: { provider: "fallback" } });
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
    onChanged: (listener: typeof changed) => { changed = listener; return () => {}; },
    action: mock(async () => {}), subscribeSessionEvents(listener: typeof emit) { subscriptions++; emit = listener; return () => { releases++; }; },
  };
  const windowStub = {
    location: { pathname: "/file-window.html" },
    localStorage: { getItem: () => null },
    addEventListener() {}, removeEventListener() {},
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
  const state = { workspaceId: "ws_mount", sessionId: session.id, workspaceRoot: "/project", local: seedVariant === "high" || fromHistory, platform: "darwin", tabs: [{ path: "first.docx", name: "First" }, { path: "second.docx", name: "Second" }], activePath: "first.docx", recent: [], conversation: { model: fromHistory ? undefined : expectedModel, agent: seedAgent, variant: seedVariant, desktopConfig: {} } };
  let view: TestRenderer.ReactTestRenderer | undefined;
  const render = () => <QueryClientProvider client={queryClient}><PlatformProvider value={createDefaultPlatform()}><FileWindowApp /></PlatformProvider></QueryClientProvider>;
  const toggle = () => view!.root.findAllByType("button").find((item) => item.props["aria-controls"] === "file-window-conversation" || item.props["aria-label"] === t("file_window.show_document"))!.props.onClick();
  const composer = () => view!.root.findByType(Composer).props as React.ComponentProps<typeof ReactSessionComposer>;
  try {
    expect(hasFileWindowConversation({ ...state, local: true })).toBe(true);
    expect(hasFileWindowConversation({ ...state, local: true, sessionId: "file-browser" })).toBe(false);
    expect(hasFileWindowConversation({ ...state, workspaceId: "rem_remote" })).toBe(false);
    expect(hasFileWindowConversation({ ...state, conversation: undefined })).toBe(false);
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
  const state = { workspaceId: "ws_new_child", sessionId: session.id, workspaceRoot: "/project", platform: "darwin", tabs: [], activePath: null, recent: [], conversation: { desktopConfig: {} } };
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
  const bridge = { action: async () => {}, subscribeSessionEvents(listener: typeof emit) { emit = listener; return () => {}; } };
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

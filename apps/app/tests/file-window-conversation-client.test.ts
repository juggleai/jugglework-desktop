import { expect, test } from "bun:test";
import type { FileWindowBridge } from "@jugglework/types/file-window";
import { createClient, unwrap } from "../src/app/lib/opencode";
import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { fileWindowEventResponse } from "../src/app/lib/file-window-conversation-bridge";
import { createSessionDraftSender } from "../src/react-app/domains/session/sync/session-draft-sender";
import type { ComposerDraft } from "../src/app/types";
import { t } from "../src/i18n";

test("event Response releases preload subscription on abort and cancellation", async () => {
  for (const mode of ["abort", "cancel"] as const) {
    const controller = new AbortController();
    let emit!: Parameters<NonNullable<FileWindowBridge["subscribeSessionEvents"]>>[1], disposed = 0, connected = 0;
    const response = fileWindowEventResponse({ subscribeSessionEvents(input, listener) { expect(input).toEqual({ workspaceId: "ws" }); emit = listener; return () => { disposed++; }; } }, { workspaceId: "ws" }, controller.signal, () => { connected++; });
    const reader = response.body!.getReader();
    emit({ type: "server.connected", properties: {} });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"type":"server.connected"');
    expect(connected).toBe(1);
    if (mode === "abort") controller.abort(); else await reader.cancel();
    expect(disposed).toBe(1);
    emit({ type: "server.heartbeat", properties: {} });
    expect((await reader.read()).done).toBe(true);
  }
});

test("parallel SDK streams bind their URL workspace and cancel independently across tab changes", async () => {
  const previousWindow = globalThis.window;
  const listeners = new Map<string, (event: { type: string; properties: object }) => void>();
  const disposed: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/file-window.html" },
    __JUGGLEWORK_ELECTRON__: { fileWindow: { subscribeSessionEvents({ workspaceId }: { workspaceId: string }, listener: (event: { type: string; properties: object }) => void) {
      listeners.set(workspaceId, listener); return () => { disposed.push(workspaceId); };
    } } },
  } });
  const a = new AbortController(), b = new AbortController();
  try {
    const first = await createClient("http://127.0.0.1:1234/workspace/file%20a/opencode", "/a", { mode: "jugglework" }).event.subscribe(undefined, { signal: a.signal });
    const second = await createClient("http://127.0.0.1:1234/workspace/file-b/opencode", "/b", { mode: "jugglework" }).event.subscribe(undefined, { signal: b.signal });
    const ia = first.stream[Symbol.asyncIterator](), ib = second.stream[Symbol.asyncIterator]();
    const na = ia.next(), nb = ib.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...listeners.keys()]).toEqual(["file a", "file-b"]);
    listeners.get("file a")!({ type: "session.status", properties: { sessionID: "ses-a", status: { type: "busy" } } });
    listeners.get("file-b")!({ type: "session.status", properties: { sessionID: "ses-b", status: { type: "idle" } } });
    expect((await na).value?.properties).toMatchObject({ sessionID: "ses-a" });
    expect((await nb).value?.properties).toMatchObject({ sessionID: "ses-b" });
    a.abort(); await ia.return?.();
    expect(disposed).toEqual(["file a"]);
    const nextB = ib.next(); listeners.get("file-b")!({ type: "server.heartbeat", properties: {} });
    expect((await nextB).value?.type).toBe("server.heartbeat");
    b.abort(); await ib.return?.();
    expect(disposed).toEqual(["file a", "file-b"]);
  } finally {
    a.abort(); b.abort();
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test("real SDK uses tokenless Main fetch, shared admission/abort and preload SSE without native fetch or observations", async () => {
  const previousWindow = globalThis.window, previousFetch = globalThis.fetch;
  const nativeFetch = previousFetch;
  const calls: Array<{ path: string; method: string; body: any }> = [];
  const server = Bun.serve({ port: 0, fetch: async (request) => {
    const path = new URL(request.url).pathname;
    const body = request.method === "POST" ? await request.json() : undefined;
    calls.push({ path, method: request.method, body });
    if (path.endsWith("/provider")) return Response.json({ all: [], connected: [], default: {} });
    if (path.endsWith("/runs/start")) return Response.json({ run: { runId: "run_file", sessionId: "ses_file", generation: 1 } });
    if (path.endsWith("/session-runs")) return Response.json({ items: [{ runId: "run_file", sessionId: "ses_file", generation: 1 }] });
    if (path.endsWith("/abort")) return Response.json({ abortRequested: true });
    throw new Error(`unexpected endpoint ${path}`);
  } });
  let listener!: Parameters<NonNullable<FileWindowBridge["subscribeSessionEvents"]>>[1], unsubscribed = 0;
  const controller = new AbortController();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/file-window.html" },
    localStorage: { getItem: () => null },
    __JUGGLEWORK_ELECTRON__: {
      fileWindow: { subscribeSessionEvents(input: { workspaceId: string }, callback: typeof listener) { expect(input).toEqual({ workspaceId: "ws_file" }); listener = callback; return () => { unsubscribed++; }; } },
      invokeDesktop: async (command: string, url: string, init: RequestInit) => {
        expect(command).toBe("__fetch");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        const response = await nativeFetch(url, init);
        return { status: response.status, headers: [...response.headers], body: await response.arrayBuffer() };
      },
    },
  } });
  globalThis.fetch = (() => { throw new Error("renderer must not use native fetch"); }) as typeof fetch;
  try {
    const base = server.url.href.replace(/\/$/, "");
    const sdk = createClient(`${base}/workspace/ws_file/opencode`, "/project", { mode: "jugglework" });
    const host = createJuggleWorkServerClient({ baseUrl: base });
    await sdk.provider.list();
    const draft: ComposerDraft = { text: "edit file", mode: "prompt", parts: [{ type: "text", text: "edit file" }], attachments: [] };
    let file = "first.docx";
    const sender = createSessionDraftSender({
      sessionId: "ses_file", workspaceId: "ws_file", workspaceRoot: "/project", client: sdk, host, endpoint: null,
      hostKind: "file", agent: "plan", systemContext: `Current file: ${file}`,
      canSubmit: () => true, captureContext: () => ({ isCurrent: () => true, validateGeneration: () => true }),
      prepare: async () => { file = "second.docx"; return { model: { providerID: "p", modelID: "m" }, variant: "high" }; },
      cloudSubmit: async ({ send }) => { await send(); return { outcome: "sent" }; },
    });
    expect((await sender(draft, "ses_file")).outcome).toBe("sent");
    expect(calls.find((call) => call.path.endsWith("/runs/start"))?.body).toMatchObject({ prompt: { parts: [{ type: "text", text: "edit file" }], agent: "plan", variant: "high", system: "Current file: first.docx" } });
    expect(unwrap(await sdk.session.abort({ sessionID: "ses_file" }))).toBe(true);
    expect(calls.some((call) => call.path.endsWith("/runs/run_file/abort"))).toBe(true);
    const sub = await sdk.event.subscribe(undefined, { signal: controller.signal });
    const iterator = sub.stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener({ type: "server.connected", properties: {} });
    expect((await next).value?.type).toBe("server.connected");
    controller.abort(); await iterator.return?.();
    expect(unsubscribed).toBe(1);
    expect(calls.some((call) => /\/event|\/observations|\/env|\/config/.test(call.path))).toBe(false);
    for (const bad of [{ ...draft, mode: "shell" as const }, { ...draft, command: { name: "new", arguments: "" } }]) {
      await expect(sender(bad, "ses_file")).rejects.toThrow("main window");
    }
    await expect(sender(draft, "other-session")).rejects.toThrow(t("file_window.operation_unavailable"));
    await expect(sender(draft, "ses_file", { delivery: "steer", admissionId: "steer" })).rejects.toThrow(t("file_window.operation_unavailable"));
    for (const part of [{ type: "file", path: "first.docx" }, { type: "agent", name: "plan" }, { type: "app", name: "Notes" }] as const) {
      const bad: ComposerDraft = { ...draft, parts: [...draft.parts, part] };
      const original = structuredClone(bad);
      await expect(sender(bad, "ses_file")).rejects.toThrow(t("file_window.mentions_unavailable"));
      expect(bad).toEqual(original);
    }
    expect(calls.filter((call) => call.path.endsWith("/runs/start"))).toHaveLength(1);
  } finally {
    controller.abort();
    globalThis.fetch = previousFetch;
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
    server.stop(true);
  }
});

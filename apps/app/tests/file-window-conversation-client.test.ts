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
    let emit!: Parameters<NonNullable<FileWindowBridge["subscribeSessionEvents"]>>[0], disposed = 0, connected = 0;
    const response = fileWindowEventResponse({ subscribeSessionEvents(listener) { emit = listener; return () => { disposed++; }; } }, controller.signal, () => { connected++; });
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
  let listener!: Parameters<NonNullable<FileWindowBridge["subscribeSessionEvents"]>>[0], unsubscribed = 0;
  const controller = new AbortController();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { pathname: "/file-window.html" },
    __JUGGLEWORK_ELECTRON__: {
      fileWindow: { subscribeSessionEvents(callback: typeof listener) { listener = callback; return () => { unsubscribed++; }; } },
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

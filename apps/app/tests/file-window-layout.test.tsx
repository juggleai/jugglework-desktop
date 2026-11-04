/** @jsxImportSource react */
import * as React from "react";
import { expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FileWindowState } from "@jugglework/types/file-window";
import { t } from "../src/i18n";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

let conversationMounts = 0, conversationUnmounts = 0, viewerMounts = 0;
function Conversation(props: any) {
  React.useEffect(() => { conversationMounts++; return () => { conversationUnmounts++; }; }, []);
  return <div data-visible={props.visible} />;
}
function Viewer() { React.useEffect(() => { viewerMounts++; }, []); return null; }
// Keep the real availability predicate, but isolate the unused surface before
// importing its module: Bun's Lexical node export initializes via top-level await.
mock.module("../src/react-app/domains/session/surface/session-surface", () => ({ SessionSurface: () => null }));
mock.module("../src/react-app/domains/session/files/file-viewer", () => ({ FileViewer: Viewer }));
mock.module("../src/react-app/domains/session/files/file-editor-toolbar", () => ({ FileEditorToolbar: ({ trailingActions }: any) => <div data-file-editor-toolbar>{trailingActions}</div>, getOfficeEditorStatus: () => "saved" }));
const Box = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module("../src/components/ui/dropdown-menu", () => Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuGroup", "DropdownMenuItem", "DropdownMenuLabel", "DropdownMenuSeparator", "DropdownMenuSub", "DropdownMenuSubContent", "DropdownMenuSubTrigger", "DropdownMenuTrigger"].map((name) => [name, Box])));
const { hasFileWindowConversation } = await import("../src/react-app/domains/session/files/file-window-conversation");
mock.module("../src/react-app/domains/session/files/file-window-conversation", () => ({ FileWindowConversation: Conversation, hasFileWindowConversation }));
const { FileWindowApp } = await import("../src/react-app/domains/session/files/file-window-app");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// TestRenderer checks React layout state and handlers; CSS geometry, pointer
// capture and native Office view bounds are outside this fixture.
test("file window updates split state, keeps its viewer and conversation mounted when collapsed, and gates local files", async () => {
  const previousWindow = globalThis.window;
  let changed!: (state: FileWindowState) => void;
  let stopped = 0;
  let officeRequest!: (input: any) => Promise<any>;
  const actions: string[] = [];
  const state: FileWindowState = { workspaceId: "ws", sessionId: "ses", workspaceRoot: "/project", tabs: [{ path: "file.txt", name: "file.txt" }], activePath: "file.txt", recent: [], platform: "darwin", conversation: { desktopConfig: {} }, appearance: { theme: "dark", lang: "zh" } };
  const bridge = {
    state: async () => ({ ...state, baseUrl: "http://127.0.0.1:1234" }),
    onChanged: (callback: typeof changed) => { changed = callback; return () => { stopped++; }; },
    action: async (action: string) => { actions.push(action); }, subscribeSessionEvents: () => () => {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __JUGGLEWORK_ELECTRON__: { fileWindow: bridge,
    office: { onComposerRequest: (callback: typeof officeRequest) => { officeRequest = callback; return () => {}; } },
  }, addEventListener() {}, removeEventListener() {} } });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const appearanceChanged = mock();
  let view: TestRenderer.ReactTestRenderer | undefined;
  const button = (label: string) => view!.root.findAllByType("button").find((item) => item.props["aria-controls"] === label || item.props["aria-label"] === label)!;
  try {
    await act(async () => { view = TestRenderer.create(<QueryClientProvider client={query}><FileWindowApp onAppearanceChange={appearanceChanged} /></QueryClientProvider>, { createNodeMock: (element) => element.type === "main" ? { getBoundingClientRect: () => ({ right: 1000, width: 1000 }) } : null }); });
    expect(appearanceChanged).toHaveBeenLastCalledWith({ theme: "dark", lang: "zh" });
    // Main publishes tab/policy changes without the state() appearance field.
    const { appearance: _appearance, ...changedState } = state;
    await act(async () => { changed({ ...changedState, recent: [{ path: "other.txt", name: "other.txt" }] }); });
    expect(appearanceChanged).toHaveBeenCalledTimes(1);
    await act(async () => { changed({ ...changedState, appearance: { theme: "system", lang: "invalid" } as unknown as FileWindowState["appearance"] }); });
    expect(appearanceChanged).toHaveBeenCalledTimes(1);
    expect(viewerMounts).toBe(1);
    expect(conversationMounts).toBe(0);
    expect(view!.root.findByType("header").findAllByProps({ "aria-controls": "file-window-conversation" })).toHaveLength(0);
    expect(view!.root.findByProps({ "data-file-editor-toolbar": true }).findAllByType("button").filter((item) => item.props["aria-controls"] === "file-window-conversation")).toHaveLength(1);
    await act(async () => { button("file-window-conversation").props.onClick(); });
    expect(conversationMounts).toBe(1);
    expect(view!.root.findAllByProps({ "aria-controls": "file-window-conversation" })).toHaveLength(0);
    expect(view!.root.findByProps({ className: "file-window-conversation-title" }).children).toEqual(["JuggleWork"]);
    expect(view!.root.findByType("main").props.className).toContain("has-conversation");
    const separator = () => view!.root.findByProps({ role: "separator" });
    await act(async () => { separator().props.onKeyDown({ key: "ArrowLeft", preventDefault() {} }); });
    expect(separator().props["aria-valuenow"]).toBe(44);
    const target = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
    await act(async () => { separator().props.onPointerMove({ currentTarget: target, pointerId: 1, clientX: 400 }); });
    expect(separator().props["aria-valuenow"]).toBe(60);
    // Main navigation is a fixed action; no session identity comes from the renderer.
    await act(async () => { button(t("file_window.open_session")).props.onClick(); });
    expect(actions).toEqual(["open-session"]);
    await act(async () => { button(t("file_window.show_document")).props.onClick(); });
    expect(view!.root.findByType("aside").props.hidden).toBe(true);
    expect(view!.root.findByType(Conversation).props.visible).toBe(false);
    expect(conversationUnmounts).toBe(0);
    expect(viewerMounts).toBe(1);
    expect(button("file-window-conversation")).toBeDefined();
    await act(async () => { button("file-window-conversation").props.onClick(); });
    expect(conversationMounts).toBe(1);
    expect(view!.root.findByType("aside").props.hidden).toBe(false);
    await act(async () => { button(t("file_window.show_document")).props.onClick(); });
    await expect(officeRequest({ action: "prepare", workspaceId: "foreign", sessionId: "ses" })).rejects.toThrow("不属于");
    expect(await officeRequest({ action: "prepare", workspaceId: "ws", sessionId: "ses" })).toEqual({ epoch: 0 });
    const ref = { referenceId: "file-ref", captureId: "capture", workspaceId: "ws", ownerSessionId: "ses", documentId: "doc", sourcePageId: "page",
      modelGeneration: "page:model", locator: { kind: "doc-text", ranges: [{ begin: 0, end: 2 }] }, contentStamp: "stamp", capturedAt: 1,
      preview: { name: "file.docx", path: "file.docx", range: "0–2", text: "正文" } };
    await act(async () => { await officeRequest({ action: "append", workspaceId: "ws", sessionId: "ses", reference: ref, instructionId: "file-instruction", epoch: 0, text: "修改正文", mode: "add" }); });
    expect(view!.root.findByType("aside").props.hidden).toBe(false);
    expect(conversationMounts).toBe(1);
    expect(useComposerStateStore.getState().sessions.ses?.officeGroups[0].instruction.text).toBe("修改正文");
    const guard = await officeRequest({ action: "guard", workspaceId: "ws", sessionId: "ses", closingDocumentId: "doc" });
    expect(guard.needsConfirmation).toBe(true);
    expect((await officeRequest({ ...guard, action: "clear", workspaceId: "ws", sessionId: "ses" })).ok).toBe(true);
    expect(useComposerStateStore.getState().sessions.ses?.officeGroups[0].instruction.bindingState).toBe("needs-selection");
    await act(async () => { changed({ ...state, local: true, conversation: undefined, appearance: { theme: "light", lang: "en" } }); });
    expect(appearanceChanged).toHaveBeenLastCalledWith({ theme: "light", lang: "en" });
    expect(view!.root.findAllByType(Conversation)).toHaveLength(0);
    expect(view!.root.findAllByType("button").some((item) => item.props["aria-controls"] === "file-window-conversation")).toBe(false);
  } finally {
    await act(async () => { view?.unmount(); });
    query.clear();
    useComposerStateStore.setState({ sessions: {}, officeEpochs: {} });
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
  expect(stopped).toBe(1);
});

test("unavailable conversation retries Main state, stays closed on failure, and recovers without reloading the viewer", async () => {
  const previousWindow = globalThis.window;
  let changed!: (state: FileWindowState) => void;
  const available: FileWindowState = { workspaceId: "ws_retry", sessionId: "ses_retry", workspaceRoot: "/project", tabs: [{ path: "file.txt", name: "file.txt" }], activePath: "file.txt", recent: [], platform: "darwin", conversation: { desktopConfig: {} } };
  let next: FileWindowState = { ...available, conversation: undefined };
  let finish!: (state: FileWindowState & { baseUrl: string }) => void;
  let delayed = false, reads = 0;
  const bridge = {
    state: async () => {
      reads++;
      return delayed ? new Promise<FileWindowState & { baseUrl: string }>((resolve) => { finish = resolve; }) : { ...next, baseUrl: "http://127.0.0.1:1234" };
    },
    onChanged: (callback: typeof changed) => { changed = callback; return () => {}; },
    action: async () => {}, subscribeSessionEvents: () => () => {},
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __JUGGLEWORK_ELECTRON__: { fileWindow: bridge }, addEventListener() {}, removeEventListener() {} } });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let view: TestRenderer.ReactTestRenderer | undefined;
  const retryLabel = `${t("file_window.ai")}: ${t("common.retry")}`;
  const retry = () => view!.root.findByProps({ "aria-label": retryLabel });
  const ai = () => view!.root.findAllByType("button").find((item) => item.props["aria-controls"] === "file-window-conversation")!;
  const viewersBefore = viewerMounts;
  try {
    await act(async () => { view = TestRenderer.create(<QueryClientProvider client={query}><FileWindowApp /></QueryClientProvider>); });
    expect(reads).toBe(1);
    expect(ai()).toBeUndefined();
    await act(async () => { await retry().props.onClick(); });
    expect(reads).toBe(2);
    expect(view!.root.findAllByType(Conversation)).toHaveLength(0);
    expect(ai()).toBeUndefined();
    // A retry cannot mount the panel until Main returns a validated conversation.
    delayed = true;
    await act(async () => { retry().props.onClick(); });
    expect(retry().props.disabled).toBe(true);
    expect(ai()).toBeUndefined();
    await act(async () => { finish({ ...available, baseUrl: "http://127.0.0.1:1234" }); });
    await act(async () => { ai().props.onClick(); });
    expect(view!.root.findAllByType(Conversation)).toHaveLength(1);
    const choices = { model: { providerID: "chosen", modelID: "model" }, agent: "plan", variant: "high" };
    await act(async () => { view!.root.findByType(Conversation).props.onOptionsChange(choices); });
    // Revocation removes the live panel immediately; retry does not retain authority.
    await act(async () => { changed({ ...available, conversation: undefined }); });
    expect(view!.root.findAllByType(Conversation)).toHaveLength(0);
    expect(ai()).toBeUndefined();
    delayed = false;
    next = { ...available, conversation: undefined };
    await act(async () => { await retry().props.onClick(); });
    expect(view!.root.findAllByType(Conversation)).toHaveLength(0);
    next = available;
    await act(async () => { await retry().props.onClick(); });
    expect(view!.root.findAllByType(Conversation)).toHaveLength(1);
    expect(view!.root.findByType(Conversation).props.options).toEqual(choices);
    expect(viewerMounts - viewersBefore).toBe(1);
    await act(async () => { changed({ ...available, local: true, workspaceRoot: "", sessionId: "file-browser", conversation: undefined }); });
    expect(view!.root.findAllByProps({ "aria-label": retryLabel })).toHaveLength(0);
  } finally {
    await act(async () => { view?.unmount(); });
    query.clear();
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

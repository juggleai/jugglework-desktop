/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import {
  $createTextNode, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $setCompositionKey, $setSelection,
  KEY_ENTER_COMMAND, UNDO_COMMAND, REDO_COMMAND, type LexicalEditor,
} from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { t } from "../src/i18n";
import type { LexicalPromptEditorHandle } from "../src/react-app/domains/session/surface/composer/editor";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createJuggleWorkServerClient } from "../src/app/lib/jugglework-server";
import { usePromptSuggestions } from "../src/react-app/domains/session/surface/prompt-suggestions";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

// Real composer, editor, history and command chain; only the DOM leaf/services
// are replaced. Native focus traversal and OS IME require Desktop verification.
let editor: LexicalEditor;
mock.module("@lexical/react/LexicalContentEditable.js", () => ({ ContentEditable: (props: object) => {
  [editor] = useLexicalComposerContext();
  return <div {...props} data-testid="editable-leaf" />;
} }));
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
const extensions = await import("../src/react-app/domains/settings/extension-state");
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ ...desktopConfig, useDesktopRestriction: () => false }));
mock.module("../src/react-app/domains/settings/extension-state", () => ({ ...extensions, isJuggleWorkExtensionHidden: () => true }));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/model-behavior-select", () => ({ ModelBehaviorSelect: () => null }));
mock.module("../src/react-app/domains/session/surface/composer/context-usage", () => ({ ContextUsage: () => null }));
mock.module("../src/components/ui/tooltip", () => {
  const Pass = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: Pass };
});
const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
const { LexicalPromptEditor } = await import("../src/react-app/domains/session/surface/composer/editor");
type Props = React.ComponentProps<typeof ReactSessionComposer>;
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
class KeyTarget {
  constructor(private editable: boolean) {}
  matches(selector: string) { return this.editable && selector === "[contenteditable='true']"; }
}
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: KeyTarget });
Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
  location: { origin: "http://suggestion.test" }, localStorage: { getItem: () => null },
}) });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  for (const [name, descriptor] of [["window", previousWindow], ["HTMLElement", previousHTMLElement], ["document", previousDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});
let view: TestRenderer.ReactTestRenderer;
let props: Props;
let renderComposer = (value: Props): React.ReactElement => <ReactSessionComposer {...value} />;
let lifecycleQuery: QueryClient | undefined;
afterEach(async () => { await act(async () => view?.unmount()); lifecycleQuery?.clear(); lifecycleQuery = undefined; });
const noop = () => {};
const empty = async () => [];
const suggestion = "请补充这项交互的边界测试";
const root = () => view.root.findAllByType("div").find((node) => node.props.onKeyDownCapture)!;
const text = () => editor.getEditorState().read(() => $getRoot().getTextContent());
const leaf = () => view.root.findByProps({ "data-testid": "editable-leaf" });
const visibleSuggestion = () => view.root.findAll((node) => node.type === "div" && node.props["aria-hidden"] === true && node.props.className?.includes("pointer-events-none"));

async function update(next: Partial<Props>) {
  props = { ...props, ...next };
  await act(async () => { view.update(renderComposer(props)); });
}

async function mount(overrides: Partial<Props> = {}, render = (value: Props) => <ReactSessionComposer {...value} />) {
  renderComposer = render;
  props = {
    restrictedHost: true, sessionId: "prompt-suggestion", focusEligible: false, draft: "", mentions: {},
    promptSuggestion: suggestion,
    createVoiceRealtimeSession: null, getVoiceRealtimeStatus: null,
    onDraftChange: mock((draft: string) => {
      props = { ...props, draft };
      view.update(renderComposer(props));
    }),
    // A ready suggestion remains available; only the draft hides it.
    // The connected harness below exercises the real hook's view-local hiding.
    onAcceptPromptSuggestion: mock(),
    onDismissPromptSuggestion: mock(() => {
      props = { ...props, promptSuggestion: null, promptSuggestionPending: false };
      view.update(renderComposer(props));
    }),
    onSend: mock(), onQueue: mock(), onSteer: mock(), onStop: mock(),
    busy: false, steering: false, submissionPreparing: false, submissionPreparingLabel: null, submissionDisabled: false,
    queuedCount: 0, disabled: false, statusLabel: "", modelPickerOpen: false, selectedModel: { providerID: "test", modelID: "test" },
    contextUsageMessages: [], contextUsageTranscript: [], contextWindowTokens: 0, onModelPickerOpenChange: noop, onModelChange: noop,
    attachments: [], onAttachFiles: noop, onRemoveAttachment: noop, attachmentsEnabled: false, attachmentsDisabledReason: null,
    imageGenerationModels: [], imageGenerationLoading: false, imageGeneration: null, onEnableImageGeneration: noop,
    onImageGenerationChange: noop, onDisableImageGeneration: noop, onRefreshImageGenerationModels: empty,
    videoGenerationModels: [], videoGenerationLoading: false, videoGeneration: null, onEnableVideoGeneration: noop,
    onVideoGenerationChange: noop, onDisableVideoGeneration: noop, onRefreshVideoGenerationModels: empty,
    modelVariantLabel: "", modelVariant: null, onModelVariantChange: noop, agentLabel: "", selectedAgent: null, listAgents: empty,
    onSelectAgent: noop, listCommands: empty, recentFiles: [], searchFiles: empty, onInsertMention: noop,
    pastedText: [], isRemoteWorkspace: false, isSandboxWorkspace: false,
    ...overrides,
  };
  await act(async () => { view = TestRenderer.create(renderComposer(props)); });
}

async function press(key: string, flags: Record<string, unknown> = {}) {
  const event = {
    key, keyCode: key === "Enter" ? 13 : 0, target: new KeyTarget(true), defaultPrevented: false,
    preventDefault: mock(function(this: { defaultPrevented: boolean }) { this.defaultPrevented = true; }),
    stopPropagation: mock(), ...flags,
  };
  await act(async () => {
    root().props.onKeyDownCapture({ ...event, nativeEvent: event, preventDefault: () => event.preventDefault() });
    if (key === "Enter" && !event.defaultPrevented) {
      editor.update(() => {
        $getRoot().selectEnd();
        editor.dispatchCommand(KEY_ENTER_COMMAND, event as unknown as KeyboardEvent);
      }, { discrete: true });
    }
  });
  return event;
}

test("suggestion is separate gray placeholder with a short localized ARIA hint; arrival never edits or focuses", async () => {
  await mount({ promptSuggestion: null });
  const focus = mock();
  editor.focus = focus;
  const state = editor.getEditorState();
  const beforeButtons = view.root.findAllByType("button").map((node) => node.props.disabled);
  await update({ promptSuggestion: suggestion });
  expect(text()).toBe("");
  expect(editor.getEditorState()).toBe(state);
  expect(props.draft).toBe("");
  expect(props.onDraftChange).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(visibleSuggestion()).toHaveLength(1);
  expect(visibleSuggestion()[0].children).toEqual([suggestion]);
  expect(visibleSuggestion()[0].findAllByType("span")).toHaveLength(0);
  expect(leaf().props["aria-keyshortcuts"]).toBe("Tab");
  const hint = view.root.findByProps({ role: "status", "aria-live": "polite" });
  expect(hint.children).toEqual([t("composer.prompt_suggestion.available_hint")]);
  expect(hint.props.id).toBe(leaf().props["aria-describedby"]);
  expect(view.root.findAllByType("button").map((node) => node.props.disabled)).toEqual(beforeButtons);
});

test("Tab inserts once, positions the caret at the end, notifies lifecycle and supports one-step undo/redo", async () => {
  await mount();
  const accepted = props.onAcceptPromptSuggestion;
  const event = await press("Tab");
  expect(event.preventDefault).toHaveBeenCalledTimes(1);
  expect(text()).toBe(suggestion);
  expect(props.draft).toBe(suggestion);
  expect(props.onDraftChange).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledWith(suggestion);
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection)).toBe(true);
    if ($isRangeSelection(selection)) {
      expect(selection.isCollapsed()).toBe(true);
      expect(selection.anchor.getNode().getTextContent().slice(selection.anchor.offset)).toBe("");
    }
  });
  expect(visibleSuggestion()).toHaveLength(0);
  for (const callback of [props.onSend, props.onQueue, props.onSteer]) expect(callback).not.toHaveBeenCalled();
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(text()).toBe("");
  expect(props.draft).toBe("");
  expect(visibleSuggestion()).toHaveLength(1);
  await act(async () => { editor.dispatchCommand(REDO_COMMAND, undefined); });
  expect(text()).toBe(suggestion);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  await press("Enter");
  expect(props.onSend).toHaveBeenCalledTimes(1);
});

test("Enter never accepts or sends gray text, including while busy", async () => {
  await mount({ busy: true });
  await press("Enter");
  expect(text()).toBe("");
  for (const callback of [props.onAcceptPromptSuggestion, props.onSend, props.onQueue, props.onSteer]) expect(callback).not.toHaveBeenCalled();
});

test("accepted suggestion stays literal text rather than becoming a capability or command chip", async () => {
  const literal = "/review [skill example] @example";
  await mount({ promptSuggestion: literal });
  await press("Tab");
  expect(text()).toBe(literal);
  editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    expect($isElementNode(paragraph)).toBe(true);
    if ($isElementNode(paragraph)) expect(paragraph.getChildren().map((node) => node.getType())).toEqual(["text"]);
  });
});

test("modified/repeated Tab, toolbar Tab, arrows and no-suggestion Tab retain their behavior", async () => {
  await mount();
  for (const flags of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { repeat: true }, { target: new KeyTarget(false) }]) {
    expect((await press("Tab", flags)).preventDefault).not.toHaveBeenCalled();
  }
  expect((await press("ArrowRight")).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(text()).toBe("");
  await update({ promptSuggestion: null });
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
});

test("pending-only Escape dismisses once without arming stop; Tab and subsequent idle Escape pass through", async () => {
  await mount({ promptSuggestion: null, promptSuggestionPending: true, draft: "existing" });
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(visibleSuggestion()).toHaveLength(0);
  expect((await press("Escape")).preventDefault).toHaveBeenCalledTimes(1);
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(1);
  expect(props.onStop).not.toHaveBeenCalled(); expect(props.draft).toBe("existing");
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(1);
});

test("pending dismissal preserves the existing busy double-Escape stop sequence", async () => {
  await mount({ promptSuggestion: null, promptSuggestionPending: true, busy: true });
  await press("Escape");
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(1); expect(props.onStop).not.toHaveBeenCalled();
  await press("Escape"); expect(props.onStop).not.toHaveBeenCalled();
  await press("Escape"); expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(1);
});

test("pending Escape respects native IME, tracked composition, Lexical composition, menus and disabled input", async () => {
  await mount({ promptSuggestion: null, promptSuggestionPending: true });
  for (const flags of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    expect((await press("Escape", flags)).preventDefault).not.toHaveBeenCalled();
  }
  await act(async () => { root().props.onCompositionStart(); });
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  await act(async () => { root().props.onCompositionEnd(); });
  await act(async () => { editor.update(() => { $setCompositionKey($getRoot().getFirstChild()!.getKey()); }, { discrete: true }); });
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  await act(async () => { editor.update(() => { $setCompositionKey(null); }, { discrete: true }); });
  await act(async () => { view.root.findByProps({ "aria-haspopup": "menu" }).props.onClick(); });
  await press("Escape"); expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ restrictedHost: false, draft: "/no-matching-command" });
  await press("Escape"); expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ draft: "@no-matching-mention" });
  await press("Escape"); expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ draft: "", modelPickerOpen: true });
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  await update({ modelPickerOpen: false, disabled: true });
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ disabled: false }); await press("Escape");
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(1);
});

for (const dismissPending of [true, false]) test(`real hook-composer wiring ${dismissPending ? "cancels pending before late resolution" : "transitions pending to ready and accepts with Tab"}`, async () => {
  const wait = () => new Promise<void>((done) => setTimeout(done, 5));
  let resolve!: (value: { turnKey: string; suggestion: string }) => void;
  let signal!: AbortSignal;
  const request = mock((_workspace: string, _session: string, _input: unknown, options: { signal: AbortSignal }) => {
    signal = options.signal;
    return new Promise<{ turnKey: string; suggestion: string }>((done) => { resolve = done; });
  });
  const client = { ...createJuggleWorkServerClient({ baseUrl: "https://suggestion.test" }),
    capabilities: async () => ({ sessions: { promptSuggestions: true } }) as Awaited<ReturnType<ReturnType<typeof createJuggleWorkServerClient>["capabilities"]>>,
    getPromptSuggestion: request,
  };
  lifecycleQuery = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let turn = { turnKey: "old", turnCreatedAt: 100, running: false, completed: true };
  let lifecycle!: ReturnType<typeof usePromptSuggestions>;
  function Connected(composerProps: Props) {
    lifecycle = usePromptSuggestions({ client, workspaceId: "ws", sessionId: composerProps.sessionId,
      model: { providerID: "p", modelID: "m" }, policyKey: "allowed", enabled: true, active: true, loaded: true,
      blocked: false, empty: !composerProps.draft, ready: true, ...turn });
    return <ReactSessionComposer {...composerProps} promptSuggestion={lifecycle.suggestion}
      promptSuggestionPending={lifecycle.pending} onDismissPromptSuggestion={lifecycle.dismiss} onAcceptPromptSuggestion={lifecycle.accept}
      onDraftChange={(draft) => {
        useComposerStateStore.getState().setDraft(composerProps.sessionId, draft);
        composerProps.onDraftChange(draft);
      }} />;
  }
  await mount({ sessionId: `pending-escape-${dismissPending}` }, (value) => <React.StrictMode><QueryClientProvider client={lifecycleQuery!}><Connected {...value} /></QueryClientProvider></React.StrictMode>);
  await act(wait);
  expect(lifecycle.pending).toBe(false);
  turn = { turnKey: "new", turnCreatedAt: 200, running: true, completed: false }; await update({});
  turn = { ...turn, running: false, completed: true }; await update({});
  await act(wait);
  expect(lifecycle.pending).toBe(true); expect(lifecycle.suggestion).toBeNull();
  expect(view.root.findByType(ReactSessionComposer).props.promptSuggestionPending).toBe(true);
  expect(request).toHaveBeenCalledTimes(1); expect(signal.aborted).toBe(false);
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled(); expect(text()).toBe("");
  if (dismissPending) {
    expect((await press("Escape")).preventDefault).toHaveBeenCalledTimes(1);
    expect(lifecycle.pending).toBe(false); expect(signal.aborted).toBe(true);
  } else {
    await update({ draft: "existing" });
    expect(lifecycle.pending).toBe(false); expect(signal.aborted).toBe(false);
    expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
    expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  }
  await act(async () => { resolve({ turnKey: "new", suggestion }); await wait(); });
  expect(lifecycle.pending).toBe(false);
  if (dismissPending) {
    expect(lifecycle.suggestion).toBeNull(); expect(visibleSuggestion()).toHaveLength(0);
    expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
    expect(text()).toBe("");
  } else {
    expect(lifecycle.suggestion).toBeNull(); expect(visibleSuggestion()).toHaveLength(0);
    expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
    expect(text()).toBe("existing");
    await update({ draft: "" });
    expect(lifecycle.suggestion).toBe(suggestion); expect(visibleSuggestion()).toHaveLength(1);
    expect((await press("Tab")).preventDefault).toHaveBeenCalledTimes(1);
    expect(text()).toBe(suggestion); expect(lifecycle.suggestion).toBeNull();
    await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
    expect(text()).toBe(""); expect(props.draft).toBe("");
    expect(lifecycle.suggestion).toBe(suggestion); expect(visibleSuggestion()).toHaveLength(1);
    await act(async () => { editor.dispatchCommand(REDO_COMMAND, undefined); });
    expect(text()).toBe(suggestion); expect(visibleSuggestion()).toHaveLength(0);
    await update({ draft: "" });
    expect(lifecycle.suggestion).toBe(suggestion); expect(visibleSuggestion()).toHaveLength(1);
  }
  await update({ draft: "" }); await act(wait);
  expect(request).toHaveBeenCalledTimes(1); expect(lifecycle.pending).toBe(false);
  expect(props.onStop).not.toHaveBeenCalled();
});

for (const draft of ["", "existing"]) test(`all IME signals protect Tab and Escape, including independent Lexical composition (${draft || "empty"})`, async () => {
  await mount({ draft });
  for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Tab", "Escape"]) expect((await press(key, flags)).preventDefault).not.toHaveBeenCalled();
  }
  await act(async () => { root().props.onCompositionStart(); });
  for (const key of ["Tab", "Escape"]) expect((await press(key)).preventDefault).not.toHaveBeenCalled();
  await act(async () => { root().props.onCompositionEnd(); });
  await act(async () => { editor.update(() => { $setCompositionKey($getRoot().getFirstChild()!.getKey()); }, { discrete: true }); });
  expect(editor.isComposing()).toBe(true);
  for (const key of ["Tab", "Escape"]) expect((await press(key)).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await act(async () => { editor.update(() => { $setCompositionKey(null); }, { discrete: true }); });
  await press("Tab");
  expect(text()).toBe(draft || suggestion);
});

for (const draft of ["", "existing"]) test(`empty plus menu owns Tab/Escape before suggestions; suggestion Escape dismisses before busy stop (${draft || "empty"})`, async () => {
  await mount({ busy: true, draft });
  await act(async () => { view.root.findByProps({ "aria-haspopup": "menu" }).props.onClick(); });
  expect(view.root.findAllByProps({ role: "menuitem" })).toHaveLength(0);
  await press("Tab");
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  await press("Escape");
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  expect(view.root.findAllByProps({ role: "menu" })).toHaveLength(0);
  await press("Escape", { target: new KeyTarget(false) });
  expect(props.onDismissPromptSuggestion).toHaveBeenCalledTimes(draft ? 0 : 1);
  expect(props.onStop).not.toHaveBeenCalled();
  expect(text()).toBe(draft);
});

for (const draft of ["/no-matching-command", "@no-matching-mention"]) test(`empty ${draft[0]} menu Escape closes without dismissing`, async () => {
  await mount({ restrictedHost: false, draft });
  await press("Tab");
  await press("Escape");
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ draft: "" });
  await press("Tab");
  expect(text()).toBe(suggestion);
});

for (const draft of ["", "existing"]) test(`model picker blocks suggestion keys (${draft || "empty"})`, async () => {
  await mount({ modelPickerOpen: true, draft });
  for (const key of ["Tab", "Escape"]) expect((await press(key)).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
});

test("nonempty drafts hide the placeholder and ARIA hint; clearing reveals the same suggestion", async () => {
  await mount({ draft: "existing" });
  expect(visibleSuggestion()).toHaveLength(0);
  expect(leaf().props["aria-keyshortcuts"]).toBeUndefined();
  expect(leaf().props["aria-describedby"]).toBeUndefined();
  expect(text()).toBe("existing");
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await update({ draft: "" });
  expect(visibleSuggestion()).toHaveLength(1);
  expect(visibleSuggestion()[0].props.className).toContain("row-start-1");
  expect(visibleSuggestion()[0].props.className).not.toContain("row-start-2");
  await update({ draft: "", disabled: true });
  expect(visibleSuggestion()).toHaveLength(0);
  expect(leaf().props["aria-describedby"]).toBeUndefined();
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
});

test("live input hides suggestions and blocks Tab/Escape even when external draft props are stale", async () => {
  await mount();
  await update({ disabled: false, onDraftChange: mock() });
  await act(async () => { editor.update(() => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    if ($isElementNode(paragraph)) paragraph.append($createTextNode("typed"));
  }, { discrete: true }); });
  expect(props.draft).toBe("");
  expect(visibleSuggestion()).toHaveLength(0);
  expect(leaf().props["aria-keyshortcuts"]).toBeUndefined();
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(text()).toBe("typed");
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(text()).toBe("");
  expect(visibleSuggestion()).toHaveLength(1);
});

for (const content of [
  { draft: " " },
  { draft: "\n" },
  { draft: "[skill example]" },
  { draft: "[attachment file]" },
  { mentions: { example: "file" as const } },
  { pastedText: [{ id: "paste", label: "paste", text: "pasted content", lines: 1 }] },
  { attachments: [{ id: "file", name: "notes.txt", kind: "file" as const, mimeType: "text/plain", dataUrl: "data:text/plain;base64," }] },
]) test(`attachments, chips and whitespace hide suggestions and prevent acceptance (${JSON.stringify(content)})`, async () => {
  await mount(content);
  const original = props.draft;
  expect(visibleSuggestion()).toHaveLength(0);
  expect(leaf().props["aria-describedby"]).toBeUndefined();
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  expect(props.draft).toBe(original);
  if ("attachments" in content) {
    expect(view.root.findAllByProps({ "aria-label": "Remove notes.txt" })).toHaveLength(1);
  }
  await update({ draft: "", mentions: {}, pastedText: [], attachments: [] });
  expect(visibleSuggestion()).toHaveLength(1);
});

test("ordinary editing hides without dismissing; undo reveals the suggestion and retains user-edit notifications", async () => {
  await mount({ onUserEdit: mock() });
  await act(async () => { editor.update(() => {
    $getRoot().selectEnd();
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText("typed");
  }, { discrete: true }); });
  expect(props.draft).toBe("typed");
  expect(props.onUserEdit).toHaveBeenCalledTimes(1);
  expect(visibleSuggestion()).toHaveLength(0);
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(props.draft).toBe("");
  expect(props.onUserEdit).toHaveBeenCalledTimes(2);
  expect(visibleSuggestion()).toHaveLength(1);
  expect(visibleSuggestion()[0].props.className).toContain("row-start-1");
  expect((await press("Tab")).preventDefault).toHaveBeenCalledTimes(1);
  expect(props.onUserEdit).toHaveBeenCalledTimes(2);
});

for (const [anchor, focus] of [[1, 4], [4, 1], [3, 3]]) test(`nonempty Tab preserves draft and selection (${anchor}, ${focus})`, async () => {
  await mount({ draft: "abcdef", onUserEdit: mock() });
  await act(async () => { editor.update(() => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    if ($isElementNode(paragraph)) paragraph.getFirstChildOrThrow().select(anchor, focus);
  }, { discrete: true }); });
  const state = editor.getEditorState();
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect(props.draft).toBe("abcdef");
  expect(editor.getEditorState()).toBe(state);
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection)).toBe(true);
    if ($isRangeSelection(selection)) {
      expect(selection.anchor.offset).toBe(anchor);
      expect(selection.focus.offset).toBe(focus);
    }
  });
  expect(props.onUserEdit).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  for (const callback of [props.onSend, props.onQueue, props.onSteer]) expect(callback).not.toHaveBeenCalled();
});

test("nonempty Tab without a selection passes through; Escape keeps the busy stop sequence", async () => {
  await mount({ draft: "existing" });
  expect((await press("Escape")).preventDefault).not.toHaveBeenCalled();
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
  expect(props.draft).toBe("existing");
  await act(async () => { editor.update(() => $setSelection(null), { discrete: true }); });
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect(props.onAcceptPromptSuggestion).not.toHaveBeenCalled();
  expect(props.draft).toBe("existing");
  await update({ busy: true });
  await press("Escape"); expect(props.onStop).not.toHaveBeenCalled();
  await press("Escape"); expect(props.onStop).toHaveBeenCalledTimes(1);
  expect(props.onDismissPromptSuggestion).not.toHaveBeenCalled();
});

test("empty-draft acceptance notifies before draft sync and undo reveals the retained suggestion", async () => {
  const events: string[] = [];
  await mount({ onUserEdit: mock(), onAcceptPromptSuggestion: mock(() => {
    events.push("accept");
  }) });
  const change = props.onDraftChange;
  await update({ onDraftChange: mock((draft: string) => { events.push("draft"); change(draft); }) });
  await press("Tab");
  expect(events).toEqual(["accept", "draft"]);
  expect(props.draft).toBe(suggestion);
  expect(props.onUserEdit).not.toHaveBeenCalled();
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(props.draft).toBe("");
  expect(props.onUserEdit).toHaveBeenCalledTimes(1);
  expect(visibleSuggestion()).toHaveLength(1);
});

test("external draft clear syncs without a user-edit notification", async () => {
  await mount({ draft: "submitted", onUserEdit: mock() });
  await update({ draft: "" });
  expect(text()).toBe("");
  expect(props.onUserEdit).not.toHaveBeenCalled();
  expect(visibleSuggestion()).toHaveLength(1);
});

test("multiline draft selection is preserved; only clearing allows multiline suggestion acceptance", async () => {
  await mount({ draft: "first\nsecond", promptSuggestion: "新行\n末行" });
  await act(async () => { editor.update(() => {
    const first = $getRoot().getFirstDescendant()!;
    const last = $getRoot().getLastDescendant()!;
    const selection = last.select(3, 3);
    selection.focus.set(first.getKey(), 2, "text");
  }, { discrete: true }); });
  const state = editor.getEditorState();
  expect((await press("Tab")).preventDefault).not.toHaveBeenCalled();
  expect(editor.getEditorState()).toBe(state);
  expect(props.draft).toBe("first\nsecond");
  await update({ draft: "" });
  await press("Tab");
  expect(props.draft).toBe("新行\n末行");
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(props.draft).toBe("");
  expect(visibleSuggestion()).toHaveLength(1);
});

for (const endpoint of ["root", "chip"]) test(`imperative acceptance refuses nonempty editor and preserves chips at ${endpoint} endpoint`, async () => {
  const handle = React.createRef<LexicalPromptEditorHandle>();
  const original = "[attachment file] @example [skill example] tail";
  const literal = "/review [skill literal] @example";
  let draft = original;
  const render = () => <LexicalPromptEditor ref={handle} value={draft} disabled={false} placeholder=""
    promptSuggestion={literal} mentions={{ example: "file" }}
    attachments={[{ id: "file", name: "notes.txt", kind: "file" }]}
    onChange={(next) => { draft = next; view.update(render()); }} />;
  await act(async () => { view = TestRenderer.create(render()); });
  const nodes = () => editor.getEditorState().read(() => {
    const paragraph = $getRoot().getFirstChildOrThrow();
    return $isElementNode(paragraph) ? paragraph.getChildren().map((node) => [node.getKey(), node.getType()]) : [];
  });
  const chips = nodes().filter(([, type]) => type !== "text");
  expect(chips.map(([, type]) => type)).toEqual(["composer-attachment", "composer-mention", "composer-skill"]);
  expect(visibleSuggestion()).toHaveLength(0);
  await act(async () => { editor.update(() => {
    if (endpoint === "root") $getRoot().select(0, $getRoot().getChildrenSize());
    else {
      const paragraph = $getRoot().getFirstChildOrThrow();
      if ($isElementNode(paragraph)) paragraph.getFirstChildOrThrow().select(0, 1);
    }
  }, { discrete: true }); });
  const state = editor.getEditorState();
  const accepted = mock();
  await act(async () => { expect(handle.current!.acceptPromptSuggestion(literal, accepted)).toBe(false); });
  expect(accepted).not.toHaveBeenCalled();
  expect(editor.getEditorState()).toBe(state);
  expect(draft).toBe(original);
  expect(nodes().filter(([, type]) => type !== "text")).toEqual(chips);
});

/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { $getRoot, $getSelection, $isRangeSelection, $setCompositionKey, FORMAT_TEXT_COMMAND, KEY_DOWN_COMMAND, KEY_ENTER_COMMAND, PASTE_COMMAND, UNDO_COMMAND, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";
import { $applyBlockStyle, markdownLink } from "../src/react-app/domains/session/surface/composer/selection-formatting";
import { $readOfficeComposerDraft } from "../src/react-app/domains/session/surface/composer/office-selection-node";

// Mount the real composer, LexicalComposer, editor state and production plugins.
// There is no DOM/OS IME here: the editable leaf only exposes the real editor.
let editor: LexicalEditor;
const draftText = () => editor.getEditorState().read(() => $readOfficeComposerDraft([]).draft);
mock.module("@lexical/react/LexicalContentEditable.js", () => ({ ContentEditable: () => {
  [editor] = useLexicalComposerContext();
  return null;
} }));
const desktopConfig = await import("../src/react-app/domains/cloud/desktop-config-provider");
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ ...desktopConfig, useDesktopRestriction: () => false }));
mock.module("../src/components/model-select", () => ({ ModelSelect: () => null }));
mock.module("../src/components/model-behavior-select", () => ({ ModelBehaviorSelect: () => null }));
mock.module("../src/react-app/domains/session/surface/composer/context-usage", () => ({ ContextUsage: () => null }));
mock.module("../src/components/ui/tooltip", () => {
  const Pass = ({ children }: React.PropsWithChildren) => <>{children}</>;
  return { Tooltip: Pass, TooltipTrigger: Pass, TooltipContent: Pass };
});
const { ReactSessionComposer } = await import("../src/react-app/domains/session/surface/composer/composer");
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
  location: { origin: "http://composition.test" }, localStorage: { getItem: () => null },
}) });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
let view: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); });
const noop = () => {};
const empty = async () => [];

async function mount(restrictedHost: boolean, busy: boolean, draft = "你好", overrides: Partial<React.ComponentProps<typeof ReactSessionComposer>> = {}) {
  const send = mock(), queue = mock(), stop = mock();
  const props: React.ComponentProps<typeof ReactSessionComposer> = {
    restrictedHost, sessionId: "composition-regression", focusEligible: false, draft, mentions: {},
    createVoiceRealtimeSession: null, getVoiceRealtimeStatus: null, onDraftChange: noop, onSend: send, onQueue: queue, onSteer: noop, onStop: stop,
    busy, steering: false, submissionPreparing: false, submissionPreparingLabel: null, submissionDisabled: false,
    queuedCount: 0, disabled: false, statusLabel: "", modelPickerOpen: false, selectedModel: { providerID: "test", modelID: "test" },
    contextUsageMessages: [], contextUsageTranscript: [], contextWindowTokens: 0, onModelPickerOpenChange: noop, onModelChange: noop,
    attachments: [], onAttachFiles: noop, onRemoveAttachment: noop, attachmentsEnabled: false, attachmentsDisabledReason: null,
    imageGenerationModels: [], imageGenerationLoading: false, imageGeneration: null, onEnableImageGeneration: noop,
    onImageGenerationChange: noop, onDisableImageGeneration: noop, onRefreshImageGenerationModels: empty,
    videoGenerationModels: [], videoGenerationLoading: false, videoGeneration: null, onEnableVideoGeneration: noop,
    onVideoGenerationChange: noop, onDisableVideoGeneration: noop, onRefreshVideoGenerationModels: empty,
    modelVariantLabel: "", modelVariant: null, onModelVariantChange: noop, agentLabel: "", selectedAgent: null, listAgents: empty,
    onSelectAgent: noop, listCommands: empty, recentFiles: [], searchFiles: empty, onInsertMention: noop,
    pastedText: [], onExpandPastedText: noop, onRemovePastedText: noop, isRemoteWorkspace: false, isSandboxWorkspace: false,
    ...overrides,
  };
  await act(async () => { view = TestRenderer.create(<ReactSessionComposer {...props} />); });
  const root = () => view!.root.findAllByType("div").find((node) => node.props.onKeyDownCapture)!;
  const press = async (flags: Partial<KeyboardEvent> = {}) => {
    const event = { key: "Enter", keyCode: 13, isComposing: false, preventDefault: mock(), stopPropagation: mock(), ...flags } as unknown as KeyboardEvent;
    await act(async () => {
      root().props.onKeyDownCapture({ ...event, nativeEvent: event });
      // Explicitly exercise the command chain even when capture returned early.
      editor.update(() => { $getRoot().selectEnd(); editor.dispatchCommand(KEY_ENTER_COMMAND, event); }, { discrete: true });
    });
  };
  return { root, press, send, queue, stop };
}

for (const restrictedHost of [true, false]) test(`mounted Lexical Enter respects all composition signals (restrictedHost=${restrictedHost})`, async () => {
  const h = await mount(restrictedHost, true);
  await h.press({ isComposing: true });
  await h.press({ keyCode: 229 });
  await act(async () => { h.root().props.onCompositionStart(); });
  await h.press(); // Event flags can be absent while compositionstart is still active.
  await act(async () => { h.root().props.onCompositionEnd(); });
  editor.update(() => { $setCompositionKey($getRoot().getFirstDescendant()!.getKey()); }, { discrete: true });
  expect(editor.isComposing()).toBe(true);
  await h.press(); // Independent Lexical composition state, with no native flags.
  expect(h.send).not.toHaveBeenCalled();
  expect(h.queue).not.toHaveBeenCalled();
  editor.update(() => { $setCompositionKey(null); }, { discrete: true });
  await h.press();
  expect(h.send).toHaveBeenCalledTimes(restrictedHost ? 1 : 0);
  expect(h.queue).toHaveBeenCalledTimes(restrictedHost ? 0 : 1);
});

const longPaste = "保留换行和内容".repeat(10) + "\n第二行";
for (const { text, mime, collapse, expected, start, end } of [
  { text: "短文本", mime: "text/plain", collapse: true, expected: "短文本", start: 1, end: 1 },
  { text: longPaste, mime: "text/plain", collapse: true, expected: "[pasted text sample]", start: 1, end: 3 },
  { text: longPaste, mime: "text/plain", collapse: false, expected: longPaste, start: 1, end: 3 },
  { text: "https://one.test\r\nhttps://two.test", mime: "text/uri-list", collapse: true, expected: "https://one.test\nhttps://two.test", start: 1, end: 3 },
]) test(`paste uses the selection and leaves the cursor after the insertion (${mime}, ${text.length}, chip=${collapse})`, async () => {
  const draft = "甲乙丙丁";
  const onDraftChange = mock();
  const register = mock((value: string) => ({ label: "sample", lines: 2, text: value }));
  await mount(false, false, draft, { onDraftChange, registerPastedText: collapse ? register : undefined });
  await act(async () => editor.update(() => {
    $getRoot().getAllTextNodes()[0].select(start, end);
    editor.dispatchCommand(PASTE_COMMAND, {
      clipboardData: { files: [], getData: (type: string) => type === mime ? text : "" },
      preventDefault: noop,
    } as unknown as ClipboardEvent);
  }, { discrete: true }));
  expect(onDraftChange).toHaveBeenLastCalledWith(draft.slice(0, start) + expected + draft.slice(end));
  expect(register).toHaveBeenCalledTimes(expected.startsWith("[pasted") ? 1 : 0);
  await act(async () => editor.update(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) selection.insertText("!");
  }, { discrete: true }));
  expect(onDraftChange).toHaveBeenLastCalledWith(draft.slice(0, start) + expected + "!" + draft.slice(end));
});

test("mounted Lexical keeps Shift/Alt+Enter as newlines and submits ordinary Enter once", async () => {
  const h = await mount(true, false);
  await h.press({ shiftKey: true });
  await h.press({ altKey: true });
  expect(draftText()).toBe("你好\n\n");
  expect(h.send).not.toHaveBeenCalled();
  await h.press();
  expect(h.send).toHaveBeenCalledTimes(1);
});

test("typing the period indents immediately, Shift+Enter continues or exits, Enter submits", async () => {
  const h = await mount(true, false, "1");
  const content = draftText;
  await act(async () => editor.update(() => {
    $getRoot().selectEnd();
    editor.dispatchCommand(KEY_DOWN_COMMAND, { key: ".", preventDefault: noop } as KeyboardEvent);
  }, { discrete: true }));
  expect(content()).toBe("  1. ");
  await h.press({ shiftKey: true });
  expect(content()).toBe("");
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(content()).toBe("  1. ");
  await act(async () => editor.update(() => { $getRoot().selectEnd().insertText("设计"); }, { discrete: true }));
  await h.press({ shiftKey: true });
  expect(content()).toBe("  1. 设计\n  2. ");
  await act(async () => editor.update(() => { $getRoot().selectEnd().insertText("检查"); }, { discrete: true }));
  await h.press({ shiftKey: true });
  expect(content()).toBe("  1. 设计\n  2. 检查\n  3. ");
  await h.press({ shiftKey: true });
  expect(content()).toBe("  1. 设计\n  2. 检查\n");
  expect(h.send).not.toHaveBeenCalled();
  await act(async () => { editor.dispatchCommand(UNDO_COMMAND, undefined); });
  expect(content()).toBe("  1. 设计\n  2. 检查\n  3. ");
  await h.press();
  expect(h.send).toHaveBeenCalledTimes(1);
});

for (const [draft, expected] of [
  ["  9、核对", "\n  10、 "],
  ["- 事项", "\n- "],
  ["版本 1.2", "\n"],
  ["3.14", "\n"],
  ["1", "\n"],
]) test(`Shift+Enter handles the draft ${draft}`, async () => {
  const h = await mount(true, false, draft);
  await h.press({ shiftKey: true });
  expect(draftText()).toBe(draft + expected);
  expect(h.send).not.toHaveBeenCalled();
});

test("inline Markdown shows formatting and round-trips the exact draft", async () => {
  const draft = "1. **重点**、*补充* 和 `git`";
  const h = await mount(true, false, draft);
  // The headless editable has no DOM commit. Flush the initial editor update.
  await act(async () => editor.update(() => { $getRoot().selectEnd(); }, { discrete: true }));
  const formatted = editor.getEditorState().read(() =>
    $getRoot().getAllTextNodes().filter((node) => node.getFormat())
      .map((node) => [node.getTextContent(), node.hasFormat("bold"), node.hasFormat("italic"), node.hasFormat("code")]));
  expect(formatted).toEqual([["重点", true, false, false], ["补充", false, true, false], ["git", false, false, true]]);
  await h.press({ shiftKey: true });
  expect(draftText()).toBe(draft + "\n2. ");
});

test("format shortcut wraps the selection, keeps it selected and toggles it off", async () => {
  await mount(true, false, "检查重点");
  await act(async () => editor.update(() => {
    $getRoot().getAllTextNodes()[0].select(2, 4);
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
  }, { discrete: true }));
  expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("检查重点");
  expect(draftText()).toBe("检查**重点**");
  await act(async () => editor.update(() => { editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold"); }, { discrete: true }));
  expect(draftText()).toBe("检查重点");
});

test("paragraph styles replace existing prefixes on the selected lines of a draft", async () => {
  await mount(true, false, "intro\n# first\n- second\noutro");
  await act(async () => editor.update(() => {
    const [, first, second] = $getRoot().getAllTextNodes();
    const range = second.select(3, 3);
    range.focus.set(first.getKey(), 4, "text");
    $applyBlockStyle(range, "ordered");
  }, { discrete: true }));
  expect(editor.getEditorState().read(() => $getRoot().getChildren().map(n => n.getType()))).toEqual(["paragraph", "list", "paragraph"]);
  expect(draftText()).toBe("intro\n  1. first\n  2. second\noutro");
});

test("link formatting keeps its label and destination intact in Markdown", () => {
  expect(markdownLink("A [B]", "https://example.com/(x)")).toBe("[A \\[B\\]](https://example.com/%28x%29)");
  expect(markdownLink("A", "invalid address")).toBeNull();
});

test("Shift+Enter splits a restored list at the caret and preserves text on either side", async () => {
  const h = await mount(true, false, "计划\n1. 设计测试");
  await act(async () => editor.update(() => {
    $getRoot().getAllTextNodes().at(-1)!.select(2, 2);
    editor.dispatchCommand(KEY_ENTER_COMMAND, { shiftKey: true, preventDefault: noop } as KeyboardEvent);
  }, { discrete: true }));
  expect(draftText()).toBe("计划\n1. 设计\n2. 测试");
  expect(h.send).not.toHaveBeenCalled();
});

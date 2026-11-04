/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { $getRoot, $setCompositionKey, KEY_ENTER_COMMAND, type LexicalEditor } from "lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";

// Mount the real composer, LexicalComposer, editor state and production plugins.
// There is no DOM/OS IME here: the editable leaf only exposes the real editor.
let editor: LexicalEditor;
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

async function mount(restrictedHost: boolean, busy: boolean) {
  const send = mock(), queue = mock(), stop = mock();
  const props: React.ComponentProps<typeof ReactSessionComposer> = {
    restrictedHost, sessionId: "composition-regression", focusEligible: false, draft: "你好", mentions: {},
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
    onSelectAgent: noop, listCommands: empty, recentFiles: [], searchFiles: empty, onInsertMention: noop, onPasteText: noop,
    onUnsupportedFileLinks: noop, pastedText: [], onExpandPastedText: noop, onRemovePastedText: noop, isRemoteWorkspace: false, isSandboxWorkspace: false,
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

test("mounted Lexical keeps Shift/Alt+Enter as newlines and submits ordinary Enter once", async () => {
  const h = await mount(true, false);
  await h.press({ shiftKey: true });
  await h.press({ altKey: true });
  expect(editor.getEditorState().read(() => $getRoot().getTextContent())).toBe("你好\n\n");
  expect(h.send).not.toHaveBeenCalled();
  await h.press();
  expect(h.send).toHaveBeenCalledTimes(1);
});

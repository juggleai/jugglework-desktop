/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";

import { canStartStop, createStopGuard, shouldSettleStaleRunProjection, STOP_RECONCILE_TIMEOUT_MS, stopReconcileAction } from "../src/react-app/domains/session/surface/session-run-recovery";

// Real composer; only DOM leaves and unrelated services are replaced.
mock.module("@lexical/react/LexicalContentEditable.js", () => ({ ContentEditable: (props: object) => {
  useLexicalComposerContext();
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
type Props = React.ComponentProps<typeof ReactSessionComposer>;

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
  location: { origin: "http://stop.test" }, localStorage: { getItem: () => null },
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
afterEach(async () => { await act(async () => view?.unmount()); });
const noop = () => {};
const empty = async () => [];

async function mount(overrides: Partial<Props> = {}) {
  props = {
    restrictedHost: true, sessionId: "stop-pending", focusEligible: false, draft: "", mentions: {},
    promptSuggestion: null,
    createVoiceRealtimeSession: null, getVoiceRealtimeStatus: null,
    onDraftChange: noop, onAcceptPromptSuggestion: noop, onDismissPromptSuggestion: noop,
    onSend: mock(), onQueue: mock(), onSteer: mock(), onStop: mock(),
    busy: true, steering: false, submissionPreparing: false, submissionPreparingLabel: null, submissionDisabled: false,
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
  await act(async () => { view = TestRenderer.create(<ReactSessionComposer {...props} />); });
}
async function update(next: Partial<Props>) {
  props = { ...props, ...next };
  await act(async () => { view.update(<ReactSessionComposer {...props} />); });
}
const stopButton = () => view.root.findAll((node) => node.type === "button" && node.props["data-stop-pending"] !== undefined
  ? true : node.type === "button" && node.props.title === "Stop")[0];
const stopButtons = () => view.root.findAllByType("button").filter((node) => node.findAll((child) => child.props?.fill === "currentColor" || child.props?.className?.includes?.("animate-spin")).length > 0
  && (node.props.onClick !== undefined || node.props["aria-disabled"] === true));

test("a Stop click calls onStop while idle of any pending request", async () => {
  await mount();
  const button = view.root.findAllByType("button").find((node) => node.props["aria-disabled"] === undefined && node.props.title?.length && node.props.onClick === props.onStop)!;
  expect(button).toBeDefined();
  await act(async () => { button.props.onClick(); });
  expect(props.onStop).toHaveBeenCalledTimes(1);
});

test("while Stop is pending the button shows progress, is marked disabled, and ignores clicks", async () => {
  await mount({ stopPending: true });
  const pending = view.root.findAll((node) => node.type === "button" && node.props["data-stop-pending"] === "true");
  expect(pending).toHaveLength(1);
  expect(pending[0]!.props["aria-disabled"]).toBe(true);
  expect(pending[0]!.props.onClick).toBeUndefined();
  expect(pending[0]!.findAll((node) => String(node.props?.className ?? "").includes("animate-spin"))).not.toHaveLength(0);
});

test("the Stop button is gone once the run is no longer busy, even if a Stop was pending", async () => {
  await mount({ stopPending: true });
  await update({ busy: false, stopPending: false });
  expect(view.root.findAll((node) => node.type === "button" && node.props["data-stop-pending"] !== undefined)).toHaveLength(0);
  expect(view.root.findAll((node) => node.type === "button" && node.props.onClick === props.onStop)).toHaveLength(0);
});

test("Stop is not restarted while one is outstanding, and the reconcile window is bounded", () => {
  expect(canStartStop({ chatStreaming: true, stopPending: false })).toBe(true);
  expect(canStartStop({ chatStreaming: true, stopPending: true })).toBe(false);
  expect(canStartStop({ chatStreaming: false, stopPending: false })).toBe(false);
  expect(stopReconcileAction({ pendingForMs: STOP_RECONCILE_TIMEOUT_MS - 1 })).toBe("wait");
  expect(stopReconcileAction({ pendingForMs: STOP_RECONCILE_TIMEOUT_MS })).toBe("reconcile");
});

test("stale-projection recovery is what removes a Stop button the server no longer backs", () => {
  const stale = {
    activeRunsSucceeded: true, coordinatorActive: false, snapshotStatus: "idle",
    snapshotUpdatedAt: 200, activeRunsUpdatedAt: 100, sending: false, liveStatus: "busy", activityRunActive: true,
  };
  // The Stop button renders from chatStreaming; settling clears the busy inputs.
  expect(shouldSettleStaleRunProjection(stale)).toBe(true);
  // A run the server still owns, or one still being sent, must keep its Stop button.
  expect(shouldSettleStaleRunProjection({ ...stale, coordinatorActive: true })).toBe(false);
  expect(shouldSettleStaleRunProjection({ ...stale, sending: true })).toBe(false);
});

test("createStopGuard drops repeat Stops, reports pending, and fires the reconcile only if the abort outlasts the window", async () => {
  const pendingStates: boolean[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const guard = createStopGuard({
    onPendingChange: (value) => pendingStates.push(value),
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true; },
  });
  let release!: () => void;
  const abort = mock(() => new Promise<void>((resolve) => { release = resolve; }));
  const onTimeout = mock();

  const first = guard.run({ chatStreaming: true, abort, onTimeout });
  expect(guard.isPending()).toBe(true);
  expect(await guard.run({ chatStreaming: true, abort, onTimeout })).toBe(false);
  expect(abort).toHaveBeenCalledTimes(1);

  // The abort is still outstanding when the window elapses.
  expect(timers[0]!.ms).toBe(STOP_RECONCILE_TIMEOUT_MS);
  timers[0]!.fn();
  expect(onTimeout).toHaveBeenCalledTimes(1);

  release();
  expect(await first).toBe(true);
  expect(guard.isPending()).toBe(false);
  expect(timers[0]!.cleared).toBe(true);
  expect(pendingStates).toEqual([true, false]);
});

test("createStopGuard clears pending when the abort throws and accepts a later Stop", async () => {
  const guard = createStopGuard({ setTimer: () => 0, clearTimer: () => {} });
  await expect(guard.run({ chatStreaming: true, abort: async () => { throw new Error("boom"); }, onTimeout: () => {} })).rejects.toThrow("boom");
  expect(guard.isPending()).toBe(false);
  expect(await guard.run({ chatStreaming: true, abort: async () => {}, onTimeout: () => {} })).toBe(true);
  expect(await guard.run({ chatStreaming: false, abort: async () => {}, onTimeout: () => {} })).toBe(false);
});

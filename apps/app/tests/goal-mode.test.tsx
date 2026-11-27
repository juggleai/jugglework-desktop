/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";

import type { JuggleWorkSessionGoal } from "../src/app/lib/jugglework-server";
import { canContinueGoal, goalCriteriaProgress, isGoalToolName, isGoalUnfinished } from "../src/react-app/domains/session/surface/use-session-goal";
import { emptyGoalDraft, GoalCard, goalDraftFromGoal, goalDraftPayload } from "../src/react-app/domains/session/surface/goal-panel";

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
type ComposerProps = React.ComponentProps<typeof ReactSessionComposer>;

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const previousHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible" }) });
Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
  location: { origin: "http://goal.test" }, localStorage: { getItem: () => null },
}) });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => {
  for (const [name, descriptor] of [["window", previousWindow], ["HTMLElement", previousHTMLElement], ["document", previousDocument]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

let view: TestRenderer.ReactTestRenderer | undefined;
afterEach(async () => { await act(async () => view?.unmount()); view = undefined; });

function goal(overrides: Partial<JuggleWorkSessionGoal> = {}): JuggleWorkSessionGoal {
  return {
    id: "goal_1", workspaceId: "ws", sessionId: "ses", objective: "Ship CSV export",
    criteria: [
      { id: "c1", text: "Export downloads a CSV", required: true, status: "met", evidence: "tested" },
      { id: "c2", text: "Error handling", required: true, status: "pending", evidence: null },
      { id: "c3", text: "Docs", required: false, status: "pending", evidence: null },
    ],
    status: "active", execution: "idle", checkpoint: null,
    continuationTotal: 3, continuationStreak: 3, continuationCap: 10,
    blockerReason: null, blockerCount: 0, noProgressCount: 0, activeRunId: null, version: 4, createdAt: 1, updatedAt: 2, completedAt: null,
    ...overrides,
  };
}

const noop = () => {};
const empty = async () => [];
function composerProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    restrictedHost: false, sessionId: "goal", focusEligible: false, draft: "", mentions: {},
    promptSuggestion: null, createVoiceRealtimeSession: null, getVoiceRealtimeStatus: null,
    onDraftChange: noop, onAcceptPromptSuggestion: noop, onDismissPromptSuggestion: noop,
    onSend: mock(), onQueue: mock(), onSteer: mock(), onStop: mock(),
    busy: false, steering: false, submissionPreparing: false, submissionPreparingLabel: null, submissionDisabled: false,
    queuedCount: 0, disabled: false, statusLabel: "", modelPickerOpen: false, selectedModel: { providerID: "test", modelID: "test" },
    contextUsageMessages: [], contextUsageTranscript: [], contextWindowTokens: 0, onModelPickerOpenChange: noop, onModelChange: noop,
    attachments: [], onAttachFiles: noop, onRemoveAttachment: noop, attachmentsEnabled: true, attachmentsDisabledReason: null,
    imageGenerationModels: [], imageGenerationLoading: false, imageGeneration: null, onEnableImageGeneration: noop,
    onImageGenerationChange: noop, onDisableImageGeneration: noop, onRefreshImageGenerationModels: empty,
    videoGenerationModels: [], videoGenerationLoading: false, videoGeneration: null, onEnableVideoGeneration: noop,
    onVideoGenerationChange: noop, onDisableVideoGeneration: noop, onRefreshVideoGenerationModels: empty,
    modelVariantLabel: "", modelVariant: null, onModelVariantChange: noop, agentLabel: "", selectedAgent: null,
    listAgents: async () => [{ name: "build", mode: "primary" }, { name: "plan", mode: "primary" }] as never,
    onSelectAgent: mock(), listCommands: empty, recentFiles: [], searchFiles: empty, onInsertMention: noop,
    pastedText: [], isRemoteWorkspace: false, isSandboxWorkspace: false,
    ...overrides,
  };
}

async function openPlusMenu(props: ComposerProps) {
  await act(async () => { view = TestRenderer.create(<ReactSessionComposer {...props} />); });
  // Let listAgents resolve so Plan mode is in the menu.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const plus = view!.root.findAll((node) => node.type === "button" && node.props["aria-haspopup"] !== undefined)[0]
    ?? view!.root.findAll((node) => node.type === "button" && String(node.props["aria-label"] ?? "").toLowerCase().includes("add"))[0];
  expect(plus).toBeDefined();
  await act(async () => { plus!.props.onClick?.({ preventDefault() {}, stopPropagation() {} }); });
  return view!.root.findAll((node) => node.type === "button" && node.props.role === "menuitem");
}
const menuLabels = (items: TestRenderer.ReactTestInstance[]) =>
  items.map((item) => item.findAll((node) => node.type === "span" && String(node.props.className ?? "").includes("font-medium"))[0]?.children.join(""));

test("goal helpers classify unfinished goals, progress and when Continue is allowed", () => {
  expect(isGoalUnfinished(goal())).toBe(true);
  expect(isGoalUnfinished(goal({ status: "paused" }))).toBe(true);
  expect(isGoalUnfinished(goal({ status: "completed" }))).toBe(false);
  expect(isGoalUnfinished(null)).toBe(false);
  // Only required criteria count toward progress.
  expect(goalCriteriaProgress(goal())).toEqual({ done: 1, total: 2 });
  expect(canContinueGoal(goal(), false)).toBe(true);
  expect(canContinueGoal(goal({ execution: "waiting_user" }), false)).toBe(true);
  expect(canContinueGoal(goal(), true)).toBe(false);
  expect(canContinueGoal(goal({ execution: "running" }), false)).toBe(false);
  expect(canContinueGoal(goal({ status: "paused" }), false)).toBe(false);
});

test("setup draft requires an objective and a required criterion, and drops blank rows", () => {
  const draft = emptyGoalDraft();
  expect(goalDraftPayload(draft)).toEqual({ ok: false, error: "objective" });
  expect(goalDraftPayload({ ...draft, objective: "  Ship it " })).toEqual({ ok: false, error: "criteria" });
  expect(goalDraftPayload({ objective: "Ship", criteria: [{ key: "a", text: "optional", required: false }] })).toEqual({ ok: false, error: "criteria" });
  expect(goalDraftPayload({
    objective: " Ship ",
    criteria: [{ key: "a", text: " works ", required: true }, { key: "b", text: "   ", required: true }, { key: "c", id: "c9", text: "docs", required: false }],
  })).toEqual({ ok: true, objective: "Ship", criteria: [{ text: "works", required: true }, { id: "c9", text: "docs", required: false }] });
  // Editing keeps criterion ids so the server can preserve their progress.
  expect(goalDraftFromGoal(goal()).criteria.map((criterion) => criterion.id)).toEqual(["c1", "c2", "c3"]);
});

test("the + menu lists Goal next to Plan mode only in local workspaces, and Goal does not change the agent", async () => {
  const onOpenGoal = mock();
  const props = composerProps({ onOpenGoal });
  const items = await openPlusMenu(props);
  const labels = menuLabels(items);
  const planIndex = labels.findIndex((label) => label === "Plan mode");
  const goalIndex = labels.indexOf("Goal");
  expect(planIndex).toBeGreaterThanOrEqual(0);
  // Same group, directly after Plan mode.
  expect(goalIndex).toBe(planIndex + 1);
  await act(async () => { items[goalIndex]!.props.onClick(); });
  expect(onOpenGoal).toHaveBeenCalledTimes(1);
  expect(props.onSelectAgent).not.toHaveBeenCalled();
  await act(async () => view?.unmount());

  // Without onOpenGoal (remote, sandbox or file host) there is no Goal entry.
  const remoteItems = await openPlusMenu(composerProps({ isRemoteWorkspace: true }));
  expect(menuLabels(remoteItems)).not.toContain("Goal");
});

test("the goal card shows criteria progress and the n/10 continuation count, and wires its controls", async () => {
  const handlers = {
    onContinue: mock(), onPause: mock(), onResume: mock(), onEdit: mock(), onComplete: mock(), onCancel: mock(), onDismiss: mock(),
  };
  const render = (value: JuggleWorkSessionGoal, running = false) =>
    <GoalCard goal={value} sessionRunning={running} pending={false} error={null} {...handlers} />;
  await act(async () => { view = TestRenderer.create(render(goal())); });
  const byTestId = (id: string) => view!.root.findAll((node) => node.props["data-testid"] === id && typeof node.type === "string");
  const text = (id: string) => byTestId(id)[0]!.children.join("");
  expect(text("goal-criteria-progress")).toBe("1/2 criteria");
  expect(text("goal-continuations")).toBe("Auto runs 3/10");
  expect(byTestId("goal-continue")[0]!.props.disabled).toBe(false);
  await act(async () => { byTestId("goal-continue")[0]!.props.onClick(); });
  await act(async () => { byTestId("goal-pause")[0]!.props.onClick(); });
  expect(handlers.onContinue).toHaveBeenCalledTimes(1);
  expect(handlers.onPause).toHaveBeenCalledTimes(1);

  // While a run is active, Continue is disabled.
  await act(async () => { view!.update(render(goal({ execution: "running" }), true)); });
  expect(byTestId("goal-continue")[0]!.props.disabled).toBe(true);

  // A paused goal offers Resume instead of Continue/Pause.
  await act(async () => { view!.update(render(goal({ status: "paused" }))); });
  expect(byTestId("goal-continue")).toHaveLength(0);
  expect(byTestId("goal-pause")).toHaveLength(0);
  await act(async () => { byTestId("goal-resume")[0]!.props.onClick(); });
  expect(handlers.onResume).toHaveBeenCalledTimes(1);

  // A finished goal hides lifecycle controls and the continuation count.
  await act(async () => { view!.update(render(goal({ status: "completed" }))); });
  expect(byTestId("goal-continuations")).toHaveLength(0);
  expect(byTestId("goal-cancel")).toHaveLength(0);
  await act(async () => { byTestId("goal-dismiss")[0]!.props.onClick(); });
  expect(handlers.onDismiss).toHaveBeenCalledTimes(1);
});

test("the card shows the blocker reason, criterion evidence and the checkpoint", async () => {
  const handlers = { onContinue: mock(), onPause: mock(), onResume: mock(), onEdit: mock(), onComplete: mock(), onCancel: mock(), onDismiss: mock() };
  const waiting = goal({ execution: "waiting_user", blockerReason: "Which CSV delimiter?", blockerCount: 1, checkpoint: "Export button wired; delimiter pending" });
  await act(async () => { view = TestRenderer.create(<GoalCard goal={waiting} sessionRunning={false} pending={false} error={null} {...handlers} />); });
  const byTestId = (id: string) => view!.root.findAll((node) => node.props["data-testid"] === id && typeof node.type === "string");
  expect(byTestId("goal-blocker")[0]!.children.join("")).toBe("Needs you: Which CSV delimiter?");
  expect(byTestId("goal-execution")[0]!.children.join("")).toBe("Waiting for you");
  // Waiting for the user still allows Continue once they have answered.
  expect(byTestId("goal-continue")[0]!.props.disabled).toBe(false);
  // Criteria details are collapsed until expanded.
  expect(byTestId("goal-criteria")).toHaveLength(0);
  const expand = view!.root.findAll((node) => node.type === "button" && node.props["aria-expanded"] === false)[0]!;
  await act(async () => { expand.props.onClick(); });
  expect(byTestId("goal-criterion-evidence").map((node) => node.children.join(""))).toEqual(["tested"]);
  expect(byTestId("goal-checkpoint")[0]!.children.join("")).toContain("Export button wired; delimiter pending");

  await act(async () => { view!.update(<GoalCard goal={{ ...waiting, status: "blocked" }} sessionRunning={false} pending={false} error={null} {...handlers} />); });
  expect(byTestId("goal-blocker")[0]!.children.join("")).toBe("Blocked: Which CSV delimiter?");
  expect(byTestId("goal-resume")).toHaveLength(1);
});

test("goal tool names are recognized for card refresh", () => {
  expect(isGoalToolName("jugglework_goal_progress")).toBe(true);
  expect(isGoalToolName("jugglework_goal_complete")).toBe(true);
  expect(isGoalToolName("todowrite")).toBe(false);
  expect(isGoalToolName(undefined)).toBe(false);
});

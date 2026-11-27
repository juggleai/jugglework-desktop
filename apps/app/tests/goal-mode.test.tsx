/** @jsxImportSource react */
import * as React from "react";
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import TestRenderer, { act } from "react-test-renderer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext.js";

import type { JuggleWorkSessionGoal } from "../src/app/lib/jugglework-server";
import { canContinueGoal, GOAL_OBJECTIVE_MAX_CHARS, goalComposerBlock, goalCriteriaProgress, isGoalToolName, isGoalUnfinished, sessionGoalQueryKey, useSessionGoal } from "../src/react-app/domains/session/surface/use-session-goal";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setLocale } from "../src/i18n";
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
Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { visibilityState: "visible", documentElement: { setAttribute() {} } }) });
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
    blockerReason: null, blockerCount: 0, noProgressCount: 0, stopReason: null, activeRunId: null, version: 4, createdAt: 1, updatedAt: 2, completedAt: null,
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

test("the + menu lists Goal next to Plan mode only in local workspaces, and picking it does not change the agent", async () => {
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

test("the card explains why automatic continuation stopped and still offers Continue", async () => {
  const handlers = { onContinue: mock(), onPause: mock(), onResume: mock(), onEdit: mock(), onComplete: mock(), onCancel: mock(), onDismiss: mock() };
  const byTestId = (id: string) => view!.root.findAll((node) => node.props["data-testid"] === id && typeof node.type === "string");
  const expected: Record<string, string> = {
    continuation_cap: "Paused after 10 automatic runs. Press Continue to keep going.",
    no_progress: "Paused: 3 runs in a row recorded no progress. Check the checkpoint, then press Continue.",
    run_failed: "Paused: the last run failed. Press Continue to try again.",
    run_aborted: "Paused: the last run was stopped. Press Continue to resume.",
    run_lost: "Paused: the last run was interrupted. Press Continue to resume from the checkpoint.",
    dispatch_failed: "Paused: the next run could not be started. Press Continue to try again.",
  };
  for (const [reason, text] of Object.entries(expected)) {
    const stopped = goal({ execution: "waiting_user", stopReason: reason as never, continuationStreak: 10 });
    await act(async () => { view = TestRenderer.create(<GoalCard goal={stopped} sessionRunning={false} pending={false} error={null} {...handlers} />); });
    expect({ reason, text: byTestId("goal-stop-reason")[0]?.children.join("") }).toEqual({ reason, text });
    expect(byTestId("goal-continue")[0]!.props.disabled).toBe(false);
    await act(async () => { view!.unmount(); });
  }
  // A stop the user has not hit (or a running goal) shows no stop reason.
  await act(async () => { view = TestRenderer.create(<GoalCard goal={goal({ execution: "running" })} sessionRunning pending={false} error={null} {...handlers} />); });
  expect(byTestId("goal-stop-reason")).toHaveLength(0);
});

const noHandlers = () => ({ onContinue: mock(), onPause: mock(), onResume: mock(), onEdit: mock(), onComplete: mock(), onCancel: mock(), onDismiss: mock() });
const byTestId = (id: string) => view!.root.findAll((node) => node.props["data-testid"] === id && typeof node.type === "string");
const textOf = (id: string) => byTestId(id)[0]?.children.join("");

test("an unfinished goal between turns stays visible and unfinished while the session reports no running turn", async () => {
  const handlers = noHandlers();
  // Idle between turns: the card is unfinished and Continue is offered, even though no run is active.
  await act(async () => { view = TestRenderer.create(<GoalCard goal={goal({ execution: "idle" })} sessionRunning={false} pending={false} error={null} {...handlers} />); });
  expect(byTestId("goal-card")).toHaveLength(1);
  expect(textOf("goal-execution")).toBe("Idle");
  expect(byTestId("goal-continue")[0]!.props.disabled).toBe(false);
  expect(byTestId("goal-cancel")).toHaveLength(1);
  // The goal card never claims a running turn, and the helper that feeds the session's run indicator is untouched.
  expect(canContinueGoal(goal({ execution: "idle" }), false)).toBe(true);
  expect(isGoalUnfinished(goal({ execution: "idle" }))).toBe(true);
  // A running turn flips only the card label; Continue is disabled instead of hidden.
  await act(async () => { view!.update(<GoalCard goal={goal({ execution: "running" })} sessionRunning pending={false} error={null} {...handlers} />); });
  expect(textOf("goal-execution")).toBe("Working");
  expect(byTestId("goal-continue")[0]!.props.disabled).toBe(true);
});

test("the goal card is separate from run todos: it owns objective progress and exposes no todo content", async () => {
  const handlers = noHandlers();
  await act(async () => { view = TestRenderer.create(<GoalCard goal={goal()} sessionRunning pending={false} error={null} {...handlers} />); });
  const rendered = JSON.stringify(view!.toJSON());
  expect(textOf("goal-criteria-progress")).toBe("1/2 criteria");
  expect(rendered).not.toContain("todo");
});

test("every lifecycle and execution state has a localized label in English and Chinese", async () => {
  const handlers = noHandlers();
  const cases: Array<[Partial<JuggleWorkSessionGoal>, string, string]> = [
    [{ execution: "idle" }, "Idle", "空闲"],
    [{ execution: "queued" }, "Starting", "启动中"],
    [{ execution: "running" }, "Working", "执行中"],
    [{ execution: "waiting_user" }, "Waiting for you", "等待你处理"],
    [{ execution: "retrying" }, "Retrying", "重试中"],
    [{ execution: "usage_limited", stopReason: "usage_limited" }, "Usage limit reached", "额度已用完"],
    [{ status: "paused" }, "Paused", "已暂停"],
    [{ status: "blocked", blockerReason: "needs creds" }, "Blocked", "已阻塞"],
    [{ status: "completed", completedAt: 5 }, "Completed", "已完成"],
    [{ status: "cancelled", completedAt: 5 }, "Cancelled", "已取消"],
    [{ execution: "waiting_user", stopReason: "continuation_cap", continuationStreak: 10 }, "Waiting for you", "等待你处理"],
  ];
  try {
    for (const locale of ["en", "zh"] as const) {
      setLocale(locale);
      for (const [overrides, en, zh] of cases) {
        await act(async () => { view = TestRenderer.create(<GoalCard goal={goal(overrides)} sessionRunning={false} pending={false} error={null} {...handlers} />); });
        expect({ locale, overrides, label: textOf("goal-execution") }).toEqual({ locale, overrides, label: locale === "en" ? en : zh });
        await act(async () => { view!.unmount(); });
      }
    }
  } finally {
    setLocale("en");
  }
});

test("usage-limited and cap-reached goals explain the stop in both languages and keep Continue available", async () => {
  const handlers = noHandlers();
  try {
    for (const [locale, expected] of [["en", "Paused: the account usage limit was reached. Press Continue after the limit resets."], ["zh", "已暂停：账号额度已用完。额度重置后点击“继续”。"]] as const) {
      setLocale(locale);
      await act(async () => { view = TestRenderer.create(<GoalCard goal={goal({ execution: "usage_limited", stopReason: "usage_limited" })} sessionRunning={false} pending={false} error={null} {...handlers} />); });
      expect(textOf("goal-stop-reason")).toBe(expected);
      expect(byTestId("goal-continue")[0]!.props.disabled).toBe(false);
      await act(async () => { view!.unmount(); });
    }
  } finally {
    setLocale("en");
  }
});

test("accessibility: the card is a labelled region, state changes are announced, controls have names and keyboard focus styles", async () => {
  const handlers = noHandlers();
  await act(async () => { view = TestRenderer.create(<GoalCard goal={goal({ execution: "waiting_user", blockerReason: "Which delimiter?" })} sessionRunning={false} pending={false} error="Could not update" {...handlers} />); });
  const region = byTestId("goal-card")[0]!;
  expect(region.type).toBe("section");
  expect(region.props.role).toBe("region");
  expect(region.props["aria-label"]).toContain("Ship CSV export");
  expect(region.props["aria-label"]).toContain("1 of 2 required criteria done");
  const status = byTestId("goal-execution")[0]!;
  expect(status.props.role).toBe("status");
  expect(status.props["aria-live"]).toBe("polite");
  expect(byTestId("goal-blocker")[0]!.props.role).toBe("status");
  // Every interactive control has an accessible name and a visible keyboard focus style.
  const buttons = view!.root.findAll((node) => node.type === "button");
  expect(buttons.length).toBeGreaterThan(4);
  for (const button of buttons) {
    const name = button.props["aria-label"] ?? button.findAll((node) => typeof node.children?.[0] === "string").map((node) => node.children[0]).join("");
    expect({ name: String(name).length > 0 }).toEqual({ name: true });
    expect(String(button.props.className)).toContain("focus-visible:");
    expect(button.props.type).toBe("button");
  }
  // Errors are announced, and the expand control points at the criteria list it toggles.
  expect(view!.root.findAll((node) => node.props.role === "alert").some((node) => node.children.join("") === "Could not update")).toBe(true);
  const expand = view!.root.findAll((node) => node.type === "button" && node.props["aria-expanded"] === false)[0]!;
  expect(expand.props["aria-controls"]).toBe("goal-criteria-goal_1");
  await act(async () => { expand.props.onClick(); });
  const list = byTestId("goal-criteria")[0]!;
  expect(list.props.id).toBe("goal-criteria-goal_1");
  expect(list.props["aria-label"]).toBe("Success criteria");
  expect(JSON.stringify(view!.toJSON())).toContain("Required");
  expect(JSON.stringify(view!.toJSON())).toContain("Optional");
});

test("responsive: the control row wraps on narrow widths and uses theme tokens only, so light and dark share one markup", async () => {
  const handlers = noHandlers();
  await act(async () => { view = TestRenderer.create(<GoalCard goal={goal({ execution: "waiting_user", stopReason: "no_progress", blockerReason: "x" })} sessionRunning={false} pending={false} error={null} {...handlers} />); });
  const controls = view!.root.findAll((node) => String(node.props.className ?? "").includes("ml-auto"))[0]!;
  expect(String(controls.props.className)).toContain("flex-wrap");
  const markup = JSON.stringify(view!.toJSON());
  // No hard-coded colours: only Radix-style scale tokens that switch with the theme.
  expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(|hsl\(/);
  expect(markup).not.toMatch(/\bbg-(white|black)\b|\btext-(white|black)\b/);
});

test("ordinary composer submissions never read or write goal state: the goal definition only changes through the explicit edit call", async () => {
  const calls: string[] = [];
  const current = goal();
  const client = {
    getSessionGoal: async () => { calls.push("get"); return { item: current }; },
    editSessionGoal: async (_w: string, _s: string, _g: string, body: { objective?: string; criteria?: unknown[] }) => { calls.push(`edit:${JSON.stringify(body)}`); return { item: { ...current, ...body, version: current.version + 1 } }; },
    createSessionGoal: async () => { calls.push("create"); throw new Error("must not create"); },
    updateSessionGoalLifecycle: async () => { calls.push("lifecycle"); throw new Error("must not change lifecycle"); },
    continueSessionGoal: async () => { calls.push("continue"); throw new Error("must not continue"); },
  } as never;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let hook: ReturnType<typeof useSessionGoal> | undefined;
  const Probe = () => { hook = useSessionGoal({ client, workspaceId: "ws", sessionId: "ses", enabled: true }); return null; };
  await act(async () => { view = TestRenderer.create(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(hook!.goal?.objective).toBe("Ship CSV export");

  // A steer, a queued follow-up or an unrelated question goes through the composer submit path, which has no goal calls.
  expect(calls.filter((call) => call !== "get")).toEqual([]);
  // The explicit edit action is the only path that changes objective or criteria, and it sends the expected version.
  await act(async () => { await hook!.edit.mutateAsync({ objective: "Ship CSV export v2" }); });
  expect(calls.filter((call) => call !== "get")).toEqual([`edit:{"expectedVersion":4,"objective":"Ship CSV export v2"}`]);
  expect(queryClient.getQueryData<JuggleWorkSessionGoal>(sessionGoalQueryKey("ws", "ses"))?.objective).toBe("Ship CSV export v2");
});

const placeholderOf = () => {
  const editable = view!.root.findAll((node) => node.props["data-testid"] === "editable-leaf" && typeof node.type === "string")[0];
  return editable?.props["aria-placeholder"] as string | undefined;
};

test("goal mode shows a closable Goal chip and the goal placeholder, like Plan mode", async () => {
  const onCloseGoalMode = mock();
  await act(async () => { view = TestRenderer.create(<ReactSessionComposer {...composerProps({ goalMode: true, onCloseGoalMode })} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const chip = byTestId("composer-goal-mode-control");
  expect(chip).toHaveLength(1);
  expect(chip[0]!.findAll((node) => node.type === "span").map((node) => node.children.join("")).join("")).toContain("Goal");
  expect(placeholderOf()).toBe("Describe your goal, and set measurable expected outcomes for the best results");
  const close = chip[0]!.findAll((node) => node.type === "button")[0]!;
  expect(close.props["aria-label"]).toBe("Exit goal mode");
  await act(async () => { close.props.onClick(); });
  expect(onCloseGoalMode).toHaveBeenCalledTimes(1);
  await act(async () => view?.unmount());

  // Outside goal mode there is no chip and the normal placeholder is used.
  await act(async () => { view = TestRenderer.create(<ReactSessionComposer {...composerProps()} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(byTestId("composer-goal-mode-control")).toHaveLength(0);
  expect(placeholderOf()).toBe("Describe your task...");
});

test("the Goal menu entry is marked selected while goal mode is on", async () => {
  const items = await openPlusMenu(composerProps({ onOpenGoal: mock(), goalMode: true }));
  const goalItem = items[menuLabels(items).indexOf("Goal")]!;
  expect(goalItem.props.className).toContain("bg-gray-3");
  await act(async () => view?.unmount());
  const idle = await openPlusMenu(composerProps({ onOpenGoal: mock(), goalMode: false }));
  const idleGoal = idle[menuLabels(idle).indexOf("Goal")]!;
  expect(idleGoal.props.className).not.toContain("bg-gray-3 text-gray-12");
});

test("the goal icon is drawn as an inline svg that follows the text color and size", async () => {
  const { GoalIcon } = await import("../src/components/icons/goal-icon");
  await act(async () => { view = TestRenderer.create(<GoalIcon size={18} />); });
  const svg = view!.root.findByType("svg");
  expect(svg.props.width).toBe(18);
  expect(svg.props.stroke).toBe("currentColor");
  expect(svg.props["aria-hidden"]).toBe("true");
  // Two rings, a shaft and an arrow head.
  expect(svg.findAllByType("path")).toHaveLength(4);
});

test("goal mode only turns plain text into a goal, and says why when it cannot", () => {
  const ok = { text: "  Ship CSV export; the button downloads a valid CSV  ", attachmentCount: 0, officeGroupCount: 0, sessionRunning: false };
  expect(goalComposerBlock(ok)).toBeNull();
  expect(goalComposerBlock({ ...ok, text: "   \n " })).toBe("empty");
  // Files and Office selections would be lost, so the message stays in the composer.
  expect(goalComposerBlock({ ...ok, attachmentCount: 1 })).toBe("text_only");
  expect(goalComposerBlock({ ...ok, officeGroupCount: 1 })).toBe("text_only");
  expect(goalComposerBlock({ ...ok, text: "x".repeat(GOAL_OBJECTIVE_MAX_CHARS) })).toBeNull();
  expect(goalComposerBlock({ ...ok, text: "x".repeat(GOAL_OBJECTIVE_MAX_CHARS + 1) })).toBe("too_long");
  // A running session cannot also start a goal run.
  expect(goalComposerBlock({ ...ok, sessionRunning: true })).toBe("busy");
  // Empty wins over busy so an empty Enter stays silent.
  expect(goalComposerBlock({ ...ok, text: "", sessionRunning: true })).toBe("empty");
});

test("the client objective limit matches the server limit", async () => {
  const source = await Bun.file(new URL("../../server/src/goal-store.ts", import.meta.url)).text();
  expect(source).toContain(`export const GOAL_OBJECTIVE_MAX_CHARS = ${GOAL_OBJECTIVE_MAX_CHARS.toLocaleString("en-US").replace(/,/g, "_")};`);
});

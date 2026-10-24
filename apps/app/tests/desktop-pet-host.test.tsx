import { afterEach, expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import type { PetAction, PetActionResult, PetSnapshot } from "../src/app/lib/desktop-pet-types";
import type { JuggleWorkSessionSnapshot } from "../src/app/lib/jugglework-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

// TIPS: 保留真实QueryObserver、任务投影和同步写入；仅替换网络入口及不参与本次回归的服务准备。
const sync = { ...await import("../src/react-app/domains/session/sync/session-sync") };
let syncInput: Parameters<typeof sync.ensureWorkspaceSessionSync>[0];
let tracked: string[] = [];
mock.module("../src/react-app/domains/session/sync/session-sync", () => ({
  ...sync,
  ensureWorkspaceSessionSync: (input: typeof syncInput) => {
    syncInput = input;
    return sync.__createWorkspaceSessionSyncForTest(input);
  },
  trackWorkspaceSessionsSync: (input: typeof syncInput, ids: string[]) => {
    tracked = ids;
    return sync.trackWorkspaceSessionsSync(input, ids);
  },
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => () => false, useDesktopAllowedModels: () => [] }));
mock.module("../src/react-app/domains/settings/state/host-marketplace-plugins-provider", () => ({ useHostMarketplacePlugins: () => ({}) }));
mock.module("../src/react-app/domains/connections/use-session-mcp-maintenance", () => ({ useSessionMcpMaintenance: () => ({}) }));
mock.module("../src/react-app/domains/connections/use-cloud-mcp-submit-readiness", () => ({ useCloudMcpSubmitReadiness: () => ({}) }));

const { DesktopPetHost } = await import("../src/react-app/domains/pet/desktop-pet-host");
const query = getReactQueryClient();
const workspaceId = "pet-host-regression";
let renderer: TestRenderer.ReactTestRenderer | undefined;
const savedGlobals = { window: globalThis.window, document: globalThis.document, MutationObserver: globalThis.MutationObserver };
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("live progress during initial loading still hydrates user history without replacing live output", async () => {
  let reads = 0;
  let resolveSnapshot!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pending = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveSnapshot = resolve; });
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", false).session] }),
    listActiveSessionRuns: async () => ({ items: [{ sessionId: "root" }] }),
    getSessionSnapshot: () => { reads++; return pending; },
  });
  await waitFor(() => tracked.includes("root") && reads >= 2);
  await act(async () => {
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "message.updated", properties: { info: { id: "root-answer-2", sessionID: "root", role: "assistant", time: { created: 21 } } } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: { id: "root-result-2", sessionID: "root", messageID: "root-answer-2", type: "text", text: "latest live progress" } } } as never);
    resolveSnapshot({ item: snapshot("root", false) });
  });
  await waitFor(() => host.state()?.syncing === false && host.state()?.tasks[0]?.turnKey === "root-user-2");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "running", progressText: "latest live progress" });
});

test("chat rendering retains live stopped metadata when its shared snapshot is stale", async () => {
  const { deriveRenderedSessionMessages } = await import("../src/react-app/domains/session/surface/session-render-state");
  const { wasTaskStopped } = await import("../src/components/chat/utils");
  let reads = 0;
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", false).session] }),
    listActiveSessionRuns: async () => ({ items: [{ sessionId: "root" }] }),
    getSessionSnapshot: () => ++reads === 1 ? Promise.resolve({ item: snapshot("root", false) }) : new Promise(() => {}),
  });
  await waitFor(() => host.state()?.tasks[0]?.turnKey === "root-user-2");
  const stopped = snapshot("root", true, 3);
  stopped.messages[1]!.info = { ...stopped.messages[1]!.info, error: { name: "MessageAbortedError", data: { message: "User cancelled" } } } as never;
  await act(async () => {
    sync.__applySessionSyncEventForTest(syncInput, { type: "message.updated", properties: { info: stopped.messages[1]!.info } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } as never);
  });
  const cached = query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))!;
  const live = query.getQueryData<import("ai").UIMessage[]>(sync.transcriptKey(workspaceId, "root"))!;
  expect(sync.isSessionSnapshotCurrent(workspaceId, cached)).toBe(false);
  const rendered = deriveRenderedSessionMessages({ transcriptState: live, snapshot: cached, snapshotCurrent: sync.isSessionSnapshotCurrent(workspaceId, cached) });
  expect(wasTaskStopped(rendered, 0)).toBe(true);
  expect(rendered[1]?.metadata).toMatchObject({ opencode: { completed: 22, stopped: true } });
});

test("a delayed send receipt does not restart a turn already completed by live events", async () => {
  let accept!: (value: { outcome: "sent" }) => void;
  let sending = false;
  const receipt = new Promise<{ outcome: "sent" }>((resolve) => { accept = resolve; });
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", true).session] }),
    listActiveSessionRuns: async () => ({ items: [] }),
    getSession: async () => ({ item: snapshot("root", true).session }),
    getSessionSnapshot: async () => ({ item: snapshot("root", true) }),
  }, { selectedSend: async () => { sending = true; return receipt; } });
  await waitFor(() => host.state()?.syncing === false);
  let submission!: Promise<PetActionResult | void>;
  await act(async () => {
    submission = host.dispatch({ type: "send", target: { key: `${workspaceId}:root`, workspaceId, sessionId: "root", title: "root", project: "test" }, text: "quick", draftKey: "__quick__" });
    await pause();
  });
  await waitFor(() => sending);
  await act(async () => {
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "root", status: { type: "busy" } } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } as never);
  });
  expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.root?.runActive).toBe(false);
  await act(async () => { accept({ outcome: "sent" }); await submission; await pause(200); });
  expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.root?.runActive).toBe(false);
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", canStop: false });
});

for (const mutation of ["remove", "revert", "remote-revert"] as const) test(`late snapshots do not refill history after ${mutation}`, async () => {
  let reads = 0;
  let resolveSnapshot!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pending = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveSnapshot = resolve; });
  const original = snapshot("root", false);
  await mountHost({
    listSessions: async () => ({ items: [original.session] }),
    listActiveSessionRuns: async () => ({ items: [{ sessionId: "root" }] }),
    getSessionSnapshot: () => { reads++; return pending; },
  });
  await waitFor(() => tracked.includes("root") && reads >= 2);
  await act(async () => {
    if (mutation !== "remote-revert") sync.__applySessionSyncEventForTest(syncInput, { type: "message.updated", properties: { info: original.messages[0]!.info } } as never);
    if (mutation === "remove") sync.__applySessionSyncEventForTest(syncInput, { type: "message.removed", properties: { sessionID: "root", messageID: "root-user-2" } } as never);
    else if (mutation === "revert") sync.applySessionRevert(workspaceId, { ...original.session, revert: { messageID: "root-user-2" } } as never);
    else {
      sync.__applySessionSyncEventForTest(syncInput, { type: "session.updated", properties: { info: { ...original.session, revert: { messageID: "root-user-2" } } } } as never);
    }
    resolveSnapshot({ item: original });
    await pause(200);
  });
  expect(query.getQueryData<import("ai").UIMessage[]>(sync.transcriptKey(workspaceId, "root")) ?? []).toEqual([]);
});

test("completed task navigation selects its original workspace and session", async () => {
  let done = false;
  const opened: string[][] = [];
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", done, done ? 3 : 2).session] }),
    listActiveSessionRuns: async () => ({ items: done ? [] : [{ sessionId: "root" }] }),
    getSessionSnapshot: async () => ({ item: snapshot("root", done, done ? 3 : 2) }),
  }, { onOpen: (workspace, session) => { opened.push([workspace, session]); } });
  await waitFor(() => host.state()?.tasks[0]?.state === "running");
  await act(async () => { done = true; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.state === "completed");
  await host.dispatch({ type: "open", key: `${workspaceId}:root` });
  expect(opened).toEqual([[workspaceId, "root"]]);
});

afterEach(async () => {
  await act(async () => { renderer?.unmount(); renderer = undefined; });
  query.clear();
  for (const id of ["root", "child"]) useSessionActivityStore.getState().removeSession(workspaceId, id);
  Object.assign(globalThis, savedGlobals);
  tracked = [];
});

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error("宠物宿主回归等待超时");
    await act(async () => { await pause(); });
  }
}

function snapshot(id: string, completed: boolean, updated = 2): JuggleWorkSessionSnapshot {
  const turn = updated >= 4 ? updated : 2;
  return {
    session: { id, title: id, parentID: id === "child" ? "root" : undefined, version: "0", time: { created: 1, updated } },
    status: { type: completed ? "idle" : "busy" }, todos: [],
    messages: [
      { info: { id: `${id}-user-${turn}`, role: "user", sessionID: id, time: { created: turn * 10 } }, parts: [{ id: `${id}-prompt-${turn}`, messageID: `${id}-user-${turn}`, sessionID: id, type: "text", text: "work" }] },
      { info: { id: `${id}-answer-${turn}`, role: "assistant", sessionID: id, ...(completed ? { finish: "stop" } : {}), time: { created: turn * 10 + 1, ...(completed ? { completed: turn * 10 + 2 } : {}) } }, parts: [{ id: `${id}-result-${turn}`, messageID: `${id}-answer-${turn}`, sessionID: id, type: "text", text: completed ? "finished result" : "" }] },
    ],
  } as JuggleWorkSessionSnapshot;
}

async function mountHost(client: object, propsOverride: Partial<React.ComponentProps<typeof DesktopPetHost>> = {}, initialInteraction?: PetSnapshot["interaction"]) {
  let published: Omit<PetSnapshot, "visible"> | undefined;
  let action: (action: PetAction) => Promise<PetActionResult | void>;
  const initial: PetSnapshot = { interaction: initialInteraction, visible: true, ready: true, syncing: false, partial: false, tasks: [], locale: "zh", theme: "light", editing: false, voicePhase: "idle" };
  const bridge = { getState: async () => initial, onState: () => () => {}, publish: (value: typeof published) => { published = value; }, onAction: (callback: typeof action) => { action = callback; return () => {}; } };
  Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), { __JUGGLEWORK_ELECTRON__: { pet: bridge } }),
    document: Object.assign(new EventTarget(), { documentElement: { classList: { contains: () => false }, dataset: {} }, hasFocus: () => false, querySelector: () => null }),
    MutationObserver: class { observe() {} disconnect() {} },
  });
  const workspace = { id: workspaceId, path: "/isolated", name: "test", workspaceType: "local" };
  const endpoint = { workspaceId, client, opencodeBaseUrl: "http://127.0.0.1:1", token: "isolated-test" };
  await act(async () => {
    renderer = TestRenderer.create(<DesktopPetHost {...{
      workspaces: [workspace], endpointForWorkspace: () => endpoint, contextKey: "test", coordinatorIds: {},
      selectedWorkspaceId: workspaceId, selectedSend: null, defaultModel: null, defaultVariant: null,
      reloadBusy: false, cloudSignedIn: false, cloudAuthStatus: "signed_out", onOpen: () => {}, onOpenApp: () => {},
    ...propsOverride,
    } as React.ComponentProps<typeof DesktopPetHost>} />);
  });
  return { state: () => published, refresh: () => action!({ type: "sessions" }), dispatch: (value: PetAction) => action!(value) };
}

test("late pet snapshots and cached replay preserve newer live todo updates", async () => {
  let resolveSnapshot!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pending = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveSnapshot = resolve; });
  let reads = 0, running = true;
  const stale = snapshot("root", false, 1);
  stale.todos = [{ id: "old", content: "old progress", status: "pending", priority: "low" }];
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", false, 2).session] }),
    listActiveSessionRuns: async () => ({ items: running ? [{ sessionId: "root" }] : [] }),
    getSessionSnapshot: () => { reads++; return pending; },
  });
  await waitFor(() => tracked.includes("root") && reads >= 2);
  await act(async () => {
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "child", status: { type: "busy" } } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "todo.updated", properties: { sessionID: "root", todos: [{ id: "live", content: "new progress", status: "in_progress", priority: "high" }] } } as never);
    resolveSnapshot({ item: stale });
    await pause();
  });
  await waitFor(() => host.state()?.syncing === false && Boolean(host.state()?.tasks.length));
  expect(query.getQueryData(sync.todoKey(workspaceId, "root"))).toMatchObject([{ id: "live", content: "new progress" }]);
  expect(host.state()?.tasks[0]?.progressText).toBe("new progress");
  expect(host.state()?.tasks[0]?.turnKey).toBe("root-user-2");

  const cached = { ...stale, session: { ...stale.session, time: { created: 1, updated: 2 } } };
  await act(async () => {
    query.setQueryData(sync.snapshotKey(workspaceId, "root"), cached);
    running = false;
    await host.refresh();
    await pause();
  });
  expect(query.getQueryData(sync.todoKey(workspaceId, "root"))).toMatchObject([{ id: "live", content: "new progress" }]);
});

test("completed roots release transcript and descendant observers while reminders survive cache eviction and restart", async () => {
  let completed = false, updated = 2;
  const host = await mountHost({
    listSessions: async () => ({ items: ["root", "child"].map((id) => snapshot(id, completed, updated).session) }),
    listActiveSessionRuns: async () => ({ items: completed ? [] : [{ sessionId: "root" }, { sessionId: "child" }] }),
    getSessionSnapshot: async (_workspace: string, id: string) => ({ item: snapshot(id, completed, updated) }),
  });
  await waitFor(() => tracked.includes("child") && host.state()?.tasks[0]?.state === "running");
  expect(query.getQueryCache().find({ queryKey: sync.transcriptKey(workspaceId, "root") })?.getObserversCount()).toBeGreaterThan(0);
  await act(async () => { completed = true; updated = 3; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.state === "completed" && tracked.length === 0);
  for (const id of ["root", "child"]) {
    expect(query.getQueryCache().find({ queryKey: sync.transcriptKey(workspaceId, id) })?.getObserversCount()).toBe(0);
    expect(query.getQueryCache().find({ queryKey: sync.snapshotKey(workspaceId, id) })?.getObserversCount()).toBe(0);
  }
  await act(async () => {
    for (const id of ["root", "child"]) query.removeQueries({ queryKey: sync.transcriptKey(workspaceId, id), exact: true });
    await pause(200);
  });
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", turnKey: "root-user-2", progressText: "finished result" });
  expect(tracked).toEqual([]);
  await act(async () => { completed = false; updated = 4; await host.refresh(); });
  await waitFor(() => tracked.includes("root") && host.state()?.tasks[0]?.turnKey === "root-user-4");
  expect(host.state()?.tasks[0]?.state).toBe("running");
});

for (const outcome of ["stopped", "error"] as const) test(`an idle root retains its current ${outcome} child and excludes that outcome from the next turn`, async () => {
  let childEnded = false, rootTurn = 2;
  const childSnapshot = () => {
    const item = snapshot("child", childEnded, childEnded ? 3 : 2);
    if (childEnded) {
      item.messages[1]!.info = { ...item.messages[1]!.info, finish: outcome === "stopped" ? "stop" : "error", error: { name: outcome === "stopped" ? "MessageAbortedError" : "UnknownError", data: { message: outcome } } } as never;
      item.messages[1]!.parts = [];
    }
    return item;
  };
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", true, rootTurn).session, childSnapshot().session] }),
    listActiveSessionRuns: async () => ({ items: childEnded ? [] : [{ sessionId: "child" }] }),
    getSessionSnapshot: async (_workspace: string, id: string) => ({ item: id === "root" ? snapshot("root", true, rootTurn) : childSnapshot() }),
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "running");
  await act(async () => { childEnded = true; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.state !== "running");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "resumable", stopped: outcome === "stopped", turnKey: "root-user-2", canStop: false });
  expect(tracked).toContain("child");

  await act(async () => { rootTurn = 4; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.turnKey === "root-user-4");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", stopped: false });
  expect(tracked).toEqual([]);
});

for (const outcome of ["stopped", "error"] as const) test(`a late root snapshot retains the current child's confirmed ${outcome} without leaking into a later turn`, async () => {
  let phase = "initial", rootRequested = false;
  let resolveRoot!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pendingRoot = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveRoot = resolve; });
  const rootItem = () => snapshot("root", phase !== "initial", phase === "initial" ? 2 : phase === "old-done" ? 3 : phase === "next-turn" ? 6 : 4);
  const childItem = () => {
    const item = snapshot("child", phase !== "new-running", phase === "initial" || phase === "old-done" ? 2 : 4);
    if (phase === "new-stopped" || phase === "next-turn") {
      item.session.time.updated = 5;
      item.messages[1]!.info = { ...item.messages[1]!.info, error: { name: outcome === "stopped" ? "MessageAbortedError" : "UnknownError", data: { message: outcome } } } as never;
      item.messages[1]!.parts = [];
    }
    return item;
  };
  const host = await mountHost({
    listSessions: async () => ({ items: [rootItem().session, childItem().session] }),
    listActiveSessionRuns: async () => ({ items: phase === "initial" ? [{ sessionId: "root" }] : phase === "new-running" ? [{ sessionId: "child" }] : [] }),
    getSessionSnapshot: async (_workspace: string, id: string) => {
      if (id === "root" && phase.startsWith("new-")) { rootRequested = true; return pendingRoot; }
      return { item: id === "root" ? rootItem() : childItem() };
    },
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "running");
  await act(async () => { phase = "old-done"; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.state === "completed");
  await act(async () => {
    phase = "new-running"; await host.refresh();
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: ["child"] }} />);
  });
  await waitFor(() => rootRequested && host.state()?.tasks[0]?.state === "running" && tracked.includes("child"));
  await act(async () => {
    phase = "new-stopped";
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: [] }} />);
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "resumable");
  await act(async () => { resolveRoot({ item: rootItem() }); });
  await waitFor(() => host.state()?.tasks[0]?.turnKey === "root-user-4");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "resumable", stopped: outcome === "stopped" });

  await act(async () => { phase = "next-turn"; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.turnKey === "root-user-6");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", stopped: false });
});

test("an unrelated historical child read failure does not block current root completion", async () => {
  let done = false;
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", done, done ? 3 : 2).session, snapshot("child", true, 1).session] }),
    listActiveSessionRuns: async () => ({ items: done ? [] : [{ sessionId: "root" }] }),
    getSessionSnapshot: async (_workspace: string, id: string) => {
      if (id === "child") throw new Error("historical child unavailable");
      return { item: snapshot("root", done, done ? 3 : 2) };
    },
  });
  await waitFor(() => host.state()?.syncing === false && Boolean(host.state()?.tasks[0]));
  await act(async () => { done = true; await host.refresh(); });
  await waitFor(() => query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))?.session.time.updated === 3);
  await act(async () => { await pause(200); });
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", canStop: false });
  expect(host.state()?.partial).toBe(true);
  expect(tracked).toEqual([]);
});

for (const failedId of ["root", "child"]) test(`a current ${failedId} read failure still blocks completion until authoritative recovery`, async () => {
  let ended = false, failing = false, failures = 0;
  const childItem = () => {
    const item = snapshot("child", ended, ended ? 3 : 2);
    if (ended) {
      item.messages[1]!.info = { ...item.messages[1]!.info, error: { name: "MessageAbortedError", data: { message: "User cancelled" } } } as never;
      item.messages[1]!.parts = [];
    }
    return item;
  };
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", ended, ended ? 3 : 2).session, childItem().session] }),
    listActiveSessionRuns: async () => ({ items: ended ? [] : [{ sessionId: "root" }, { sessionId: "child" }] }),
    getSessionSnapshot: async (_workspace: string, id: string) => {
      if (failing && id === failedId) { failures++; throw new Error("current task unavailable"); }
      return { item: id === "root" ? snapshot("root", ended, ended ? 3 : 2) : childItem() };
    },
  });
  await waitFor(() => tracked.includes("child") && host.state()?.tasks[0]?.state === "running");
  await act(async () => { ended = true; failing = true; await host.refresh(); });
  await waitFor(() => failures > 0 && host.state()?.tasks[0]?.state === "reconciling");
  expect(tracked).toContain(failedId);
  await act(async () => { failing = false; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.state === "resumable");
  expect(host.state()?.tasks[0]).toMatchObject({ stopped: true, canStop: false });
});

for (const source of ["observer", "discovery"] as const) test(`a late busy ${source} snapshot cannot overwrite a newer completed snapshot or revive its task`, async () => {
  let reads = 0;
  let resolveOld!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pending = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveOld = resolve; });
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", false, 2).session] }),
    listActiveSessionRuns: async () => ({ items: [{ sessionId: "root" }] }),
    getSessionSnapshot: async () => ++reads === 1 ? { item: snapshot("root", false, 2) } : pending,
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "running");
  await act(async () => {
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: ["root"] }} />);
    if (source === "observer") void query.invalidateQueries({ queryKey: sync.snapshotKey(workspaceId, "root"), exact: true });
    else await host.refresh();
  });
  await waitFor(() => reads >= 2);
  const completed = snapshot("root", true, 3);
  await act(async () => {
    query.setQueryData(sync.snapshotKey(workspaceId, "root"), completed);
    sync.seedSessionState(workspaceId, completed);
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: [] }} />);
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "completed");
  await act(async () => { resolveOld({ item: snapshot("root", false, 2) }); await pause(250); });
  expect(host.state()?.tasks[0]).toMatchObject({ state: "completed", canStop: false, progressText: "finished result" });
  expect(query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))).toMatchObject({ session: { time: { updated: 3 } }, status: { type: "idle" } });
  expect(useSessionActivityStore.getState().recordsByWorkspaceId[workspaceId]?.root?.runActive).toBe(false);
});

for (const outcome of ["completed", "stopped"] as const) test(`a live ${outcome} turn survives late busy replies and cache replay, then accepts fresh recovery and a new run`, async () => {
  let reads = 0, ended = false, fresh = false, restarted = false;
  let resolveOld!: (value: { item: JuggleWorkSessionSnapshot }) => void;
  const pending = new Promise<{ item: JuggleWorkSessionSnapshot }>((resolve) => { resolveOld = resolve; });
  const recovered = () => {
    const item = snapshot("root", true, 3);
    if (outcome === "stopped") {
      item.messages[1]!.info = { ...item.messages[1]!.info, error: { name: "MessageAbortedError", data: { message: "User cancelled" } } } as never;
      item.messages[1]!.parts = [];
    }
    return item;
  };
  const host = await mountHost({
    // 元信息版本不变时也须重新读取已失效的缓存，不能永远重放旧busy。
    listSessions: async () => ({ items: [snapshot("root", ended, restarted ? 4 : 2).session] }),
    listActiveSessionRuns: async () => ({ items: ended && !restarted ? [] : [{ sessionId: "root" }] }),
    getSessionSnapshot: async () => ++reads === 1 ? { item: snapshot("root", false, 2) } : restarted ? { item: snapshot("root", false, 4) } : fresh ? { item: recovered() } : pending,
  });
  await waitFor(() => host.state()?.tasks[0]?.state === "running");
  await act(async () => {
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: ["root"] }} />);
    void query.invalidateQueries({ queryKey: sync.snapshotKey(workspaceId, "root"), exact: true });
  });
  await waitFor(() => reads >= 2);
  await act(async () => {
    ended = true;
    const info = recovered().messages[1]!.info;
    sync.__applySessionSyncEventForTest(syncInput, { type: "message.updated", properties: { info } } as never);
    if (outcome === "completed") sync.__applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: recovered().messages[1]!.parts[0] } } as never);
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: "root", status: { type: "idle" } } } as never);
    renderer!.update(<DesktopPetHost {...renderer!.root.props} coordinatorIds={{ [workspaceId]: [] }} />);
  });
  const expectedState = outcome === "completed" ? "completed" : "resumable";
  await waitFor(() => host.state()?.tasks[0]?.state === expectedState);
  await act(async () => { resolveOld({ item: snapshot("root", false, 2) }); await pause(250); });
  const cached = query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))!;
  expect(sync.isSessionSnapshotCurrent(workspaceId, cached)).toBe(false);
  await act(async () => { sync.seedSessionState(workspaceId, cached, { skipTodos: true }); await pause(200); });
  expect(host.state()?.tasks[0]).toMatchObject({ state: expectedState, canStop: false, stopped: outcome === "stopped" });
  await act(async () => {
    sync.__applySessionSyncEventForTest(syncInput, { type: "session.updated", properties: { info: snapshot("root", true, 3).session } } as never);
    const copied = query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))!;
    expect(sync.isSessionSnapshotCurrent(workspaceId, copied)).toBe(false);
    sync.seedSessionState(workspaceId, copied);
    await pause(200);
  });
  expect(host.state()?.tasks[0]?.state).toBe(expectedState);
  await act(async () => { fresh = true; await host.refresh(); });
  await waitFor(() => query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))?.session.time.updated === 3);
  expect(sync.isSessionSnapshotCurrent(workspaceId, query.getQueryData<JuggleWorkSessionSnapshot>(sync.snapshotKey(workspaceId, "root"))!)).toBe(true);
  await act(async () => { restarted = true; await host.refresh(); });
  await waitFor(() => host.state()?.tasks[0]?.turnKey === "root-user-4");
  expect(host.state()?.tasks[0]).toMatchObject({ state: "running", canStop: true });
});

for (const draft of ["", "saved draft"]) test(`voice availability follows ${draft ? "the saved target" : "the latest target"} across projects`, async () => {
  const secondWorkspace = `${workspaceId}-new`;
  const oldTarget = { key: `${workspaceId}:root`, workspaceId, sessionId: "root", title: "old", project: "old" };
  const old = snapshot("root", true, 2), newer = snapshot("root", true, 4);
  let oldProbes = 0, newProbes = 0;
  const clients = {
    [workspaceId]: { listSessions: async () => ({ items: [old.session] }), listActiveSessionRuns: async () => ({ items: [] }), getSessionSnapshot: async () => ({ item: old }), getVoiceRealtimeStatus: async () => { oldProbes++; return { configured: false }; } },
    [secondWorkspace]: { listSessions: async () => ({ items: [newer.session] }), listActiveSessionRuns: async () => ({ items: [] }), getSessionSnapshot: async () => ({ item: newer }), getVoiceRealtimeStatus: async () => { newProbes++; return { configured: true }; } },
  };
  const host = await mountHost(clients[workspaceId], {
    workspaces: [workspaceId, secondWorkspace].map((id) => ({ id, path: `/isolated/${id}`, workspaceType: "local" })),
    endpointForWorkspace: (workspace) => ({ workspaceId: workspace.id, client: clients[workspace.id], opencodeBaseUrl: "http://127.0.0.1:1", token: "isolated-test" }) as ReturnType<React.ComponentProps<typeof DesktopPetHost>["endpointForWorkspace"]>,
  }, { drafts: { __quick__: draft }, targets: {}, dismissed: {}, target: oldTarget });
  await waitFor(() => host.state()?.ready === true && host.state()?.syncing === false && host.state()?.voiceChecking === false);
  expect((await host.dispatch({ type: "latest" }))?.target?.workspaceId).toBe(secondWorkspace);
  expect(host.state()?.voiceAvailable).toBe(!draft);
  expect(draft ? oldProbes : newProbes).toBeGreaterThan(0);
});

test("cancelling while the actual voice target is checked prevents a delayed microphone start", async () => {
  let checking = false, probes = 0, sessions = 0;
  let resolveProbe!: (value: { configured: boolean }) => void;
  const pending = new Promise<{ configured: boolean }>((resolve) => { resolveProbe = resolve; });
  const host = await mountHost({
    listSessions: async () => ({ items: [snapshot("root", true, 2).session] }), listActiveSessionRuns: async () => ({ items: [] }), getSessionSnapshot: async () => ({ item: snapshot("root", true, 2) }),
    getVoiceRealtimeStatus: () => { probes++; return checking ? pending : Promise.resolve({ configured: true }); },
    createVoiceRealtimeSession: async () => { sessions++; throw new Error("must not start"); },
  });
  await waitFor(() => host.state()?.voiceAvailable === true);
  checking = true;
  const before = probes;
  let starting!: Promise<PetActionResult | void>;
  await act(async () => { starting = host.dispatch({ type: "voice-start", target: { key: `${workspaceId}:root`, workspaceId, sessionId: "root", title: "test", project: "test" } }); });
  await waitFor(() => probes > before);
  await act(async () => { await host.dispatch({ type: "voice-cancel" }); resolveProbe({ configured: true }); await starting; });
  expect(sessions).toBe(0);
  expect(host.state()?.voicePhase).toBe("idle");
});

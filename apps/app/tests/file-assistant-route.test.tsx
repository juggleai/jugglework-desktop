import { expect, mock, test } from "bun:test";
import React, { useEffect, useState } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { WorkspaceWire } from "@jugglework/types/workspace";
import { parseWorkspaceAppPath } from "../src/react-app/shell/workspace-routes";
import { toSessionGroups } from "../src/react-app/shell/route-workspaces";
import { buildCommandPaletteSessions } from "../src/react-app/shell/command-palette-sessions";
import { resolveWorkspaceListSelectedId } from "../src/app/lib/desktop";
import { MainOfficeComposerBridge } from "../src/react-app/domains/session/surface/composer/office-composer-bridge";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";

let baseUrl = "";
const noop = () => {};
const subscriptions = new Set<string>();
mock.module("../src/react-app/kernel/local-provider", () => ({ useLocal: () => ({ prefs: { hasCompletedOnboarding: true } }) }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: "signed-out", isSignedIn: false }) }));
mock.module("../src/react-app/shell/boot-state", () => ({ useBootState: () => ({ phase: "ready", routeReady: true, markRouteReady: noop }) }));
mock.module("../src/react-app/shell/jugglework-connection", () => ({ resolveJuggleWorkConnection: async () => ({ normalizedBaseUrl: baseUrl, resolvedToken: "test-only", resolvedHostToken: "", hostInfo: null }) }));
mock.module("../src/react-app/domains/session/sync/session-sync", () => ({ ensureWorkspaceSessionSync: ({ workspaceId }: { workspaceId: string }) => {
  subscriptions.add(workspaceId);
  return () => { subscriptions.delete(workspaceId); };
} }));
const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test.each(["exact", "ordinary", "direct", "only-internal", "missing"])("file assistant route %s keeps exact identity separate from normal selection", async (mode) => {
  const previousWindow = globalThis.window;
  const storage = new Map([["jugglework.react.activeWorkspace", "internal"]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  }) });
  const ordinary: WorkspaceWire = { id: "normal", name: "Normal", path: "/normal", preset: "starter", workspaceType: "local" };
  const internal: WorkspaceWire = { id: "internal", name: "File assistant", path: "/internal", preset: "starter", workspaceType: "local", fileAssistantManaged: true };
  const calls: string[] = [];
  const session = (id: string, directory: string) => ({ id, title: id, directory, time: { created: 1, updated: 1 } });
  const server = Bun.serve({ port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname; calls.push(path);
    // A mixed-version server/desktop may still leak the marked entry into lists.
    if (path === "/workspaces") return Response.json({ items: mode === "only-internal" ? [internal] : mode === "ordinary" || mode === "direct" ? [internal, ordinary] : [ordinary], activeId: "internal" });
    if (path === "/w/internal/workspaces") return mode === "missing" ? Response.json({ code: "workspace_not_found", message: "missing" }, { status: 404 }) : Response.json({ items: [internal] });
    if (path.endsWith("/sessions/exact-session")) return Response.json({ item: session("exact-session", "/internal") });
    if (path.endsWith("/sessions")) return Response.json({ items: [session(path.includes("/internal/") ? "another-session" : "normal-session", path.includes("/internal/") ? "/internal" : "/normal")] });
    if (path.endsWith("/activate")) return Response.json({ ok: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: [] });
    throw new Error(`Unexpected route request ${path}`);
  } });
  baseUrl = server.url.href.replace(/\/$/, "");
  let state!: ReturnType<typeof useWorkspaceRouteState>, location!: ReturnType<typeof useLocation>, navigate!: ReturnType<typeof useNavigate>;
  function Probe() {
    location = useLocation(); navigate = useNavigate();
    const route = parseWorkspaceAppPath(location.pathname);
    state = useWorkspaceRouteState({ routeWorkspaceId: route?.view === "session" ? route.workspaceId : "", routeSessionId: route?.view === "session" ? route.sessionId : null, developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
    return null;
  }
  let view: TestRenderer.ReactTestRenderer | undefined;
  const settle = async () => { for (let i = 0; i < 40 && (state.loading || state.selectedWorkspaceIsLoading); i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  try {
    const initialPath = mode === "ordinary" || mode === "only-internal" ? "/session" : `/workspace/internal/session/exact-session${mode === "direct" ? "" : "?exact=1"}`;
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={[initialPath]}><Probe /></MemoryRouter>); });
    await settle();
    if (mode === "ordinary" || mode === "direct") {
      expect(state.selectedWorkspaceId).toBe("normal");
      expect(state.workspaces.map((workspace) => workspace.id)).toEqual(["normal"]);
      expect(location.pathname).toBe("/workspace/normal/session");
      expect(calls).not.toContain("/w/internal/workspaces");
      expect(calls.some((path) => path.startsWith("/workspace/internal/"))).toBe(false);
    } else if (mode === "only-internal") {
      expect(state.selectedWorkspace).toBeNull();
      expect(state.workspaces).toEqual([]);
      expect(location.pathname).toBe("/session");
      expect(calls).toEqual(["/workspaces"]);
    } else {
      expect(location.pathname + location.search).toBe("/workspace/internal/session/exact-session?exact=1");
      expect(state.selectedSessionId).toBe("exact-session");
      expect(calls).toContain("/w/internal/workspaces");
      if (mode === "exact") {
        expect(state.selectedWorkspace?.fileAssistantManaged).toBe(true);
        expect(state.sessionsByWorkspaceId.internal?.some((item) => item.id === "exact-session")).toBe(true);
        expect(storage.get("jugglework.react.activeWorkspace")).toBe("internal");
        expect(JSON.parse(storage.get("jugglework.react.workspaceOrder")!)).toEqual(["normal"]);
        const groups = toSessionGroups(state.workspaces, state.sessionsByWorkspaceId, {}, new Set());
        expect(groups.map((group) => group.workspace.id)).toEqual(["normal"]);
        expect(buildCommandPaletteSessions(state.workspaces, state.sessionsByWorkspaceId, "internal").some((item) => item.workspaceId === "internal")).toBe(false);
        await act(async () => { navigate("/session"); }); await settle();
        expect(state.selectedWorkspaceId).toBe("normal");
        expect(state.selectedSessionId).not.toBe("exact-session");
      } else {
        expect(state.selectedWorkspace).toBeNull();
        expect(state.routeError).toContain("missing");
      }
    }
    expect(resolveWorkspaceListSelectedId({ workspaces: [internal, ordinary], selectedId: "internal", activeId: "internal" })).toBe("normal");
  } finally {
    await act(async () => view?.unmount()); server.stop(true);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test.each(["ordinary", "exact", "retained"])("真实 hook 在 Desktop 唯一分类、Server 缺标记时保持隔离（%s）", async mode => {
  const previousWindow = globalThis.window;
  const storage = new Map([["jugglework.react.activeWorkspace", "internal"]]);
  const normal: WorkspaceWire = { id: "normal", name: "Normal", path: "/normal", preset: "starter", workspaceType: "local" };
  const internal: WorkspaceWire = { id: "internal", name: "File", path: "/internal", preset: "starter", workspaceType: "local", fileAssistantManaged: true };
  const { fileAssistantManaged: _marker, ...staleInternal } = internal;
  const calls: string[] = [];
  let bootstraps = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    __JUGGLEWORK_ELECTRON__: {
      async invokeDesktop(command: string, url: string, init: RequestInit) {
        if (command === "workspaceBootstrap") { bootstraps++; return { workspaces: [internal, normal], activeId: "internal" }; }
        if (command !== "__fetch") throw new Error(`Unexpected desktop command ${command}`);
        const response = await fetch(url, init);
        return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: await response.arrayBuffer() };
      },
    },
  }) });
  const server = Bun.serve({ port: 0, fetch: req => {
    const path = new URL(req.url).pathname; calls.push(path);
    if (path === "/workspaces") return Response.json({ items: [staleInternal, normal], activeId: "internal" });
    if (path.endsWith("/sessions/owner")) return Response.json({ item: { id: "owner", title: "Owner", directory: "/internal", time: { created: 1, updated: 1 } } });
    if (path.endsWith("/sessions")) return Response.json({ items: [{ id: "listed", title: "Listed", directory: path.includes("/internal/") ? "/internal" : "/normal", time: { created: 1, updated: 1 } }] });
    if (path.endsWith("/activate")) return Response.json({ ok: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: [] });
    throw new Error(`Unexpected route request ${path}`);
  } });
  baseUrl = server.url.href.replace(/\/$/, "");
  let state!: ReturnType<typeof useWorkspaceRouteState>, location!: ReturnType<typeof useLocation>, navigate!: ReturnType<typeof useNavigate>;
  let mounts = 0;
  function Probe() {
    location = useLocation(); navigate = useNavigate();
    const route = parseWorkspaceAppPath(location.pathname);
    // 与 shell 相同：其他页面可见时仍把上一个 session target 交给常驻 hook。
    const [retained, setRetained] = useState({ workspaceId: "internal", sessionId: "owner" as string | null });
    const target = route?.view === "session" ? route : retained;
    useEffect(() => { mounts++; }, []);
    useEffect(() => { if (route?.view === "session") setRetained({ workspaceId: route.workspaceId, sessionId: route.sessionId }); }, [location.pathname]);
    state = useWorkspaceRouteState({ routeWorkspaceId: target.workspaceId, routeSessionId: target.sessionId, developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
    return null;
  }
  let view: TestRenderer.ReactTestRenderer | undefined;
  const settle = async () => {
    for (let i = 0; i < 80; i++) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
      if (!state.loading && !state.selectedWorkspaceIsLoading) break;
    }
    expect(state.loading).toBe(false);
    expect(state.selectedWorkspaceIsLoading).toBe(false);
  };
  const exactPath = "/workspace/internal/session/owner?exact=1";
  try {
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={[mode === "ordinary" ? "/session" : exactPath]}><Probe /></MemoryRouter>); });
    await settle();
    expect(bootstraps).toBeGreaterThan(0);
    expect(toSessionGroups(state.workspaces, state.sessionsByWorkspaceId, {}, new Set()).map(group => group.workspace.id)).toEqual(["normal"]);
    expect(buildCommandPaletteSessions(state.workspaces, state.sessionsByWorkspaceId, "internal").every(item => item.workspaceId !== "internal")).toBe(true);
    if (mode === "ordinary") {
      expect(state.workspaces.map(workspace => workspace.id)).toEqual(["normal"]);
      expect(state.selectedWorkspaceId).toBe("normal");
      expect(location.pathname).toBe("/workspace/normal/session");
      expect(calls.some(path => path.includes("/internal/"))).toBe(false);
    } else {
      expect(location.pathname + location.search).toBe(exactPath);
      expect(state.selectedWorkspace?.fileAssistantManaged).toBe(true);
      expect(state.sessionsByWorkspaceId.internal?.some(session => session.id === "owner")).toBe(true);
      if (mode === "retained") {
        for (const path of ["/workspace/internal/settings/preferences", "/workspace/normal/settings/preferences", "/workspace/internal/chat", "/apps", "/calendar"]) {
          await act(async () => { navigate(path); });
          await settle();
          await act(async () => { window.dispatchEvent(new Event("jugglework-server-settings-changed")); });
          await settle();
          expect(location.pathname + location.search).toBe(path);
          expect(state.routeWorkspaceId).toBe("internal");
          expect(state.selectedSessionId).toBe("owner");
          expect(state.workspaces.map(workspace => workspace.id)).toEqual(["normal"]);
        }
        await act(async () => { navigate(exactPath); }); await settle();
        expect(location.pathname + location.search).toBe(exactPath);
        expect(state.selectedWorkspace?.fileAssistantManaged).toBe(true);
        expect(state.sessionsByWorkspaceId.internal?.some(session => session.id === "owner")).toBe(true);
        // 返回普通 session 路由时仍由当前匹配的 hook 执行正常 fallback。
        await act(async () => { navigate("/workspace/internal/session/owner"); }); await settle();
        expect(location.pathname).toBe("/workspace/normal/session");
        expect(mounts).toBe(1);
      }
    }
    expect(calls).not.toContain("/w/internal/workspaces");
    expect(JSON.parse(storage.get("jugglework.react.workspaceOrder")!)).toEqual(["normal"]);
  } finally {
    await act(async () => view?.unmount()); server.stop(true);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test.each(["internal", "normal"])("真实 Main Office bridge append 精确打开 %s owner；普通导航仍使用正常选择", async target => {
  const previousWindow = globalThis.window;
  const storage = new Map<string, string>();
  let request!: (input: any) => Promise<any>;
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    __JUGGLEWORK_ELECTRON__: {
      office: { onComposerRequest(handler: typeof request) { request = handler; return noop; } },
      async invokeDesktop(command: string, url: string, init: RequestInit) {
        if (command === "workspaceBootstrap") return { workspaces: [], activeId: "normal" };
        if (command !== "__fetch") throw new Error(`Unexpected desktop command ${command}`);
        const response = await fetch(url, init);
        return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: await response.arrayBuffer() };
      },
    },
  }) });
  const normal: WorkspaceWire = { id: "normal", name: "Normal", path: "/normal", preset: "starter", workspaceType: "local" };
  const internal: WorkspaceWire = { id: "internal", name: "File", path: "/internal", preset: "starter", workspaceType: "local", fileAssistantManaged: true };
  const calls: string[] = [];
  const session = (id: string, directory: string) => ({ id, title: id, directory, time: { created: 1, updated: 1 } });
  const server = Bun.serve({ port: 0, fetch: req => {
    const path = new URL(req.url).pathname; calls.push(path);
    if (path === "/workspaces") return Response.json({ items: [normal], activeId: "normal" });
    if (path === "/w/internal/workspaces") return Response.json({ items: [internal] });
    if (path.endsWith("/sessions/owner")) return Response.json({ item: session("owner", `/${target}`) });
    if (path.endsWith("/sessions")) return Response.json({ items: [session("normal-session", path.includes("/internal/") ? "/internal" : "/normal")] });
    if (path.endsWith("/activate")) return Response.json({ ok: true });
    if (path.endsWith("/session-runs")) return Response.json({ items: [] });
    throw new Error(`Unexpected route request ${path}`);
  } });
  baseUrl = server.url.href.replace(/\/$/, "");
  let state!: ReturnType<typeof useWorkspaceRouteState>, location!: ReturnType<typeof useLocation>, navigate!: ReturnType<typeof useNavigate>;
  function Probe() {
    location = useLocation(); navigate = useNavigate();
    const route = parseWorkspaceAppPath(location.pathname);
    state = useWorkspaceRouteState({ routeWorkspaceId: route?.view === "session" ? route.workspaceId : "", routeSessionId: route?.view === "session" ? route.sessionId : null, developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
    return null;
  }
  let view: TestRenderer.ReactTestRenderer | undefined;
  const settle = async () => { for (let i = 0; i < 60; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    if (!state.loading && !state.selectedWorkspaceIsLoading && state.selectedWorkspace &&
      (location.pathname.endsWith("/owner") ? state.sessionsByWorkspaceId[target]?.some(item => item.id === "owner") : true)) break;
  } };
  try {
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={["/workspace/normal/session/normal-session"]}><MainOfficeComposerBridge /><Probe /></MemoryRouter>); });
    await settle();
    const input = { action: "append", workspaceId: target, sessionId: "owner", instructionId: "instruction", epoch: 0, text: "修改选中内容", mode: "add",
      reference: { referenceId: "ref", workspaceId: target, ownerSessionId: "owner", documentId: "doc", preview: { path: "file.docx" } } };
    await act(async () => { expect(await request(input)).toEqual({ ok: true }); });
    await settle();
    expect(location.pathname + location.search).toBe(`/workspace/${target}/session/owner?exact=1`);
    expect(state.selectedWorkspaceId).toBe(target);
    expect(state.selectedSessionId).toBe("owner");
    expect(state.sessionsByWorkspaceId[target]?.some(item => item.id === "owner")).toBe(true);
    expect(useComposerStateStore.getState().sessions.owner?.officeGroups[0].references[0].workspaceId).toBe(target);
    if (target === "internal") expect(calls).toContain("/w/internal/workspaces");
    else expect(calls).not.toContain("/w/internal/workspaces");
    await act(async () => { navigate("/session"); }); await settle();
    expect(state.selectedWorkspaceId).toBe("normal");
    expect(location.search).toBe("");
  } finally {
    await act(async () => view?.unmount()); server.stop(true);
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, officeEpochs: {} });
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

test.each(["fileAssistantManaged", "hidden"] as const)("exact %s 路由与远端后台按 active run 惰性订阅同时成立", async marker => {
  const previousWindow = globalThis.window;
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
  }) });
  const calls: string[] = [];
  let active = true;
  let probeFails = false;
  const remoteServer = Bun.serve({ port: 0, fetch: request => {
    const path = new URL(request.url).pathname; calls.push(`remote:${path}`);
    if (path === "/workspace/idle/sessions" || path === "/workspace/running/sessions") return Response.json({ items: [] });
    if (path === "/workspace/idle/session-runs") return Response.json({ items: [] });
    if (path === "/workspace/running/session-runs") return probeFails
      ? Response.json({ message: "temporary outage" }, { status: 500 })
      : Response.json({ items: active ? [{ sessionId: "remote-task" }] : [] });
    throw new Error(`Unexpected remote request ${path}`);
  } });
  const normal: WorkspaceWire = { id: "normal", name: "Normal", path: "/normal", preset: "starter", workspaceType: "local" };
  const internal: WorkspaceWire = { id: "internal", name: "Internal", path: "/internal", preset: "starter", workspaceType: "local", [marker]: true };
  const remotes: WorkspaceWire[] = ["idle", "running"].map(id => ({
    id: `rem_${id}`, name: id, path: `/${id}`, preset: "starter", workspaceType: "remote", remoteType: "jugglework",
    baseUrl: remoteServer.url.href.replace(/\/$/, ""), juggleworkWorkspaceId: id,
  }));
  const server = Bun.serve({ port: 0, fetch: request => {
    const path = new URL(request.url).pathname; calls.push(`local:${path}`);
    if (path === "/workspaces") return Response.json({ items: [normal, internal, ...remotes], activeId: "normal" });
    if (path === "/workspace/internal/sessions/owner") return Response.json({ item: { id: "owner", title: "Owner", directory: "/internal", time: { created: 1, updated: 1 } } });
    if (path === "/workspace/internal/sessions" || path === "/workspace/normal/sessions") return Response.json({ items: [] });
    if (path === "/workspace/normal/session-runs") return Response.json({ items: [] });
    throw new Error(`Unexpected local request ${path}`);
  } });
  baseUrl = server.url.href.replace(/\/$/, "");
  let state!: ReturnType<typeof useWorkspaceRouteState>, location!: ReturnType<typeof useLocation>, navigate!: ReturnType<typeof useNavigate>;
  function Probe() {
    location = useLocation(); navigate = useNavigate();
    const route = parseWorkspaceAppPath(location.pathname);
    state = useWorkspaceRouteState({ routeWorkspaceId: route?.workspaceId ?? "", routeSessionId: route?.view === "session" ? route.sessionId : null, developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
    return null;
  }
  const settle = async (ready: () => boolean) => {
    // 三个后台候选会跨过真实的 500ms 分批间隔。
    for (let i = 0; i < 240 && !ready(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(ready()).toBe(true);
  };
  let view: TestRenderer.ReactTestRenderer | undefined;
  try {
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={["/workspace/internal/session/owner?exact=1"]}><Probe /></MemoryRouter>); });
    await settle(() => !state.loading && !state.selectedWorkspaceIsLoading && subscriptions.has("running") && state.sessionsByWorkspaceId.internal?.some(item => item.id === "owner") === true);
    expect(location.pathname + location.search).toBe("/workspace/internal/session/owner?exact=1");
    expect([...subscriptions].sort()).toEqual(["internal", "running"]);
    expect(calls).toContain("remote:/workspace/idle/session-runs");
    expect(calls).toContain("remote:/workspace/running/session-runs");
    expect(calls.some(path => path.startsWith("local:/workspace/rem_"))).toBe(false);
    expect(calls).not.toContain("local:/workspace/internal/session-runs");
    expect(toSessionGroups(state.workspaces, {}, {}, new Set()).map(group => group.workspace.id)).toEqual(["normal", "rem_idle", "rem_running"]);
    expect(storage.get("jugglework.react.activeWorkspace")).toBeUndefined();

    // 有限探测失败保留已知运行任务；权威空列表到达后释放其 SSE。
    probeFails = true;
    const beforeFailure = calls.filter(path => path === "remote:/workspace/running/session-runs").length;
    await act(async () => state.setWorkspaces(current => [...current]));
    await settle(() => calls.filter(path => path === "remote:/workspace/running/session-runs").length > beforeFailure);
    expect(subscriptions.has("running")).toBe(true);
    probeFails = false; active = false;
    await act(async () => state.setWorkspaces(current => [...current]));
    await settle(() => !subscriptions.has("running"));
    expect([...subscriptions]).toEqual(["internal"]);

    await act(async () => { navigate("/session"); });
    await settle(() => !state.loading && state.selectedWorkspaceId === "normal" && !state.workspaces.some(workspace => workspace.id === "internal") && subscriptions.has("normal") && !subscriptions.has("internal"));
    expect(location.pathname).toBe("/workspace/normal/session");
    expect([...subscriptions]).toEqual(["normal"]);
    expect(calls).not.toContain("local:/workspace/internal/session-runs");
    expect(storage.get("jugglework.react.activeWorkspace")).toBe("normal");
  } finally {
    await act(async () => view?.unmount());
    server.stop(true); remoteServer.stop(true);
    expect(subscriptions.size).toBe(0);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

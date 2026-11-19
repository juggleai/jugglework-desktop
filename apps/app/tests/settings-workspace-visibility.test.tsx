import { expect, mock, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { WorkspaceWire } from "@jugglework/types/workspace";
import { parseWorkspaceAppPath, sessionSettingsNavigation } from "../src/react-app/shell/workspace-routes";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const noop = () => {};
const unrestricted = () => false;
const local = { prefs: { hasCompletedOnboarding: true }, ui: {}, setUi: noop, setPrefs: noop };
const reload = { markReloadRequired: noop, registerWorkspaceReloadControls: () => noop };
const cloud = { isSignedIn: false, baseUrl: "", activeOrganization: null, client: {} };
let baseUrl = "";
let shell: any, palette: any;

// 保留 SettingsRoute 的真实状态、刷新和路由逻辑，仅替换外围服务及展示组件。
mock.module("../src/react-app/kernel/local-provider", () => ({ useLocal: () => local }));
mock.module("../src/react-app/kernel/platform", () => ({ usePlatform: () => ({ openLink: noop }) }));
mock.module("../src/react-app/shell/boot-state", () => ({ useBootState: () => ({ markRouteReady: noop }) }));
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({ useDenAuth: () => ({ status: "signed-out", isSignedIn: false }) }));
mock.module("../src/react-app/domains/session/sync/session-sync", () => ({ ensureWorkspaceSessionSync: () => noop }));
mock.module("../src/react-app/shell/desktop-local-jugglework", () => ({ ensureDesktopLocalJuggleWorkConnection: async () => false }));
mock.module("../src/react-app/shell/jugglework-connection", () => ({ resolveJuggleWorkConnection: async () => ({ normalizedBaseUrl: baseUrl, resolvedToken: "test-only", resolvedHostToken: "" }) }));
mock.module("../src/react-app/shell/reload-coordinator", () => ({ useReloadCoordinator: () => reload, orgOnboardingVisibilityEvent: "test-onboarding" }));
mock.module("../src/react-app/shell/control/control-provider", () => ({ useControlAction: noop }));
mock.module("../src/react-app/shell/app-navigation-sidebar-preview", () => ({ usePublishAppNavigationPluginItems: noop }));
mock.module("../src/react-app/shell/notifications", () => ({ notifyAlert: noop, notifyEvent: noop, requestOpenMarketplacePlugin: noop, openNotificationCenter: noop, drainPendingMarketplacePlugin: () => null, openNotificationCenterEvent: "test-notifications", openMarketplacePluginEvent: "test-marketplace" }));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({ useCheckDesktopRestriction: () => unrestricted, useDesktopAllowedModels: () => [], useDesktopConfig: () => ({ config: {} }), useOrgRestrictions: () => ({}), useConnectEnabled: () => true, useDesktopRestriction: () => false }));
mock.module("../src/react-app/domains/cloud/restriction-notice-provider", () => ({ useRestrictionNotice: () => ({ show: noop }) }));
mock.module("../src/react-app/domains/cloud/use-cloud-provider-auto-sync", () => ({ useCloudProviderAutoSync: noop }));
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({ useCloudSession: () => cloud }));
mock.module("../src/react-app/domains/settings/cloud/use-den-session", () => ({ useDenSession: () => ({}) }));
mock.module("../src/react-app/domains/settings/state/debug-view-model", () => ({ useDebugViewModel: () => ({}) }));
mock.module("../src/react-app/domains/settings/state/electron-updater-state", () => ({ useElectronUpdaterState: () => ({}) }));
mock.module("../src/react-app/domains/settings/state/global-compaction-preference", () => ({ readGlobalAutoCompaction: async () => true, writeGlobalAutoCompaction: noop }));
mock.module("../src/react-app/domains/settings/state/host-marketplace-plugins-provider", () => ({ useHostMarketplacePlugins: () => ({ snapshot: {} }) }));
mock.module("../src/react-app/domains/settings/settings-extension-controller", () => ({ useSettingsExtensionController: () => ({ isConnected: () => false }) }));
mock.module("../src/react-app/domains/connections/use-org-mcp-connections", () => ({ useOrgMcpConnections: () => ({ connections: [], refresh: noop }) }));
mock.module("../src/react-app/domains/connections/use-workspace-mcp-policy", () => ({ useWorkspaceMcpPolicy: () => ({ refresh: noop }) }));
mock.module("../src/react-app/domains/connections/use-workspace-mcp-tool-policy", () => ({ useWorkspaceMcpToolPolicy: () => ({}) }));
mock.module("../src/react-app/domains/connections/use-workspace-skill-policy", () => ({ useWorkspaceSkillPolicy: () => ({}) }));
mock.module("../src/react-app/domains/connections/use-workspace-plugin-policy", () => ({ useWorkspacePluginPolicy: () => ({}) }));
mock.module("../src/react-app/domains/session/modals/use-model-picker", () => ({ useModelPicker: () => ({ open: false, options: [], query: "" }) }));
mock.module("../src/react-app/domains/settings/shell/settings-shell", () => ({ SettingsShell: (props: any) => { shell = props; return null; } }));
mock.module("../src/react-app/shell/command-palette", () => ({ CommandPalette: (props: any) => { palette = props; return null; } }));

// Store 的真实快照契约仍然使用原实现；不启动与工作区列表无关的后台同步。
const serverStore = await import("../src/react-app/domains/connections/jugglework-server-store");
const connections = await import("../src/react-app/domains/connections/store");
const providers = await import("../src/react-app/domains/connections/provider-auth/store");
const extensions = await import("../src/react-app/domains/settings/state/extensions-store");
const { createJuggleWorkServerStore } = serverStore;
const { createConnectionsStore } = connections;
const { createProviderAuthStore } = providers;
const { createExtensionsStore } = extensions;
mock.module("../src/react-app/domains/connections/jugglework-server-store", () => ({ ...serverStore, createJuggleWorkServerStore: (...args: Parameters<typeof createJuggleWorkServerStore>) => ({ ...createJuggleWorkServerStore(...args), start: noop, syncFromOptions: noop }) }));
mock.module("../src/react-app/domains/connections/store", () => ({ ...connections, createConnectionsStore: (...args: Parameters<typeof createConnectionsStore>) => ({ ...createConnectionsStore(...args), start: noop, syncFromOptions: noop, refreshMcpServers: noop }) }));
mock.module("../src/react-app/domains/connections/provider-auth/store", () => ({ ...providers, createProviderAuthStore: (...args: Parameters<typeof createProviderAuthStore>) => ({ ...createProviderAuthStore(...args), start: noop, syncFromOptions: noop, refreshProviders: noop }) }));
mock.module("../src/react-app/domains/settings/state/extensions-store", () => ({ ...extensions, createExtensionsStore: (...args: Parameters<typeof createExtensionsStore>) => ({ ...createExtensionsStore(...args), start: noop, syncFromOptions: noop }) }));
const { SettingsRoute } = await import("../src/react-app/shell/settings-route");
const { useWorkspaceRouteState } = await import("../src/react-app/shell/use-workspace-route-state");

test.each(["connected", "disconnected", "failed", "retained", "ordinary-return"])("真实 settings 加载先合并 Desktop 分类再过滤（%s）", async mode => {
  const previousWindow = globalThis.window;
  const storage = new Map<string, string>([["jugglework.react.activeWorkspace", "internal"]]);
  const normal: WorkspaceWire = { id: "normal", name: "Normal", path: "/normal", preset: "starter", workspaceType: "local" };
  const internal: WorkspaceWire = { id: "internal", name: "File", path: "/internal", preset: "starter", workspaceType: "local", fileAssistantManaged: true };
  const { fileAssistantManaged: _marker, ...staleInternal } = internal;
  const calls: string[] = [];
  let bootstraps = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    __JUGGLEWORK_ELECTRON__: { async invokeDesktop(command: string, url: string, init: RequestInit) {
      if (command === "workspaceBootstrap") { bootstraps++; return { workspaces: [internal, normal], activeId: "internal" }; }
      if (command === "__setNativeTheme") return;
      if (command !== "__fetch") throw new Error(`Unexpected desktop command ${command}`);
      const response = await fetch(url, init);
      return { status: response.status, statusText: response.statusText, headers: [...response.headers.entries()], body: await response.arrayBuffer() };
    } },
  }) });
  const server = Bun.serve({ port: 0, fetch: req => {
    const path = new URL(req.url).pathname; calls.push(path);
    if (path === "/workspaces") return mode === "failed" ? Response.json({ message: "list unavailable" }, { status: 500 }) : Response.json({ items: [staleInternal, normal], activeId: "internal" });
    if (path.endsWith("/sessions/owner")) return Response.json({ item: { id: "owner", title: "Owner", directory: path.includes("/internal/") ? "/internal" : "/normal", time: { created: 1, updated: 1 } } });
    if (path.endsWith("/sessions")) return Response.json({ items: [{ id: "listed", title: "Listed", directory: path.includes("/internal/") ? "/internal" : "/normal", time: { created: 1, updated: 1 } }] });
    if (path.endsWith("/activate")) return Response.json({ ok: true });
    if (path === "/env/keys") return Response.json({ keys: [] });
    if (path === "/experimental/google-workspace/status") return Response.json({ connected: false });
    throw new Error(`Unexpected route request ${path}`);
  } });
  baseUrl = mode === "disconnected" ? "" : server.url.href.replace(/\/$/, "");
  let location!: ReturnType<typeof useLocation>;
  let navigate!: ReturnType<typeof useNavigate>;
  let openSettings!: () => void;
  let state: ReturnType<typeof useWorkspaceRouteState> | undefined;
  const returning = mode === "retained" || mode === "ordinary-return";
  const sourceWorkspaceId = mode === "retained" ? "internal" : "normal";
  function Probe() { location = useLocation(); return <SettingsRoute active workspaceId={parseWorkspaceAppPath(location.pathname)?.workspaceId ?? undefined} />; }
  function RetainedProbe() {
    location = useLocation(); navigate = useNavigate();
    const route = parseWorkspaceAppPath(location.pathname);
    state = useWorkspaceRouteState({ routeWorkspaceId: sourceWorkspaceId, routeSessionId: "owner", developerMode: false, onServerSettingsChanged: noop, onHostInfo: noop });
    openSettings = () => {
      const { to, state: navigationState } = sessionSettingsNavigation(location, sourceWorkspaceId, "owner");
      navigate(to, { state: navigationState });
    };
    return <SettingsRoute active={route?.view === "settings"} workspaceId={route?.view === "settings" ? route.workspaceId ?? undefined : "normal"} routePath={route?.view === "settings" ? location.pathname : "/workspace/normal/settings/preferences"} />;
  }
  const settle = async () => {
    for (let i = 0; i < 80 && (bootstraps === 0 || !shell || shell.busyHint || state?.loading || state?.selectedWorkspaceIsLoading); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); });
    expect(shell.busyHint).toBeNull();
    if (state) { expect(state.loading).toBe(false); expect(state.selectedWorkspaceIsLoading).toBe(false); }
  };
  let view: TestRenderer.ReactTestRenderer | undefined;
  shell = palette = undefined;
  try {
    const returnPath = `/workspace/${sourceWorkspaceId}/session/owner${mode === "retained" ? "?exact=1" : ""}`;
    const sourcePath = returnPath + (mode === "retained" ? "&documentId=private&preview=1" : "");
    await act(async () => { view = TestRenderer.create(<MemoryRouter initialEntries={[returning ? sourcePath : "/workspace/normal/settings/preferences"]}>{returning ? <RetainedProbe /> : <Probe />}</MemoryRouter>); });
    await settle();
    if (returning) {
      const settingsPath = `/workspace/${sourceWorkspaceId}/settings/preferences`;
      const assertRestored = (path: string) => {
        expect(location.pathname + location.search).toBe(path);
        expect(state?.selectedWorkspaceId).toBe(sourceWorkspaceId);
        expect(state?.selectedSessionId).toBe("owner");
        expect(state?.selectedWorkspace?.fileAssistantManaged).toBe(mode === "retained" ? true : undefined);
        expect(state?.sessionsByWorkspaceId[sourceWorkspaceId]?.some(session => session.id === "owner")).toBe(true);
      };
      assertRestored(sourcePath);
      await act(async () => { openSettings(); }); await settle();
      expect(location.pathname + location.search).toBe(settingsPath);
      expect(location.state).toEqual({ workspaceId: sourceWorkspaceId, sessionId: "owner", returnPath });
      await act(async () => { window.dispatchEvent(new Event("jugglework-server-settings-changed")); }); await settle();
      expect(location.pathname + location.search).toBe(settingsPath);
      expect(shell.workspaces.map((workspace: any) => workspace.id)).toEqual(["normal"]);
      expect(palette.sessions.every((session: any) => session.workspaceId !== "internal")).toBe(true);
      expect(state?.workspaces.map(workspace => workspace.id)).toEqual(["normal"]);
      expect(state?.selectedSessionId).toBe("owner");
      // 真正消费入口 helper 生成的 navigation state，由 SettingsRoute 原 onClose 协议返回。
      await act(async () => { shell.onClose(); }); await settle();
      assertRestored(returnPath);
      // Close 保持 push 历史协议：后退回设置，再后退回原始 source URL。
      await act(async () => { navigate(-1); }); await settle();
      expect(location.pathname + location.search).toBe(settingsPath);
      expect(location.state.returnPath).toBe(returnPath);
      await act(async () => { navigate(-1); }); await settle();
      assertRestored(sourcePath);
    }
    expect(bootstraps).toBeGreaterThan(0);
    expect(shell.busyHint).toBeNull();
    expect(shell.workspaces.map((workspace: any) => workspace.id)).toEqual(["normal"]);
    expect(shell.selectedWorkspaceId).toBe("normal");
    expect(palette.sessions.every((session: any) => session.workspaceId !== "internal")).toBe(true);
    if (!returning) {
      expect(location.pathname + location.search).toBe("/workspace/normal/settings/preferences");
      expect(calls.some(path => path.includes("/internal/"))).toBe(false);
    }
    expect(storage.get("jugglework.react.activeWorkspace")).toBe("normal");
  } finally {
    await act(async () => view?.unmount()); server.stop(true);
    if (previousWindow === undefined) Reflect.deleteProperty(globalThis, "window"); else Reflect.set(globalThis, "window", previousWindow);
  }
});

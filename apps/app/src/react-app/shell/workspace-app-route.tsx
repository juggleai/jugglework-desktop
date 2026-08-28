/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { AppsPage } from "./apps-page";
import { ChatPage } from "./chat-page";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";
import { AutomationPage } from "../domains/automations/automation-page";
import { readActiveWorkspaceId, readLastSessionFor } from "./session-memory";
import {
  WorkspaceShellActionsProvider,
  useWorkspaceShellActions,
} from "./workspace-shell-actions";
import {
  legacySessionRoute,
  parseWorkspaceAppPath,
  workspaceAppsRoute,
  workspaceChatRoute,
  workspaceSessionRoute,
  workspaceSettingsRoute,
} from "./workspace-routes";

type RetainedSessionTarget = {
  workspaceId: string;
  sessionId: string | null;
};

function readNavigationValue(state: unknown, key: "workspaceId" | "sessionId"): string | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() || null : null;
}

function initialSessionTarget(pathname: string, navigationState: unknown): RetainedSessionTarget {
  const appPath = parseWorkspaceAppPath(pathname);
  if (appPath?.view === "session") {
    return { workspaceId: appPath.workspaceId, sessionId: appPath.sessionId };
  }

  const navigationWorkspaceId = readNavigationValue(navigationState, "workspaceId");
  const navigationSessionId = readNavigationValue(navigationState, "sessionId");
  const workspaceId = appPath?.workspaceId
    ? appPath.workspaceId
    : navigationWorkspaceId ?? readActiveWorkspaceId() ?? "";
  const sessionId = workspaceId && workspaceId === navigationWorkspaceId
    ? navigationSessionId ?? readLastSessionFor(workspaceId)
    : readLastSessionFor(workspaceId);
  return { workspaceId, sessionId };
}

/**
 * Keeps the task workspace mounted while full-page app surfaces such as
 * Settings are visible. Route changes therefore switch visible surfaces
 * without reconnecting the active session, refetching its transcript, or
 * resetting transient composer/model state.
 */
function WorkspaceAppRouteContent() {
  const location = useLocation();
  const navigate = useNavigate();
  const workspaceShellActions = useWorkspaceShellActions();
  const appPath = useMemo(
    () => parseWorkspaceAppPath(location.pathname),
    [location.pathname],
  );
  const [retainedSession, setRetainedSession] = useState<RetainedSessionTarget>(() => (
    initialSessionTarget(location.pathname, location.state)
  ));
  const [retainedSettings, setRetainedSettings] = useState(() => {
    const initial = initialSessionTarget(location.pathname, location.state);
    const initialPath = parseWorkspaceAppPath(location.pathname);
    const workspaceId = initialPath?.view === "settings"
      ? initialPath.workspaceId
      : initial.workspaceId || null;
    return {
      workspaceId,
      routePath: initialPath?.view === "settings"
        ? location.pathname
        : workspaceId
          ? workspaceSettingsRoute(workspaceId, "preferences")
          : "/settings/preferences",
    };
  });
  const [appsMounted, setAppsMounted] = useState(() => appPath?.view === "apps");

  const currentSession = appPath?.view === "session"
    ? { workspaceId: appPath.workspaceId, sessionId: appPath.sessionId }
    : null;
  const settingsWorkspaceId = appPath?.view === "settings" ? appPath.workspaceId : null;
  const chatWorkspaceId = appPath?.view === "chat" ? appPath.workspaceId : null;
  const appsWorkspaceId = appPath?.view === "apps" ? appPath.workspaceId : null;
  const surfaceWorkspaceId = settingsWorkspaceId ?? chatWorkspaceId ?? appsWorkspaceId;

  useEffect(() => {
    const next = currentSession ?? (
      surfaceWorkspaceId && surfaceWorkspaceId !== retainedSession.workspaceId
        ? {
            workspaceId: surfaceWorkspaceId,
            sessionId: readLastSessionFor(surfaceWorkspaceId),
          }
        : null
    );
    if (!next) return;
    setRetainedSession((current) => (
      current.workspaceId === next.workspaceId && current.sessionId === next.sessionId
        ? current
        : next
    ));
  }, [currentSession?.sessionId, currentSession?.workspaceId, retainedSession.workspaceId, surfaceWorkspaceId]);

  useEffect(() => {
    if (appPath?.view === "apps") setAppsMounted(true);
  }, [appPath?.view]);

  useEffect(() => {
    if (appPath?.view !== "settings") return;
    setRetainedSettings((current) => (
      current.workspaceId === appPath.workspaceId && current.routePath === location.pathname
        ? current
        : { workspaceId: appPath.workspaceId, routePath: location.pathname }
    ));
  }, [appPath, location.pathname]);

  if (!appPath) {
    return <Navigate to="/session" replace />;
  }

  const activeSession = currentSession ?? retainedSession;
  const settingsVisible = appPath.view === "settings";
  const chatVisible = appPath.view === "chat";
  const appsVisible = appPath.view === "apps";
  const automationsVisible = appPath.view === "automations";
  const sessionPath = activeSession.workspaceId
    ? workspaceSessionRoute(activeSession.workspaceId, activeSession.sessionId)
    : legacySessionRoute(activeSession.sessionId);

  const openSurfaceSettings = (
    tab: "cloud-account" | "preferences",
    returnPath: string,
  ) => {
    const target = activeSession.workspaceId
      ? workspaceSettingsRoute(activeSession.workspaceId, tab)
      : `/settings/${tab}`;
    navigate(target, {
      state: {
        workspaceId: activeSession.workspaceId || null,
        sessionId: activeSession.sessionId,
        returnPath,
      },
    });
  };

  return (
    <div className="relative h-dvh min-h-screen w-full overflow-hidden">
      <div
        className={settingsVisible || chatVisible || appsVisible || automationsVisible ? "hidden" : "h-full min-h-0"}
        aria-hidden={settingsVisible || chatVisible || appsVisible || automationsVisible || undefined}
        data-testid="retained-session-surface"
      >
        <SessionRoute
          routeWorkspaceId={activeSession.workspaceId}
          routeSessionId={activeSession.sessionId}
        />
      </div>

      {/*
        TIPS: 隐藏态必须用 display:none，不能用 visibility:hidden。
        设置页（尤其是「扩展」这类长页面）一旦滚动过，其滚动容器会被提升为独立合成层；
        visibility:hidden 只是让它不可见，布局盒与合成层仍然保留，并且它是绝对定位、盖在
        会话面板之上的。切回本地工作区时旧图层来不及失效，就会在工作区页面上残留「扩展」
        页的内容。display:none 直接把它移出布局与合成，切换一帧到位。
        组件本身仍然挂载（React 状态、路由解析、请求都不丢），只是不参与排版。
      */}
      <div
        className={settingsVisible ? "absolute inset-0 z-10 bg-background" : "hidden"}
        aria-hidden={!settingsVisible || undefined}
        data-testid="workspace-settings-surface"
      >
        <SettingsRoute
          active={settingsVisible}
          workspaceId={(settingsVisible ? appPath.workspaceId : retainedSettings.workspaceId) ?? undefined}
          routePath={settingsVisible ? location.pathname : retainedSettings.routePath}
        />
      </div>

      {/* Keep Chat mounted from startup so the React runtime initializes the IM
          SDK and desktop skill bridge before the user first opens the surface. */}
      <div
        className={chatVisible
          ? "visible absolute inset-0 z-10 bg-background"
          : "invisible pointer-events-none absolute inset-0 z-0 bg-background"}
        aria-hidden={!chatVisible || undefined}
        data-testid="workspace-chat-surface"
      >
        <ChatPage
          onOpenAccount={() => openSurfaceSettings("cloud-account", workspaceChatRoute(activeSession.workspaceId))}
          onOpenHome={() => navigate(sessionPath)}
          onOpenApps={() => navigate(workspaceAppsRoute(activeSession.workspaceId))}
          onToggleChat={() => navigate(sessionPath)}
          onOpenSettings={() => openSurfaceSettings("preferences", workspaceChatRoute(activeSession.workspaceId))}
          onOpenTaskSearch={workspaceShellActions.openTaskSearch}
          onOpenCreateWorkspace={workspaceShellActions.openCreateWorkspace}
        />
      </div>

      {appsMounted || appsVisible ? (
        <div
          className={appsVisible ? "absolute inset-0" : "hidden"}
          aria-hidden={!appsVisible || undefined}
          data-testid="workspace-apps-surface"
        >
          <AppsPage
            workspaceId={activeSession.workspaceId}
            onOpenAccount={() => openSurfaceSettings("cloud-account", workspaceAppsRoute(activeSession.workspaceId))}
            onOpenHome={() => navigate(sessionPath)}
            onOpenChat={() => navigate(workspaceChatRoute(activeSession.workspaceId))}
            onOpenSettings={() => openSurfaceSettings("preferences", workspaceAppsRoute(activeSession.workspaceId))}
            onOpenTaskSearch={workspaceShellActions.openTaskSearch}
            onOpenCreateWorkspace={workspaceShellActions.openCreateWorkspace}
          />
        </div>
      ) : null}

      {automationsVisible ? (
        <div className="absolute inset-0" data-testid="workspace-automations-surface">
          <AutomationPage
            sessionPath={sessionPath}
            onOpenAccount={() => openSurfaceSettings("cloud-account", location.pathname)}
            onOpenApps={() => navigate(workspaceAppsRoute(activeSession.workspaceId))}
            onOpenChat={() => navigate(workspaceChatRoute(activeSession.workspaceId))}
            onOpenSettings={() => openSurfaceSettings("preferences", location.pathname)}
            onOpenTaskSearch={workspaceShellActions.openTaskSearch}
            onOpenCreateWorkspace={workspaceShellActions.openCreateWorkspace}
          />
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceAppRoute() {
  return (
    <WorkspaceShellActionsProvider>
      <WorkspaceAppRouteContent />
    </WorkspaceShellActionsProvider>
  );
}

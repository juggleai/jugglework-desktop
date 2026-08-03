/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { AppsPage } from "./apps-page";
import { ChatPage } from "./chat-page";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";
import { readActiveWorkspaceId, readLastSessionFor } from "./session-memory";
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
export function WorkspaceAppRoute() {
  const location = useLocation();
  const navigate = useNavigate();
  const appPath = useMemo(
    () => parseWorkspaceAppPath(location.pathname),
    [location.pathname],
  );
  const [retainedSession, setRetainedSession] = useState<RetainedSessionTarget>(() => (
    initialSessionTarget(location.pathname, location.state)
  ));
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

  if (!appPath) {
    return <Navigate to="/session" replace />;
  }

  const activeSession = currentSession ?? retainedSession;
  const settingsVisible = appPath.view === "settings";
  const chatVisible = appPath.view === "chat";
  const appsVisible = appPath.view === "apps";
  const sessionPath = activeSession.workspaceId
    ? workspaceSessionRoute(activeSession.workspaceId, activeSession.sessionId)
    : legacySessionRoute(activeSession.sessionId);

  const openRetainedSessionAction = (testId: string) => {
    navigate(sessionPath);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const selector = `[data-testid="retained-session-surface"] [data-testid="${testId}"]`;
        document.querySelector<HTMLButtonElement>(selector)?.click();
      });
    });
  };

  const openSurfaceSettings = (
    tab: "cloud-account" | "general",
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
        className={settingsVisible || chatVisible || appsVisible ? "hidden" : "h-full min-h-0"}
        aria-hidden={settingsVisible || chatVisible || appsVisible || undefined}
        data-testid="retained-session-surface"
      >
        <SessionRoute
          routeWorkspaceId={activeSession.workspaceId}
          routeSessionId={activeSession.sessionId}
        />
      </div>

      {settingsVisible ? (
        <div className="absolute inset-0" data-testid="workspace-settings-surface">
          <SettingsRoute workspaceId={appPath.workspaceId ?? undefined} />
        </div>
      ) : null}

      {/* Keep Chat mounted from startup so the React runtime initializes the IM
          SDK and desktop skill bridge before the user first opens the surface. */}
      <div
        className={chatVisible ? "absolute inset-0" : "hidden"}
        aria-hidden={!chatVisible || undefined}
        data-testid="workspace-chat-surface"
      >
        <ChatPage
          onOpenAccount={() => openSurfaceSettings("cloud-account", workspaceChatRoute(activeSession.workspaceId))}
          onOpenHome={() => navigate(sessionPath)}
          onOpenApps={() => navigate(workspaceAppsRoute(activeSession.workspaceId))}
          onToggleChat={() => navigate(sessionPath)}
          onOpenSettings={() => openSurfaceSettings("general", workspaceChatRoute(activeSession.workspaceId))}
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
            onOpenSettings={() => openSurfaceSettings("general", workspaceAppsRoute(activeSession.workspaceId))}
          />
        </div>
      ) : null}
    </div>
  );
}

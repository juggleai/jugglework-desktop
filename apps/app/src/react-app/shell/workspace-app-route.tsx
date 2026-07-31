/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { ChatPage } from "./chat-page";
import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";
import { readActiveWorkspaceId, readLastSessionFor } from "./session-memory";
import {
  legacySessionRoute,
  parseWorkspaceAppPath,
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
  const [chatMounted, setChatMounted] = useState(() => appPath?.view === "chat");

  const currentSession = appPath?.view === "session"
    ? { workspaceId: appPath.workspaceId, sessionId: appPath.sessionId }
    : null;
  const settingsWorkspaceId = appPath?.view === "settings" ? appPath.workspaceId : null;
  const chatWorkspaceId = appPath?.view === "chat" ? appPath.workspaceId : null;
  const surfaceWorkspaceId = settingsWorkspaceId ?? chatWorkspaceId;

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
    if (appPath?.view === "chat") setChatMounted(true);
  }, [appPath?.view]);

  if (!appPath) {
    return <Navigate to="/session" replace />;
  }

  const activeSession = currentSession ?? retainedSession;
  const settingsVisible = appPath.view === "settings";
  const chatVisible = appPath.view === "chat";
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

  const openChatSettings = (tab: "cloud-account" | "general") => {
    const target = activeSession.workspaceId
      ? workspaceSettingsRoute(activeSession.workspaceId, tab)
      : `/settings/${tab}`;
    navigate(target, {
      state: {
        workspaceId: activeSession.workspaceId || null,
        sessionId: activeSession.sessionId,
        returnPath: workspaceChatRoute(activeSession.workspaceId),
      },
    });
  };

  return (
    <div className="relative h-dvh min-h-screen w-full overflow-hidden">
      <div
        className={settingsVisible || chatVisible ? "hidden" : "h-full min-h-0"}
        aria-hidden={settingsVisible || chatVisible || undefined}
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

      {chatMounted || chatVisible ? (
        <div
          className={chatVisible ? "absolute inset-0" : "hidden"}
          aria-hidden={!chatVisible || undefined}
          data-testid="workspace-chat-surface"
        >
          <ChatPage
            onOpenAccount={() => openChatSettings("cloud-account")}
            onCreateLocalWorkspace={() => openRetainedSessionAction("app-rail-create-local")}
            onConnectRemoteWorkspace={() => openRetainedSessionAction("app-rail-connect-remote")}
            onToggleChat={() => navigate(sessionPath)}
            onOpenSettings={() => openChatSettings("general")}
          />
        </div>
      ) : null}
    </div>
  );
}

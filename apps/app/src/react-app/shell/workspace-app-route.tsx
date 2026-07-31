/** @jsxImportSource react */
import { useEffect, useMemo, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { SessionRoute } from "./session-route";
import { SettingsRoute } from "./settings-route";
import { readActiveWorkspaceId, readLastSessionFor } from "./session-memory";
import { parseWorkspaceAppPath } from "./workspace-routes";

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
  const workspaceId = appPath?.view === "settings" && appPath.workspaceId
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
  const appPath = useMemo(
    () => parseWorkspaceAppPath(location.pathname),
    [location.pathname],
  );
  const [retainedSession, setRetainedSession] = useState<RetainedSessionTarget>(() => (
    initialSessionTarget(location.pathname, location.state)
  ));

  const currentSession = appPath?.view === "session"
    ? { workspaceId: appPath.workspaceId, sessionId: appPath.sessionId }
    : null;
  const settingsWorkspaceId = appPath?.view === "settings" ? appPath.workspaceId : null;

  useEffect(() => {
    const next = currentSession ?? (
      settingsWorkspaceId && settingsWorkspaceId !== retainedSession.workspaceId
        ? {
            workspaceId: settingsWorkspaceId,
            sessionId: readLastSessionFor(settingsWorkspaceId),
          }
        : null
    );
    if (!next) return;
    setRetainedSession((current) => (
      current.workspaceId === next.workspaceId && current.sessionId === next.sessionId
        ? current
        : next
    ));
  }, [currentSession?.sessionId, currentSession?.workspaceId, retainedSession.workspaceId, settingsWorkspaceId]);

  if (!appPath) {
    return <Navigate to="/session" replace />;
  }

  const activeSession = currentSession ?? retainedSession;
  const settingsVisible = appPath.view === "settings";

  return (
    <div className="relative h-dvh min-h-screen w-full overflow-hidden">
      <div
        className={settingsVisible ? "hidden" : "h-full min-h-0"}
        aria-hidden={settingsVisible || undefined}
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
    </div>
  );
}

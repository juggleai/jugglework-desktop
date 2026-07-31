import type { SettingsTab } from "../../app/types";

export type WorkspaceAppPath =
  | { view: "session"; workspaceId: string; sessionId: string | null }
  | { view: "settings"; workspaceId: string | null }
  | { view: "apps"; workspaceId: string | null }
  | { view: "chat"; workspaceId: string | null }
  | null;

function decodeRoutePart(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

export function parseWorkspaceAppPath(pathname: string): WorkspaceAppPath {
  const modernSession = pathname.match(/^\/workspace\/([^/]+)\/session(?:\/([^/]+))?\/?$/);
  if (modernSession) {
    return {
      view: "session",
      workspaceId: decodeRoutePart(modernSession[1]),
      sessionId: decodeRoutePart(modernSession[2]) || null,
    };
  }

  const legacySession = pathname.match(/^\/session(?:\/([^/]+))?\/?$/);
  if (legacySession) {
    return {
      view: "session",
      workspaceId: "",
      sessionId: decodeRoutePart(legacySession[1]) || null,
    };
  }

  const workspaceSettings = pathname.match(/^\/workspace\/([^/]+)\/settings(?:\/.*)?$/);
  if (workspaceSettings) {
    return {
      view: "settings",
      workspaceId: decodeRoutePart(workspaceSettings[1]) || null,
    };
  }

  if (/^\/settings(?:\/.*)?$/.test(pathname)) {
    return { view: "settings", workspaceId: null };
  }

  const workspaceApps = pathname.match(/^\/workspace\/([^/]+)\/apps\/?$/);
  if (workspaceApps) {
    return {
      view: "apps",
      workspaceId: decodeRoutePart(workspaceApps[1]) || null,
    };
  }

  if (/^\/apps\/?$/.test(pathname)) {
    return { view: "apps", workspaceId: null };
  }

  const workspaceChat = pathname.match(/^\/workspace\/([^/]+)\/chat\/?$/);
  if (workspaceChat) {
    return {
      view: "chat",
      workspaceId: decodeRoutePart(workspaceChat[1]) || null,
    };
  }

  if (/^\/chat\/?$/.test(pathname)) {
    return { view: "chat", workspaceId: null };
  }

  return null;
}

export function workspaceSessionRoute(workspaceId: string, sessionId?: string | null) {
  const workspace = encodeURIComponent(workspaceId.trim());
  const session = sessionId?.trim();
  return session
    ? `/workspace/${workspace}/session/${encodeURIComponent(session)}`
    : `/workspace/${workspace}/session`;
}

export function workspaceChatRoute(workspaceId?: string | null) {
  const workspace = workspaceId?.trim();
  return workspace ? `/workspace/${encodeURIComponent(workspace)}/chat` : "/chat";
}

export function workspaceAppsRoute(workspaceId?: string | null) {
  const workspace = workspaceId?.trim();
  return workspace ? `/workspace/${encodeURIComponent(workspace)}/apps` : "/apps";
}

export function settingsReturnRoute(
  selectedWorkspaceId?: string | null,
  navigationWorkspaceId?: string | null,
  navigationSessionId?: string | null,
  rememberedSessionId?: string | null,
) {
  const workspaceId = selectedWorkspaceId?.trim() ?? "";
  if (!workspaceId) return "/session";

  const originalWorkspaceId = navigationWorkspaceId?.trim() ?? "";
  const sessionId = workspaceId === originalWorkspaceId
    ? navigationSessionId?.trim() || rememberedSessionId?.trim() || null
    : rememberedSessionId?.trim() || null;
  return workspaceSessionRoute(workspaceId, sessionId);
}

export function workspaceSettingsRoute(
  workspaceId: string,
  tab: SettingsTab | "extensions/mcp" | "extensions/plugins" | string = "general",
) {
  return `/workspace/${encodeURIComponent(workspaceId.trim())}/settings/${tab}`;
}

export function globalSettingsRoute(tab: SettingsTab) {
  return `/settings/${tab}`;
}

export function sessionIdForLegacyWorkspaceInference(
  routeWorkspaceId?: string | null,
  routeSessionId?: string | null,
): string | null {
  if (routeWorkspaceId?.trim()) return null;
  const sessionId = routeSessionId?.trim();
  return sessionId || null;
}

export function mergeWorkspaceRouteSession<T extends { id: string }>(sessions: T[], session: T): T[] {
  const index = sessions.findIndex((item) => item.id === session.id);
  if (index < 0) return [session, ...sessions];
  if (sessions[index] === session) return sessions;
  const next = [...sessions];
  next[index] = session;
  return next;
}

export function preserveWorkspaceRouteSession<T extends { id: string }>(
  fetched: T[],
  current: T[],
  sessionId?: string | null,
): T[] {
  const id = sessionId?.trim();
  if (!id || fetched.some((session) => session.id === id)) return fetched;
  const session = current.find((item) => item.id === id);
  return session ? mergeWorkspaceRouteSession(fetched, session) : fetched;
}

export function removeWorkspaceRouteSession<T extends { id: string }>(sessions: T[], sessionId: string): T[] {
  const next = sessions.filter((session) => session.id !== sessionId);
  return next.length === sessions.length ? sessions : next;
}

export function legacySessionRoute(sessionId?: string | null) {
  const session = sessionId?.trim();
  return session ? `/session/${encodeURIComponent(session)}` : "/session";
}

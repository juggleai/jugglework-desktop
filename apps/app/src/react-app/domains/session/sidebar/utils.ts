import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type { WorkspaceSessionGroup } from "../../../../app/types";
import { isSandboxWorkspace } from "../../../../app/utils";
import { t } from "../../../../i18n";

export const MAX_SESSIONS_PREVIEW = 6;

export type SessionListItem = WorkspaceSessionGroup["sessions"][number];
export type FlattenedSessionRow = { session: SessionListItem; depth: number };
export type SessionTreeState = {
  childrenByParent: Map<string, SessionListItem[]>;
  ancestorIdsBySessionId: Map<string, string[]>;
  descendantCountBySessionId: Map<string, number>;
  activeIds: Set<string>;
  streamingIds: Set<string>;
};

export const isSessionArchived = (session: SessionListItem): boolean =>
  typeof session.time?.archived === "number" && session.time.archived > 0;

/** Active agent work shown as the left-lane loader (never a completion / unread state). */
export const isActiveWorkSessionStatus = (status: string | undefined) =>
  status === "running" ||
  status === "busy" ||
  status === "retry" ||
  status === "streaming" ||
  status === "thinking" ||
  status === "responding" ||
  status === "stalled" ||
  status === "incomplete" ||
  status === "compacting";

/** Waiting is "needs you" on the right edge — not left-lane activity. */
export const isStreamingSessionStatus = (status: string | undefined) =>
  isActiveWorkSessionStatus(status) || status === "waiting";

export const isNeedsAttentionSessionStatus = (status: string | undefined) =>
  status === "waiting";

export type WorkspaceSessionIndicator = "running" | "unread" | null;

/**
 * 汇总工作区内全部会话的状态指示。
 * @param sessions 工作区内的会话列表
 * @param sessionStatusById 会话运行状态映射
 * @param unreadSessionIds 尚未查看结果的会话 id 集合
 * @returns 运行中优先显示绿色呼吸状态，其次显示绿色未读状态，否则不显示
 */
export function resolveWorkspaceSessionIndicator(
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
  unreadSessionIds: ReadonlySet<string>,
): WorkspaceSessionIndicator {
  if (sessions.some((session) => isActiveWorkSessionStatus(sessionStatusById?.[session.id]))) {
    return "running";
  }
  if (sessions.some((session) => unreadSessionIds.has(session.id))) {
    return "unread";
  }
  return null;
}

export function formatSessionRelativeTime(updatedAt: number | null | undefined): string | null {
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt) || updatedAt <= 0) return null;
  const ms = updatedAt < 1_000_000_000_000 ? updatedAt * 1000 : updatedAt;
  const seconds = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const normalizeSessionParentID = (session: SessionListItem) => {
  const parentID = session.parentID?.trim();
  return parentID || "";
};

/** Main sessions are the only sessions exposed by session-list UI surfaces. */
export const isMainSession = (session: Pick<SessionListItem, "parentID">) =>
  !session.parentID?.trim();

export const getRootSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  return sessions.filter(isMainSession);
};

/** Split sessions into active vs. archived. Archived sessions live in their own section. */
export const partitionArchivedSessions = (sessions: WorkspaceSessionGroup["sessions"]) => {
  const active: SessionListItem[] = [];
  const archived: SessionListItem[] = [];
  for (const session of sessions) {
    (isSessionArchived(session) ? archived : active).push(session);
  }
  return { active, archived };
};

/**
 * Sessions whose title matches the sidebar filter, plus the ancestors of every
 * match so each kept session still hangs off a root the tree can walk from.
 * An empty query returns the input untouched.
 */
export const filterSessionsByTitle = (
  sessions: WorkspaceSessionGroup["sessions"],
  query: string,
): WorkspaceSessionGroup["sessions"] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return sessions;

  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const kept = new Set<string>();

  for (const session of sessions) {
    if (!getDisplaySessionTitle(session.title).toLocaleLowerCase().includes(needle)) continue;
    kept.add(session.id);
    // Ancestors already in `kept` carry their own ancestors with them.
    let parentID = normalizeSessionParentID(session);
    while (parentID && !kept.has(parentID)) {
      kept.add(parentID);
      const parent = sessionsById.get(parentID);
      if (!parent) break;
      parentID = normalizeSessionParentID(parent);
    }
  }

  return sessions.filter((session) => kept.has(session.id));
};

/**
 * Order root sessions: pinned first, then manual order, then server recency.
 */
export const orderRootSessions = (
  roots: SessionListItem[],
  pinnedIds: Set<string>,
  orderIds: string[],
): SessionListItem[] => {
  const byId = new Map(roots.map((root) => [root.id, root]));
  const ordered: SessionListItem[] = [];
  const used = new Set<string>();

  for (const id of orderIds) {
    const root = byId.get(id);
    if (!root || used.has(id)) continue;
    ordered.push(root);
    used.add(id);
  }
  for (const root of roots) {
    if (used.has(root.id)) continue;
    ordered.push(root);
    used.add(root.id);
  }

  // Stable partition: pinned roots float to the top, preserving relative order.
  const pinned = ordered.filter((root) => pinnedIds.has(root.id));
  const rest = ordered.filter((root) => !pinnedIds.has(root.id));
  return [...pinned, ...rest];
};

export const buildSessionTreeState = (
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
): SessionTreeState => {
  const childrenByParent = new Map<string, SessionListItem[]>();
  const ancestorIdsBySessionId = new Map<string, string[]>();
  const descendantCountBySessionId = new Map<string, number>();
  const activeIds = new Set<string>();
  const streamingIds = new Set<string>();
  // Archived sessions render in their own flat section, so they never join the
  // active tree (neither as roots nor as children of active sessions).
  const visibleSessions = sessions.filter((session) => !isSessionArchived(session));
  const sessionIds = new Set(visibleSessions.map((session) => session.id));

  visibleSessions.forEach((session) => {
    const parentID = normalizeSessionParentID(session);
    if (!parentID || !sessionIds.has(parentID)) return;
    const siblings = childrenByParent.get(parentID) ?? [];
    siblings.push(session);
    childrenByParent.set(parentID, siblings);
  });

  const walk = (session: SessionListItem, ancestors: string[]) => {
    ancestorIdsBySessionId.set(session.id, ancestors);
    const children = childrenByParent.get(session.id) ?? [];
    let descendantCount = 0;
    const ownStatus = sessionStatusById?.[session.id] ?? "idle";
    let subtreeActive = ownStatus !== "idle";
    let subtreeStreaming = isStreamingSessionStatus(ownStatus);

    children.forEach((child) => {
      const childState = walk(child, [...ancestors, session.id]);
      descendantCount += 1 + childState.descendantCount;
      subtreeActive = subtreeActive || childState.subtreeActive;
      subtreeStreaming = subtreeStreaming || childState.subtreeStreaming;
    });

    descendantCountBySessionId.set(session.id, descendantCount);
    if (subtreeActive) activeIds.add(session.id);
    if (subtreeStreaming) streamingIds.add(session.id);
    return { descendantCount, subtreeActive, subtreeStreaming };
  };

  getRootSessions(visibleSessions).forEach((session) => {
    walk(session, []);
  });

  return {
    childrenByParent,
    ancestorIdsBySessionId,
    descendantCountBySessionId,
    activeIds,
    streamingIds,
  };
};

export const flattenSessionRows = (
  sessions: WorkspaceSessionGroup["sessions"],
  rootLimit: number,
  tree: SessionTreeState,
  expandedSessionIds: Set<string>,
  forcedExpandedSessionIds: Set<string>,
  pinnedIds: Set<string> = EMPTY_SET,
  orderIds: string[] = EMPTY_ARRAY,
  rootFilter?: { include?: Set<string>; exclude?: Set<string> },
) => {
  const { active } = partitionArchivedSessions(sessions);
  const orderedRoots = orderRootSessions(getRootSessions(active), pinnedIds, orderIds)
    .filter((root) => (
      (!rootFilter?.include || rootFilter.include.has(root.id)) &&
      !rootFilter?.exclude?.has(root.id)
    ))
    .slice(0, rootLimit);
  const rows: FlattenedSessionRow[] = [];
  const visited = new Set<string>();

  orderedRoots.forEach((session) => {
    if (visited.has(session.id)) return;
    visited.add(session.id);
    rows.push({ session, depth: 0 });
  });
  return rows;
};

const EMPTY_SET: Set<string> = new Set();
const EMPTY_ARRAY: string[] = [];

export const workspaceLabel = (workspace: WorkspaceInfo) =>
  workspace.displayName?.trim() ||
  workspace.juggleworkWorkspaceName?.trim() ||
  workspace.name?.trim() ||
  workspace.path?.trim() ||
  t("workspace_list.workspace_fallback");

export const workspaceKindLabel = (workspace: WorkspaceInfo) =>
  workspace.workspaceType === "remote"
    ? isSandboxWorkspace(workspace)
      ? t("workspace.sandbox_badge")
      : t("workspace.remote_badge")
    : t("workspace.local_badge");

const WORKSPACE_SWATCHES = ["#2563eb", "#5a67d8", "#f97316", "#10b981"];

export const workspaceSwatchColor = (seed: string) => {
  const value = seed.trim() || "workspace";
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return WORKSPACE_SWATCHES[Math.abs(hash) % WORKSPACE_SWATCHES.length];
};

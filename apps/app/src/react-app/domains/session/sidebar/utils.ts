import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { WorkspaceInfo } from "../../../../app/lib/desktop";
import type { WorkspaceSessionGroup } from "../../../../app/types";
import { isSandboxWorkspace } from "../../../../app/utils";
import { t } from "../../../../i18n";

export const MAX_SESSIONS_PREVIEW = 6;

export type SessionListItem = WorkspaceSessionGroup["sessions"][number];
export type FlattenedSessionRow = { session: SessionListItem; depth: number };
export type RecentSessionEntry = {
  group: WorkspaceSessionGroup;
  session: SessionListItem;
};
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
  status === "retrying" ||
  status === "stalled" ||
  status === "compacting";

/** Waiting is "needs you" on the right edge — not left-lane activity. */
export const isStreamingSessionStatus = (status: string | undefined) =>
  isActiveWorkSessionStatus(status) || status === "waiting";

export const isNeedsAttentionSessionStatus = (status: string | undefined) =>
  status === "waiting" || status === "error" || status === "incomplete";

export const isTerminalSessionStatus = (status: string | undefined) =>
  status === "idle" || status === "error" || status === "incomplete";

export type WorkspaceSessionIndicator = "running" | "completed" | null;

/**
 * Server-owned session runs outlive transient OpenCode `idle` events (most
 * notably while a parent waits for delegated child work). Prefer that
 * lifecycle receipt when deriving sidebar state so an active task never
 * flashes as completed merely because the engine root is temporarily idle.
 */
export function overlayCoordinatorSessionRuns(
  statusBySessionId: Record<string, string>,
  coordinatorSessionIds: ReadonlySet<string>,
): Record<string, string> {
  if (coordinatorSessionIds.size === 0) return statusBySessionId;
  const next = { ...statusBySessionId };
  for (const sessionId of coordinatorSessionIds) next[sessionId] = "running";
  return next;
}

/**
 * A probe only bridges the gap until the coordinator has answered. Once an
 * authoritative response arrives, a session absent from that response must
 * stop contributing a running indicator even when another session in the
 * same workspace is still active. Transport failures keep the probes intact.
 */
export function reconcileCoordinatorProbeSessionIds(
  probeSessionIds: readonly string[],
  authoritativeSessionIds: readonly string[] | null,
): string[] {
  if (authoritativeSessionIds === null) return [...probeSessionIds];
  if (probeSessionIds.length === 0 || authoritativeSessionIds.length === 0) return [];
  const activeSessionIds = new Set(authoritativeSessionIds);
  return probeSessionIds.filter((sessionId) => activeSessionIds.has(sessionId));
}

/**
 * 汇总工作区内全部会话的状态指示。
 * @param sessions 工作区内的会话列表
 * @param sessionStatusById 会话运行状态映射
 * @param unseenCompletedSessionIds 尚未查看完成结果的会话 id 集合
 * @returns 运行中优先显示绿色呼吸状态，其次显示绿色未读状态，否则不显示
 */
export function resolveWorkspaceSessionIndicator(
  sessions: WorkspaceSessionGroup["sessions"],
  sessionStatusById: Record<string, string> | undefined,
  unseenCompletedSessionIds: ReadonlySet<string>,
): WorkspaceSessionIndicator {
  if (sessions.some((session) => isActiveWorkSessionStatus(sessionStatusById?.[session.id]))) {
    return "running";
  }
  if (sessions.some((session) => unseenCompletedSessionIds.has(session.id))) {
    return "completed";
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

const sessionRecency = (session: SessionListItem) =>
  session.time?.updated ?? session.time?.created ?? 0;

/**
 * Collect active root sessions across workspaces in a single stable recency list.
 * Child sessions remain reachable from their parent but never become duplicate
 * top-level entries in the global "Recent" section.
 */
export const collectRecentSessions = (
  groups: WorkspaceSessionGroup[],
  excludedSessionIds: ReadonlySet<string> = EMPTY_SET,
): RecentSessionEntry[] => {
  const entries = groups.flatMap((group, groupIndex) =>
    getRootSessions(partitionArchivedSessions(group.sessions).active)
      .filter((session) => !excludedSessionIds.has(session.id))
      .map((session, sessionIndex) => ({ group, session, groupIndex, sessionIndex })),
  );

  entries.sort((left, right) =>
    sessionRecency(right.session) - sessionRecency(left.session)
    || left.groupIndex - right.groupIndex
    || left.sessionIndex - right.sessionIndex,
  );

  return entries.map(({ group, session }) => ({ group, session }));
};

/**
 * Apply a saved manual order. Entries not yet in the saved order (for example
 * newly created sessions) appear first in their incoming recency order, so a
 * new chat never disappears to the bottom of a hand-sorted list.
 */
export function applyManualOrder<T>(
  entries: T[],
  orderIds: readonly string[],
  idOf: (entry: T) => string,
): T[] {
  if (orderIds.length === 0) return entries;
  const rank = new Map(orderIds.map((id, index) => [id, index]));
  const unranked = entries.filter((entry) => !rank.has(idOf(entry)));
  const ranked = entries
    .filter((entry) => rank.has(idOf(entry)))
    .sort((left, right) => rank.get(idOf(left))! - rank.get(idOf(right))!);
  return [...unranked, ...ranked];
}

export type SectionedRecentSessions = {
  recent: RecentSessionEntry[];
  bySection: Map<string, RecentSessionEntry[]>;
};

/**
 * Split recent root sessions into user sections and the remaining Recent list.
 * Assignments to deleted sections fall back to Recent. In manual mode each list
 * follows its own saved order; otherwise lists keep update-time recency.
 */
export function partitionRecentSessionsIntoSections(
  entries: RecentSessionEntry[],
  input: {
    sectionIds: readonly string[];
    assignments: Readonly<Record<string, string>>;
    sortMode: "recent" | "manual";
    manualOrder: Readonly<Record<string, readonly string[]>>;
    recentListId: string;
  },
): SectionedRecentSessions {
  const known = new Set(input.sectionIds);
  const bySection = new Map<string, RecentSessionEntry[]>(input.sectionIds.map((id) => [id, []]));
  const recent: RecentSessionEntry[] = [];
  for (const entry of entries) {
    const sectionId = input.assignments[entry.session.id];
    if (sectionId && known.has(sectionId)) bySection.get(sectionId)!.push(entry);
    else recent.push(entry);
  }
  if (input.sortMode !== "manual") return { recent, bySection };
  const idOf = (entry: RecentSessionEntry) => entry.session.id;
  for (const [sectionId, list] of bySection) {
    bySection.set(sectionId, applyManualOrder(list, input.manualOrder[sectionId] ?? [], idOf));
  }
  return { recent: applyManualOrder(recent, input.manualOrder[input.recentListId] ?? [], idOf), bySection };
}

/** Root sessions of a workspace by update time, newest first. */
export function sortRootsByRecency(roots: SessionListItem[]): SessionListItem[] {
  return roots
    .map((session, index) => ({ session, index }))
    .sort((left, right) => sessionRecency(right.session) - sessionRecency(left.session) || left.index - right.index)
    .map(({ session }) => session);
}

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
    let subtreeActive = isActiveWorkSessionStatus(ownStatus);
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

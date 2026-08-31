import type {
  PermissionRequest,
  PermissionV2Request,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2/client";

import type {
  JuggleWorkInteractionSnapshot,
  JuggleWorkOwnedInteraction,
} from "@/app/lib/jugglework-server";
import type { PendingPermission, PendingQuestion } from "@/app/types";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionActivityStore } from "../status/session-activity-store";

type SessionAncestry = Record<string, {
  parentSessionId: string | null;
  rootSessionIdHint?: string;
}>;

export type WorkspaceInteractionState = {
  permissions: PendingPermission[];
  questions: PendingQuestion[];
  sessions: SessionAncestry;
  revision: number;
  appliedSnapshotFences: Record<string, number>;
  invalidSnapshotBeforeRevision: number;
  tombstones: Record<string, { revision: number; expiresAt: number }>;
};

type OwnedInteraction = PendingPermission | PendingQuestion;
type InteractionKind = "permission" | "question";

const emptyState: WorkspaceInteractionState = {
  permissions: [],
  questions: [],
  sessions: {},
  revision: 0,
  appliedSnapshotFences: {},
  invalidSnapshotBeforeRevision: 0,
  tombstones: {},
};

export const INTERACTION_TOMBSTONE_TTL_MS = 10 * 60_000;
export const INTERACTION_TOMBSTONE_CAPACITY = 512;

export const workspaceInteractionsKey = (workspaceId: string) =>
  ["react-workspace-interactions", workspaceId] as const;

function identity(kind: InteractionKind, targetSessionId: string, requestId: string) {
  return `${kind}\u0000${targetSessionId}\u0000${requestId}`;
}

function resolveRoot(sessions: SessionAncestry, sessionId: string): string | null {
  const seen = new Set<string>();
  let current = sessionId;
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const session = sessions[current];
    if (!session) return null;
    if (!session.parentSessionId) return session.rootSessionIdHint ?? current;
    if (!sessions[session.parentSessionId] && session.rootSessionIdHint) {
      return session.rootSessionIdHint;
    }
    current = session.parentSessionId;
  }
}

function ancestryPathFor(sessions: SessionAncestry, sessionId: string): string[] {
  const reversed: string[] = [];
  const seen = new Set<string>();
  let current = sessionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    reversed.push(current);
    const session = sessions[current];
    if (!session) break;
    if (!session.parentSessionId) {
      if (session.rootSessionIdHint && session.rootSessionIdHint !== current) {
        reversed.push(session.rootSessionIdHint);
      }
      break;
    }
    if (!sessions[session.parentSessionId] && session.rootSessionIdHint) {
      reversed.push(session.rootSessionIdHint);
      break;
    }
    current = session.parentSessionId;
  }
  return reversed.reverse();
}

function ownerFor(sessions: SessionAncestry, targetSessionId: string) {
  return {
    parentSessionId: sessions[targetSessionId]?.parentSessionId ?? null,
    rootSessionId: resolveRoot(sessions, targetSessionId),
    ancestryPath: ancestryPathFor(sessions, targetSessionId),
  };
}

function sortInteractions<T extends OwnedInteraction>(items: T[]): T[] {
  return items.sort((a, b) =>
    a.receivedAt - b.receivedAt ||
    a.targetSessionId.localeCompare(b.targetSessionId) ||
    a.id.localeCompare(b.id));
}

function rehome<T extends OwnedInteraction>(items: T[], sessions: SessionAncestry): T[] {
  return items.map((item) => {
    const owner = ownerFor(sessions, item.targetSessionId);
    const keepAuthoritativePath = item.ancestryPath.length > owner.ancestryPath.length;
    return {
      ...item,
      parentSessionId: owner.parentSessionId ?? item.parentSessionId,
      rootSessionId: owner.rootSessionId ?? item.rootSessionId,
      ancestryPath: keepAuthoritativePath ? item.ancestryPath : owner.ancestryPath,
    };
  });
}

function updateState(
  workspaceId: string,
  updater: (current: WorkspaceInteractionState) => WorkspaceInteractionState,
) {
  getReactQueryClient().setQueryData<WorkspaceInteractionState>(
    workspaceInteractionsKey(workspaceId),
    (current) => updater(current ?? emptyState),
  );
}

export function seedWorkspaceSessionAncestry(
  workspaceId: string,
  sessions: Array<Pick<Session, "id" | "parentID">>,
) {
  if (!workspaceId || sessions.length === 0) return;
  updateState(workspaceId, (current) => {
    const nextSessions = { ...current.sessions };
    for (const session of sessions) {
      if (!session.id) continue;
      const previous = nextSessions[session.id];
      nextSessions[session.id] = {
        parentSessionId: session.parentID?.trim() || null,
        ...(previous?.rootSessionIdHint ? { rootSessionIdHint: previous.rootSessionIdHint } : {}),
      };
    }
    return {
      ...current,
      sessions: nextSessions,
      permissions: rehome(current.permissions, nextSessions),
      questions: rehome(current.questions, nextSessions),
    };
  });
}

export function removeWorkspaceSessionAncestry(workspaceId: string, sessionId: string, now = Date.now()) {
  const deletedSessionIds = new Set<string>([sessionId]);
  const affectedRootSessionIds = new Set<string>();
  let nextState: WorkspaceInteractionState | null = null;
  updateState(workspaceId, (current) => {
    const pruned = pruneTombstones(current, now);
    const deletedRootSessionId = resolveRoot(pruned.sessions, sessionId);
    if (deletedRootSessionId) affectedRootSessionIds.add(deletedRootSessionId);

    for (const candidate of Object.keys(pruned.sessions)) {
      const seen = new Set<string>();
      let currentSessionId = candidate;
      while (currentSessionId && !seen.has(currentSessionId)) {
        if (currentSessionId === sessionId) {
          deletedSessionIds.add(candidate);
          break;
        }
        seen.add(currentSessionId);
        currentSessionId = pruned.sessions[currentSessionId]?.parentSessionId ?? "";
      }
    }

    const belongsToDeletedSubtree = (item: OwnedInteraction) => (
      deletedSessionIds.has(item.targetSessionId) || item.ancestryPath.includes(sessionId)
    );
    const deletedPermissions = pruned.permissions.filter(belongsToDeletedSubtree);
    const deletedQuestions = pruned.questions.filter(belongsToDeletedSubtree);
    for (const item of [...deletedPermissions, ...deletedQuestions]) {
      deletedSessionIds.add(item.targetSessionId);
      if (item.rootSessionId) affectedRootSessionIds.add(item.rootSessionId);
    }

    const revision = pruned.revision + 1;
    const tombstones = Object.fromEntries(
      Object.entries(pruned.tombstones).filter(([key]) => {
        const targetSessionId = key.split("\u0000", 3)[1];
        return !targetSessionId || !deletedSessionIds.has(targetSessionId);
      }),
    );

    const nextSessions = Object.fromEntries(
      Object.entries(pruned.sessions).filter(([candidate]) => !deletedSessionIds.has(candidate)),
    );
    nextState = pruneTombstones({
      ...pruned,
      revision,
      invalidSnapshotBeforeRevision: Math.max(pruned.invalidSnapshotBeforeRevision, revision),
      tombstones,
      sessions: nextSessions,
      permissions: rehome(pruned.permissions.filter((item) => !belongsToDeletedSubtree(item)), nextSessions),
      questions: rehome(pruned.questions.filter((item) => !belongsToDeletedSubtree(item)), nextSessions),
    }, now);
    return nextState;
  });
  if (!nextState) return;
  for (const rootSessionId of affectedRootSessionIds) {
    syncActivityWaitingForRoot(workspaceId, rootSessionId, nextState);
  }
  const activity = useSessionActivityStore.getState();
  for (const deletedSessionId of deletedSessionIds) {
    activity.removeSession(workspaceId, deletedSessionId);
  }
}

function v2PermissionKind(action: string): string {
  if (action === "external_directory" || action.endsWith(".external_directory")) return "external_directory";
  if (action === "file.read") return "read";
  if (action === "file.edit" || action === "file.write") return "edit";
  return action;
}

function normalizePermission(
  permission: PermissionRequest | PermissionV2Request | JuggleWorkOwnedInteraction,
  interactionRevision: number,
  ownership?: { targetSessionId: string; parentSessionId: string | null; rootSessionId: string | null; ancestryPath: string[] },
): PendingPermission | null {
  const wire = permission as Partial<JuggleWorkOwnedInteraction>;
  const targetSessionId = ownership?.targetSessionId ?? wire.targetSessionId ?? permission.sessionID;
  if (!permission.id || !targetSessionId) return null;
  const parentSessionId = ownership?.parentSessionId ?? wire.parentSessionId ?? null;
  const rootSessionId = ownership?.rootSessionId ?? wire.rootSessionId ?? null;
  const ancestryPath = ownership?.ancestryPath ?? normalizeAncestryPath(wire.ancestryPath, rootSessionId, targetSessionId);
  if ("action" in permission && typeof permission.action === "string") {
    const resources = Array.isArray(permission.resources)
      ? permission.resources.filter((item): item is string => typeof item === "string")
      : [];
    const save = Array.isArray(permission.save)
      ? permission.save.filter((item): item is string => typeof item === "string")
      : [];
    const metadata: Record<string, unknown> = permission.metadata && typeof permission.metadata === "object"
      ? { ...permission.metadata as Record<string, unknown>, action: permission.action }
      : { action: permission.action };
    if (save.length) metadata.save = save.join(", ");
    return {
      id: permission.id,
      sessionID: targetSessionId,
      permission: v2PermissionKind(permission.action),
      patterns: resources,
      metadata,
      always: save,
      receivedAt: interactionRevision,
      interactionRevision,
      protocol: "v2",
      v2: { action: permission.action, resources, ...(save.length ? { save } : {}) },
      targetSessionId,
      parentSessionId,
      rootSessionId,
      ancestryPath,
    };
  }
  if (!("permission" in permission) || typeof permission.permission !== "string") return null;
  return {
    ...permission as PermissionRequest,
    sessionID: targetSessionId,
    always: "always" in permission ? permission.always : [],
    receivedAt: interactionRevision,
    interactionRevision,
    protocol: wire.protocol === "v2" ? "v2" : "legacy",
    targetSessionId,
    parentSessionId,
    rootSessionId,
    ancestryPath,
  };
}

function normalizeAncestryPath(raw: unknown, rootSessionId: string | null, targetSessionId: string): string[] {
  const path = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).map((item) => item.trim())
    : [];
  if (path[0] === rootSessionId && path[path.length - 1] === targetSessionId) return path;
  if (path[0] === targetSessionId && path[path.length - 1] === rootSessionId) return path.reverse();
  if (rootSessionId && rootSessionId !== targetSessionId) return [rootSessionId, targetSessionId];
  return [targetSessionId];
}

function normalizeQuestion(
  question: QuestionRequest | JuggleWorkOwnedInteraction,
  interactionRevision: number,
  ownership?: { targetSessionId: string; parentSessionId: string | null; rootSessionId: string | null; ancestryPath: string[] },
): PendingQuestion | null {
  const wire = question as Partial<JuggleWorkOwnedInteraction>;
  const targetSessionId = ownership?.targetSessionId ?? wire.targetSessionId ?? question.sessionID;
  if (!question.id || !targetSessionId || !Array.isArray(question.questions)) return null;
  return {
    ...question as QuestionRequest,
    sessionID: targetSessionId,
    receivedAt: interactionRevision,
    interactionRevision,
    protocol: wire.protocol === "v2" ? "v2" : "legacy",
    targetSessionId,
    parentSessionId: ownership?.parentSessionId ?? wire.parentSessionId ?? null,
    rootSessionId: ownership?.rootSessionId ?? wire.rootSessionId ?? null,
    ancestryPath: ownership?.ancestryPath ?? normalizeAncestryPath(
      wire.ancestryPath,
      ownership?.rootSessionId ?? wire.rootSessionId ?? null,
      targetSessionId,
    ),
  };
}

function pruneTombstones(state: WorkspaceInteractionState, now: number): WorkspaceInteractionState {
  const ordered = Object.entries(state.tombstones).sort((left, right) => right[1].revision - left[1].revision);
  const tombstones: WorkspaceInteractionState["tombstones"] = {};
  let invalidSnapshotBeforeRevision = state.invalidSnapshotBeforeRevision;
  let retained = 0;
  for (const [key, tombstone] of ordered) {
    if (tombstone.expiresAt <= now || retained >= INTERACTION_TOMBSTONE_CAPACITY) {
      invalidSnapshotBeforeRevision = Math.max(invalidSnapshotBeforeRevision, tombstone.revision);
      continue;
    }
    tombstones[key] = tombstone;
    retained += 1;
  }
  return { ...state, tombstones, invalidSnapshotBeforeRevision };
}

export function captureInteractionSnapshotFence(workspaceId: string): number {
  let fence = 0;
  updateState(workspaceId, (current) => {
    fence = current.revision + 1;
    return { ...current, revision: fence };
  });
  return fence;
}

export function upsertLivePermission(
  workspaceId: string,
  permission: PermissionRequest | PermissionV2Request,
  _receivedAt?: number,
) {
  let accepted = false;
  updateState(workspaceId, (current) => {
    const pruned = pruneTombstones(current, Date.now());
    const revision = pruned.revision + 1;
    const owner = ownerFor(pruned.sessions, permission.sessionID);
    const next = normalizePermission(permission, revision, { targetSessionId: permission.sessionID, ...owner });
    if (!next) return pruned;
    const key = identity("permission", next.targetSessionId, next.id);
    if (pruned.tombstones[key] !== undefined) return pruned;
    accepted = true;
    const existing = pruned.permissions.find((item) => identity("permission", item.targetSessionId, item.id) === key);
    return {
      ...pruned,
      revision,
      permissions: sortInteractions([
        ...pruned.permissions.filter((item) => identity("permission", item.targetSessionId, item.id) !== key),
        { ...next, receivedAt: existing?.receivedAt ?? next.receivedAt },
      ]),
    };
  });
  return accepted;
}

export function upsertLiveQuestion(
  workspaceId: string,
  question: QuestionRequest & { protocol?: "legacy" | "v2" },
  _receivedAt?: number,
) {
  let accepted = false;
  updateState(workspaceId, (current) => {
    const pruned = pruneTombstones(current, Date.now());
    const revision = pruned.revision + 1;
    const owner = ownerFor(pruned.sessions, question.sessionID);
    const protocol = (question as QuestionRequest & { protocol?: "legacy" | "v2" }).protocol;
    const next = normalizeQuestion(
      { ...question, ...(protocol ? { protocol } : {}) } as QuestionRequest,
      revision,
      { targetSessionId: question.sessionID, ...owner },
    );
    if (!next) return pruned;
    const key = identity("question", next.targetSessionId, next.id);
    if (pruned.tombstones[key] !== undefined) return pruned;
    accepted = true;
    const existing = pruned.questions.find((item) => identity("question", item.targetSessionId, item.id) === key);
    return {
      ...pruned,
      revision,
      questions: sortInteractions([
        ...pruned.questions.filter((item) => identity("question", item.targetSessionId, item.id) !== key),
        { ...next, receivedAt: existing?.receivedAt ?? next.receivedAt },
      ]),
    };
  });
  return accepted;
}

export function resolveLiveInteraction(
  workspaceId: string,
  kind: InteractionKind,
  targetSessionId: string,
  requestId: string,
  now = Date.now(),
) {
  updateState(workspaceId, (current) => {
    const pruned = pruneTombstones(current, now);
    const revision = pruned.revision + 1;
    const key = identity(kind, targetSessionId, requestId);
    return pruneTombstones({
      ...pruned,
      revision,
      tombstones: {
        ...pruned.tombstones,
        [key]: { revision, expiresAt: now + INTERACTION_TOMBSTONE_TTL_MS },
      },
      permissions: kind === "permission"
        ? pruned.permissions.filter((item) => identity(kind, item.targetSessionId, item.id) !== key)
        : pruned.permissions,
      questions: kind === "question"
        ? pruned.questions.filter((item) => identity(kind, item.targetSessionId, item.id) !== key)
        : pruned.questions,
    }, now);
  });
  useSessionActivityStore.getState().setWaitingRequest(workspaceId, targetSessionId, kind, requestId, false);
}

function reconcileKind<T extends OwnedInteraction>(input: {
  kind: InteractionKind;
  current: T[];
  snapshot: JuggleWorkOwnedInteraction[];
  rootSessionId: string;
  snapshotFence: number;
  tombstones: WorkspaceInteractionState["tombstones"];
  normalize: (item: JuggleWorkOwnedInteraction, receivedAt: number) => T | null;
}): T[] {
  const incoming = new Map<string, T>();
  const existingByKey = new Map(input.current.map((item) => [identity(input.kind, item.targetSessionId, item.id), item]));
  for (const raw of input.snapshot) {
    const targetSessionId = raw.targetSessionId || raw.sessionID;
    const key = identity(input.kind, targetSessionId, raw.id);
    if ((input.tombstones[key]?.revision ?? 0) > input.snapshotFence) continue;
    const existing = existingByKey.get(key);
    if (existing && existing.interactionRevision > input.snapshotFence) {
      incoming.set(key, existing);
      continue;
    }
    const normalized = input.normalize(raw, existing?.interactionRevision ?? input.snapshotFence);
    if (normalized) incoming.set(key, normalized);
  }
  for (const item of input.current) {
    const key = identity(input.kind, item.targetSessionId, item.id);
    if (incoming.has(key)) continue;
    if (item.rootSessionId !== input.rootSessionId || item.interactionRevision > input.snapshotFence) {
      incoming.set(key, item);
    }
  }
  return sortInteractions([...incoming.values()]);
}

function seedSnapshotAncestry(
  sessions: SessionAncestry,
  item: JuggleWorkOwnedInteraction,
) {
  const path = normalizeAncestryPath(item.ancestryPath, item.rootSessionId, item.targetSessionId);
  for (let index = 0; index < path.length; index += 1) {
    const sessionId = path[index]!;
    sessions[sessionId] = {
      parentSessionId: index > 0 ? path[index - 1]! : null,
      rootSessionIdHint: item.rootSessionId,
    };
  }
  sessions[item.targetSessionId] = {
    parentSessionId: item.parentSessionId,
    rootSessionIdHint: item.rootSessionId,
  };
}

function syncActivityWaitingForRoot(workspaceId: string, rootSessionId: string, state: WorkspaceInteractionState) {
  const sessionIds = new Set<string>([rootSessionId]);
  for (const sessionId of Object.keys(state.sessions)) {
    if (resolveRoot(state.sessions, sessionId) === rootSessionId) sessionIds.add(sessionId);
  }
  for (const item of [...state.permissions, ...state.questions]) {
    if (item.rootSessionId === rootSessionId) sessionIds.add(item.targetSessionId);
  }
  const activity = useSessionActivityStore.getState();
  for (const sessionId of sessionIds) {
    activity.replaceWaitingRequests(
      workspaceId,
      sessionId,
      "permission",
      state.permissions.flatMap((item) => item.targetSessionId === sessionId ? [item.id] : []),
    );
    activity.replaceWaitingRequests(
      workspaceId,
      sessionId,
      "question",
      state.questions.flatMap((item) => item.targetSessionId === sessionId ? [item.id] : []),
    );
  }
}

export function reconcileInteractionSnapshot(
  workspaceId: string,
  snapshot: JuggleWorkInteractionSnapshot,
  snapshotFence: number,
  now = Date.now(),
) {
  let reconciled: WorkspaceInteractionState | null = null;
  updateState(workspaceId, (current) => {
    const pruned = pruneTombstones(current, now);
    if (
      snapshotFence < pruned.invalidSnapshotBeforeRevision ||
      snapshotFence < (pruned.appliedSnapshotFences[snapshot.rootSessionId] ?? 0)
    ) return pruned;
    const nextSessions = { ...pruned.sessions };
    nextSessions[snapshot.rootSessionId] = {
      ...nextSessions[snapshot.rootSessionId],
      parentSessionId: null,
      rootSessionIdHint: snapshot.rootSessionId,
    };
    for (const item of [...snapshot.permissions, ...snapshot.questions]) {
      seedSnapshotAncestry(nextSessions, item);
    }
    const permissions = reconcileKind({
      kind: "permission",
      current: rehome(pruned.permissions, nextSessions),
      snapshot: snapshot.permissions,
      rootSessionId: snapshot.rootSessionId,
      snapshotFence,
      tombstones: pruned.tombstones,
      normalize: (item, receivedAt) => normalizePermission(item, receivedAt),
    });
    const questions = reconcileKind({
      kind: "question",
      current: rehome(pruned.questions, nextSessions),
      snapshot: snapshot.questions,
      rootSessionId: snapshot.rootSessionId,
      snapshotFence,
      tombstones: pruned.tombstones,
      normalize: (item, receivedAt) => normalizeQuestion(item, receivedAt),
    });
    reconciled = {
      ...pruned,
      sessions: nextSessions,
      permissions,
      questions,
      appliedSnapshotFences: {
        ...pruned.appliedSnapshotFences,
        [snapshot.rootSessionId]: snapshotFence,
      },
    };
    return reconciled;
  });
  if (reconciled) syncActivityWaitingForRoot(workspaceId, snapshot.rootSessionId, reconciled);
}

export function pendingInteractionsForRoot(state: WorkspaceInteractionState, rootSessionId: string) {
  return {
    permissions: state.permissions.filter((item) => item.rootSessionId === rootSessionId),
    questions: state.questions.filter((item) => item.rootSessionId === rootSessionId),
  };
}

export function taskHasPendingInteraction(
  state: WorkspaceInteractionState,
  rootSessionId: string,
  childSessionId: string,
): boolean {
  const isOwnedByTask = (item: OwnedInteraction) => {
    if (item.rootSessionId !== rootSessionId) return false;
    if (item.ancestryPath.includes(childSessionId)) return true;
    let current = item.targetSessionId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === childSessionId) return true;
      seen.add(current);
      current = state.sessions[current]?.parentSessionId ?? "";
    }
    return false;
  };
  return state.permissions.some(isOwnedByTask) || state.questions.some(isOwnedByTask);
}

export function interactionRootsForSessions(state: WorkspaceInteractionState, sessionIds: Iterable<string>): string[] {
  const roots = new Set<string>();
  for (const sessionId of sessionIds) roots.add(resolveRoot(state.sessions, sessionId) ?? sessionId);
  return [...roots];
}

export function getWorkspaceInteractionState(workspaceId: string): WorkspaceInteractionState {
  return getReactQueryClient().getQueryData(workspaceInteractionsKey(workspaceId)) ?? emptyState;
}

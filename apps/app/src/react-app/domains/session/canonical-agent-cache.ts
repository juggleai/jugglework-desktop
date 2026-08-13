import type {
  CanonicalAgentEvent,
  CanonicalAgentMessage,
  CanonicalAgentPart,
  CanonicalInteraction,
  CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

import { getReactQueryClient } from "@/react-app/infra/query-client";

export const canonicalAgentCacheKeys = {
  root: ["canonical-agent"] as const,
  runtimes: (workspaceId: string) => ["canonical-agent", "runtimes", workspaceId] as const,
  sessions: (workspaceId: string) => ["canonical-agent", "sessions", workspaceId] as const,
  session: (workspaceId: string, sessionId: string) => ["canonical-agent", "session", workspaceId, sessionId] as const,
  snapshot: (workspaceId: string, sessionId: string) => ["canonical-agent", "snapshot", workspaceId, sessionId] as const,
  transcript: (workspaceId: string, sessionId: string) => ["canonical-agent", "transcript", workspaceId, sessionId] as const,
  status: (workspaceId: string, sessionId: string) => ["canonical-agent", "status", workspaceId, sessionId] as const,
  todos: (workspaceId: string, sessionId: string) => ["canonical-agent", "todos", workspaceId, sessionId] as const,
  interactions: (workspaceId: string, sessionId: string) => ["canonical-agent", "interactions", workspaceId, sessionId] as const,
  events: (workspaceId: string, sessionId: string) => ["canonical-agent", "events", workspaceId, sessionId] as const,
};

export type CanonicalReconcileResult = {
  snapshot: CanonicalSessionSnapshot;
  applied: number;
  ignored: number;
  needsSnapshot: boolean;
  nextSequence: number;
};

function byOrdinal(left: CanonicalAgentPart, right: CanonicalAgentPart): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

function byCreatedAt(left: CanonicalAgentMessage, right: CanonicalAgentMessage): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function upsertMessage(messages: CanonicalAgentMessage[], message: CanonicalAgentMessage): CanonicalAgentMessage[] {
  const next = messages.filter((item) => item.id !== message.id);
  next.push({ ...message, parts: [...message.parts].sort(byOrdinal) });
  return next.sort(byCreatedAt);
}

function upsertPart(messages: CanonicalAgentMessage[], messageId: string, part: CanonicalAgentPart): CanonicalAgentMessage[] {
  return messages.map((message) => message.id === messageId
    ? { ...message, parts: [...message.parts.filter((item) => item.id !== part.id), part].sort(byOrdinal) }
    : message);
}

function upsertInteraction(interactions: CanonicalInteraction[], interaction: CanonicalInteraction): CanonicalInteraction[] {
  return [...interactions.filter((item) => item.id !== interaction.id), interaction]
    .sort((left, right) => left.requestedAt - right.requestedAt || left.id.localeCompare(right.id));
}

function applyEvent(snapshot: CanonicalSessionSnapshot, event: CanonicalAgentEvent): CanonicalSessionSnapshot {
  const data = event.data;
  let next = snapshot;
  if (data.type === "session.created" || data.type === "session.updated") {
    next = { ...next, session: data.session };
  } else if (data.type === "session.status") {
    const active = data.status.type === "starting" || data.status.type === "running" || data.status.type === "waiting"
      || data.status.type === "retrying" || data.status.type === "aborting";
    next = {
      ...next,
      session: {
        ...next.session,
        status: data.status,
        updatedAt: event.occurredAt,
        ...(active ? { lastError: null } : {}),
      },
    };
  } else if (data.type === "message.updated") {
    next = { ...next, messages: upsertMessage(next.messages, data.message) };
  } else if (data.type === "message.part.updated") {
    next = { ...next, messages: upsertPart(next.messages, data.messageId, data.part) };
  } else if (data.type === "message.part.delta") {
    next = {
      ...next,
      messages: next.messages.map((message) => message.id !== data.messageId ? message : {
        ...message,
        parts: message.parts.map((part) => {
          if (part.id !== data.partId) return part;
          if (part.type !== "text" && part.type !== "reasoning") return part;
          return { ...part, text: `${part.text}${data.delta}`, updatedAt: event.occurredAt };
        }),
      }),
    };
  } else if (data.type === "todo.updated") {
    next = { ...next, todos: data.todos };
  } else if (data.type === "interaction.requested" || data.type === "interaction.resolved") {
    next = { ...next, interactions: upsertInteraction(next.interactions, data.interaction) };
  } else if (data.type === "run.completed" || data.type === "run.aborted") {
    next = { ...next, session: { ...next.session, status: { type: "idle" }, updatedAt: event.occurredAt } };
  } else if (data.type === "run.failed") {
    next = {
      ...next,
      session: {
        ...next.session,
        status: { type: "idle" },
        updatedAt: event.occurredAt,
        lastError: { code: data.code, message: data.message },
      },
    };
  }
  return { ...next, latestSequence: event.sequence };
}

/**
 * Replays only one contiguous event range. A gap leaves later events unapplied
 * and asks the caller to fetch a fresh snapshot before resuming.
 */
export function reconcileCanonicalEvents(
  snapshot: CanonicalSessionSnapshot,
  events: readonly CanonicalAgentEvent[],
): CanonicalReconcileResult {
  let next = snapshot;
  let applied = 0;
  let ignored = 0;
  let needsSnapshot = false;
  const seenIds = new Set<string>();
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));

  for (const event of ordered) {
    if (event.workspaceId !== snapshot.session.workspaceId || event.sessionId !== snapshot.session.id) {
      ignored += 1;
      continue;
    }
    if (seenIds.has(event.id) || event.sequence <= next.latestSequence) {
      ignored += 1;
      continue;
    }
    seenIds.add(event.id);
    if (event.sequence !== next.latestSequence + 1) {
      needsSnapshot = true;
      break;
    }
    next = applyEvent(next, event);
    applied += 1;
  }

  return {
    snapshot: next,
    applied,
    ignored,
    needsSnapshot,
    nextSequence: next.latestSequence + 1,
  };
}

export function reconcileCanonicalSnapshot(
  current: CanonicalSessionSnapshot | undefined,
  incoming: CanonicalSessionSnapshot,
): CanonicalSessionSnapshot {
  if (!current) return incoming;
  if (current.session.id !== incoming.session.id || current.session.workspaceId !== incoming.session.workspaceId) return incoming;
  return incoming.latestSequence >= current.latestSequence ? incoming : current;
}

export function publishCanonicalAgentSnapshot(snapshot: CanonicalSessionSnapshot): void {
  const queryClient = getReactQueryClient();
  const workspaceId = snapshot.session.workspaceId;
  const sessionId = snapshot.session.id;
  queryClient.setQueryData(canonicalAgentCacheKeys.session(workspaceId, sessionId), snapshot.session);
  queryClient.setQueryData(canonicalAgentCacheKeys.snapshot(workspaceId, sessionId), snapshot);
  queryClient.setQueryData(canonicalAgentCacheKeys.transcript(workspaceId, sessionId), snapshot.messages);
  queryClient.setQueryData(canonicalAgentCacheKeys.status(workspaceId, sessionId), snapshot.session.status);
  queryClient.setQueryData(canonicalAgentCacheKeys.todos(workspaceId, sessionId), snapshot.todos);
  queryClient.setQueryData(canonicalAgentCacheKeys.interactions(workspaceId, sessionId), snapshot.interactions);
}

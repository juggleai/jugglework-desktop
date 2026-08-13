import {
  canonicalAgentEventSchema,
  canonicalSessionSnapshotSchema,
  type CanonicalAgentEvent,
  type CanonicalAgentMessage,
  type CanonicalAgentPart,
  type CanonicalInteraction,
  type CanonicalSessionSnapshot,
} from "@jugglework/types/agent-runtime";

export type CanonicalReplayResult = {
  snapshot: CanonicalSessionSnapshot;
  applied: number;
  duplicateEventIds: string[];
  requiresSnapshot: boolean;
  gap?: { expectedSequence: number; receivedSequence: number };
};

/** Applies a contiguous event suffix without allowing gaps or duplicate backend events to corrupt state. */
export function replayCanonicalEvents(
  inputSnapshot: CanonicalSessionSnapshot,
  inputEvents: readonly CanonicalAgentEvent[],
): CanonicalReplayResult {
  let snapshot = canonicalSessionSnapshotSchema.parse(inputSnapshot);
  const seen = new Set<string>();
  const duplicateEventIds: string[] = [];
  let applied = 0;

  for (const inputEvent of inputEvents) {
    const event = canonicalAgentEventSchema.parse(inputEvent);
    if (event.sessionId !== snapshot.session.id) continue;
    if (seen.has(event.id)) {
      duplicateEventIds.push(event.id);
      continue;
    }
    seen.add(event.id);
    if (event.sequence <= snapshot.latestSequence) continue;
    const expectedSequence = snapshot.latestSequence + 1;
    if (event.sequence !== expectedSequence) {
      return {
        snapshot,
        applied,
        duplicateEventIds,
        requiresSnapshot: true,
        gap: { expectedSequence, receivedSequence: event.sequence },
      };
    }
    snapshot = applyEvent(snapshot, event);
    applied += 1;
  }

  return { snapshot, applied, duplicateEventIds, requiresSnapshot: false };
}

function applyEvent(snapshot: CanonicalSessionSnapshot, event: CanonicalAgentEvent): CanonicalSessionSnapshot {
  let session = snapshot.session;
  let messages = snapshot.messages;
  let todos = snapshot.todos;
  let interactions = snapshot.interactions;

  switch (event.data.type) {
    case "session.created":
    case "session.updated":
      session = event.data.session;
      break;
    case "session.status":
      session = { ...session, status: event.data.status, updatedAt: Math.max(session.updatedAt, event.occurredAt) };
      break;
    case "message.updated":
      messages = upsertMessage(messages, event.data.message);
      break;
    case "message.part.updated":
      messages = updatePart(messages, event.data.messageId, event.data.part);
      break;
    case "message.part.delta":
      messages = appendDelta(messages, event.data.messageId, event.data.partId, event.data.field, event.data.delta, event.occurredAt);
      break;
    case "interaction.requested":
    case "interaction.resolved":
      interactions = upsertInteraction(interactions, event.data.interaction);
      break;
    case "todo.updated":
      todos = event.data.todos;
      break;
    case "run.usage":
    case "run.completed":
    case "run.failed":
    case "run.aborted":
    case "run.configuration":
      break;
  }

  return canonicalSessionSnapshotSchema.parse({
    ...snapshot,
    session,
    messages,
    todos,
    interactions,
    latestSequence: event.sequence,
  });
}

function upsertMessage(messages: CanonicalAgentMessage[], message: CanonicalAgentMessage): CanonicalAgentMessage[] {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index < 0) return [...messages, message].sort(messageOrder);
  const next = [...messages];
  next[index] = message;
  return next.sort(messageOrder);
}

function updatePart(
  messages: CanonicalAgentMessage[],
  messageId: string,
  part: CanonicalAgentPart,
): CanonicalAgentMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    const index = message.parts.findIndex((item) => item.id === part.id);
    const parts = index < 0 ? [...message.parts, part] : message.parts.map((item, itemIndex) => itemIndex === index ? part : item);
    return { ...message, parts: parts.sort(partOrder) };
  });
}

function appendDelta(
  messages: CanonicalAgentMessage[],
  messageId: string,
  partId: string,
  field: "text" | "reasoning",
  delta: string,
  occurredAt: number,
): CanonicalAgentMessage[] {
  return messages.map((message) => {
    if (message.id !== messageId) return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part.id !== partId) return part;
        if (field === "text" && part.type === "text") return { ...part, text: part.text + delta, updatedAt: occurredAt };
        if (field === "reasoning" && part.type === "reasoning") return { ...part, text: part.text + delta, updatedAt: occurredAt };
        return part;
      }),
    };
  });
}

function upsertInteraction(interactions: CanonicalInteraction[], interaction: CanonicalInteraction): CanonicalInteraction[] {
  const index = interactions.findIndex((item) => item.id === interaction.id);
  if (index < 0) return [...interactions, interaction];
  const next = [...interactions];
  next[index] = interaction;
  return next;
}

function messageOrder(left: CanonicalAgentMessage, right: CanonicalAgentMessage): number {
  return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function partOrder(left: CanonicalAgentPart, right: CanonicalAgentPart): number {
  return left.ordinal - right.ordinal || left.id.localeCompare(right.id);
}

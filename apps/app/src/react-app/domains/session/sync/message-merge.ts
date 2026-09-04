import type { UIMessage } from "ai";

import { getSessionCompactionFromMessage, getSessionCompactionFromPart } from "../../../../app/lib/session-compaction";

function mergeMessageParts(snapshotMessage: UIMessage, cachedMessage: UIMessage) {
  const parts = snapshotMessage.parts.map((part, index) => {
    const cachedPart = cachedMessage.parts[index];
    if (!cachedPart) return part;

    if (
      (part.type === "text" || part.type === "reasoning") &&
      cachedPart.type === part.type &&
      cachedPart.text.length > part.text.length
    ) {
      return { ...part, text: cachedPart.text };
    }

    return part;
  });

  if (cachedMessage.parts.length > snapshotMessage.parts.length) {
    parts.push(...cachedMessage.parts.slice(snapshotMessage.parts.length));
  }

  return parts;
}

function mergeSnapshotMessageWithCached(snapshotMessage: UIMessage, cachedMessage: UIMessage): UIMessage {
  const metadata = snapshotMessage.metadata ?? cachedMessage.metadata;
  let parts = mergeMessageParts(snapshotMessage, cachedMessage);

  // A snapshot window that excludes the compaction boundary maps its summary
  // receipt to mode "unknown", while the live stream already observed the
  // real mode (from the boundary or the compaction lifecycle events). Live
  // and snapshot part orderings also differ (the live marker is created
  // before the summary streams, the snapshot marker is appended last), so
  // index-paired merging cannot carry the mode across. Patch it at the
  // message level: a known cached mode must not be downgraded to unknown, or
  // grouping would split the run into a standalone compaction task.
  const cachedCompaction = getSessionCompactionFromMessage(cachedMessage);
  if (cachedCompaction && cachedCompaction.mode !== "unknown") {
    const mergedCompaction = getSessionCompactionFromMessage({ ...snapshotMessage, parts });
    if (!mergedCompaction || mergedCompaction.mode === "unknown") {
      parts = parts.map((part) => {
        const compaction = getSessionCompactionFromPart(part);
        // Compaction markers are text parts by construction; other part
        // kinds never carry a compaction presentation.
        if (!compaction || compaction.mode !== "unknown" || part.type !== "text") return part;
        const metadata = part.providerMetadata as { opencode?: Record<string, unknown> } | undefined;
        return {
          ...part,
          providerMetadata: {
            ...part.providerMetadata,
            opencode: {
              ...(metadata?.opencode),
              compaction: { ...compaction, mode: cachedCompaction.mode },
            },
          },
        };
      });
    }
  }

  return {
    ...snapshotMessage,
    ...(metadata === undefined ? {} : { metadata }),
    parts,
  };
}

function messageCreated(message: UIMessage) {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object" || !("opencode" in metadata)) return null;

  const opencode = metadata.opencode;
  if (!opencode || typeof opencode !== "object" || !("created" in opencode)) return null;

  const created = opencode.created;
  return typeof created === "number" ? created : null;
}

function insertMessageByChronology(messages: UIMessage[], message: UIMessage, sourceOrder: UIMessage[]) {
  const created = messageCreated(message);
  if (created !== null) {
    const timestampIndex = messages.findIndex((existing) => {
      const existingCreated = messageCreated(existing);
      return existingCreated !== null && existingCreated > created;
    });
    if (timestampIndex !== -1) {
      messages.splice(timestampIndex, 0, message);
      return;
    }
  }

  const sourceIndex = sourceOrder.findIndex((item) => item.id === message.id);
  if (sourceIndex !== -1) {
    for (let index = sourceIndex + 1; index < sourceOrder.length; index += 1) {
      const nextIndex = messages.findIndex((item) => item.id === sourceOrder[index]?.id);
      if (nextIndex !== -1) {
        messages.splice(nextIndex, 0, message);
        return;
      }
    }

    for (let index = sourceIndex - 1; index >= 0; index -= 1) {
      const previousIndex = messages.findIndex((item) => item.id === sourceOrder[index]?.id);
      if (previousIndex !== -1) {
        messages.splice(previousIndex + 1, 0, message);
        return;
      }
    }
  }

  messages.push(message);
}

function sortFullyTimestampedMessages(messages: UIMessage[]) {
  const withCreated = messages.map((message, index) => ({ message, index, created: messageCreated(message) }));
  if (withCreated.some((item) => item.created === null)) return messages;

  return withCreated
    .sort((a, b) => (a.created ?? 0) - (b.created ?? 0) || a.index - b.index)
    .map((item) => item.message);
}

export function messageListContainsAll(container: UIMessage[], required: UIMessage[]) {
  if (required.length === 0) return true;
  const ids = new Set(container.map((message) => message.id));
  return required.every((message) => ids.has(message.id));
}

export function mergeSnapshotAndLiveMessages(
  snapshotMessages: UIMessage[],
  liveMessages: UIMessage[],
  options: { appendLiveOnlyMessages?: boolean } = {},
) {
  if (snapshotMessages.length === 0) return liveMessages;
  if (liveMessages.length === 0) return snapshotMessages;

  const liveById = new Map(liveMessages.map((message) => [message.id, message]));
  const snapshotIds = new Set(snapshotMessages.map((message) => message.id));
  const merged = snapshotMessages.map((snapshotMessage) => {
    const liveMessage = liveById.get(snapshotMessage.id);
    return liveMessage ? mergeSnapshotMessageWithCached(snapshotMessage, liveMessage) : snapshotMessage;
  });

  if (options.appendLiveOnlyMessages) {
    for (const liveMessage of liveMessages) {
      if (!snapshotIds.has(liveMessage.id)) insertMessageByChronology(merged, liveMessage, liveMessages);
    }
  }

  return sortFullyTimestampedMessages(merged);
}

export function mergeSnapshotIntoCachedMessages(snapshotMessages: UIMessage[], cachedMessages: UIMessage[]) {
  if (snapshotMessages.length === 0) return cachedMessages;
  if (cachedMessages.length === 0) return snapshotMessages;

  const snapshotById = new Map(snapshotMessages.map((message) => [message.id, message]));
  const cachedById = new Map(cachedMessages.map((message) => [message.id, message]));
  const seen = new Set<string>();
  const merged = snapshotMessages.map((message) => {
    seen.add(message.id);
    const snapshotMessage = snapshotById.get(message.id);
    const cachedMessage = cachedById.get(message.id);
    return snapshotMessage && cachedMessage
      ? mergeSnapshotMessageWithCached(snapshotMessage, cachedMessage)
      : message;
  });

  for (const message of cachedMessages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    insertMessageByChronology(merged, message, cachedMessages);
  }

  return sortFullyTimestampedMessages(merged);
}

import type { UIMessage } from "ai";

import { getSessionCompactionFromMessage, getSessionCompactionFromPart } from "../../../../app/lib/session-compaction";

type MessagePart = UIMessage["parts"][number];

export function getPartMetadataId(part: MessagePart): string | null {
  const metadata = "callProviderMetadata" in part ? part.callProviderMetadata
    : "providerMetadata" in part ? part.providerMetadata : undefined;
  const partId = metadata?.opencode?.partId;
  return typeof partId === "string" && partId ? partId : null;
}

function partKeys(part: MessagePart): string[] {
  const partId = getPartMetadataId(part);
  const keys = partId ? [`part:${partId}`] : [];
  // Older projections may carry only the SDK identity. Each message also has
  // at most one compaction receipt, whose ID may predate the persisted marker.
  if ("toolCallId" in part && part.toolCallId) keys.push(`tool:${part.toolCallId}`);
  if ("sourceId" in part && part.sourceId) keys.push(`source:${part.sourceId}`);
  if (getSessionCompactionFromPart(part)) keys.push("compaction");
  return keys;
}

function deduplicateParts(parts: MessagePart[]): MessagePart[] {
  if (parts.length < 2) return parts;
  const seen = new Set<string>();
  const hasIdentifiedStep = parts.some((part) => part.type === "step-start" && getPartMetadataId(part));
  const unique = parts.filter((part) => {
    const keys = partKeys(part);
    // Before live step markers carried IDs, replaying them created anonymous
    // copies alongside the persisted markers.
    if (hasIdentifiedStep && part.type === "step-start" && keys.length === 0) return false;
    const duplicate = keys.some((key) => seen.has(key));
    for (const key of keys) seen.add(key);
    return !duplicate;
  });
  return unique.length === parts.length ? parts : unique;
}

function deduplicateMessage(message: UIMessage): UIMessage {
  const parts = deduplicateParts(message.parts);
  return parts === message.parts ? message : { ...message, parts };
}

function deduplicateMessages(messages: UIMessage[]): UIMessage[] {
  const unique = messages.map(deduplicateMessage);
  return unique.every((message, index) => message === messages[index]) ? messages : unique;
}

function indexParts(parts: MessagePart[]) {
  const byKey = new Map<string, MessagePart>();
  for (const part of parts) {
    for (const key of partKeys(part)) byKey.set(key, part);
  }
  return byKey;
}

function findPart(keys: string[], byKey: Map<string, MessagePart>) {
  for (const key of keys) {
    const part = byKey.get(key);
    if (part) return part;
  }
}

/** Insert missing parts before the next shared anchor in the fallback order. */
function fillMissingParts(parts: MessagePart[], fallback: MessagePart[], identifiedOnly = false) {
  const byKey = indexParts(parts);
  let merged = parts;
  let nextAnchor: MessagePart | undefined;
  for (let index = fallback.length - 1; index >= 0; index -= 1) {
    const part = fallback[index]!;
    const keys = partKeys(part);
    if (identifiedOnly && keys.length === 0) continue;
    const match = findPart(keys, byKey);
    if (match) {
      nextAnchor = match;
      continue;
    }
    if (merged === parts) merged = parts.slice();
    merged.splice(nextAnchor ? merged.indexOf(nextAnchor) : merged.length, 0, part);
    nextAnchor = part;
  }
  return merged === parts ? parts : deduplicateParts(merged);
}

function mergeMessageParts(snapshotMessage: UIMessage, cachedMessage: UIMessage) {
  const snapshot = deduplicateParts(snapshotMessage.parts);
  const cached = deduplicateParts(cachedMessage.parts);
  const cachedByKey = indexParts(cached);
  const completed = (snapshotMessage.metadata as { opencode?: { completed?: unknown } } | undefined)?.opencode?.completed;

  const parts = snapshot.map((part) => {
    const cachedPart = findPart(partKeys(part), cachedByKey);
    if (
      typeof completed !== "number" &&
      (part.type === "text" || part.type === "reasoning") &&
      cachedPart?.type === part.type &&
      cachedPart.text.length > part.text.length
    ) {
      return { ...part, text: cachedPart.text };
    }

    return part;
  });

  return fillMissingParts(parts, cached);
}

function mergeSnapshotMessageWithCached(snapshotMessage: UIMessage, cachedMessage: UIMessage): UIMessage {
  const metadata = snapshotMessage.metadata ?? cachedMessage.metadata;
  let parts = mergeMessageParts(snapshotMessage, cachedMessage);

  // A snapshot window that excludes the compaction boundary maps its summary
  // receipt to mode "unknown", while the live stream already observed the
  // real mode (from the boundary or the compaction lifecycle events). Keep
  // the known mode so grouping keeps the compaction within the same run.
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

/** Only fill missing identified parts; live content, role and terminal metadata win. */
function recoverMissingSnapshotParts(snapshotMessage: UIMessage, liveMessage: UIMessage): UIMessage {
  const live = deduplicateParts(liveMessage.parts);
  const parts = fillMissingParts(live, deduplicateParts(snapshotMessage.parts), true);
  return parts === liveMessage.parts ? liveMessage : { ...liveMessage, parts };
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

/** 合并历史快照和实时消息；失效快照只补缺失消息及part，历史删除/回退须由调用方先过滤。 */
export function mergeSnapshotAndLiveMessages(
  snapshotMessages: UIMessage[],
  liveMessages: UIMessage[],
  options: { appendLiveOnlyMessages?: boolean; preserveLiveMessages?: boolean } = {},
) {
  if (snapshotMessages.length === 0) return deduplicateMessages(liveMessages);
  if (liveMessages.length === 0) return deduplicateMessages(snapshotMessages);

  const liveById = new Map(liveMessages.map((message) => [message.id, message]));
  const snapshotIds = new Set(snapshotMessages.map((message) => message.id));
  const merged = snapshotMessages.map((snapshotMessage) => {
    const liveMessage = liveById.get(snapshotMessage.id);
    if (!liveMessage) return deduplicateMessage(snapshotMessage);
    return options.preserveLiveMessages
      ? recoverMissingSnapshotParts(snapshotMessage, liveMessage)
      : mergeSnapshotMessageWithCached(snapshotMessage, liveMessage);
  });

  if (options.appendLiveOnlyMessages) {
    for (const liveMessage of liveMessages) {
      if (snapshotIds.has(liveMessage.id)) continue;
      snapshotIds.add(liveMessage.id);
      insertMessageByChronology(merged, deduplicateMessage(liveMessage), liveMessages);
    }
  }

  return sortFullyTimestampedMessages(merged);
}

export function mergeSnapshotIntoCachedMessages(snapshotMessages: UIMessage[], cachedMessages: UIMessage[]) {
  return mergeSnapshotAndLiveMessages(snapshotMessages, cachedMessages, { appendLiveOnlyMessages: true });
}

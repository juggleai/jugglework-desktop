import type { UIMessage } from "ai";

export type SessionCompactionMode = "auto" | "manual" | "unknown";

export type SessionCompactionPresentation = {
  mode: SessionCompactionMode;
  running: boolean;
  startedAt: number | null;
  finishedAt: number | null;
};

type OpencodePartMetadata = {
  partId?: string;
  compaction?: Partial<SessionCompactionPresentation>;
};

type OpencodeMessageMetadata = {
  created?: number;
  completed?: number;
  finish?: string;
  summary?: boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeMode(value: unknown): SessionCompactionMode {
  return value === "auto" || value === "manual" ? value : "unknown";
}

function normalizeTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // OpenCode message snapshots use epoch milliseconds, while some event
  // transports expose epoch seconds. Keep compaction timing on one unit so a
  // fresh `/compact` cannot accidentally look hours or years old.
  return value < 1e12 ? value * 1000 : value;
}

export function createSessionCompactionUIPart(input: {
  partId: string;
  mode: SessionCompactionMode;
  running: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
}): UIMessage["parts"][number] {
  return {
    // Keep this as an empty text part so it remains compatible with the AI SDK's
    // default UIMessage type while the renderer can still present it as a
    // first-class activity row through provider metadata.
    type: "text",
    text: "",
    state: input.running ? "streaming" : "done",
    providerMetadata: {
      opencode: {
        partId: input.partId,
        compaction: {
          mode: input.mode,
          running: input.running,
          startedAt: input.startedAt ?? null,
          finishedAt: input.finishedAt ?? null,
        },
      },
    },
  };
}

export function getSessionCompactionFromPart(
  part: UIMessage["parts"][number],
): SessionCompactionPresentation | null {
  if (part.type !== "text") return null;
  const opencode = asRecord(part.providerMetadata?.opencode) as OpencodePartMetadata | null;
  const compaction = asRecord(opencode?.compaction);
  if (!compaction) return null;
  return {
    mode: normalizeMode(compaction.mode),
    running: compaction.running === true,
    startedAt: normalizeTimestamp(compaction.startedAt),
    finishedAt: normalizeTimestamp(compaction.finishedAt),
  };
}

export function isSessionCompactionUIPart(
  part: UIMessage["parts"][number],
): boolean {
  return getSessionCompactionFromPart(part) !== null;
}

export function getSessionCompactionFromMessage(
  message: UIMessage,
): SessionCompactionPresentation | null {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const compaction = getSessionCompactionFromPart(message.parts[index]!);
    if (compaction) return compaction;
  }
  return null;
}

export function isCompactionSummaryMessage(message: UIMessage): boolean {
  if (getSessionCompactionFromMessage(message)) return true;
  const metadata = asRecord(message.metadata);
  const opencode = asRecord(metadata?.opencode) as OpencodeMessageMetadata | null;
  return opencode?.summary === true;
}

function messageTimestamp(message: UIMessage, key: "created" | "completed") {
  const metadata = asRecord(message.metadata);
  const opencode = asRecord(metadata?.opencode) as OpencodeMessageMetadata | null;
  return normalizeTimestamp(opencode?.[key]);
}

/**
 * Compaction summaries are internal context fed back to the model. They must
 * never be rendered as assistant prose. Reduce the message to one activity
 * marker, synthesizing a backward-compatible marker for older snapshots that
 * only expose `info.summary`.
 */
export function toCompactionPresentationMessage(message: UIMessage): UIMessage {
  if (!isCompactionSummaryMessage(message)) return message;

  const marker = message.parts.findLast(isSessionCompactionUIPart);
  if (marker) return { ...message, parts: [marker] };

  const startedAt = messageTimestamp(message, "created");
  const finishedAt = messageTimestamp(message, "completed");
  return {
    ...message,
    parts: [createSessionCompactionUIPart({
      partId: `${message.id}:compaction`,
      mode: "unknown",
      running: finishedAt === null,
      startedAt,
      finishedAt,
    })],
  };
}

function mergeMessageMetadata(
  current: UIMessage["metadata"],
  update: { created?: number | null; completed?: number | null },
): UIMessage["metadata"] {
  const currentMetadata = asRecord(current) ?? {};
  const currentOpencode = asRecord(currentMetadata.opencode) ?? {};
  const nextOpencode = {
    ...currentOpencode,
    summary: true,
    ...(typeof update.created === "number" ? { created: update.created } : {}),
    ...(typeof update.completed === "number" ? { completed: update.completed } : {}),
  };
  return { ...currentMetadata, opencode: nextOpencode };
}

/** Upsert the single live compaction marker associated with an engine message. */
export function upsertSessionCompactionMessage(
  messages: UIMessage[],
  input: {
    messageId: string;
    mode: SessionCompactionMode;
    running: boolean;
    startedAt?: number | null;
    finishedAt?: number | null;
    partId?: string;
  },
): UIMessage[] {
  const existing = messages.find((message) => message.id === input.messageId);
  const previous = existing ? getSessionCompactionFromMessage(existing) : null;
  const mode = input.mode === "unknown" ? previous?.mode ?? "unknown" : input.mode;
  const startedAt = input.startedAt ?? previous?.startedAt ?? null;
  const finishedAt = input.finishedAt ?? (input.running ? null : previous?.finishedAt ?? null);
  const marker = createSessionCompactionUIPart({
    partId: input.partId ?? `${input.messageId}:compaction`,
    mode,
    running: input.running,
    startedAt,
    finishedAt,
  });

  if (!existing) {
    return [...messages, {
      id: input.messageId,
      role: "assistant",
      metadata: mergeMessageMetadata(undefined, {
        created: startedAt,
        completed: finishedAt,
      }),
      parts: [marker],
    }];
  }

  return messages.map((message) => {
    if (message.id !== input.messageId) return message;
    return {
      ...message,
      role: "assistant",
      metadata: mergeMessageMetadata(message.metadata, {
        created: startedAt,
        completed: finishedAt,
      }),
      parts: [
        ...message.parts.filter((part) => !isSessionCompactionUIPart(part)),
        marker,
      ],
    };
  });
}

export function completeRunningSessionCompactions(
  messages: UIMessage[],
  finishedAt: number | null,
): UIMessage[] {
  return messages.reduce((current, message) => {
    const compaction = getSessionCompactionFromMessage(message);
    if (!compaction?.running) return current;
    return upsertSessionCompactionMessage(current, {
      messageId: message.id,
      mode: compaction.mode,
      running: false,
      startedAt: compaction.startedAt,
      finishedAt,
    });
  }, messages);
}

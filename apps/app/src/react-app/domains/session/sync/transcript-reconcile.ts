import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../../../../app/types";
import { mergeSnapshotIntoCachedMessages } from "./message-merge";

export type TranscriptReconcileReason = "snapshot" | "revert";

export type ReconcileTranscriptInput = {
  /** Current canonical transcript cache rendered by the session UI. */
  currentMessages: UIMessage[];
  /** Messages reconstructed from the latest server snapshot. */
  snapshotMessages: UIMessage[];
  /** Why this reconciliation is happening. Reserved for explicit truncation rules. */
  reason?: TranscriptReconcileReason;
};

/**
 * Reconcile a server snapshot into the canonical transcript cache.
 *
 * Snapshot reads can lag behind the OpenCode event stream during prompt
 * submission. This helper centralizes the invariant that ordinary snapshots
 * may fill/update the cache, but must not make the visible transcript move
 * backwards. Explicit history operations such as revert can opt into their own
 * truncation path instead of relying on snapshot absence.
 */
export function reconcileTranscriptMessages(input: ReconcileTranscriptInput): UIMessage[] {
  const current = input.currentMessages;
  const snapshot = input.snapshotMessages;

  if (current.length === 0) return snapshot;
  if (snapshot.length === 0) return current;

  return mergeSnapshotIntoCachedMessages(snapshot, current);
}

/**
 * Hide messages at and after OpenCode's revert cursor. Revert is an explicit
 * history mutation, so it is the one place the rendered transcript is allowed
 * to move backwards.
 *
 * OpenCode treats `session.revert.messageID` as the FIRST reverted message.
 * The cursor is located by exact ID in the time-ordered transcript, so the
 * cursor message itself and every later array item must be hidden.
 */
export function applyRevertCursor(messages: UIMessage[], revertMessageId: string | null | undefined): UIMessage[] {
  if (!revertMessageId || messages.length === 0) return messages;
  let idx = messages.findIndex((message) => message.id === revertMessageId);
  if (idx < 0) {
    idx = messages.findIndex((message) => message.id === `${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${revertMessageId}`);
  }
  if (idx < 0) return messages;
  return messages.slice(0, idx);
}

export function isSyntheticMessageId(id: string) {
  return id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
}

export function getSessionErrorParentId(message: UIMessage): string | undefined {
  if (!isSyntheticMessageId(message.id)) return undefined;
  const parentID = (message.metadata as { opencode?: { parentID?: unknown } } | undefined)?.opencode?.parentID;
  return typeof parentID === "string" ? parentID : undefined;
}

/** An error may arrive after a later turn. Place it beside its actual parent. */
export function placeSessionErrorsWithParent(messages: UIMessage[]): UIMessage[] {
  if (!messages.some((message) => getSessionErrorParentId(message))) return messages;
  const parents = new Set(messages.filter((message) => message.role === "user").map((message) => message.id));
  const errors = new Map<string, UIMessage[]>();
  let currentParent: string | undefined;
  const transcript = messages.filter((message) => {
    if (message.role === "user" && message.parts.length > 0) currentParent = message.id;
    const parent = getSessionErrorParentId(message);
    if (!parent || parent === currentParent || !parents.has(parent)) return true;
    const group = errors.get(parent);
    if (group) group.push(message);
    else errors.set(parent, [message]);
    return false;
  });
  if (errors.size === 0) return messages;
  const result: UIMessage[] = [];
  currentParent = undefined;
  for (const message of transcript) {
    if (message.role === "user" && (message.parts.length > 0 || errors.has(message.id))) {
      if (currentParent) result.push(...(errors.get(currentParent) ?? []));
      currentParent = message.id;
    }
    result.push(message);
  }
  if (currentParent) result.push(...(errors.get(currentParent) ?? []));
  return result;
}

/**
 * Resolve the message id to pass to OpenCode's `session.fork` so the branch
 * INCLUDES the message the user branched at.
 *
 * OpenCode copies messages strictly BEFORE the given id, so branching "at" a
 * message means forking at the next real message after it. Synthetic
 * client-side messages (e.g. `session-error:*`) are skipped because their ids
 * do not exist server-side and would corrupt the fork boundary. Returns null
 * when the branch point is the last message, meaning "fork the full session".
 */
export function resolveForkBoundaryId(messages: UIMessage[], messageId: string): string | null {
  const idx = messages.findIndex((message) => message.id === messageId);
  if (idx < 0) return null;
  for (let index = idx + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (candidate && !isSyntheticMessageId(candidate.id)) return candidate.id;
  }
  return null;
}

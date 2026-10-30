import { create } from "zustand";

import { isActiveWorkSessionStatus, isNeedsAttentionSessionStatus } from "./utils";

type SessionCompletionState = {
  unseenSessionIds: string[];
  acknowledgedAttentionSessionIds: string[];
  previousStatusBySessionId: Record<string, string>;
  reconcile: (
    statusBySessionId: Record<string, string>,
    accessibleSessionIds: ReadonlySet<string>,
    visibleSessionIds: ReadonlySet<string>,
  ) => void;
  clear: (sessionId: string) => void;
  acknowledgeAttention: (sessionId: string) => void;
};

/** In-memory completion markers derived only from status transitions observed this run. */
export const useSessionCompletionStore = create<SessionCompletionState>((set) => ({
  unseenSessionIds: [],
  acknowledgedAttentionSessionIds: [],
  previousStatusBySessionId: {},

  reconcile: (statusBySessionId, accessibleSessionIds, visibleSessionIds) => set((state) => {
    const unseen = new Set(
      state.unseenSessionIds.filter((sessionId) => (
        accessibleSessionIds.has(sessionId) && !visibleSessionIds.has(sessionId)
      )),
    );
    const acknowledgedAttention = new Set(
      state.acknowledgedAttentionSessionIds.filter((sessionId) => accessibleSessionIds.has(sessionId)),
    );
    const previousStatusBySessionId: Record<string, string> = {};

    for (const sessionId of accessibleSessionIds) {
      const status = statusBySessionId[sessionId];
      if (!status) continue;

      const previousStatus = state.previousStatusBySessionId[sessionId];
      const active = isActiveWorkSessionStatus(status);
      // A new run or a return to a healthy idle state rearms attention. If the
      // session later needs the user again, its orange dot must be visible even
      // when an older warning was already opened and acknowledged.
      if (active || !isNeedsAttentionSessionStatus(status)) {
        acknowledgedAttention.delete(sessionId);
      }
      if (active || status === "error" || status === "incomplete" || visibleSessionIds.has(sessionId)) {
        unseen.delete(sessionId);
      } else if (isActiveWorkSessionStatus(previousStatus) && status === "idle") {
        unseen.add(sessionId);
      }
      previousStatusBySessionId[sessionId] = status;
    }

    const unseenSessionIds = [...unseen];
    const acknowledgedAttentionSessionIds = [...acknowledgedAttention];
    const unseenUnchanged = unseenSessionIds.length === state.unseenSessionIds.length
      && unseenSessionIds.every((sessionId, index) => sessionId === state.unseenSessionIds[index]);
    const attentionUnchanged = acknowledgedAttentionSessionIds.length === state.acknowledgedAttentionSessionIds.length
      && acknowledgedAttentionSessionIds.every((sessionId, index) => sessionId === state.acknowledgedAttentionSessionIds[index]);
    return {
      previousStatusBySessionId,
      unseenSessionIds: unseenUnchanged ? state.unseenSessionIds : unseenSessionIds,
      acknowledgedAttentionSessionIds: attentionUnchanged
        ? state.acknowledgedAttentionSessionIds
        : acknowledgedAttentionSessionIds,
    };
  }),

  clear: (sessionId) => set((state) => (
    state.unseenSessionIds.includes(sessionId)
      ? { unseenSessionIds: state.unseenSessionIds.filter((id) => id !== sessionId) }
      : state
  )),

  acknowledgeAttention: (sessionId) => set((state) => (
    state.acknowledgedAttentionSessionIds.includes(sessionId)
      ? state
      : { acknowledgedAttentionSessionIds: [...state.acknowledgedAttentionSessionIds, sessionId] }
  )),
}));

const EMPTY_COMPLETIONS = new Set<string>();

export function useUnseenCompletedSessionIds(): Set<string> {
  const ids = useSessionCompletionStore((state) => state.unseenSessionIds);
  return ids.length ? new Set(ids) : EMPTY_COMPLETIONS;
}

export function useAcknowledgedAttentionSessionIds(): Set<string> {
  const ids = useSessionCompletionStore((state) => state.acknowledgedAttentionSessionIds);
  return ids.length ? new Set(ids) : EMPTY_COMPLETIONS;
}

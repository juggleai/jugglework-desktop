import { create } from "zustand";

import { isActiveWorkSessionStatus, isTerminalSessionStatus } from "./utils";

type SessionCompletionState = {
  unseenSessionIds: string[];
  previousStatusBySessionId: Record<string, string>;
  reconcile: (
    statusBySessionId: Record<string, string>,
    accessibleSessionIds: ReadonlySet<string>,
    visibleSessionIds: ReadonlySet<string>,
  ) => void;
  clear: (sessionId: string) => void;
};

/** In-memory completion markers derived only from status transitions observed this run. */
export const useSessionCompletionStore = create<SessionCompletionState>((set) => ({
  unseenSessionIds: [],
  previousStatusBySessionId: {},

  reconcile: (statusBySessionId, accessibleSessionIds, visibleSessionIds) => set((state) => {
    const unseen = new Set(
      state.unseenSessionIds.filter((sessionId) => (
        accessibleSessionIds.has(sessionId) && !visibleSessionIds.has(sessionId)
      )),
    );
    const previousStatusBySessionId: Record<string, string> = {};

    for (const sessionId of accessibleSessionIds) {
      const status = statusBySessionId[sessionId];
      if (!status) continue;

      const previousStatus = state.previousStatusBySessionId[sessionId];
      const active = isActiveWorkSessionStatus(status);
      if (active || visibleSessionIds.has(sessionId)) {
        unseen.delete(sessionId);
      } else if (isActiveWorkSessionStatus(previousStatus) && isTerminalSessionStatus(status)) {
        unseen.add(sessionId);
      }
      previousStatusBySessionId[sessionId] = status;
    }

    const unseenSessionIds = [...unseen];
    const unchanged = unseenSessionIds.length === state.unseenSessionIds.length
      && unseenSessionIds.every((sessionId, index) => sessionId === state.unseenSessionIds[index]);
    return {
      previousStatusBySessionId,
      unseenSessionIds: unchanged ? state.unseenSessionIds : unseenSessionIds,
    };
  }),

  clear: (sessionId) => set((state) => (
    state.unseenSessionIds.includes(sessionId)
      ? { unseenSessionIds: state.unseenSessionIds.filter((id) => id !== sessionId) }
      : state
  )),
}));

const EMPTY_COMPLETIONS = new Set<string>();

export function useUnseenCompletedSessionIds(): Set<string> {
  const ids = useSessionCompletionStore((state) => state.unseenSessionIds);
  return ids.length ? new Set(ids) : EMPTY_COMPLETIONS;
}

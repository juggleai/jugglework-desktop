import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const PERSISTED_PRESENTATION_PENDING_STORE_KEY = "jugglework:presentation-pending:v1";

type PendingPresentationTurns = Record<string, Record<string, string[]>>;

type PresentationPendingStore = {
  turnsByWorkspaceId: PendingPresentationTurns;
  add: (workspaceId: string, sessionId: string, turnId: string) => void;
  remove: (workspaceId: string, sessionId: string, turnId: string) => void;
};

const EMPTY_TURN_IDS: string[] = [];

export function getPendingPresentationTurnIds(
  state: Pick<PresentationPendingStore, "turnsByWorkspaceId">,
  workspaceId: string,
  sessionId: string,
) {
  return state.turnsByWorkspaceId[workspaceId]?.[sessionId] ?? EMPTY_TURN_IDS;
}

export const usePresentationPendingStore = create<PresentationPendingStore>()(
  persist(
    (set) => ({
      turnsByWorkspaceId: {},
      add: (workspaceId, sessionId, turnId) => set((state) => {
        const turns = getPendingPresentationTurnIds(state, workspaceId, sessionId);
        if (turns.includes(turnId)) return state;
        return {
          turnsByWorkspaceId: {
            ...state.turnsByWorkspaceId,
            [workspaceId]: {
              ...state.turnsByWorkspaceId[workspaceId],
              [sessionId]: [...turns, turnId],
            },
          },
        };
      }),
      remove: (workspaceId, sessionId, turnId) => set((state) => {
        const workspace = state.turnsByWorkspaceId[workspaceId];
        const turns = workspace?.[sessionId];
        if (!workspace || !turns?.includes(turnId)) return state;

        const nextTurns = turns.filter((candidate) => candidate !== turnId);
        const nextWorkspace = { ...workspace };
        if (nextTurns.length > 0) nextWorkspace[sessionId] = nextTurns;
        else delete nextWorkspace[sessionId];

        const turnsByWorkspaceId = { ...state.turnsByWorkspaceId };
        if (Object.keys(nextWorkspace).length > 0) turnsByWorkspaceId[workspaceId] = nextWorkspace;
        else delete turnsByWorkspaceId[workspaceId];
        return { turnsByWorkspaceId };
      }),
    }),
    {
      name: PERSISTED_PRESENTATION_PENDING_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ turnsByWorkspaceId: state.turnsByWorkspaceId }),
    },
  ),
);

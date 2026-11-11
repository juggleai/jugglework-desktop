/**
 * Sidebar-level chat ordering and user-defined sections.
 *
 * Sections group root sessions across workspaces and are a local, per-device
 * view preference (like pins), so they are persisted to localStorage and are
 * never synced to the server. Workspace-scoped session groups remain the
 * server-synced feature in session-management-store.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type ChatSortMode = "recent" | "manual";

export type SidebarSection = {
  id: string;
  label: string;
};

type SidebarSectionsState = {
  sortMode: ChatSortMode;
  sections: SidebarSection[];
  /** Order of top-level sidebar groups: pinned, projects, recent, and custom sections. */
  groupOrder: string[];
  /** sessionId -> sectionId. */
  assignments: Record<string, string>;
  /** Manual order for each list ("recent" or a section id). */
  manualOrder: Record<string, string[]>;
  collapsedSectionIds: string[];
};

type SidebarSectionsActions = {
  setSortMode: (mode: ChatSortMode) => void;
  createSection: (label: string) => string | null;
  renameSection: (sectionId: string, label: string) => void;
  /** Removes the section; its sessions return to Recent. */
  removeSection: (sectionId: string) => void;
  assignSession: (sessionId: string, sectionId: string | null) => void;
  setGroupOrder: (groupIds: string[]) => void;
  setManualOrder: (listId: string, sessionIds: string[]) => void;
  toggleSectionCollapsed: (sectionId: string) => void;
};

export const RECENT_LIST_ID = "recent";
export const PINNED_GROUP_ID = "pinned";
export const PROJECTS_GROUP_ID = "projects";
export const RECENT_GROUP_ID = "recent";
export const SECTION_GROUP_PREFIX = "section:";
export const DEFAULT_SIDEBAR_GROUP_ORDER = [PINNED_GROUP_ID, PROJECTS_GROUP_ID, RECENT_GROUP_ID];
export const MAX_SECTION_LABEL_LENGTH = 60;

export const sidebarSectionGroupId = (sectionId: string) => `${SECTION_GROUP_PREFIX}${sectionId}`;

/** Keeps saved order for known groups and appends newly introduced groups. */
export function normalizeSidebarGroupOrder(saved: readonly string[] | undefined, sectionIds: readonly string[]): string[] {
  const sectionGroupIds = sectionIds.map(sidebarSectionGroupId);
  const available = [PINNED_GROUP_ID, PROJECTS_GROUP_ID, ...sectionGroupIds, RECENT_GROUP_ID];
  const availableSet = new Set(available);
  const used = new Set<string>();
  const normalized = (saved ?? []).filter((id) => availableSet.has(id) && !used.has(id) && Boolean(used.add(id)));
  for (const id of [PROJECTS_GROUP_ID, PINNED_GROUP_ID]) {
    if (!used.has(id)) {
      normalized.unshift(id);
      used.add(id);
    }
  }
  for (const id of sectionGroupIds) {
    if (used.has(id)) continue;
    const recentIndex = normalized.indexOf(RECENT_GROUP_ID);
    normalized.splice(recentIndex >= 0 ? recentIndex : normalized.length, 0, id);
    used.add(id);
  }
  if (!used.has(RECENT_GROUP_ID)) normalized.push(RECENT_GROUP_ID);
  return normalized;
}

export function normalizeSectionLabel(label: string): string {
  return label.replace(/\s+/g, " ").trim().slice(0, MAX_SECTION_LABEL_LENGTH);
}

export const useSidebarSectionsStore = create<SidebarSectionsState & SidebarSectionsActions>()(
  persist(
    (set) => ({
      sortMode: "recent",
      sections: [],
      groupOrder: DEFAULT_SIDEBAR_GROUP_ORDER,
      assignments: {},
      manualOrder: {},
      collapsedSectionIds: [],

      setSortMode: (sortMode) => set({ sortMode }),

      createSection: (label) => {
        const normalized = normalizeSectionLabel(label);
        if (!normalized) return null;
        const id = `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        set((state) => {
          const groupId = sidebarSectionGroupId(id);
          const order = normalizeSidebarGroupOrder(state.groupOrder, state.sections.map((section) => section.id));
          const recentIndex = order.indexOf(RECENT_GROUP_ID);
          const groupOrder = recentIndex >= 0
            ? [...order.slice(0, recentIndex), groupId, ...order.slice(recentIndex)]
            : [...order, groupId];
          return { sections: [...state.sections, { id, label: normalized }], groupOrder };
        });
        return id;
      },

      renameSection: (sectionId, label) => {
        const normalized = normalizeSectionLabel(label);
        if (!normalized) return;
        set((state) => ({
          sections: state.sections.map((section) => (
            section.id === sectionId ? { ...section, label: normalized } : section
          )),
        }));
      },

      removeSection: (sectionId) =>
        set((state) => {
          const assignments = Object.fromEntries(
            Object.entries(state.assignments).filter(([, assigned]) => assigned !== sectionId),
          );
          const { [sectionId]: _removed, ...manualOrder } = state.manualOrder;
          return {
            sections: state.sections.filter((section) => section.id !== sectionId),
            groupOrder: state.groupOrder.filter((id) => id !== sidebarSectionGroupId(sectionId)),
            assignments,
            manualOrder,
            collapsedSectionIds: state.collapsedSectionIds.filter((id) => id !== sectionId),
          };
        }),

      assignSession: (sessionId, sectionId) =>
        set((state) => {
          const assignments = { ...state.assignments };
          if (sectionId && state.sections.some((section) => section.id === sectionId)) {
            assignments[sessionId] = sectionId;
          } else {
            delete assignments[sessionId];
          }
          return { assignments };
        }),

      setGroupOrder: (groupOrder) => set((state) => ({
        groupOrder: normalizeSidebarGroupOrder(groupOrder, state.sections.map((section) => section.id)),
      })),

      setManualOrder: (listId, sessionIds) =>
        set((state) => ({ manualOrder: { ...state.manualOrder, [listId]: sessionIds } })),

      toggleSectionCollapsed: (sectionId) =>
        set((state) => ({
          collapsedSectionIds: state.collapsedSectionIds.includes(sectionId)
            ? state.collapsedSectionIds.filter((id) => id !== sectionId)
            : [...state.collapsedSectionIds, sectionId],
        })),
    }),
    {
      name: "jugglework.react.sidebarSections",
      version: 1,
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<SidebarSectionsState>;
        const sections = saved.sections ?? current.sections;
        return {
          ...current,
          ...saved,
          sections,
          groupOrder: normalizeSidebarGroupOrder(
            saved.groupOrder,
            sections.map((section) => section.id),
          ),
        };
      },
    },
  ),
);

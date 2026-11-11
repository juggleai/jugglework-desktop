import { beforeEach, describe, expect, test } from "bun:test";

import type { WorkspaceSessionGroup } from "../src/app/types";
import {
  applyManualOrder,
  collectRecentSessions,
  partitionRecentSessionsIntoSections,
  sortRootsByRecency,
} from "../src/react-app/domains/session/sidebar/utils";
import {
  PINNED_GROUP_ID,
  PROJECTS_GROUP_ID,
  RECENT_LIST_ID,
  RECENT_GROUP_ID,
  normalizeSectionLabel,
  normalizeSidebarGroupOrder,
  sidebarSectionGroupId,
  useSidebarSectionsStore,
} from "../src/react-app/domains/session/sidebar/sidebar-sections-store";

const groups: WorkspaceSessionGroup[] = [
  {
    workspace: { id: "ws-a", path: "/a", workspaceType: "local" },
    status: "ready",
    sessions: [
      { id: "a-new", title: "A new", time: { updated: 300 } },
      { id: "a-old", title: "A old", time: { updated: 100 } },
    ],
  },
  {
    workspace: { id: "ws-b", path: "/b", workspaceType: "local" },
    status: "ready",
    sessions: [{ id: "b-mid", title: "B mid", time: { updated: 200 } }],
  },
] as WorkspaceSessionGroup[];

const ids = (entries: { session: { id: string } }[]) => entries.map((entry) => entry.session.id);
const recent = () => collectRecentSessions(groups);

describe("manual order", () => {
  test("keeps saved order and places unseen entries first", () => {
    const entries = ["a", "b", "c", "new"];
    expect(applyManualOrder(entries, ["c", "a", "b"], (id) => id)).toEqual(["new", "c", "a", "b"]);
  });

  test("an empty saved order keeps the incoming order", () => {
    expect(applyManualOrder(["x", "y"], [], (id) => id)).toEqual(["x", "y"]);
  });

  test("recency sort is newest first and stable for ties", () => {
    const roots = [
      { id: "old", time: { updated: 1 } },
      { id: "tie-1", time: { updated: 5 } },
      { id: "new", time: { updated: 9 } },
      { id: "tie-2", time: { updated: 5 } },
    ] as never;
    expect(sortRootsByRecency(roots).map((root: { id: string }) => root.id)).toEqual(["new", "tie-1", "tie-2", "old"]);
  });
});

describe("section partitioning", () => {
  const base = { sectionIds: ["sec-1"], sortMode: "recent" as const, manualOrder: {}, recentListId: RECENT_LIST_ID };

  test("assigned sessions leave Recent and keep recency inside the section", () => {
    const result = partitionRecentSessionsIntoSections(recent(), {
      ...base,
      assignments: { "a-old": "sec-1", "a-new": "sec-1" },
    });
    expect(ids(result.recent)).toEqual(["b-mid"]);
    expect(ids(result.bySection.get("sec-1")!)).toEqual(["a-new", "a-old"]);
  });

  test("assignments to deleted sections fall back to Recent", () => {
    const result = partitionRecentSessionsIntoSections(recent(), {
      ...base,
      assignments: { "b-mid": "sec-gone" },
    });
    expect(ids(result.recent)).toEqual(["a-new", "b-mid", "a-old"]);
  });

  test("manual mode applies each list's own saved order", () => {
    const result = partitionRecentSessionsIntoSections(recent(), {
      ...base,
      sortMode: "manual",
      assignments: { "a-new": "sec-1", "a-old": "sec-1" },
      manualOrder: { [RECENT_LIST_ID]: [], "sec-1": ["a-old", "a-new"] },
    });
    expect(ids(result.bySection.get("sec-1")!)).toEqual(["a-old", "a-new"]);
    expect(ids(result.recent)).toEqual(["b-mid"]);
  });

  test("recent mode ignores a saved manual order", () => {
    const result = partitionRecentSessionsIntoSections(recent(), {
      ...base,
      assignments: {},
      manualOrder: { [RECENT_LIST_ID]: ["a-old", "b-mid", "a-new"] },
    });
    expect(ids(result.recent)).toEqual(["a-new", "b-mid", "a-old"]);
  });
});

describe("sidebar sections store", () => {
  beforeEach(() => {
    useSidebarSectionsStore.setState({
      sortMode: "recent",
      sections: [],
      groupOrder: [PINNED_GROUP_ID, PROJECTS_GROUP_ID, RECENT_GROUP_ID],
      assignments: {},
      manualOrder: {},
      collapsedSectionIds: [],
    });
  });

  test("normalizes and rejects blank section names", () => {
    expect(normalizeSectionLabel("  Work   items ")).toBe("Work items");
    expect(useSidebarSectionsStore.getState().createSection("   ")).toBeNull();
    expect(useSidebarSectionsStore.getState().sections).toEqual([]);
  });

  test("creates a section and assigns only to existing sections", () => {
    const store = useSidebarSectionsStore.getState();
    const id = store.createSection("Work")!;
    store.assignSession("s1", id);
    store.assignSession("s2", "missing");
    expect(useSidebarSectionsStore.getState().assignments).toEqual({ s1: id });
    store.assignSession("s1", null);
    expect(useSidebarSectionsStore.getState().assignments).toEqual({});
  });

  test("removing a section returns its chats to Recent and drops its order", () => {
    const store = useSidebarSectionsStore.getState();
    const keep = store.createSection("Keep")!;
    const drop = store.createSection("Drop")!;
    store.assignSession("s1", drop);
    store.assignSession("s2", keep);
    store.setManualOrder(drop, ["s1"]);
    store.toggleSectionCollapsed(drop);
    store.removeSection(drop);
    const state = useSidebarSectionsStore.getState();
    expect(state.sections.map((section) => section.id)).toEqual([keep]);
    expect(state.assignments).toEqual({ s2: keep });
    expect(state.manualOrder[drop]).toBeUndefined();
    expect(state.collapsedSectionIds).toEqual([]);
  });

  test("rename trims and ignores blank labels", () => {
    const store = useSidebarSectionsStore.getState();
    const id = store.createSection("Old")!;
    store.renameSection(id, "  New  ");
    store.renameSection(id, "  ");
    expect(useSidebarSectionsStore.getState().sections[0]?.label).toBe("New");
  });

  test("sort mode switches between recent and manual", () => {
    useSidebarSectionsStore.getState().setSortMode("manual");
    expect(useSidebarSectionsStore.getState().sortMode).toBe("manual");
  });

  test("persists top-level group order and inserts new sections before Recent", () => {
    const store = useSidebarSectionsStore.getState();
    const first = store.createSection("First")!;
    expect(useSidebarSectionsStore.getState().groupOrder).toEqual([
      PINNED_GROUP_ID,
      PROJECTS_GROUP_ID,
      sidebarSectionGroupId(first),
      RECENT_GROUP_ID,
    ]);

    store.setGroupOrder([
      RECENT_GROUP_ID,
      sidebarSectionGroupId(first),
      PROJECTS_GROUP_ID,
      PINNED_GROUP_ID,
    ]);
    expect(useSidebarSectionsStore.getState().groupOrder).toEqual([
      RECENT_GROUP_ID,
      sidebarSectionGroupId(first),
      PROJECTS_GROUP_ID,
      PINNED_GROUP_ID,
    ]);

    const second = store.createSection("Second")!;
    expect(useSidebarSectionsStore.getState().groupOrder).toEqual([
      sidebarSectionGroupId(second),
      RECENT_GROUP_ID,
      sidebarSectionGroupId(first),
      PROJECTS_GROUP_ID,
      PINNED_GROUP_ID,
    ]);
  });

  test("normalizes stale group ids and removes deleted section groups", () => {
    const section = "sec-1";
    expect(normalizeSidebarGroupOrder(undefined, [section])).toEqual([
      PINNED_GROUP_ID,
      PROJECTS_GROUP_ID,
      sidebarSectionGroupId(section),
      RECENT_GROUP_ID,
    ]);
    expect(normalizeSidebarGroupOrder([
      "missing",
      RECENT_GROUP_ID,
      sidebarSectionGroupId(section),
      RECENT_GROUP_ID,
    ], [section])).toEqual([
      PINNED_GROUP_ID,
      PROJECTS_GROUP_ID,
      RECENT_GROUP_ID,
      sidebarSectionGroupId(section),
    ]);

    const store = useSidebarSectionsStore.getState();
    const id = store.createSection("Delete me")!;
    store.setGroupOrder([sidebarSectionGroupId(id), RECENT_GROUP_ID, PROJECTS_GROUP_ID, PINNED_GROUP_ID]);
    store.removeSection(id);
    expect(useSidebarSectionsStore.getState().groupOrder).toEqual([
      RECENT_GROUP_ID,
      PROJECTS_GROUP_ID,
      PINNED_GROUP_ID,
    ]);
  });
});

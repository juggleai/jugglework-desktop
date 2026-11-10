import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem, WorkspaceSessionGroup } from "../src/app/types";
import {
  buildSessionTreeState,
  collectRecentSessions,
  flattenSessionRows,
  isActiveWorkSessionStatus,
  overlayCoordinatorSessionRuns,
  resolveWorkspaceSessionIndicator,
} from "../src/react-app/domains/session/sidebar/utils";

const sessions: SidebarSessionItem[] = [
  { id: "session-a", title: "Pinned root" },
  { id: "session-a-child", title: "Pinned child", parentID: "session-a" },
  { id: "session-b", title: "Regular root" },
];

describe("global session pinning", () => {
  test("shows only the pinned main session even when it has expanded children", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(["session-a"]),
      new Set(),
      new Set(["session-a"]),
      [],
      { include: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-a"]);
  });

  test("does not promote an orphaned child into the main session list", () => {
    const orphaned = [
      ...sessions,
      { id: "session-orphan", title: "Orphan child", parentID: "missing-parent" },
    ];
    const tree = buildSessionTreeState(orphaned, undefined);
    const rows = flattenSessionRows(
      orphaned,
      10,
      tree,
      new Set(),
      new Set(),
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-a", "session-b"]);
  });

  test("removes pinned roots before applying the workspace preview limit", () => {
    const tree = buildSessionTreeState(sessions, undefined);
    const rows = flattenSessionRows(
      sessions,
      1,
      tree,
      new Set(),
      new Set(),
      new Set(),
      [],
      { exclude: new Set(["session-a"]) },
    );

    expect(rows.map((row) => row.session.id)).toEqual(["session-b"]);
  });
});

describe("local recent sessions", () => {
  test("merges workspaces by latest activity and omits children, archived sessions, and pinned roots", () => {
    const groups: WorkspaceSessionGroup[] = [
      {
        workspace: { id: "workspace-a", path: "/a", workspaceType: "local" },
        status: "ready",
        sessions: [
          { id: "older", title: "Older", time: { created: 10, updated: 20 } },
          { id: "newest", title: "Newest", time: { created: 10, updated: 60 } },
          { id: "child", title: "Child", parentID: "newest", time: { updated: 100 } },
          { id: "archived", title: "Archived", time: { updated: 90, archived: 91 } },
        ],
      },
      {
        workspace: { id: "workspace-b", path: "/b", workspaceType: "local" },
        status: "ready",
        sessions: [
          { id: "pinned", title: "Pinned", time: { updated: 80 } },
          { id: "middle", title: "Middle", time: { created: 40 } },
        ],
      },
    ];

    expect(collectRecentSessions(groups, new Set(["pinned"])).map((entry) => (
      `${entry.group.workspace.id}:${entry.session.id}`
    ))).toEqual([
      "workspace-a:newest",
      "workspace-b:middle",
      "workspace-a:older",
    ]);
  });
});

describe("workspace session indicator", () => {
  test("treats incomplete as a terminal result rather than active work", () => {
    expect(isActiveWorkSessionStatus("incomplete")).toBe(false);
    expect(isActiveWorkSessionStatus("error")).toBe(false);
    expect(isActiveWorkSessionStatus("waiting")).toBe(false);
    expect(isActiveWorkSessionStatus("thinking")).toBe(true);
    expect(isActiveWorkSessionStatus("responding")).toBe(true);

    expect(resolveWorkspaceSessionIndicator(
      sessions,
      { "session-a": "incomplete", "session-b": "idle" },
      new Set(),
    )).toBeNull();
  });

  test("prioritizes running work across multiple sessions", () => {
    expect(resolveWorkspaceSessionIndicator(
      sessions,
      { "session-a": "idle", "session-b": "responding" },
      new Set(["session-a"]),
    )).toBe("running");
  });

  test("keeps a coordinator-owned task running across a transient engine idle", () => {
    const status = overlayCoordinatorSessionRuns(
      { "session-a": "idle", "session-b": "idle" },
      new Set(["session-a"]),
    );
    expect(status).toEqual({ "session-a": "running", "session-b": "idle" });
    expect(resolveWorkspaceSessionIndicator(sessions, status, new Set(["session-a"]))).toBe("running");
  });

  test("shows unread after every session becomes idle", () => {
    expect(resolveWorkspaceSessionIndicator(
      sessions,
      { "session-a": "idle", "session-b": "idle" },
      new Set(["session-a"]),
    )).toBe("completed");
  });

  test("hides the indicator after all results are read", () => {
    expect(resolveWorkspaceSessionIndicator(
      sessions,
      { "session-a": "idle", "session-b": "idle" },
      new Set(),
    )).toBeNull();
  });

  test("ignores unread child sessions that are not directly accessible in the sidebar", () => {
    expect(resolveWorkspaceSessionIndicator(
      sessions.filter((session) => !session.parentID),
      { "session-a": "idle", "session-a-child": "idle", "session-b": "idle" },
      new Set(["session-a-child"]),
    )).toBeNull();
  });
});

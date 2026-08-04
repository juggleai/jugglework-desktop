import { describe, expect, test } from "bun:test";

import type { SidebarSessionItem } from "../src/app/types";
import {
  buildSessionTreeState,
  flattenSessionRows,
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

import { describe, expect, test } from "bun:test";

import { buildCommandPaletteSessions } from "../src/react-app/shell/command-palette-sessions";
import type { RouteSession, RouteWorkspace } from "../src/react-app/shell/route-workspaces";

describe("command palette sessions", () => {
  test("lists main sessions and hides child sessions", () => {
    const workspace = {
      id: "workspace-a",
      displayName: "Workspace A",
    } as RouteWorkspace;
    const sessions = [
      {
        id: "session-main",
        title: "Main session",
        parentID: null,
        time: { created: 10, updated: 20 },
      },
      {
        id: "session-child",
        title: "Child session",
        parentID: "session-main",
        time: { created: 11, updated: 21 },
      },
    ] as RouteSession[];

    const options = buildCommandPaletteSessions(
      [workspace],
      { [workspace.id]: sessions },
      workspace.id,
    );

    expect(options.map((option) => option.sessionId)).toEqual(["session-main"]);
  });
});

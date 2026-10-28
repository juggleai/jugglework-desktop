import { expect, test } from "bun:test";
import { groupPetSessions } from "../src/pet/session-groups";
import type { PetTarget } from "../src/app/lib/desktop-pet-types";

test("groups interleaved conversations by workspace while retaining recency order and distinct IDs", () => {
  const target = (workspaceId: string, project: string, sessionId: string): PetTarget => ({
    key: `${workspaceId}:${sessionId}`, workspaceId, sessionId, project, title: sessionId,
  });
  const sessions = [target("new", "同名项目", "latest"), target("older", "同名项目", "second"), target("new", "同名项目", "third")];
  expect(groupPetSessions(sessions)).toEqual([
    { workspaceId: "new", project: "同名项目", sessions: [sessions[0], sessions[2]] },
    { workspaceId: "older", project: "同名项目", sessions: [sessions[1]] },
  ]);
  expect(groupPetSessions([])).toEqual([]);
});

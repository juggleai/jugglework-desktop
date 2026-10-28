import { expect, test } from "bun:test";
import { interactionForBridge } from "../src/pet/interaction-sync";
import type { PetInteraction } from "../src/app/lib/desktop-pet-types";

test("IME composition keeps its draft private while persisting a card dismissal and target change", () => {
  const target = { key: "workspace:task", workspaceId: "workspace", sessionId: "task", project: "项目", title: "任务" };
  const current: PetInteraction = {
    drafts: { "workspace:task": "ni", __quick__: "其他草稿" }, targets: {},
    dismissed: { "workspace:task": "turn-1" }, target,
  };
  const sent = interactionForBridge(current, { key: "workspace:task", persistedDraft: "旧草稿" });
  expect(sent).toEqual({ ...current, drafts: { "workspace:task": "旧草稿", __quick__: "其他草稿" } });
  expect(current.drafts["workspace:task"]).toBe("ni");
  expect(interactionForBridge(current, null)).toBe(current);
});

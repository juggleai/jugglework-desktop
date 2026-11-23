import { expect, test } from "bun:test";

import type { DenProductTaskActivityItem } from "../src/app/lib/den";
import { formatTaskActivityTime, groupTaskActivity } from "../src/react-app/domains/tasks/task-activity-view";

function activity(id: string, sequence: number, occurredAt: string): DenProductTaskActivityItem {
  return {
    event: { id, sequence, eventType: "task.updated", payloadVersion: 1, taskId: `task_${id}`, taskVersion: 1, listId: null, actorMemberId: "member_one", affectedMemberId: null, occurredAt, payload: {} },
    readAt: null,
    attentionLevel: "attention",
    task: { id: `task_${id}`, displayNumber: null, title: id, accessible: true, deleted: false },
    list: null,
    actor: { memberId: "member_one", name: "Alice", avatar: null },
  };
}

test("groups activity by local calendar time and keeps descending server sequence", () => {
  const now = new Date(2026, 10, 11, 15, 0);
  const groups = groupTaskActivity([
    activity("older-today", 8, new Date(2026, 10, 11, 9, 0).toISOString()),
    activity("latest-today", 10, new Date(2026, 10, 11, 14, 0).toISOString()),
    activity("yesterday", 7, new Date(2026, 10, 10, 14, 0).toISOString()),
    activity("week", 6, new Date(2026, 10, 7, 14, 0).toISOString()),
    activity("older", 5, new Date(2026, 9, 1, 14, 0).toISOString()),
  ], now);

  expect(groups.map((group) => [group.key, group.items.map((item) => item.event.id)])).toEqual([
    ["today", ["latest-today", "older-today"]],
    ["yesterday", ["yesterday"]],
    ["week", ["week"]],
    ["2026-10-01", ["older"]],
  ]);
});

test("activity shows a date only outside the current local calendar day", () => {
  const now = new Date(2026, 10, 23, 15, 0);
  const format = (year: number, month: number, day: number, hour: number, minute: number) =>
    formatTaskActivityTime(new Date(year, month, day, hour, minute).toISOString(), now, "zh-CN");

  expect(format(2026, 10, 23, 0, 5)).toBe("00:05");
  expect(format(2026, 10, 22, 14, 30)).toBe("11月22日 14:30");
  expect(format(2025, 10, 23, 14, 30)).toBe("2025年11月23日 14:30");
  expect(formatTaskActivityTime("invalid", now)).toBe("");
});

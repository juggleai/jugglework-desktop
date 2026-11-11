import { expect, test } from "bun:test";

import type { DenProductTask } from "../src/app/lib/den";
import { groupTodayTasks } from "../src/react-app/domains/tasks/today-task-view";

function task(id: string, input: Partial<DenProductTask> = {}): DenProductTask {
  return {
    id,
    displayNumber: null,
    creatorMemberId: "member_self",
    listId: null,
    title: id,
    description: "",
    priority: "none",
    visibility: "private",
    completionPolicy: "any_assignee",
    status: "todo",
    version: 1,
    startAt: null,
    dueAt: null,
    completedAt: null,
    completedByMemberId: null,
    canceledAt: null,
    canceledByMemberId: null,
    deletedAt: null,
    restoreUntil: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...input,
  };
}

test("groups Today tasks exclusively with overdue and due-today taking precedence", () => {
  const now = new Date(2026, 10, 11, 15, 0);
  const groups = groupTodayTasks([
    task("overdue", { dueAt: new Date(2026, 10, 11, 10, 0).toISOString(), startAt: new Date(2026, 10, 11).toISOString() }),
    task("date_only_today", { dueAt: new Date(2026, 10, 11).toISOString(), startAt: new Date(2026, 10, 11).toISOString() }),
    task("starts_today", { startAt: new Date(2026, 10, 11, 9, 0).toISOString() }),
  ], now);

  expect(groups.map((group) => [group.key, group.tasks.map((item) => item.id)])).toEqual([
    ["overdue", ["overdue"]],
    ["due_today", ["date_only_today"]],
    ["starts_today", ["starts_today"]],
  ]);
});

test("excludes non-todo tasks from the Today action groups", () => {
  const now = new Date(2026, 10, 11, 15, 0);
  expect(groupTodayTasks([
    task("completed", { status: "completed", dueAt: new Date(2026, 10, 11).toISOString() }),
    task("canceled", { status: "canceled", startAt: new Date(2026, 10, 11).toISOString() }),
    task("future", { dueAt: new Date(2026, 10, 12).toISOString() }),
    task("unscheduled"),
  ], now)).toEqual([]);
});

import { beforeEach, expect, test } from "bun:test";

import type { DenProductTask } from "../src/app/lib/den";
import { productTaskEditDraft, readTaskSection, reapplyProductTaskDraft, taskSectionStorageKey, writeTaskSection } from "../src/react-app/domains/tasks/task-page-state";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  },
});

const scopeA = { baseUrl: "https://work.example/", userId: "user_one", organizationId: "org_a" };
const scopeB = { baseUrl: "https://work.example", userId: "user_one", organizationId: "org_b" };
const latestTask: DenProductTask = {
  id: "task_one",
  displayNumber: 100001,
  creatorMemberId: "member_one",
  listId: null,
  title: "Server title",
  description: "Server description",
  priority: "none",
  visibility: "private",
  status: "todo",
  version: 7,
  startAt: null,
  dueAt: null,
  completedAt: null,
  completedByMemberId: null,
  canceledAt: null,
  canceledByMemberId: null,
  deletedAt: null,
  restoreUntil: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T01:00:00Z",
};

beforeEach(() => storage.clear());

test("task section persistence is isolated by user and organization", () => {
  expect(taskSectionStorageKey(scopeA)).not.toBe(taskSectionStorageKey(scopeB));
  writeTaskSection(scopeA, "following");
  writeTaskSection(scopeB, "completed");

  expect(readTaskSection(scopeA)).toBe("following");
  expect(readTaskSection(scopeB)).toBe("completed");
});

test("hidden and invalid persisted sections migrate to Today", () => {
  for (const section of ["inbox", "trash", "archived", "unknown"]) {
    storage.set(taskSectionStorageKey(scopeA), section);
    expect(readTaskSection(scopeA)).toBe("today");
    expect(storage.get(taskSectionStorageKey(scopeA))).toBe("today");
  }
});

test("delegated section persists as a visible section", () => {
  writeTaskSection(scopeA, "delegated");
  expect(readTaskSection(scopeA)).toBe("delegated");
});

test("conflict draft survives latest task data and adopts its version for retry", () => {
  const draft = productTaskEditDraft("task_one", {
    expectedVersion: 3,
    idempotencyKey: "first-attempt",
    title: "My draft title",
    description: "My draft description",
  });

  expect(reapplyProductTaskDraft(latestTask, draft)).toEqual({
    taskId: "task_one",
    title: "My draft title",
    description: "My draft description",
    expectedVersion: 7,
  });
});

test("an unrelated draft never overwrites the selected task", () => {
  const draft = productTaskEditDraft("task_two", {
    expectedVersion: 2,
    idempotencyKey: "other-attempt",
    title: "Other draft",
    description: "Other description",
  });

  expect(reapplyProductTaskDraft(latestTask, draft)).toMatchObject({
    taskId: "task_one",
    title: "Server title",
    description: "Server description",
    expectedVersion: 7,
  });
});

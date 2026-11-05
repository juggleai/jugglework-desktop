import { beforeEach, expect, test } from "bun:test";

import { defaultTaskWorkbenchSettings, readTaskWorkbenchSettings, reorderTaskWorkbenchFields, taskWorkbenchFields, taskWorkbenchStorageKey, writeTaskWorkbenchSettings } from "../src/react-app/domains/tasks/task-view-state";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
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

beforeEach(() => storage.clear());

test("assigned workbench persistence is isolated by ProductTask scope", () => {
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, view: "board", status: "all", fields: ["due", "list"] });
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ view: "board", status: "all", fields: ["due", "list"] });
  expect(readTaskWorkbenchSettings(scopeB)).toEqual(defaultTaskWorkbenchSettings);
  expect(taskWorkbenchStorageKey(scopeA)).not.toBe(taskWorkbenchStorageKey(scopeB));
});

test("assigned workbench safely parses malformed and unknown persisted values", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), "not-json");
  expect(readTaskWorkbenchSettings(scopeA)).toEqual(defaultTaskWorkbenchSettings);
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ view: "dashboard", status: "bad", sort: "unsupported", fields: ["due", "unknown"] }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ view: "list", status: "incomplete", sort: "updated_at", fields: ["due"] });
});

test("assigned workbench migrates removed priority sorting to updated time descending", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ sort: "priority", direction: "asc" }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ sort: "updated_at", direction: "asc" });
});

test("assigned workbench upgrades the former default columns with assignee and task times", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fields: ["creator", "created", "id", "list"] }));
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual(["assignee", "start", "due", "creator", "created", "id", "list"]);
});

test("assigned workbench preserves an intentional legacy-sized selection after field ordering is available", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fieldOrder: taskWorkbenchFields, fields: ["creator", "created", "id", "list"] }));
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual(["creator", "created", "id", "list"]);
});

test("assigned workbench can persist all optional fields as hidden", () => {
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, fields: [] });
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual([]);
});

test("assigned workbench deduplicates filters and restores fields in table order", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ priorities: ["high", "low", "high"], listIds: ["two", "one", "two"], assigneeMemberIds: ["member_two", "member_one", "member_two"], assigneeMemberOperator: "not_contains", assignerMemberIds: ["member_assigner"], assignerMemberOperator: "empty", creatorMemberIds: ["member_creator"], creatorMemberOperator: "not_empty", followerMemberIds: ["member_follower"], fields: ["id", "due", "id"] }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ priorities: ["high", "low"], listIds: ["two", "one"], assigneeMemberIds: ["member_two", "member_one"], assigneeMemberOperator: "not_contains", assignerMemberIds: ["member_assigner"], assignerMemberOperator: "empty", creatorMemberIds: ["member_creator"], creatorMemberOperator: "not_empty", followerMemberIds: ["member_follower"], followerMemberOperator: "contains", fields: ["due", "id"] });
});

test("assigned workbench persists custom field order and appends newly supported fields", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fieldOrder: ["id", "due", "assignee"], fields: ["assignee", "id", "due"] }));
  const settings = readTaskWorkbenchSettings(scopeA);
  expect(settings.fieldOrder.slice(0, 3)).toEqual(["id", "due", "assignee"]);
  expect(settings.fieldOrder).toHaveLength(taskWorkbenchFields.length);
  expect(settings.fields).toEqual(["id", "due", "assignee"]);
});

test("field reorder helper moves the source before the target without mutating input", () => {
  const original = [...taskWorkbenchFields];
  const reordered = reorderTaskWorkbenchFields(original, "due", "assignee");
  expect(reordered.slice(0, 3)).toEqual(["due", "assignee", "start"]);
  expect(original).toEqual(taskWorkbenchFields);
});

test("assigned workbench clears an incompatible persisted overdue completed filter", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ status: "completed", overdue: true }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ status: "completed", overdue: false });
});

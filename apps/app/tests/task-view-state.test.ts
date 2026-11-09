import { beforeEach, expect, test } from "bun:test";

import { defaultTaskWorkbenchSettings, readTaskWorkbenchSettings, reorderTaskWorkbenchFields, taskSectionDefaultSettings, taskWorkbenchFields, taskWorkbenchStorageKey, writeTaskWorkbenchSettings } from "../src/react-app/domains/tasks/task-view-state";

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

test("workbench persistence is also isolated by task section", () => {
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, view: "board" }, "following");
  expect(readTaskWorkbenchSettings(scopeA, "following").view).toBe("board");
  expect(readTaskWorkbenchSettings(scopeA, "assigned").view).toBe("list");
  expect(taskWorkbenchStorageKey(scopeA, "following")).not.toBe(taskWorkbenchStorageKey(scopeA, "assigned"));
});

test("each task-list workbench has an isolated custom-group default", () => {
  expect(readTaskWorkbenchSettings(scopeA, "all", "list_one").group).toBe("custom");
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, group: "due" }, "all", "list_one");
  expect(readTaskWorkbenchSettings(scopeA, "all", "list_one").group).toBe("due");
  expect(readTaskWorkbenchSettings(scopeA, "all", "list_two").group).toBe("custom");
  expect(taskWorkbenchStorageKey(scopeA, "all", "list_one")).not.toBe(taskWorkbenchStorageKey(scopeA, "all", "list_two"));
});

test("task sections populate editable current-member default settings", () => {
  expect(taskSectionDefaultSettings("assigned", "member_self")).toMatchObject({ assigneeMemberIds: ["member_self"], assigneeMemberOperator: "contains" });
  expect(taskSectionDefaultSettings("following", "member_self")).toMatchObject({ followerMemberIds: ["member_self"], followerMemberOperator: "contains", creatorMemberIds: ["member_self"], creatorMemberOperator: "not_contains", assigneeMemberIds: ["member_self"], assigneeMemberOperator: "not_contains" });
  expect(taskSectionDefaultSettings("created", "member_self")).toMatchObject({ creatorMemberIds: ["member_self"], creatorMemberOperator: "contains" });
  expect(taskSectionDefaultSettings("delegated", "member_self")).toMatchObject({ assigneeMemberIds: ["member_self"], assigneeMemberOperator: "not_contains", assignerMemberIds: ["member_self"], assignerMemberOperator: "contains" });
  expect(taskSectionDefaultSettings("all", "member_self")).toMatchObject({ status: "all", assigneeMemberIds: [], creatorMemberIds: [] });
  expect(taskSectionDefaultSettings("completed", "member_self")).toMatchObject({ status: "completed", assigneeMemberIds: [], creatorMemberIds: [] });
});

test("all and completed populate their initial statuses while later status settings remain editable", () => {
  expect(readTaskWorkbenchSettings(scopeA, "all").status).toBe("all");
  expect(readTaskWorkbenchSettings(scopeA, "completed").status).toBe("completed");
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, status: "all", overdue: true }, "completed");
  expect(readTaskWorkbenchSettings(scopeA, "completed")).toMatchObject({ status: "all", overdue: true });
});

test("assigned workbench persists custom grouping", () => {
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, group: "custom", customGroupName: "Planning", customGroups: [{ id: "custom-backlog", name: "Backlog" }], customGroupAssignments: { task_one: "custom-backlog" } });
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ group: "custom", customGroupName: "Planning", customGroups: [{ id: "custom-backlog", name: "Backlog" }], customGroupAssignments: { task_one: "custom-backlog" } });
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ group: "unsupported" }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ group: "none", customGroupName: "", customGroups: [], customGroupAssignments: {} });
});

test("assigned workbench trims and bounds a persisted custom group name", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ group: "custom", customGroupName: `  ${"a".repeat(100)}  ` }));
  expect(readTaskWorkbenchSettings(scopeA).customGroupName).toBe("a".repeat(80));
});

test("assigned workbench validates, deduplicates, and bounds persisted custom groups", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ customGroups: [
    { id: " group-one ", name: " First " },
    { id: "group-one", name: "Duplicate" },
    { id: "custom-default", name: "Reserved" },
    { id: "group-two", name: "a".repeat(100) },
    { id: "", name: "Missing ID" },
  ] }));
  expect(readTaskWorkbenchSettings(scopeA).customGroups).toEqual([
    { id: "group-one", name: "First" },
    { id: "group-two", name: "a".repeat(80) },
  ]);
});

test("assigned workbench drops custom task assignments for missing groups", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({
    customGroups: [{ id: "custom-backlog", name: "Backlog" }],
    customGroupAssignments: { task_one: "custom-backlog", task_two: "custom-missing", "": "custom-backlog" },
  }));
  expect(readTaskWorkbenchSettings(scopeA).customGroupAssignments).toEqual({ task_one: "custom-backlog" });
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
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual(["assignee", "start", "due", "creator", "created", "id", "priority", "list"]);
});

test("assigned workbench preserves an intentional legacy-sized selection after field ordering is available", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fieldOrder: taskWorkbenchFields, fields: ["creator", "created", "id", "list"] }));
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual(["creator", "created", "id", "list"]);
});

test("assigned workbench inserts the new visible priority field immediately before a legacy list field", () => {
  const legacyOrder = taskWorkbenchFields.filter((field) => field !== "priority");
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fieldOrder: legacyOrder, fields: ["id", "list"] }));
  const settings = readTaskWorkbenchSettings(scopeA);
  expect(settings.fieldOrder.slice(-3)).toEqual(["id", "priority", "list"]);
  expect(settings.fields).toEqual(["id", "priority", "list"]);
});

test("assigned workbench preserves an intentional hidden priority after the new field is known", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ fieldOrder: taskWorkbenchFields, fields: ["id", "list"] }));
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual(["id", "list"]);
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

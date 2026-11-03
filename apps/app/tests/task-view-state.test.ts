import { beforeEach, expect, test } from "bun:test";

import { defaultTaskWorkbenchSettings, readTaskWorkbenchSettings, taskWorkbenchStorageKey, writeTaskWorkbenchSettings } from "../src/react-app/domains/tasks/task-view-state";

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

test("assigned workbench can persist all optional fields as hidden", () => {
  writeTaskWorkbenchSettings(scopeA, { ...defaultTaskWorkbenchSettings, fields: [] });
  expect(readTaskWorkbenchSettings(scopeA).fields).toEqual([]);
});

test("assigned workbench deduplicates persisted arrays while preserving order", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ priorities: ["high", "low", "high"], listIds: ["two", "one", "two"], fields: ["due", "id", "due"] }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ priorities: ["high", "low"], listIds: ["two", "one"], fields: ["due", "id"] });
});

test("assigned workbench clears an incompatible persisted overdue completed filter", () => {
  storage.set(taskWorkbenchStorageKey(scopeA), JSON.stringify({ status: "completed", overdue: true }));
  expect(readTaskWorkbenchSettings(scopeA)).toMatchObject({ status: "completed", overdue: false });
});

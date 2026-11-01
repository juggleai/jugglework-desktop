import { expect, test } from "bun:test";

import type { DenProductTaskPage } from "../src/app/lib/den";
import { flattenProductTaskPages, productTaskKeys } from "../src/react-app/domains/tasks/task-queries";

const task = (id: string) => ({ id, creatorMemberId: "creator", listId: null, title: id, description: "", priority: "none" as const, visibility: "private" as const, status: "todo" as const, version: 1, startAt: null, dueAt: null, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });

test("product task query keys isolate deployment user organization and filters", () => {
  const one = productTaskKeys.list({ baseUrl: "https://one.example/", userId: "user_one", organizationId: "org_one" }, { view: "today", search: "one" });
  const two = productTaskKeys.list({ baseUrl: "https://one.example", userId: "user_two", organizationId: "org_one" }, { view: "today", search: "one" });
  expect(one).not.toEqual(two);
  expect(one).toContain("https://one.example");
  expect(one.at(-1)).toEqual({ view: "today", search: "one" });
});

test("flattenProductTaskPages preserves order and removes cursor overlap", () => {
  const pages: DenProductTaskPage[] = [{ items: [task("one"), task("two")], nextCursor: "two" }, { items: [task("two"), task("three")], nextCursor: "" }];
  expect(flattenProductTaskPages({ pages }).map((item) => item.id)).toEqual(["one", "two", "three"]);
});

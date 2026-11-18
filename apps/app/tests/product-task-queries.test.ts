import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import type { DenProductTaskPage } from "../src/app/lib/den";
import { applyTaskListMembership, flattenProductTaskMembers, flattenProductTaskPages, loadAllProductTaskLists, productTaskKeys } from "../src/react-app/domains/tasks/task-queries";

const task = (id: string) => ({ id, displayNumber: null, creatorMemberId: "creator", listId: null, title: id, description: "", priority: "none" as const, visibility: "private" as const, status: "todo" as const, version: 1, startAt: null, dueAt: null, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });

test("product task query keys isolate deployment user organization and filters", () => {
  const one = productTaskKeys.list({ baseUrl: "https://one.example/", userId: "user_one", organizationId: "org_one" }, { view: "today", search: "one" });
  const two = productTaskKeys.list({ baseUrl: "https://one.example", userId: "user_two", organizationId: "org_one" }, { view: "today", search: "one" });
  expect(one).not.toEqual(two);
  expect(one).toContain("https://one.example");
  expect(one.at(-1)).toEqual({ view: "today", search: "one" });
  expect(productTaskKeys.list({ baseUrl: "https://one.example", userId: "user_one", organizationId: "org_one" }, { view: "delegated" }).at(-1)).toEqual({ view: "delegated" });
});

test("flattenProductTaskPages preserves order and removes cursor overlap", () => {
  const pages: DenProductTaskPage[] = [{ items: [task("one"), task("two")], membersByTaskId: { one: [{ memberId: "member_one", role: "assignee" }], two: [] }, nextCursor: "two" }, { items: [task("two"), task("three")], membersByTaskId: { two: [{ memberId: "late", role: "assignee" }], three: [{ memberId: "member_three", role: "follower" }] }, nextCursor: "" }];
  expect(flattenProductTaskPages({ pages }).map((item) => item.id)).toEqual(["one", "two", "three"]);
  expect(flattenProductTaskMembers({ pages })).toEqual({ one: [{ memberId: "member_one", role: "assignee" }], two: [], three: [{ memberId: "member_three", role: "follower" }] });
});

test("membership removal updates cached pages by any matching list and only in the originating scope", () => {
  const client = new QueryClient();
  const scope = { baseUrl: "https://one.example", userId: "u", organizationId: "o" };
  const onlyRemoved = productTaskKeys.list(scope, { listId: ["one"] });
  const either = productTaskKeys.list(scope, { listId: ["one", "two"] });
  const other = productTaskKeys.list({ ...scope, userId: "other" }, { listId: ["one"] });
  const data = { pages: [{ items: [{ ...task("t"), listIds: ["one", "two"] }], nextCursor: "" }], pageParams: [undefined] };
  for (const key of [onlyRemoved, either, other]) client.setQueryData(key, data);
  applyTaskListMembership(client, scope, { taskId: "t", listId: "one", added: false });
  expect(client.getQueryData<typeof data>(onlyRemoved)?.pages[0]?.items).toEqual([]);
  expect(client.getQueryData<typeof data>(either)?.pages[0]?.items[0]?.listIds).toEqual(["two"]);
  expect(client.getQueryData(other)).toEqual(data);
  client.clear();
});

test("task-list pagination deduplicates list IDs while preserving first order", async () => {
  const list = (id: string, name: string) => ({ id, creatorMemberId: "creator", name, description: "", marker: "#", visibility: "private" as const, version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" });
  const cursors: Array<string | undefined> = [];
  const client = {
    listProductTaskLists: async (_orgId: string, options: { cursor?: string }) => {
      cursors.push(options.cursor);
      return options.cursor
        ? { items: [list("two", "duplicate"), list("three", "Three")], nextCursor: "" }
        : { items: [list("one", "One"), list("two", "Two")], nextCursor: "next" };
    },
  };
  const page = await loadAllProductTaskLists({ client: client as never, organizationId: "org", archived: false });
  expect(cursors).toEqual([undefined, "next"]);
  expect(page.items.map((item) => [item.id, item.name])).toEqual([["one", "One"], ["two", "Two"], ["three", "Three"]]);
});

test("task-list pagination rejects a repeated cursor", async () => {
  const client = { listProductTaskLists: async () => ({ items: [], nextCursor: "same" }) };
  await expect(loadAllProductTaskLists({ client: client as never, organizationId: "org", archived: false })).rejects.toMatchObject({ code: "invalid_task_list_pagination" });
});

import { afterEach, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const task = {
  id: "task/one", creatorMemberId: "member_one", listId: null, title: "Follow up", description: "", priority: "none", visibility: "private", status: "todo", version: 1,
  startAt: null, dueAt: null, completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, deletedByMemberId: null,
  restoreUntil: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};
const result = { task, members: [], permissions: { canView: true, canEditContent: true, canEditTime: true, canManageMembers: true, canManageVisibility: true, canComplete: true, canReopen: false, canCancel: true, canComment: true, canDelete: true, canRestore: false }, tombstone: false, replayed: false };

test("product task client sends scoped pagination and strict mutations", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    if (String(input).includes("/tasks/task%2Fone")) return Response.json(result);
    if (init?.method === "POST") return Response.json(result, { status: 201 });
    return Response.json({ items: [task], nextCursor: "cursor_two" });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTasks("org_one", { view: "today", cursor: "cursor one", limit: 30 });
  expect(page.nextCursor).toBe("cursor_two");
  expect(requests[0]!.url).toContain("view=today");
  expect(requests[0]!.url).toContain("cursor=cursor+one");
  expect(new Headers(requests[0]!.init?.headers).get("Authorization")).toBe("Bearer token_one");
  expect(new Headers(requests[0]!.init?.headers).get("x-jugglework-legacy-org-id")).toBe("org_one");
  await client.getProductTask("org_one", "task/one");
  expect(requests[1]!.url).toContain("/tasks/task%2Fone");
  await client.createProductTask("org_one", { idempotencyKey: "create-one", title: "Follow up", visibility: "private" });
  expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({ idempotencyKey: "create-one", title: "Follow up", visibility: "private" });
});

test("product task client preserves version conflict details", async () => {
  globalThis.fetch = async () => Response.json({ error: "task_version_conflict", message: "changed", details: { currentVersion: 7 } }, { status: 409 });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  try {
    await client.updateProductTask("org_one", "task_one", { expectedVersion: 1, idempotencyKey: "update-one", title: "Draft" });
    throw new Error("expected conflict");
  } catch (error) {
    expect(error).toBeInstanceOf(DenApiError);
    expect((error as DenApiError).status).toBe(409);
    expect((error as DenApiError).details).toEqual({ currentVersion: 7 });
  }
});

test("product task client rejects malformed pages", async () => {
  globalThis.fetch = async () => Response.json({ items: [{ id: "bad" }], nextCursor: "" });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  await expect(client.listProductTasks("org_one")).rejects.toMatchObject({ code: "invalid_task_page" });
});

test("product task client reads strictly validated notification events", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({ items: [{ sequence: 9, id: "event_one", type: "reminder_due", occurredAt: "2026-11-01T10:00:00Z", task: { id: "task/one", title: "Follow up" }, reminder: { scheduledAt: "2026-11-01T10:00:00Z" } }], nextSequence: 9, hasMore: false });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTaskNotificationEvents("org_one", { afterSequence: 8, limit: 50 });
  expect(page.items[0]?.task.id).toBe("task/one");
  expect(requests[0]).toContain("/v1/task-events?afterSequence=8&limit=50");

  globalThis.fetch = async () => Response.json({ items: [{ id: "bad" }], nextSequence: 9, hasMore: false });
  await expect(client.listProductTaskNotificationEvents("org_one", { afterSequence: 8 })).rejects.toMatchObject({ code: "invalid_task_events" });
});

import { afterEach, expect, test } from "bun:test";

import { createDenClient, DenApiError } from "../src/app/lib/den";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const task = {
  id: "task/one", displayNumber: 100134, creatorMemberId: "member_one", listId: null, title: "Follow up", description: "", priority: "none", visibility: "private", completionPolicy: "all_assignees", status: "todo", version: 1,
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
    return Response.json({ items: [task], membersByTaskId: { "task/one": [{ memberId: "member_two", role: "assignee" }] }, nextCursor: "cursor_two" });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTasks("org_one", { view: "today", cursor: "cursor one", limit: 30 });
  expect(page.nextCursor).toBe("cursor_two");
  expect(page.items[0]?.displayNumber).toBe(100134);
  expect(page.items[0]?.completionPolicy).toBe("all_assignees");
  expect(page.membersByTaskId["task/one"]?.[0]).toEqual({ memberId: "member_two", role: "assignee", createdByMemberId: undefined, createdAt: undefined, completedAt: null });
  expect(requests[0]!.url).toContain("view=today");
  expect(requests[0]!.url).toContain("cursor=cursor+one");
  expect(new Headers(requests[0]!.init?.headers).get("Authorization")).toBe("Bearer token_one");
  expect(new Headers(requests[0]!.init?.headers).get("x-jugglework-legacy-org-id")).toBe("org_one");
  await client.getProductTask("org_one", "task/one");
  expect(requests[1]!.url).toContain("/tasks/task%2Fone");
  await client.createProductTask("org_one", { idempotencyKey: "create-one", title: "Follow up", visibility: "private" });
  expect(JSON.parse(String(requests[2]!.init?.body))).toEqual({ idempotencyKey: "create-one", title: "Follow up", visibility: "private" });
});

test("product task client sends the delegated view token", async () => {
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({ items: [], membersByTaskId: {}, nextCursor: "" });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  await client.listProductTasks("org_one", { view: "delegated" });
  expect(requestUrl).toContain("view=delegated");
});

test("product task collaboration client strictly reads groups and group members", async () => {
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/groups/group%2Fone/members")) return Response.json({ members: [{ id: "relation_one", groupId: "group/one", userId: "user_two", nickname: "Teammate", name: "Teammate", account: "teammate", avatar: null, joinedAt: "2026-11-01T00:00:00Z" }], total: 1, limit: 100, offset: 0 });
    return Response.json({ groups: [{ id: "group/one", name: "Launch group", avatar: null, groupType: 0, ownerId: "user_one", orgId: "org_one", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }], total: 1 });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  expect((await client.listCollaborationGroups("org_one", { limit: 100, offset: 0 })).groups[0]?.name).toBe("Launch group");
  expect((await client.listCollaborationGroupMembers("org_one", "group/one", { limit: 100, offset: 0 })).members[0]?.userId).toBe("user_two");
  expect(requests[0]).toContain("/v1/groups?limit=100&offset=0");
  expect(requests[1]).toContain("/v1/groups/group%2Fone/members?limit=100&offset=0");

  globalThis.fetch = async () => Response.json({ groups: [{ id: "bad" }], total: 1 });
  await expect(client.listCollaborationGroups("org_one")).rejects.toMatchObject({ code: "invalid_group_page" });
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

test("product task client moves tasks through the dedicated move contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return Response.json({ taskId: "task/one", version: 4, listId: "list_two", visibility: "members", replayed: false });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const moved = await client.moveProductTask("org_one", "task/one", {
    expectedVersion: 3,
    idempotencyKey: "move-one",
    destinationListId: "list_two",
    confirmedVisibility: "members",
  });
  expect(requests[0]?.url).toContain("/v1/tasks/task%2Fone/move");
  expect(requests[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    expectedVersion: 3,
    idempotencyKey: "move-one",
    destinationListId: "list_two",
    confirmedVisibility: "members",
  });
  expect(moved).toEqual({ taskId: "task/one", version: 4, listId: "list_two", visibility: "members", replayed: false });

  globalThis.fetch = async () => Response.json({ taskId: "task/one", version: "bad", listId: null, visibility: "private", replayed: false });
  await expect(client.moveProductTask("org_one", "task/one", { expectedVersion: 4, idempotencyKey: "move-two", destinationListId: "" })).rejects.toMatchObject({ code: "invalid_task_move_payload" });
});

test("product task client transfers task-list ownership through the dedicated contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const listResult = { list: { id: "list/one", creatorMemberId: "member_two", name: "Launch", description: "", marker: "L", visibility: "members", version: 4, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" }, members: [{ memberId: "member_one", role: "administrator" }, { memberId: "member_two", role: "administrator" }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: false, canDelete: false, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return Response.json(listResult); };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const transferred = await client.transferProductTaskListOwnership("org_one", "list/one", { expectedVersion: 3, idempotencyKey: "transfer-owner", newOwnerMemberId: "member_two" });
  expect(requests[0]?.url).toContain("/v1/task-lists/list%2Fone/transfer-ownership");
  expect(requests[0]?.init?.method).toBe("POST");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ expectedVersion: 3, idempotencyKey: "transfer-owner", newOwnerMemberId: "member_two" });
  expect(transferred.list.creatorMemberId).toBe("member_two");
});

test("product task client strictly validates task-list ownership results", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const valid = { list: { id: "list_one", creatorMemberId: "member_one", name: "Launch", description: "", marker: "L", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" }, members: [{ memberId: "member_one", role: "administrator" }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  for (const invalid of [
    { ...valid, permissions: { ...valid.permissions, canTransferOwnership: "true" } },
    { ...valid, permissions: { ...valid.permissions, canDelete: "true" } },
    { ...valid, replayed: "false" },
    { ...valid, list: { ...valid.list, version: 1.5 } },
    { ...valid, list: { ...valid.list, archivedAt: 123 } },
    { ...valid, members: [{ memberId: "member_one", role: "member" }] },
  ]) {
    globalThis.fetch = async () => Response.json(invalid);
    await expect(client.getProductTaskList("org_one", "list_one")).rejects.toMatchObject({ code: "invalid_task_list_payload" });
  }
});

test("product task client treats permissions absent from older task-list responses as unavailable", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const legacy = { list: { id: "list_one", creatorMemberId: "member_one", name: "Launch", description: "", marker: "L", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" }, members: [{ memberId: "member_one", role: "administrator" }], permissions: { canView: true, canEdit: true, canManageMembers: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  globalThis.fetch = async () => Response.json(legacy);
  const result = await client.getProductTaskList("org_one", "list_one");
  expect(result.permissions.canTransferOwnership).toBe(false);
  expect(result.permissions.canDelete).toBe(false);
});

test("product task client deletes a task list through the dedicated strict contract", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => { requests.push({ url: String(input), init }); return Response.json({ listId: "list/one", replayed: false }); };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  await expect(client.deleteProductTaskList("org_one", "list/one", { expectedVersion: 4, idempotencyKey: "delete-list", deleteUnassignedTasks: true })).resolves.toEqual({ listId: "list/one", replayed: false });
  expect(requests[0]?.url).toContain("/v1/task-lists/list%2Fone");
  expect(requests[0]?.init?.method).toBe("DELETE");
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ expectedVersion: 4, idempotencyKey: "delete-list", deleteUnassignedTasks: true });

  for (const invalid of [{ listId: "", replayed: false }, { listId: "list/one", replayed: "false" }, { replayed: false }]) {
    globalThis.fetch = async () => Response.json(invalid);
    await expect(client.deleteProductTaskList("org_one", "list/one", { expectedVersion: 4, idempotencyKey: "delete-list", deleteUnassignedTasks: false })).rejects.toMatchObject({ code: "invalid_task_list_delete_payload" });
  }
  globalThis.fetch = async () => Response.json({ listId: "list_two", replayed: false });
  await expect(client.deleteProductTaskList("org_one", "list/one", { expectedVersion: 4, idempotencyKey: "delete-list", deleteUnassignedTasks: false })).rejects.toMatchObject({ code: "invalid_task_list_delete_payload" });
});

test("product task client rejects a task-list result for a different requested list", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const valid = { list: { id: "list_two", creatorMemberId: "member_one", name: "Launch", description: "", marker: "L", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-17T00:00:00Z" }, members: [{ memberId: "member_one", role: "administrator" }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  globalThis.fetch = async () => Response.json(valid);
  await expect(client.getProductTaskList("org_one", "list_one")).rejects.toMatchObject({ code: "invalid_task_list_payload" });
});

test("product task client rejects malformed pages", async () => {
  globalThis.fetch = async () => Response.json({ items: [{ id: "bad" }], membersByTaskId: {}, nextCursor: "" });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  await expect(client.listProductTasks("org_one")).rejects.toMatchObject({ code: "invalid_task_page" });
});

test("product task client accepts older pages without joined members", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  globalThis.fetch = async () => Response.json({ items: [task], nextCursor: "" });
  const omitted = await client.listProductTasks("org_one");
  expect(omitted.membersByTaskId).toEqual({ "task/one": [] });
  expect(omitted.memberProjectionKnownByTaskId).toEqual({ "task/one": false });

  globalThis.fetch = async () => Response.json({ items: [task], membersByTaskId: {}, nextCursor: "" });
  const missingKey = await client.listProductTasks("org_one");
  expect(missingKey.membersByTaskId).toEqual({ "task/one": [] });
  expect(missingKey.memberProjectionKnownByTaskId).toEqual({ "task/one": false });
});

test("product task client accepts older tasks without display numbers", async () => {
  const { displayNumber: _displayNumber, ...olderTask } = task;
  globalThis.fetch = async () => Response.json({ items: [olderTask], membersByTaskId: {}, nextCursor: "" });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTasks("org_one");
  expect(page.items[0]?.displayNumber).toBeNull();
});

test("product task client defaults older tasks to any-assignee completion", async () => {
  const { completionPolicy: _completionPolicy, ...olderTask } = task;
  globalThis.fetch = async () => Response.json({ items: [olderTask], membersByTaskId: {}, nextCursor: "" });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTasks("org_one");
  expect(page.items[0]?.completionPolicy).toBe("any_assignee");
});

test("product task client rejects malformed completion state fields", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  globalThis.fetch = async () => Response.json({ items: [{ ...task, completionPolicy: "all_assignee" }], membersByTaskId: {}, nextCursor: "" });
  await expect(client.listProductTasks("org_one")).rejects.toMatchObject({ code: "invalid_task_page" });
  globalThis.fetch = async () => Response.json({ items: [task], membersByTaskId: { "task/one": [{ memberId: "member_two", role: "assignee", completedAt: 1 }] }, nextCursor: "" });
  await expect(client.listProductTasks("org_one")).rejects.toMatchObject({ code: "invalid_task_page" });
});

test("product task client rejects malformed present joined members", async () => {
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  globalThis.fetch = async () => Response.json({ items: [task], membersByTaskId: { "task/one": "bad" }, nextCursor: "" });
  await expect(client.listProductTasks("org_one")).rejects.toMatchObject({ code: "invalid_task_page" });
});

test("product task client serializes supported rich filters", async () => {
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({ items: [], membersByTaskId: {}, nextCursor: "" });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  await client.listProductTasks("org_one", {
    creatorMemberId: ["creator one"], creatorMemberOperator: "not_contains", assigneeMemberId: ["assignee"], assigneeMemberOperator: "contains", assignerMemberId: ["assigner"], assignerMemberOperator: "contains", followerMemberId: ["follower"], followerMemberOperator: "not_empty",
    startAtFrom: "2026-11-01T00:00:00Z", startAtBefore: "2026-12-01T00:00:00Z",
    dueAtFrom: "2026-11-02T00:00:00Z", dueAtBefore: "2026-12-02T00:00:00Z", overdue: true,
  });
  const query = new URL(requestUrl).searchParams;
  expect(query.getAll("creatorMemberId")).toEqual(["creator one"]);
  expect(query.get("creatorMemberOperator")).toBe("not_contains");
  expect(query.getAll("assigneeMemberId")).toEqual(["assignee"]);
  expect(query.get("assigneeMemberOperator")).toBe("contains");
  expect(query.getAll("assignerMemberId")).toEqual(["assigner"]);
  expect(query.get("assignerMemberOperator")).toBe("contains");
  expect(query.getAll("followerMemberId")).toEqual(["follower"]);
  expect(query.get("followerMemberOperator")).toBe("not_empty");
  expect(query.get("startAtFrom")).toBe("2026-11-01T00:00:00Z");
  expect(query.get("startAtBefore")).toBe("2026-12-01T00:00:00Z");
  expect(query.get("dueAtFrom")).toBe("2026-11-02T00:00:00Z");
  expect(query.get("dueAtBefore")).toBe("2026-12-02T00:00:00Z");
  expect(query.get("overdue")).toBe("true");
});

test("product task client pages typed organization members", async () => {
  let requestUrl = "";
  globalThis.fetch = async (input) => {
    requestUrl = String(input);
    return Response.json({ members: [{ id: "member_one", userId: "user_one", role: "member", user: { id: "user_one", name: "Alice", account: "alice", email: "alice@example.com", avatar: "https://example.com/a.png" } }], total: 1, limit: 200, offset: 0 });
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listOrganizationMembers("org_one", { limit: 200, offset: 0 });
  expect(requestUrl).toContain("/v1/members?limit=200&offset=0");
  expect(page.members[0]?.user.name).toBe("Alice");
});

test("organization summaries retain current member identity fields", async () => {
  globalThis.fetch = async () => Response.json({ orgs: [{ id: "org_one", name: "One", slug: "one", role: "member", kind: "organization", orgMemberId: "member_one", membershipId: "member_one" }], activeOrgId: "org_one", activeOrgSlug: "one" });
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const response = await client.listOrgs();
  expect(response.orgs[0]).toMatchObject({ orgMemberId: "member_one", membershipId: "member_one" });
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

test("product task client reads paginated aggregate activity and sends read mutations", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const activity = {
    items: [{
      event: { id: "event/one", sequence: 12, eventType: "task.assignee_added", payloadVersion: 1, taskId: "task/one", taskVersion: 3, listId: "list_one", actorMemberId: "member_two", affectedMemberId: "member_one", occurredAt: "2026-11-01T10:00:00Z", payload: { memberId: "member_one" } },
      readAt: null,
      attentionLevel: "attention",
      task: { id: "task/one", displayNumber: 100134, title: "Follow up", accessible: true, deleted: false },
      list: { id: "list_one", name: "Launch", marker: "L" },
      actor: { memberId: "member_two", name: "Alice", avatar: null },
    }],
    nextCursor: "cursor_two",
    hasMore: true,
    unreadCount: 4,
    latestSequence: 12,
  };
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return String(input).includes("/v1/task-activity?") ? Response.json(activity) : Response.json({});
  };
  const client = createDenClient({ baseUrl: "https://work.example", token: "token_one" });
  const page = await client.listProductTaskActivity("org_one", { cursor: "cursor one", limit: 30, unreadOnly: true });
  expect(page.items[0]?.event.id).toBe("event/one");
  expect(page.unreadCount).toBe(4);
  expect(requests[0]?.url).toContain("/v1/task-activity?cursor=cursor+one&limit=30&unreadOnly=true");

  await client.markProductTaskActivityRead("org_one", "event/one");
  expect(requests[1]?.url).toContain("/v1/task-activity/event%2Fone/read");
  expect(requests[1]?.init?.method).toBe("PUT");
  await client.markAllProductTaskActivityRead("org_one", 12);
  expect(requests[2]?.url).toContain("/v1/task-activity/read");
  expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ throughSequence: 12 });

  globalThis.fetch = async () => Response.json({ ...activity, items: [{ event: { id: "bad" } }] });
  await expect(client.listProductTaskActivity("org_one")).rejects.toMatchObject({ code: "invalid_task_activity_page" });
});

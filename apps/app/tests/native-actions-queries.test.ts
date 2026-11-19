import { describe, expect, test } from "bun:test";
import {
  assertLiveScope,
  contactRef,
  cursorBinding,
  localDayRange,
  NativeActionError,
  productTaskListOptions,
  projectProductTaskPage,
  resolveContactRef,
  searchOrganizationContacts,
} from "../src/react-app/domains/native-actions/native-queries";
import type { DenProductTask } from "../src/app/lib/den";
import type { OrganizationMember } from "../src/react-app/domains/jugglechat/types";

const scope = { baseUrl: "https://work.example.test/", userId: "u1", organizationId: "org1" };

describe("local due-date range", () => {
  test("today runs from local midnight to the next local midnight", () => {
    expect(localDayRange("2026-11-19", "Asia/Shanghai")).toEqual({
      dueAtFrom: "2026-11-18T16:00:00Z",
      dueAtBefore: "2026-11-19T16:00:00Z",
    });
  });

  test("a DST day is 23 or 25 hours, never a fixed 24", () => {
    const spring = localDayRange("2026-03-08", "America/New_York");
    const fall = localDayRange("2026-11-01", "America/New_York");
    const hours = (range: { dueAtFrom: string; dueAtBefore: string }) =>
      (Date.parse(range.dueAtBefore) - Date.parse(range.dueAtFrom)) / 3_600_000;
    expect(hours(spring)).toBe(23);
    expect(hours(fall)).toBe(25);
  });
});

describe("task query mapping", () => {
  test("defaults to my unfinished tasks sorted by due date, never view=today", () => {
    const options = productTaskListOptions({ dueOn: "2026-11-19" }, "Asia/Shanghai");
    expect(options).toMatchObject({
      view: "assigned", status: ["todo"], sort: "due_at", direction: "asc", limit: 20,
      dueAtFrom: "2026-11-18T16:00:00Z", dueAtBefore: "2026-11-19T16:00:00Z",
    });
    expect(options.view).not.toBe("today");
    expect(options.overdue).toBeUndefined();
  });

  test("page size is capped", () => {
    expect(productTaskListOptions({ limit: 500 }, "UTC").limit).toBe(50);
  });

  test("a cursor stays bound to its query and scope", () => {
    const base = cursorBinding({ dueOn: "2026-11-19" }, scope);
    expect(cursorBinding({ dueOn: "2026-11-19", cursor: "c2", limit: 5 }, scope)).toBe(base);
    expect(cursorBinding({ dueOn: "2026-11-20" }, scope)).not.toBe(base);
    expect(cursorBinding({ dueOn: "2026-11-19" }, { ...scope, organizationId: "org2" })).not.toBe(base);
  });
});

describe("task projection", () => {
  const task = (id: string, extra: Partial<DenProductTask> = {}) => ({
    id, displayNumber: 7, title: `task ${id}`, dueAt: "2026-11-19T09:00:00Z", priority: "high", status: "todo",
    description: "private body", deletedAt: null, ...extra,
  }) as DenProductTask;

  test("keeps only needed fields, removes multi-list duplicates and deleted tasks", () => {
    const page = projectProductTaskPage({ items: [task("a"), task("a"), task("b", { deletedAt: "2026-11-01T00:00:00Z" })], nextCursor: "" });
    expect(page.items).toEqual([{ id: "a", number: 7, title: "task a", dueAt: "2026-11-19T09:00:00Z", priority: "high", status: "todo" }]);
    expect(JSON.stringify(page)).not.toContain("private body");
    expect(page.hasMore).toBe(false);
  });

  test("a next cursor is reported as partial", () => {
    expect(projectProductTaskPage({ items: [task("a")], nextCursor: "next" })).toMatchObject({ hasMore: true, nextCursor: "next" });
  });
});

describe("identity check", () => {
  test("a changed account, organization or deployment is refused, and so is signed out", () => {
    expect(() => assertLiveScope(scope, { ...scope, baseUrl: "https://work.example.test" })).not.toThrow();
    for (const live of [{ ...scope, userId: "u2" }, { ...scope, organizationId: "org2" }, { ...scope, baseUrl: "https://other.test" }]) {
      expect(() => assertLiveScope(scope, live)).toThrow(NativeActionError);
    }
    expect(() => assertLiveScope(scope, null)).toThrow(/未登录/);
  });
});

describe("contact search", () => {
  const member = (id: string, name: string, extra: Partial<OrganizationMember["user"]> = {}) => ({
    id, userId: `user_${id}`, role: "member", createdAt: "", joinedAt: "", isOwner: false,
    user: { id: `user_${id}`, imUserId: `im_${id}`, account: `acc_${id}`, email: `${id}@example.test`, name, avatar: null, ...extra },
  }) as OrganizationMember;

  test("same-name people are all returned, exact matches first, without picking one", () => {
    const result = searchOrganizationContacts([member("1", "张伟强"), member("2", "张伟"), member("3", "张伟")], "张伟", scope);
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(["张伟", "张伟", "张伟强"]);
    expect(new Set(result.candidates.map((candidate) => candidate.email)).size).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test("candidates are bounded and say when more matched", () => {
    const many = Array.from({ length: 15 }, (_, index) => member(String(index), `李${index}`));
    const result = searchOrganizationContacts(many, "李", scope, 50);
    expect(result.candidates).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test("a reference from another account or organization cannot be reused", () => {
    const ref = contactRef(scope, "m1");
    expect(resolveContactRef(ref, scope)).toBe("m1");
    expect(() => resolveContactRef(ref, { ...scope, organizationId: "org2" })).toThrow(NativeActionError);
    expect(() => resolveContactRef(ref, { ...scope, userId: "u2" })).toThrow(NativeActionError);
    expect(() => resolveContactRef("m1", scope)).toThrow(NativeActionError);
  });
});

describe("native action dispatch order", () => {
  test("an unsupported op is reported as unsupported, before any identity check", async () => {
    const { runNativeActionRead } = await import("../src/react-app/domains/native-actions/native-actions-responder");
    const request = { requestId: "r1", op: "im.send", scope: { baseUrl: "x", userId: "x", organizationId: "x" }, params: {} };
    await expect(runNativeActionRead(request as never)).rejects.toMatchObject({ code: "native_action_unsupported" });
  });

  test("a supported op is still gated by the live identity (signed out here)", async () => {
    const { runNativeActionRead } = await import("../src/react-app/domains/native-actions/native-actions-responder");
    const request = { requestId: "r2", op: "product_tasks.list", scope: { baseUrl: "x", userId: "x", organizationId: "x" }, params: {} };
    await expect(runNativeActionRead(request as never)).rejects.toMatchObject({ code: "native_actions_signed_out" });
  });
});

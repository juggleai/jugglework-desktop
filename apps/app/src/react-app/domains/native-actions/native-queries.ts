import { Temporal } from "@js-temporal/polyfill";
import type { DenProductTask, DenProductTaskListOptions, DenProductTaskPage } from "@/app/lib/den";
import type { OrganizationMember } from "../jugglechat/types";
import type { NativeActionScope } from "./types";

export const PRODUCT_TASK_DEFAULT_LIMIT = 20;
export const PRODUCT_TASK_PAGE_LIMIT = 50;
export const CONTACT_CANDIDATE_LIMIT = 10;

/** Structured failure the conversation can tell apart from "no results". */
export class NativeActionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeActionError";
  }
}

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, "");

/**
 * Refuses a request whose frozen identity no longer matches the live session:
 * a different deployment, account or organization, or a signed-out app.
 */
export function assertLiveScope(requested: NativeActionScope, live: NativeActionScope | null) {
  if (!live) throw new NativeActionError("native_actions_signed_out", "当前未登录或未进入组织，无法查询");
  if (normalizeBaseUrl(requested.baseUrl) !== normalizeBaseUrl(live.baseUrl) || requested.userId !== live.userId || requested.organizationId !== live.organizationId)
    throw new NativeActionError("native_actions_scope_changed", "账号或组织已切换，本轮请求已失效，请重新发送");
}

/**
 * The local calendar day [today 00:00, tomorrow 00:00) as UTC instants.
 * Computed through the calendar, never "now + 24h", so DST days are 23 or 25 hours.
 */
export function localDayRange(date: string, timeZone: string) {
  const day = Temporal.PlainDate.from(date);
  const start = day.toZonedDateTime({ timeZone }).toInstant();
  const end = day.add({ days: 1 }).toZonedDateTime({ timeZone }).toInstant();
  return { dueAtFrom: start.toString(), dueAtBefore: end.toString() };
}

export type ProductTaskQueryParams = {
  dueOn?: string;
  dueFrom?: string;
  dueBefore?: string;
  status?: "todo" | "completed" | "canceled";
  view?: "assigned" | "created" | "delegated" | "following";
  limit?: number;
  cursor?: string;
};

/**
 * Maps a conversation query to the task list API. Defaults to "assigned to me,
 * status todo" and never uses view=today, which also pulls in overdue tasks and
 * tasks that merely start today.
 */
export function productTaskListOptions(params: ProductTaskQueryParams, timeZone: string): DenProductTaskListOptions {
  const range = params.dueOn ? localDayRange(params.dueOn, timeZone) : { dueAtFrom: params.dueFrom, dueAtBefore: params.dueBefore };
  return {
    view: params.view ?? "assigned",
    status: [params.status ?? "todo"],
    ...(range.dueAtFrom ? { dueAtFrom: range.dueAtFrom } : {}),
    ...(range.dueAtBefore ? { dueAtBefore: range.dueAtBefore } : {}),
    sort: "due_at",
    direction: "asc",
    timezone: timeZone,
    limit: Math.min(params.limit ?? PRODUCT_TASK_DEFAULT_LIMIT, PRODUCT_TASK_PAGE_LIMIT),
    ...(params.cursor ? { cursor: params.cursor } : {}),
  };
}

/** Binds a continuation cursor to the query and scope it came from. */
export function cursorBinding(params: ProductTaskQueryParams, scope: NativeActionScope) {
  const { cursor: _cursor, limit: _limit, ...query } = params;
  return JSON.stringify([normalizeBaseUrl(scope.baseUrl), scope.userId, scope.organizationId, query]);
}

/** Only the fields the assistant needs; never descriptions or member lists. */
export function projectProductTask(task: DenProductTask) {
  return {
    id: task.id,
    number: task.displayNumber,
    title: task.title,
    dueAt: task.dueAt,
    priority: task.priority,
    status: task.status,
  };
}

/** One page of tasks, with duplicates from multi-list membership removed. */
export function projectProductTaskPage(page: DenProductTaskPage) {
  const seen = new Set<string>();
  const items = [];
  for (const task of page.items) {
    if (seen.has(task.id) || task.deletedAt) continue;
    seen.add(task.id);
    items.push(projectProductTask(task));
  }
  return { items, hasMore: Boolean(page.nextCursor), nextCursor: page.nextCursor || null };
}

const fold = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/**
 * Bounded contact candidates for one query. Returns only what is needed to
 * tell people apart: name, account and email are shown, never the full directory.
 */
export function searchOrganizationContacts(members: OrganizationMember[], query: string, scope: NativeActionScope, limit = CONTACT_CANDIDATE_LIMIT) {
  const needle = fold(query);
  if (!needle) return { candidates: [], truncated: false };
  const matches = members.filter((member) => member.user && [member.user.name, member.user.account, member.user.email]
    .some((value) => typeof value === "string" && fold(value).includes(needle)));
  const exact = (member: OrganizationMember) => fold(member.user.name ?? "") === needle ? 0 : 1;
  matches.sort((left, right) => exact(left) - exact(right) || (left.user.name ?? "").localeCompare(right.user.name ?? "", "zh-CN"));
  const bounded = Math.min(Math.max(limit, 1), CONTACT_CANDIDATE_LIMIT);
  return {
    candidates: matches.slice(0, bounded).map((member) => ({
      ref: contactRef(scope, member.id),
      name: member.user.name || member.user.account || member.user.email,
      account: member.user.account || null,
      email: member.user.email || null,
      hasChat: Boolean(member.user.imUserId),
    })),
    truncated: matches.length > bounded,
  };
}

const scopeTag = (scope: NativeActionScope) => {
  // Not a secret: it only stops a reference from one account or organization
  // being accepted under another. Writes still re-check membership live.
  let hash = 0;
  for (const char of cursorBinding({}, scope)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(36);
};

/** Opaque candidate reference bound to the account and organization it was found in. */
export function contactRef(scope: NativeActionScope, memberId: string) {
  return `contact:${scopeTag(scope)}:${memberId}`;
}

/** Resolves a candidate reference, refusing one minted under another scope. */
export function resolveContactRef(ref: string, scope: NativeActionScope) {
  const match = /^contact:([0-9a-z]+):(.+)$/.exec(ref);
  if (!match || match[1] !== scopeTag(scope))
    throw new NativeActionError("contact_ref_invalid", "联系人引用无效或来自其他账号/组织，请重新搜索");
  return match[2]!;
}

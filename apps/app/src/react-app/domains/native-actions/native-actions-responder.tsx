import * as React from "react";
import { createDenClient, readDenSettings, readDenUserId } from "@/app/lib/den";
import { Temporal } from "@js-temporal/polyfill";
import { getChatGroupsForContacts, getMembers } from "../jugglechat/api";
import { prepareCalendarEvent, prepareIm, prepareMeeting, searchGroups, type CalendarPrepareParams, type MeetingPrepareParams } from "./native-writes";
import {
  assertLiveScope,
  cursorBinding,
  NativeActionError,
  productTaskListOptions,
  projectProductTaskPage,
  searchOrganizationContacts,
  type ProductTaskQueryParams,
} from "./native-queries";
import type { NativeActionRequest, NativeActionScope } from "./types";

/** The identity the renderer is signed in with right now, or null. */
export function liveNativeActionScope(): NativeActionScope | null {
  const settings = readDenSettings();
  const userId = readDenUserId();
  const organizationId = settings.activeOrgId?.trim();
  if (!settings.authToken || !userId || !organizationId) return null;
  return { baseUrl: settings.baseUrl, userId, organizationId };
}

const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/** Cursor issued per query; a continuation must come back with the same query and scope. */
const issuedCursors = new Map<string, string>();

const SUPPORTED_OPS = new Set<string>(["product_tasks.list", "contacts.search", "chats.search", "calendar.prepare", "meeting.prepare", "im.prepare"]);

export async function runNativeActionRead(request: NativeActionRequest) {
  // TIPS: 先判断操作是否支持，否则未知操作会被误报成"身份已切换"。
  if (!SUPPORTED_OPS.has(request.op)) throw new NativeActionError("native_action_unsupported", "不支持的原生能力");
  assertLiveScope(request.scope, liveNativeActionScope());
  const settings = readDenSettings();
  if (request.op === "product_tasks.list") {
    const params = request.params as ProductTaskQueryParams;
    const binding = cursorBinding(params, request.scope);
    if (params.cursor && issuedCursors.get(params.cursor) !== binding)
      throw new NativeActionError("cursor_mismatch", "续页游标与本次查询条件不一致，请重新查询");
    const timeZone = localTimeZone();
    const page = await createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken })
      .listProductTasks(request.scope.organizationId, productTaskListOptions(params, timeZone));
    // TIPS: 网络往返期间可能切换了账号或组织；结果属于旧身份，必须丢弃而不是返回。
    assertLiveScope(request.scope, liveNativeActionScope());
    const result = projectProductTaskPage(page);
    if (result.nextCursor) issuedCursors.set(result.nextCursor, binding);
    return {
      ...result,
      timeZone,
      criteria: { view: params.view ?? "assigned", status: params.status ?? "todo", dueOn: params.dueOn ?? null },
      dueAtPrecision: "instant",
    };
  }
  if (request.op === "contacts.search") {
    const { query, limit } = request.params as { query: string; limit?: number };
    const { members } = await getMembers();
    assertLiveScope(request.scope, liveNativeActionScope());
    return searchOrganizationContacts(members, query, request.scope, limit);
  }
  if (request.op === "chats.search") {
    const groups = await getChatGroupsForContacts();
    assertLiveScope(request.scope, liveNativeActionScope());
    return searchGroups(groups, String(request.params.query ?? ""), request.scope);
  }
  // Prepare ops resolve targets and freeze the payload. They never write.
  const now = Temporal.Now.instant();
  if (request.op === "calendar.prepare") {
    const client = createDenClient({ baseUrl: settings.baseUrl, token: settings.authToken });
    const [calendars, { members }] = await Promise.all([client.listCalendars(request.scope.organizationId), getMembers()]);
    assertLiveScope(request.scope, liveNativeActionScope());
    const self = members.find((member) => member.userId === request.scope.userId || member.user?.id === request.scope.userId);
    if (!self) throw new NativeActionError("membership_unavailable", "无法确认你在当前组织中的成员身份");
    return prepareCalendarEvent(request.params as CalendarPrepareParams, { scope: request.scope, localTimeZone: localTimeZone(), calendars, selfMemberId: self.id, members, now });
  }
  if (request.op === "meeting.prepare" || request.op === "im.prepare") {
    const [{ members }, groups] = await Promise.all([getMembers(), getChatGroupsForContacts()]);
    assertLiveScope(request.scope, liveNativeActionScope());
    const context = { scope: request.scope, members, groups, selfUserId: request.scope.userId };
    return request.op === "meeting.prepare"
      ? prepareMeeting(request.params as MeetingPrepareParams, { ...context, localTimeZone: localTimeZone(), now })
      : prepareIm(request.params as { to: string; text: string }, context);
  }
  throw new NativeActionError("native_action_unsupported", "不支持的原生能力");
}

/**
 * Answers native-action requests forwarded by the main process. Mounted once
 * at the app root so it works whatever page is open.
 */
export function NativeActionsResponder() {
  React.useEffect(() => {
    const bridge = window.__JUGGLEWORK_ELECTRON__?.nativeActions;
    if (!bridge) return;
    return bridge.onRequest((request) => {
      void runNativeActionRead(request).then(
        (result) => bridge.respond({ requestId: request.requestId, ok: true, result }),
        (error) => bridge.respond({
          requestId: request.requestId,
          ok: false,
          code: error instanceof NativeActionError ? error.code : "native_action_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }, []);
  return null;
}

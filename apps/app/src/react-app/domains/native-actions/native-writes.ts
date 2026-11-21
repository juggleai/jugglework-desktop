import { Temporal } from "@js-temporal/polyfill";
import type { DenCalendar, DenCalendarEventTime } from "@/app/lib/den";
import type { OrganizationChatGroup, OrganizationMember } from "../jugglechat/types";
import { NativeActionError, resolveContactRef, scopeTag } from "./native-queries";
import type { NativeActionScope } from "./types";

/** Prepared write: `preview` is shown on the card, `execution` is what runs on confirm. */
export type PreparedWrite = { preview: Record<string, unknown>; execution: Record<string, unknown> };

export type ChatTarget =
  | { kind: "direct"; conversationType: 1; conversationId: string; name: string }
  | { kind: "group"; conversationType: 2; conversationId: string; name: string };

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase("zh-CN").trim();

export function groupRef(scope: NativeActionScope, groupId: string) {
  return `group:${scopeTag(scope)}:${groupId}`;
}

/** Groups the signed-in user belongs to, matched by name; at most 10. */
export function searchGroups(groups: OrganizationChatGroup[], query: string, scope: NativeActionScope) {
  const needle = fold(query);
  const matches = needle ? groups.filter((group) => fold(group.name ?? "").includes(needle)) : [];
  return {
    candidates: matches.slice(0, 10).map((group) => ({ ref: groupRef(scope, group.id), name: group.name, kind: "group" as const })),
    truncated: matches.length > 10,
  };
}

function memberFor(ref: string, scope: NativeActionScope, members: OrganizationMember[]) {
  const memberId = resolveContactRef(ref, scope);
  const member = members.find((item) => item.id === memberId);
  if (!member) throw new NativeActionError("contact_unavailable", "联系人已不在组织中或不可见，请重新搜索");
  return member;
}

const displayName = (member: OrganizationMember) => member.user.name || member.user.account || member.user.email || member.id;

/** Resolves a contact or group ref to the exact chat the message goes to. */
export function resolveChatTarget(ref: string, scope: NativeActionScope, members: OrganizationMember[], groups: OrganizationChatGroup[], selfUserId: string): ChatTarget {
  if (ref.startsWith("group:")) {
    const match = /^group:([0-9a-z]+):(.+)$/.exec(ref);
    if (!match || match[1] !== scopeTag(scope)) throw new NativeActionError("chat_ref_invalid", "群聊引用无效或来自其他账号/组织，请重新搜索");
    const group = groups.find((item) => item.id === match[2]);
    if (!group) throw new NativeActionError("chat_unavailable", "你已不在该群聊中，或群聊已解散");
    return { kind: "group", conversationType: 2, conversationId: group.id, name: group.name };
  }
  const member = memberFor(ref, scope, members);
  const imUserId = member.user.imUserId;
  if (!imUserId) throw new NativeActionError("chat_unavailable", `${displayName(member)} 暂未开通聊天`);
  if (member.userId === selfUserId || imUserId === selfUserId) throw new NativeActionError("chat_self", "不能给自己发送消息");
  return { kind: "direct", conversationType: 1, conversationId: imUserId, name: displayName(member) };
}

const WALL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function zoned(date: string, time: string, timeZone: string) {
  if (!WALL_TIME.test(time)) throw new NativeActionError("invalid_time", "时间格式应为 HH:MM");
  // TIPS: 夏令时跳过的时刻拒绝而不是挪动，避免预览时间与实际写入不一致。
  try {
    const day = Temporal.PlainDate.from(date);
    return Temporal.ZonedDateTime.from({ timeZone, year: day.year, month: day.month, day: day.day, hour: Number(time.slice(0, 2)), minute: Number(time.slice(3)) }, { disambiguation: "reject" });
  } catch {
    throw new NativeActionError("invalid_time", `${date} ${time} 在 ${timeZone} 不存在或有歧义（夏令时切换），请换一个时间`);
  }
}

function validZone(timeZone: string) {
  if (/^[+-]/.test(timeZone)) throw new NativeActionError("invalid_time_zone", "时区必须是 IANA 名称，例如 Asia/Shanghai");
  try { Temporal.Now.instant().toZonedDateTimeISO(timeZone); } catch { throw new NativeActionError("invalid_time_zone", `未知时区 ${timeZone}`); }
  return timeZone;
}

export type CalendarPrepareParams = {
  title: string; description?: string; allDay?: boolean; date: string; endDate?: string;
  startTime?: string; endTime?: string; timeZone?: string; attendees?: string[]; calendarId?: string;
};

/**
 * Freezes a calendar event. Only the user's own calendars are targets; the
 * personal endpoint is used without attendees and never sends invitations.
 */
export function prepareCalendarEvent(params: CalendarPrepareParams, input: {
  scope: NativeActionScope; localTimeZone: string; calendars: DenCalendar[]; selfMemberId: string; members: OrganizationMember[]; now: Temporal.Instant;
}): PreparedWrite {
  const timeZone = validZone(params.timeZone ?? input.localTimeZone);
  const own = input.calendars.filter((calendar) => calendar.ownerMemberId === input.selfMemberId);
  const calendar = params.calendarId ? own.find((item) => item.id === params.calendarId) : own.find((item) => item.isDefault) ?? own[0];
  if (!calendar) throw new NativeActionError("calendar_unavailable", params.calendarId ? "目标日历不存在或不是你的日历" : "没有可写入的日历");
  let time: DenCalendarEventTime;
  let when: Record<string, unknown>;
  if (params.allDay) {
    const start = Temporal.PlainDate.from(params.date);
    const last = Temporal.PlainDate.from(params.endDate ?? params.date);
    if (Temporal.PlainDate.compare(last, start) < 0) throw new NativeActionError("invalid_time", "结束日期早于开始日期");
    time = { kind: "allDay", startDate: start.toString(), endDateExclusive: last.add({ days: 1 }).toString() };
    when = { allDay: true, startDate: start.toString(), endDate: last.toString() };
  } else {
    const start = zoned(params.date, params.startTime!, timeZone);
    const end = zoned(params.endDate ?? params.date, params.endTime!, timeZone);
    if (Temporal.ZonedDateTime.compare(end, start) <= 0) throw new NativeActionError("invalid_time", "结束时间必须晚于开始时间");
    if (Temporal.Instant.compare(start.toInstant(), input.now.subtract({ minutes: 1 })) < 0) throw new NativeActionError("invalid_time", "开始时间已过去");
    time = { kind: "timed", startInstant: start.toInstant().toString(), endInstantExclusive: end.toInstant().toString(), timeZone };
    when = { allDay: false, start: start.toPlainDateTime().toString({ smallestUnit: "minute" }), end: end.toPlainDateTime().toString({ smallestUnit: "minute" }), timeZone };
  }
  const attendees = [...new Map((params.attendees ?? []).map((ref) => {
    const member = memberFor(ref, input.scope, input.members);
    return [member.id, member] as const;
  })).values()].filter((member) => member.id !== input.selfMemberId);
  const base = { calendarId: calendar.id, title: params.title.trim(), description: params.description ?? "", videoConferenceEnabled: false, time };
  return {
    preview: {
      kind: "calendar", calendar: calendar.name, title: base.title, description: base.description, ...when,
      attendees: attendees.map(displayName),
      // 有参会人时对方日历会出现该日程；服务端不发送 IM 通知。
      effect: attendees.length ? "attendees_see_event" : "personal_only",
    },
    // One idempotency key per proposal: a repeated attempt replays on the server.
    execution: attendees.length
      ? { endpoint: "scheduling", idempotencyKey: crypto.randomUUID(), input: { ...base, attendees: attendees.map((member) => ({ memberId: member.id })), recurrence: null } }
      : { endpoint: "personal", idempotencyKey: crypto.randomUUID(), input: base },
  };
}

export type MeetingPrepareParams = {
  title: string; description?: string; immediate: boolean; date?: string; startTime?: string;
  durationMinutes?: number; timeZone?: string; invitees?: string[]; notifyInvitees?: boolean; shareTo?: string[];
};

export function prepareMeeting(params: MeetingPrepareParams, input: {
  scope: NativeActionScope; localTimeZone: string; members: OrganizationMember[]; groups: OrganizationChatGroup[]; selfUserId: string; now: Temporal.Instant;
}): PreparedWrite {
  const timeZone = validZone(params.timeZone ?? input.localTimeZone);
  const minutes = params.durationMinutes ?? 30;
  let startAt: string | null = null;
  let endAt: string | null = null;
  let when: Record<string, unknown> = { immediate: true, durationMinutes: 30 };
  if (!params.immediate) {
    const start = zoned(params.date!, params.startTime!, timeZone);
    if (Temporal.Instant.compare(start.toInstant(), input.now.subtract({ minutes: 1 })) < 0) throw new NativeActionError("invalid_time", "开始时间已过去");
    const end = start.add({ minutes });
    startAt = start.toInstant().toString();
    endAt = end.toInstant().toString();
    when = { immediate: false, start: start.toPlainDateTime().toString({ smallestUnit: "minute" }), durationMinutes: minutes, timeZone };
  }
  // Meeting invites are keyed by the account user id (see server validateInvitees).
  const invitees = [...new Map((params.invitees ?? []).map((ref) => {
    const member = memberFor(ref, input.scope, input.members);
    return [member.userId, member] as const;
  })).values()].filter((member) => member.userId !== input.selfUserId);
  if (params.notifyInvitees && !invitees.length) throw new NativeActionError("invalid_invitees", "没有可通知的参会人");
  const shareTo = [...new Map((params.shareTo ?? []).map((ref) => {
    const target = resolveChatTarget(ref, input.scope, input.members, input.groups, input.selfUserId);
    return [`${target.conversationType}:${target.conversationId}`, target] as const;
  })).values()];
  return {
    preview: {
      kind: "meeting", title: params.title.trim(), description: params.description ?? "", ...when,
      invitees: invitees.map(displayName),
      notifyInvitees: Boolean(params.notifyInvitees),
      notifyCount: params.notifyInvitees ? invitees.length : 0,
      shareTo: shareTo.map((target) => ({ kind: target.kind, name: target.name })),
      autoJoin: false,
    },
    execution: {
      // Same key for every attempt of this proposal: the server replays instead of creating twice.
      idempotencyKey: crypto.randomUUID(),
      input: {
        title: params.title.trim(), description: params.description ?? "", immediate: params.immediate,
        startAt: startAt ?? input.now.toString(), endAt: endAt ?? input.now.add({ minutes: 30 }).toString(), timezone: timeZone,
        invitees: invitees.map((member) => member.userId),
      },
      notifyInvitees: Boolean(params.notifyInvitees),
      shareTo,
    },
  };
}

export function prepareIm(params: { to: string; text: string }, input: {
  scope: NativeActionScope; members: OrganizationMember[]; groups: OrganizationChatGroup[]; selfUserId: string;
}): PreparedWrite {
  const target = resolveChatTarget(params.to, input.scope, input.members, input.groups, input.selfUserId);
  return {
    preview: { kind: "im", to: { kind: target.kind, name: target.name }, text: params.text },
    execution: { target, text: params.text, tid: crypto.randomUUID() },
  };
}

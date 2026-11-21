import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";
import { contactRef } from "../src/react-app/domains/native-actions/native-queries";
import { groupRef, prepareCalendarEvent, prepareIm, prepareMeeting, searchGroups } from "../src/react-app/domains/native-actions/native-writes";
import { executeConfirmedProposal, type ExecuteDeps } from "../src/react-app/domains/native-actions/native-execute";

const scope = { baseUrl: "https://work.example.test", userId: "u-self", organizationId: "org-a" };
const otherOrg = { ...scope, organizationId: "org-b" };
const member = (id: string, userId: string, name: string, imUserId = userId) => ({
  id, userId, role: "member", createdAt: "", joinedAt: "", isOwner: false,
  user: { id: userId, imUserId, account: name, email: `${name}@x.test`, name, avatar: null },
});
const members = [member("m-self", "u-self", "我"), member("m-zhang", "u-zhang", "张三"), member("m-li", "u-li", "李四", "")];
const groups = [{ id: "g-1", name: "产品周会群", groupType: "normal" }];
const calendars = [
  { id: "cal-own", organizationId: "org-a", ownerMemberId: "m-self", name: "我的日历", color: null, isDefault: true, version: 1, createdAt: "", updatedAt: "" },
  { id: "cal-team", organizationId: "org-a", ownerMemberId: "m-zhang", name: "张三的日历", color: null, isDefault: false, version: 1, createdAt: "", updatedAt: "" },
];
const now = Temporal.Instant.from("2026-11-19T02:00:00Z");
const calendarInput = { scope, localTimeZone: "Asia/Shanghai", calendars, selfMemberId: "m-self", members, now };

describe("calendar prepare", () => {
  test("without attendees uses the personal endpoint, local wall time, and says no invitations", () => {
    const { preview, execution } = prepareCalendarEvent({ title: " 写周报 ", date: "2026-11-20", startTime: "09:30", endTime: "10:00" }, calendarInput);
    expect(preview).toMatchObject({ calendar: "我的日历", title: "写周报", start: "2026-11-20T09:30", end: "2026-11-20T10:00", timeZone: "Asia/Shanghai", effect: "personal_only", attendees: [] });
    expect(execution).toMatchObject({ endpoint: "personal", input: { calendarId: "cal-own", time: { kind: "timed", startInstant: "2026-11-20T01:30:00Z", endInstantExclusive: "2026-11-20T02:00:00Z", timeZone: "Asia/Shanghai" } } });
    expect(typeof execution.idempotencyKey).toBe("string");
  });

  test("with attendees uses scheduling, dedupes, drops self, and previews what the server writes", () => {
    const zhang = contactRef(scope, "m-zhang");
    const { preview, execution } = prepareCalendarEvent({ title: "评审", date: "2026-11-20", startTime: "14:00", endTime: "15:00", attendees: [zhang, zhang, contactRef(scope, "m-self")] }, calendarInput);
    expect(preview).toMatchObject({ attendees: ["张三"], effect: "attendees_see_event" });
    expect(execution).toMatchObject({ endpoint: "scheduling", input: { attendees: [{ memberId: "m-zhang" }], recurrence: null } });
  });

  test("all-day end date is inclusive in the preview and exclusive in the payload", () => {
    const { preview, execution } = prepareCalendarEvent({ title: "出差", allDay: true, date: "2026-11-23", endDate: "2026-11-25" }, calendarInput);
    expect(preview).toMatchObject({ allDay: true, startDate: "2026-11-23", endDate: "2026-11-25" });
    expect((execution.input as any).time).toEqual({ kind: "allDay", startDate: "2026-11-23", endDateExclusive: "2026-11-26" });
  });

  test("refuses another member's calendar, past or reversed times, unknown zones and DST gaps", () => {
    expect(() => prepareCalendarEvent({ title: "x", date: "2026-11-20", startTime: "09:00", endTime: "10:00", calendarId: "cal-team" }, calendarInput)).toThrow(/不是你的日历/);
    expect(() => prepareCalendarEvent({ title: "x", date: "2026-11-19", startTime: "08:00", endTime: "09:00" }, calendarInput)).toThrow(/已过去/);
    expect(() => prepareCalendarEvent({ title: "x", date: "2026-11-20", startTime: "10:00", endTime: "09:00" }, calendarInput)).toThrow(/晚于/);
    expect(() => prepareCalendarEvent({ title: "x", date: "2026-11-20", startTime: "09:00", endTime: "10:00", timeZone: "+08:00" }, calendarInput)).toThrow(/IANA/);
    expect(() => prepareCalendarEvent({ title: "x", date: "2027-03-14", startTime: "02:30", endTime: "03:30", timeZone: "America/New_York" }, calendarInput)).toThrow(/夏令时/);
  });

  test("a contact ref from another organization is not accepted", () => {
    expect(() => prepareCalendarEvent({ title: "x", date: "2026-11-20", startTime: "09:00", endTime: "10:00", attendees: [contactRef(otherOrg, "m-zhang")] }, calendarInput)).toThrow(/其他账号/);
  });
});

describe("meeting prepare", () => {
  const input = { scope, localTimeZone: "Asia/Shanghai", members, groups, selfUserId: "u-self", now };
  test("notify is off by default and shown separately from creation; never auto-joins", () => {
    const { preview, execution } = prepareMeeting({ title: "站会", immediate: true, invitees: [contactRef(scope, "m-zhang")] }, input);
    expect(preview).toMatchObject({ immediate: true, invitees: ["张三"], notifyInvitees: false, notifyCount: 0, autoJoin: false, shareTo: [] });
    expect(execution).toMatchObject({ notifyInvitees: false, input: { immediate: true, invitees: ["u-zhang"] } });
  });

  test("scheduled meeting with notify and a group share", () => {
    const { preview, execution } = prepareMeeting({ title: "评审", immediate: false, date: "2026-11-20", startTime: "15:00", durationMinutes: 45, invitees: [contactRef(scope, "m-zhang")], notifyInvitees: true, shareTo: [groupRef(scope, "g-1")] }, input);
    expect(preview).toMatchObject({ start: "2026-11-20T15:00", durationMinutes: 45, notifyCount: 1, shareTo: [{ kind: "group", name: "产品周会群" }] });
    expect(execution).toMatchObject({ input: { startAt: "2026-11-20T07:00:00Z", endAt: "2026-11-20T07:45:00Z", timezone: "Asia/Shanghai" }, shareTo: [{ kind: "group", conversationType: 2, conversationId: "g-1" }] });
  });
});

describe("im prepare and chat refs", () => {
  test("direct chats go to the contact's IM user; groups must be ones I'm in", () => {
    expect(prepareIm({ to: contactRef(scope, "m-zhang"), text: "hi" }, { scope, members, groups, selfUserId: "u-self" }).execution)
      .toMatchObject({ target: { kind: "direct", conversationType: 1, conversationId: "u-zhang", name: "张三" }, text: "hi" });
    expect(() => prepareIm({ to: groupRef(scope, "g-gone"), text: "hi" }, { scope, members, groups, selfUserId: "u-self" })).toThrow(/不在该群聊/);
    expect(() => prepareIm({ to: contactRef(scope, "m-li"), text: "hi" }, { scope, members, groups, selfUserId: "u-self" })).toThrow(/未开通聊天/);
    expect(() => prepareIm({ to: groupRef(otherOrg, "g-1"), text: "hi" }, { scope, members, groups, selfUserId: "u-self" })).toThrow(/其他账号/);
  });

  test("group search is bounded and returns scope-bound refs", () => {
    expect(searchGroups(groups as any, "周会", scope)).toEqual({ candidates: [{ ref: groupRef(scope, "g-1"), name: "产品周会群", kind: "group" }], truncated: false });
  });
});

function deps(overrides: Partial<ExecuteDeps> = {}) {
  const calls: string[] = [];
  const meeting = { id: "mt-1", organizationId: "org-a", code: "ABC123", title: "站会", startAt: "2026-11-19T02:00:00Z", status: "live", version: 1 } as any;
  const base: ExecuteDeps = {
    liveScope: () => scope,
    createCalendarEvent: async (_o, input) => { calls.push(`calendar:${input.idempotencyKey}`); return { event: { id: "ev-1", title: input.title } }; },
    createSchedulingEvent: async (_o, input) => { calls.push(`scheduling:${input.attendees.length}`); return { event: { id: "ev-2", title: input.title } }; },
    createMeeting: async (_i, key) => { calls.push(`meeting:${key}`); return { meeting }; },
    notifyMeeting: async (id) => { calls.push(`notify:${id}`); },
    chatReachable: async () => true,
    sendMessage: async (target, message) => { calls.push(`send:${target.conversationId}:${message.name}`); return { messageId: "msg-1" }; },
    ...overrides,
  };
  return { calls, deps: base };
}
const directTarget = { kind: "direct", conversationType: 1, conversationId: "u-zhang", name: "张三" } as const;

describe("execute confirmed proposals", () => {
  test("refuses before any write when the account or organization changed", async () => {
    const { calls, deps: d } = deps({ liveScope: () => otherOrg });
    const steps = await executeConfirmedProposal("im.send", scope, { target: directTarget, text: "hi", tid: "t" }, d);
    expect(steps).toEqual([{ name: "im.send", status: "failed", error: expect.stringMatching(/切换/) }]);
    expect(calls).toEqual([]);
  });

  test("IM is blocked when the recipient chat is no longer reachable; a timeout is unknown, not failed", async () => {
    const blocked = deps({ chatReachable: async () => false });
    expect((await executeConfirmedProposal("im.send", scope, { target: directTarget, text: "hi", tid: "t" }, blocked.deps))[0]).toMatchObject({ status: "failed" });
    expect(blocked.calls).toEqual([]);
    const timeout = deps({ sendMessage: async () => { throw Object.assign(new Error("timeout"), { name: "TimeoutError" }); } });
    expect((await executeConfirmedProposal("im.send", scope, { target: directTarget, text: "hi", tid: "t" }, timeout.deps))[0]).toMatchObject({ status: "unknown", error: expect.stringMatching(/不要重复/) });
  });

  test("calendar uses the proposal's idempotency key and endpoint", async () => {
    const { calls, deps: d } = deps();
    const steps = await executeConfirmedProposal("calendar.create", scope, { endpoint: "personal", idempotencyKey: "k-1", input: { calendarId: "cal-own", title: "写周报", description: "", videoConferenceEnabled: false, time: {} } }, d);
    expect(steps).toEqual([{ name: "calendar.create", status: "succeeded", result: { eventId: "ev-1", title: "写周报" } }]);
    expect(calls).toEqual(["calendar:k-1"]);
  });

  test("meeting failure sends no notification or card", async () => {
    const { calls, deps: d } = deps({ createMeeting: async () => { throw new Error("会议服务尚未配置"); } });
    const steps = await executeConfirmedProposal("meeting.create", scope, { idempotencyKey: "k", input: {}, notifyInvitees: true, shareTo: [directTarget] }, d);
    expect(steps.map((s) => [s.name, s.status])).toEqual([["meeting.create", "failed"], ["meeting.notify", "skipped"], ["meeting.share", "skipped"]]);
    expect(calls).toEqual([]);
  });

  test("meeting then notify then the real meeting card; a share failure keeps the meeting receipt", async () => {
    const group = { kind: "group", conversationType: 2, conversationId: "g-1", name: "产品周会群" } as const;
    let sends = 0;
    const { calls, deps: d } = deps({
      sendMessage: async (target, message) => {
        calls.push(`send:${target.conversationId}:${message.name}:${(message.content as any).meetingId}`);
        if (++sends === 2) throw new Error("你已被移出群聊");
        return { messageId: "msg" };
      },
    });
    const steps = await executeConfirmedProposal("meeting.create", scope, { idempotencyKey: "k-m", input: {}, notifyInvitees: true, shareTo: [directTarget, group] }, d);
    expect(steps.map((s) => [s.name, s.status])).toEqual([["meeting.create", "succeeded"], ["meeting.notify", "succeeded"], ["meeting.share", "succeeded"], ["meeting.share", "failed"]]);
    expect(steps[0]!.result).toMatchObject({ meetingId: "mt-1", code: "ABC123" });
    expect(calls).toEqual(["meeting:k-m", "notify:mt-1", "send:u-zhang:jw:meeting-card:mt-1", "send:g-1:jw:meeting-card:mt-1"]);
  });

  test("switching organization after the meeting exists skips the remaining sends", async () => {
    let live = scope;
    const { calls, deps: d } = deps({ liveScope: () => live, createMeeting: async () => { live = otherOrg; return { meeting: { id: "mt-1", code: "C" } as any }; } });
    const steps = await executeConfirmedProposal("meeting.create", scope, { idempotencyKey: "k", input: {}, notifyInvitees: true, shareTo: [directTarget] }, d);
    expect(steps.map((s) => [s.name, s.status])).toEqual([["meeting.create", "succeeded"], ["meeting.notify", "skipped"], ["meeting.share", "skipped"]]);
    expect(calls).toEqual([]);
  });
});

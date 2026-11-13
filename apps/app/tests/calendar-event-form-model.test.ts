import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { DenApiError, type DenCalendarEvent, type DenCalendarSchedulingEvent } from "../src/app/lib/den";
import {
  CALENDAR_EVENT_DESCRIPTION_MAX,
  CALENDAR_EVENT_TITLE_MAX,
  CALENDAR_FORM_ERROR,
  calendarEventToForm,
  calendarEventUpdatePatch,
  classifyCalendarSaveFailure,
  defaultCalendarEventForm,
  switchCalendarFormTimeKind,
  validateCalendarEventForm,
} from "../src/react-app/domains/calendar/calendar-event-form-model";

const date = Temporal.PlainDate.from("2026-11-09");
const active = ["cal-1", "cal-2"];
const base = () => ({ ...defaultCalendarEventForm({ date, calendarId: "cal-1", timeZone: "Asia/Shanghai" }), title: "Review" });

describe("calendar event form model", () => {
  test("a new all-day form prefills a valid exclusive one-day range", () => {
    const form = defaultCalendarEventForm({ date, calendarId: "cal-1", timeZone: "Asia/Shanghai" });
    expect(form.time).toEqual({ kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" });
    expect(validateCalendarEventForm({ ...form, title: "x" }, active)).toEqual({
      ok: true,
      values: { calendarId: "cal-1", title: "x", description: "", time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }, attendeeMemberIds: [], recurrence: null },
    });
  });

  test("a new personal event requires the creator as an attendee", () => {
    const form = defaultCalendarEventForm({
      date,
      calendarId: "cal-1",
      timeZone: "Asia/Shanghai",
      creatorMemberId: "member-a",
    });
    expect(form.attendeeMemberIds).toEqual(["member-a"]);
    expect(validateCalendarEventForm({ ...form, title: "Owned event", attendeeMemberIds: [] }, active, "member-a"))
      .toMatchObject({ ok: true, values: { attendeeMemberIds: ["member-a"] } });
  });

  test("a valid timed form serializes to instants in its IANA zone", () => {
    const initial = defaultCalendarEventForm({ date, calendarId: "cal-1", timeZone: "Asia/Shanghai", kind: "timed" });
    const form = { ...initial, title: "Call", time: { ...initial.time, startTime: "09:00", endTime: "09:30" } as typeof initial.time };
    const result = validateCalendarEventForm(form, active);
    expect(result).toMatchObject({ ok: true, values: { time: { kind: "timed", startInstant: "2026-11-09T01:00:00Z", endInstantExclusive: "2026-11-09T01:30:00Z", timeZone: "Asia/Shanghai" } } });
    expect(validateCalendarEventForm({ ...form, time: { ...form.time, startTime: "09:00:00", endTime: "09:30:00" } as typeof form.time }, active).ok).toBe(true);
    expect(validateCalendarEventForm({ ...form, time: { ...form.time, startTime: "09:17" } as typeof form.time }, active)).toMatchObject({ ok: false, errors: { time: CALENDAR_FORM_ERROR.timeInvalid } });
    expect(validateCalendarEventForm({ ...form, time: { ...form.time, startTime: "09:00:01" } as typeof form.time }, active)).toMatchObject({ ok: false, errors: { time: CALENDAR_FORM_ERROR.timeInvalid } });
  });

  test("required fields and code-point length limits match the server", () => {
    expect(validateCalendarEventForm({ ...base(), title: "   " }, active)).toEqual({ ok: false, errors: { title: CALENDAR_FORM_ERROR.titleRequired } });
    expect(validateCalendarEventForm({ ...base(), title: "😀".repeat(CALENDAR_EVENT_TITLE_MAX) }, active).ok).toBe(true);
    expect(validateCalendarEventForm({ ...base(), title: "😀".repeat(CALENDAR_EVENT_TITLE_MAX + 1) }, active)).toMatchObject({ ok: false, errors: { title: CALENDAR_FORM_ERROR.titleTooLong } });
    expect(validateCalendarEventForm({ ...base(), description: "a".repeat(CALENDAR_EVENT_DESCRIPTION_MAX + 1) }, active)).toMatchObject({ ok: false, errors: { description: CALENDAR_FORM_ERROR.descriptionTooLong } });
    expect(validateCalendarEventForm({ ...base(), calendarId: "" }, active)).toMatchObject({ ok: false, errors: { calendarId: CALENDAR_FORM_ERROR.calendarRequired } });
    expect(validateCalendarEventForm({ ...base(), calendarId: "deleted" }, active)).toMatchObject({ ok: false, errors: { calendarId: CALENDAR_FORM_ERROR.calendarRequired } });
  });

  test("rejects more than 20 unique attendees even when the UI is bypassed", () => {
    expect(validateCalendarEventForm({
      ...base(),
      attendeeMemberIds: Array.from({ length: 21 }, (_, index) => `member-${index}`),
    }, active)).toMatchObject({ ok: false, errors: { attendees: CALENDAR_FORM_ERROR.attendeesTooMany } });
    expect(validateCalendarEventForm({
      ...base(),
      attendeeMemberIds: [...Array.from({ length: 20 }, (_, index) => `member-${index}`), "member-0", ""],
    }, active)).toMatchObject({ ok: true, values: { attendeeMemberIds: Array.from({ length: 20 }, (_, index) => `member-${index}`) } });
    expect(validateCalendarEventForm({
      ...base(),
      attendeeMemberIds: Array.from({ length: 20 }, (_, index) => `guest-${index}`),
    }, active, "member-a")).toMatchObject({ ok: false, errors: { attendees: CALENDAR_FORM_ERROR.attendeesTooMany } });
    expect(validateCalendarEventForm({
      ...base(),
      attendeeMemberIds: Array.from({ length: 19 }, (_, index) => `guest-${index}`),
    }, active, "member-a")).toMatchObject({ ok: true, values: { attendeeMemberIds: ["member-a", ...Array.from({ length: 19 }, (_, index) => `guest-${index}`)] } });
  });

  test("an end not after the start is rejected for both kinds", () => {
    expect(validateCalendarEventForm({ ...base(), time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-09" } }, active))
      .toMatchObject({ ok: false, errors: { time: CALENDAR_FORM_ERROR.endNotAfterStart } });
    const timed = defaultCalendarEventForm({ date, calendarId: "cal-1", timeZone: "Asia/Shanghai", kind: "timed" });
    expect(validateCalendarEventForm({ ...base(), time: { ...timed.time, endTime: "09:00" } as typeof timed.time }, active))
      .toMatchObject({ ok: false, errors: { time: CALENDAR_FORM_ERROR.endNotAfterStart } });
  });

  test("an invalid zone or malformed date is a field error, not a crash", () => {
    const timed = defaultCalendarEventForm({ date, calendarId: "cal-1", timeZone: "Asia/Shanghai", kind: "timed" });
    expect(validateCalendarEventForm({ ...base(), time: { ...timed.time, timeZone: "+08:00" } as typeof timed.time }, active))
      .toMatchObject({ ok: false, errors: { time: CALENDAR_FORM_ERROR.timeZoneInvalid } });
    expect(validateCalendarEventForm({ ...base(), time: { kind: "allDay", startDate: "nope", endDateExclusive: "2026-11-10" } }, active))
      .toMatchObject({ ok: false, errors: { time: expect.any(String) } });
  });

  test("a nonexistent DST local time is rejected under the reject strategy", () => {
    const timed = defaultCalendarEventForm({ date: Temporal.PlainDate.from("2026-03-08"), calendarId: "cal-1", timeZone: "America/Los_Angeles", kind: "timed" });
    const result = validateCalendarEventForm({ ...base(), time: { ...timed.time, startTime: "02:30", endTime: "04:00" } as typeof timed.time }, active);
    expect(result.ok).toBe(false);
    expect((result as { errors: Record<string, string> }).errors.time).toBeDefined();
  });

  test("switching kinds explicitly converts the range and never mixes fields", () => {
    const timed = switchCalendarFormTimeKind(base(), "timed", "Asia/Shanghai");
    expect(timed.time.kind).toBe("timed");
    expect(Object.keys(timed.time)).not.toContain("endDateExclusive");
    const back = switchCalendarFormTimeKind(timed, "allDay", "Asia/Shanghai");
    expect(back.time).toEqual({ kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" });
    expect(Object.keys(back.time)).not.toContain("timeZone");
    const broken = switchCalendarFormTimeKind({ ...base(), time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-01" } }, "timed", "UTC");
    expect(broken.time.kind).toBe("timed");
  });

  test("editing round-trips an event and sends only the changed fields", () => {
    const event: DenCalendarEvent = {
      id: "e1", organizationId: "org-a", ownerMemberId: "member-a", calendarId: "cal-1", title: "Review", description: "Notes",
      time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" },
      version: 4, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    };
    const form = calendarEventToForm(event);
    const unchanged = validateCalendarEventForm(form, active);
    expect(unchanged.ok && calendarEventUpdatePatch(event, unchanged.values)).toEqual({});
    const edited = validateCalendarEventForm({ ...form, title: "Review v2", calendarId: "cal-2" }, active);
    expect(edited.ok && calendarEventUpdatePatch(event, edited.values)).toEqual({ title: "Review v2", calendarId: "cal-2" });
  });

  test("round-trips scheduling attendees and recurrence using the server until/count contract", () => {
    const event: DenCalendarSchedulingEvent = {
      id: "scheduled", organizationId: "org-a", ownerMemberId: "member-a", calendarId: "cal-1", title: "Standup", description: "",
      time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }, status: "active",
      attendees: [{ memberId: "member-b", responseStatus: "accepted" }], recurrence: { frequency: "weekly", interval: 2, end: { kind: "until", until: "2026-12-31" } },
      version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    };
    const form = calendarEventToForm(event);
    expect(form).toMatchObject({ attendeeMemberIds: ["member-b"], recurrence: { frequency: "weekly", interval: 2, endKind: "until", untilDate: "2026-12-31" } });
    expect(validateCalendarEventForm(form, active)).toMatchObject({ ok: true, values: { recurrence: event.recurrence } });
    expect(validateCalendarEventForm({ ...form, recurrence: { frequency: "monthly", interval: 1, endKind: "count", untilDate: "", count: 1000 } }, active)).toMatchObject({ ok: true, values: { recurrence: { frequency: "monthly", interval: 1, end: { kind: "count", count: 1000 } } } });
    expect(validateCalendarEventForm({ ...form, recurrence: { frequency: "daily", interval: 365, endKind: "never", untilDate: "", count: 1 } }, active)).toMatchObject({ ok: true });
    expect(validateCalendarEventForm({ ...form, recurrence: { frequency: "daily", interval: 366, endKind: "never", untilDate: "", count: 1 } }, active)).toMatchObject({ ok: false, errors: { recurrence: "calendar.error_recurrence_invalid" } });
  });

  test("attendee order alone does not create an update patch", () => {
    const event: DenCalendarSchedulingEvent = {
      id: "scheduled", organizationId: "org-a", ownerMemberId: "member-z", calendarId: "cal-1", title: "Standup", description: "",
      time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }, status: "active",
      attendees: [{ memberId: "member-a", responseStatus: "accepted" }, { memberId: "member-z", responseStatus: "needs-action" }], recurrence: null,
      version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
    };
    const form = calendarEventToForm(event);
    const validation = validateCalendarEventForm({ ...form, attendeeMemberIds: ["member-z", "member-a"] }, active, "member-z");
    expect(validation.ok && calendarEventUpdatePatch(event, validation.values)).toEqual({});
  });

  test("save failures are classified so the UI never reports a false save", () => {
    expect(classifyCalendarSaveFailure(new DenApiError(409, "calendar_version_conflict", "x")).kind).toBe("conflict");
    expect(classifyCalendarSaveFailure(new DenApiError(401, "unauthorized", "x")).kind).toBe("auth");
    expect(classifyCalendarSaveFailure(new DenApiError(403, "forbidden", "x")).kind).toBe("auth");
    expect(classifyCalendarSaveFailure(new DenApiError(404, "not_found", "x")).kind).toBe("not-found");
    expect(classifyCalendarSaveFailure(new DenApiError(400, "invalid", "x")).kind).toBe("validation");
    expect(classifyCalendarSaveFailure(new DenApiError(503, "unavailable", "x")).kind).toBe("network");
    expect(classifyCalendarSaveFailure(new TypeError("Failed to fetch")).kind).toBe("network");
  });
});

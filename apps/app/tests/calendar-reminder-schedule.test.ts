import { expect, test } from "bun:test";
import type { DenCalendarEvent, DenCalendarEventTime, DenCalendarSchedulingEvent } from "../src/app/lib/den";
import { calendarReminderOccurrences, calendarReminderTick, calendarReminderWindow, planCalendarReminders, REMINDER_GRACE_MS } from "../src/react-app/domains/calendar/calendar-reminder-schedule";

const scope = { deployment: "https://example.org", organizationId: "o", memberId: "m" };
const time: DenCalendarEventTime = { kind: "timed", startInstant: "2026-03-08T23:10:37.123Z", endInstantExclusive: "2026-03-09T00:00:00Z", timeZone: "Asia/Tokyo" };
const event: DenCalendarEvent = { id: "e", calendarId: "c", organizationId: "o", ownerMemberId: "m", title: "Planning", time, version: 1, description: "", videoConferenceEnabled: false, createdAt: time.startInstant, updatedAt: time.startInstant };
const preferences = new Map([[event.id, [5, 0, 5, -1, 2881]]]);

test("full 48-hour leads at the end of a local day survive spring DST, including cross-zone date buckets", () => {
  const window = calendarReminderWindow("2026-03-07", "America/New_York");
  const lastDue = Date.parse("2026-03-08T04:59:59.999Z");
  expect(window.rolloverMs).toBe(lastDue + 1);
  expect(Date.parse(window.schedulingRange.endInstantExclusive)).toBe(lastDue + 1 + 48 * 3600_000);
  expect(window.range.endDateExclusive > "2026-03-10").toBe(true);
  expect(Date.parse(window.schedulingRange.startInstant)).toBeLessThan(Date.parse("2026-03-07T05:00:00Z"));
});

test("all-day starts use the viewer's first local instant, not UTC or a fixed DST offset", () => {
  const allDay = { ...event, time: { kind: "allDay", startDate: "2026-03-09", endDateExclusive: "2026-03-11" } } as const;
  const [r] = planCalendarReminders(scope, "America/Los_Angeles", calendarReminderOccurrences([allDay], []), new Map([[event.id, [2880]]]));
  expect(r?.dueMs).toBe(Date.parse("2026-03-07T07:00:00Z"));
  expect(r?.target).toMatchObject({ date: "2026-03-09", startDate: "2026-03-09" });
});

test("use each expanded occurrence time and index; ignore series masters, duplicate rows/offsets and disabled reminders", () => {
  const series: DenCalendarSchedulingEvent = { ...event, status: "active", attendees: [], recurrence: { frequency: "daily", interval: 1, end: { kind: "never" } } };
  const first = { event: series, occurrenceIndex: 3, time };
  const second = { ...first, occurrenceIndex: 4, time: { ...time, startInstant: "2026-03-09T23:10:37.123Z", endInstantExclusive: "2026-03-10T00:00:00Z" } };
  const rows = calendarReminderOccurrences([event, series], [first, first, second]);
  const plan = planCalendarReminders(scope, "UTC", rows, preferences);
  expect(plan).toHaveLength(4);
  expect(plan[2]?.target).toMatchObject({ eventId: "e", date: "2026-03-10", occurrenceIndex: 4, startInstant: second.time.startInstant });
  expect(calendarReminderOccurrences([series], [])).toEqual([]);
  expect(planCalendarReminders(scope, "UTC", rows, new Map([[event.id, []]]))).toEqual([]);
});

test("tick never fires early, tolerates a late refresh, retains simultaneous arrivals and does not replay stale reminders", () => {
  const second = { ...event, id: "other" };
  const rows = calendarReminderOccurrences([event, second], []);
  const plan = planCalendarReminders(scope, "UTC", rows, new Map([...preferences, [second.id, [5]]]));
  const now = Date.parse(time.startInstant) - 5 * 60_000;
  const seen = new Map<string, number>();
  expect(calendarReminderTick(plan, now - 1, seen)).toEqual({ due: [], nextMs: now });
  const { due } = calendarReminderTick(plan, now + 1, seen);
  expect(due.map((r) => r.target.eventId).sort()).toEqual(["e", "other"]);
  seen.set(due[0]!.key, now);
  expect(calendarReminderTick(plan, now + 50, seen).due).toEqual([due[1]!]);
  expect(calendarReminderTick(plan, now + REMINDER_GRACE_MS + 1, seen).due).toEqual([]);
});

test("refresh replaces deleted and moved deadlines; title edits reuse delivery keys and members cannot collide", () => {
  const build = (events: DenCalendarEvent[], member = scope.memberId) => planCalendarReminders({ ...scope, memberId: member }, "UTC", calendarReminderOccurrences(events, []), preferences);
  const old = build([event]);
  const renamed = { ...event, version: 2, title: "New" };
  const fresh = build([renamed, event]);
  expect(fresh.map((r) => r.key)).toEqual(old.map((r) => r.key));
  expect(fresh[0]?.title).toBe("New");
  expect(build([{ ...renamed, time: { ...time, startInstant: "2026-03-08T23:30:00Z" } }])[0]?.key).not.toBe(old[0]?.key);
  expect(build([event], "another")[0]?.key).not.toBe(old[0]?.key);
  expect(build([{ ...event, organizationId: "foreign" }])).toEqual([]);
  expect(build([])).toEqual([]);
});

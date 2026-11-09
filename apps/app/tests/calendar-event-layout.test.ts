import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent, DenCalendarEventTime } from "../src/app/lib/den";
import { calendarMonthGrid } from "../src/react-app/domains/calendar/calendar-month-model";
import { formatCalendarEntryStart, layoutCalendarEvents, splitCalendarDayOverflow } from "../src/react-app/domains/calendar/calendar-event-layout";

const event = (id: string, time: DenCalendarEventTime, calendarId = "cal-1"): DenCalendarEvent => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", calendarId, title: id, description: "", time,
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});
const allDay = (startDate: string, endDateExclusive: string) => ({ kind: "allDay" as const, startDate, endDateExclusive });
const timed = (startInstant: string, endInstantExclusive: string, timeZone: string) => ({ kind: "timed" as const, startInstant, endInstantExclusive, timeZone });

const days = calendarMonthGrid(Temporal.PlainYearMonth.from("2026-11"), 1);
const ids = (map: Map<string, { event: DenCalendarEvent }[]>, day: string) => (map.get(day) ?? []).map((entry) => entry.event.id);
const layout = (events: DenCalendarEvent[], visible = ["cal-1", "cal-2"]) => layoutCalendarEvents({ events, days, visibleCalendarIds: visible });

describe("calendar month event layout", () => {
  test("a single-day all-day event occupies only its start date", () => {
    const map = layout([event("a", allDay("2026-11-05", "2026-11-06"))]);
    expect(ids(map, "2026-11-05")).toEqual(["a"]);
    expect(ids(map, "2026-11-06")).toEqual([]);
  });

  test("a multi-day all-day event spans to the date before its exclusive end, with continuation flags", () => {
    const map = layout([event("a", allDay("2026-11-05", "2026-11-08"))]);
    expect(["2026-11-05", "2026-11-06", "2026-11-07"].map((d) => ids(map, d))).toEqual([["a"], ["a"], ["a"]]);
    expect(ids(map, "2026-11-08")).toEqual([]);
    const [first, middle, last] = ["2026-11-05", "2026-11-06", "2026-11-07"].map((d) => map.get(d)![0]!);
    expect([first.startsToday, first.continuesFromPrevious, first.continuesToNext]).toEqual([true, false, true]);
    expect([middle.startsToday, middle.continuesFromPrevious, middle.continuesToNext]).toEqual([false, true, true]);
    expect([last.continuesFromPrevious, last.continuesToNext]).toEqual([true, false]);
  });

  test("an event crossing the month edge is clipped to the visible grid", () => {
    const map = layout([event("a", allDay("2026-10-20", "2026-10-28")), event("b", allDay("2026-12-05", "2026-12-20"))]);
    expect(ids(map, "2026-10-26")).toEqual(["a"]);
    expect(ids(map, "2026-10-27")).toEqual(["a"]);
    expect(map.get("2026-10-26")![0]!.continuesFromPrevious).toBe(true);
    expect(ids(map, "2026-12-06")).toEqual(["b"]);
    expect(map.has("2026-12-07")).toBe(false);
  });

  test("a timed event crossing midnight in its stored zone covers both local dates", () => {
    // 22:00 Nov 5 → 02:00 Nov 6 in Shanghai.
    const map = layout([event("a", timed("2026-11-05T14:00:00Z", "2026-11-05T18:00:00Z", "Asia/Shanghai"))]);
    expect(ids(map, "2026-11-05")).toEqual(["a"]);
    expect(ids(map, "2026-11-06")).toEqual(["a"]);
    expect(ids(map, "2026-11-07")).toEqual([]);
  });

  test("a timed event ending exactly at local midnight does not occupy the next date", () => {
    const map = layout([event("a", timed("2026-11-05T15:00:00Z", "2026-11-05T16:00:00Z", "Asia/Shanghai"))]);
    expect(ids(map, "2026-11-05")).toEqual(["a"]);
    expect(ids(map, "2026-11-06")).toEqual([]);
  });

  test("dates follow the event's stored zone, including across a DST change", () => {
    // 2026-11-01 is the US fall-back date. 23:30 → 01:30 PST crosses local midnight.
    const map = layout([event("a", timed("2026-11-01T06:30:00Z", "2026-11-01T09:30:00Z", "America/Los_Angeles"))]);
    expect(ids(map, "2026-10-31")).toEqual(["a"]);
    expect(ids(map, "2026-11-01")).toEqual(["a"]);
    expect(formatCalendarEntryStart(map.get("2026-10-31")![0]!, "en-US")).toBe("11:30 PM");
    expect(formatCalendarEntryStart(map.get("2026-11-01")![0]!, "en-US")).toBeNull();
  });

  test("all-day entries come first, then timed by start, with a stable id tiebreak", () => {
    const map = layout([
      event("t-late", timed("2026-11-05T03:00:00Z", "2026-11-05T04:00:00Z", "UTC")),
      event("t-b", timed("2026-11-05T01:00:00Z", "2026-11-05T02:00:00Z", "UTC")),
      event("t-a", timed("2026-11-05T01:00:00Z", "2026-11-05T02:00:00Z", "UTC")),
      event("d-b", allDay("2026-11-05", "2026-11-06")),
      event("d-a", allDay("2026-11-05", "2026-11-06")),
    ]);
    expect(ids(map, "2026-11-05")).toEqual(["d-a", "d-b", "t-a", "t-b", "t-late"]);
  });

  test("hidden calendars, duplicates, and malformed times are excluded without failing the month", () => {
    const map = layout([
      event("a", allDay("2026-11-05", "2026-11-06")),
      event("a", allDay("2026-11-05", "2026-11-06")),
      event("hidden", allDay("2026-11-05", "2026-11-06"), "cal-2"),
      event("bad", { kind: "allDay", startDate: "2026-11-06", endDateExclusive: "2026-11-05" }),
    ], ["cal-1"]);
    expect(ids(map, "2026-11-05")).toEqual(["a"]);
  });

  test("overflow keeps the cell within capacity and reports the hidden count", () => {
    expect(splitCalendarDayOverflow([1, 2, 3], 3)).toEqual({ shown: [1, 2, 3], hiddenCount: 0 });
    expect(splitCalendarDayOverflow([1, 2, 3, 4, 5], 3)).toEqual({ shown: [1, 2], hiddenCount: 3 });
  });
});

import { describe, expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";
import {
  CALENDAR_GRID_DAYS,
  calendarGridRange,
  calendarHiddenStorageKey,
  calendarMonthGrid,
  calendarToday,
  calendarWeekdayOrder,
  navigateCalendarMonth,
  parseHiddenCalendarIds,
  readHiddenCalendarIds,
  reconcileHiddenCalendarIds,
  selectCalendarDate,
  visibleCalendarIds,
  writeHiddenCalendarIds,
} from "../src/react-app/domains/calendar/calendar-month-model";

const month = (value: string) => Temporal.PlainYearMonth.from(value);
const date = (value: string) => Temporal.PlainDate.from(value);

describe("calendar month model", () => {
  test("builds a stable six-week grid for any week start", () => {
    const monday = calendarMonthGrid(month("2026-11"), 1);
    expect(monday).toHaveLength(CALENDAR_GRID_DAYS);
    expect(monday[0]!.toString()).toBe("2026-10-26");
    expect(monday[41]!.toString()).toBe("2026-12-06");
    const sunday = calendarMonthGrid(month("2026-11"), 7);
    expect(sunday[0]!.toString()).toBe("2026-11-01");
    expect(calendarGridRange(month("2026-11"), 1)).toEqual({ startDate: "2026-10-26", endDateExclusive: "2026-12-07" });
    expect(calendarWeekdayOrder(7)).toEqual([7, 1, 2, 3, 4, 5, 6]);
  });

  test("handles month and year boundaries", () => {
    expect(navigateCalendarMonth({ month: month("2026-01"), selectedDate: date("2026-01-31") }, -1)).toEqual({ month: month("2025-12"), selectedDate: date("2025-12-31") });
    expect(navigateCalendarMonth({ month: month("2026-01"), selectedDate: date("2026-01-31") }, 1)).toEqual({ month: month("2026-02"), selectedDate: date("2026-02-28") });
    expect(selectCalendarDate(date("2026-12-31"))).toEqual({ month: month("2026-12"), selectedDate: date("2026-12-31") });
  });

  test("derives today in the given time zone", () => {
    const instant = Temporal.Instant.from("2026-11-08T17:30:00Z");
    expect(calendarToday("Asia/Shanghai", instant).toString()).toBe("2026-11-09");
    expect(calendarToday("America/Los_Angeles", instant).toString()).toBe("2026-11-08");
  });

  test("keeps the visibility filter local, per scope, and drops deleted calendars", () => {
    const values = new Map<string, string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
    const scopeA = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
    const scopeB = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-b", memberId: "member-a" })!;
    writeHiddenCalendarIds(scopeA, ["cal-2", "cal-2"], storage);
    expect(readHiddenCalendarIds(scopeA, storage)).toEqual(["cal-2"]);
    expect(readHiddenCalendarIds(scopeB, storage)).toEqual([]);
    expect(calendarHiddenStorageKey(scopeA)).not.toBe(calendarHiddenStorageKey(scopeB));
    expect(visibleCalendarIds(["cal-1", "cal-2"], ["cal-2"])).toEqual(["cal-1"]);
    expect(reconcileHiddenCalendarIds(["cal-2", "cal-gone"], ["cal-1", "cal-2"])).toEqual(["cal-2"]);
    writeHiddenCalendarIds(scopeA, [], storage);
    expect(values.size).toBe(0);
    expect(parseHiddenCalendarIds('["a", 3, "", null, "a"]')).toEqual(["a"]);
    expect(parseHiddenCalendarIds("nope")).toEqual([]);
  });
});

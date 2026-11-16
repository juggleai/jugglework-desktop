import { expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { calendarViewDays, calendarViewRange, calendarViewStorageKey, navigateCalendarView, parseCalendarViewMode, readCalendarViewMode, writeCalendarViewMode } from "../src/react-app/domains/calendar/calendar-view-model";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

const date = Temporal.PlainDate.from("2026-11-11");

test("day, week, and month ranges use exclusive end dates", () => {
  expect(calendarViewRange(date, "day", 7)).toEqual({ startDate: "2026-11-11", endDateExclusive: "2026-11-12" });
  expect(calendarViewRange(date, "week", 7)).toEqual({ startDate: "2026-11-08", endDateExclusive: "2026-11-15" });
  expect(calendarViewDays(date, "week", 1).map(String)).toEqual([
    "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
  ]);
  expect(calendarViewDays(date, "week", 7).map(String)).toEqual([
    "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14",
  ]);
  expect(calendarViewDays(date, "month", 7)).toHaveLength(42);
});

test("Sunday-first week view stays aligned across month and year boundaries", () => {
  expect(calendarViewDays(Temporal.PlainDate.from("2026-11-01"), "week", 7).map(String)).toEqual([
    "2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07",
  ]);
  expect(calendarViewRange(Temporal.PlainDate.from("2027-01-01"), "week", 7)).toEqual({ startDate: "2026-12-27", endDateExclusive: "2027-01-03" });
});

test("view navigation advances by the visible period and clamps month dates", () => {
  expect(String(navigateCalendarView(date, "day", 1))).toBe("2026-11-12");
  expect(String(navigateCalendarView(date, "week", -1))).toBe("2026-11-04");
  expect(String(navigateCalendarView(Temporal.PlainDate.from("2027-01-31"), "month", 1))).toBe("2027-02-28");
});

test("defaults to week and persists the selected view per calendar scope", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const scopeA = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
  const scopeB = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-b", memberId: "member-a" })!;
  expect(readCalendarViewMode(scopeA, storage)).toBe("week");
  writeCalendarViewMode(scopeA, "day", storage);
  expect(readCalendarViewMode(scopeA, storage)).toBe("day");
  expect(readCalendarViewMode(scopeB, storage)).toBe("week");
  expect(calendarViewStorageKey(scopeA)).not.toBe(calendarViewStorageKey(scopeB));
  expect(parseCalendarViewMode("invalid")).toBe("week");
});

import { expect, test } from "bun:test";
import { Temporal } from "@js-temporal/polyfill";

import { calendarViewDays, calendarViewRange, navigateCalendarView } from "../src/react-app/domains/calendar/calendar-view-model";

const date = Temporal.PlainDate.from("2026-11-11");

test("day, week, and month ranges use exclusive end dates", () => {
  expect(calendarViewRange(date, "day", 7)).toEqual({ startDate: "2026-11-11", endDateExclusive: "2026-11-12" });
  expect(calendarViewRange(date, "week", 7)).toEqual({ startDate: "2026-11-08", endDateExclusive: "2026-11-15" });
  expect(calendarViewDays(date, "week", 1).map(String)).toEqual([
    "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15",
  ]);
  expect(calendarViewDays(date, "month", 7)).toHaveLength(42);
});

test("view navigation advances by the visible period and clamps month dates", () => {
  expect(String(navigateCalendarView(date, "day", 1))).toBe("2026-11-12");
  expect(String(navigateCalendarView(date, "week", -1))).toBe("2026-11-04");
  expect(String(navigateCalendarView(Temporal.PlainDate.from("2027-01-31"), "month", 1))).toBe("2027-02-28");
});

import { Temporal } from "@js-temporal/polyfill";

import { calendarMonthGrid, type CalendarWeekday } from "./calendar-month-model";
import type { CalendarScope } from "./calendar-scope";
import { calendarScopeIdentity } from "./calendar-scope";

export type CalendarViewMode = "day" | "week" | "month";

const CALENDAR_VIEW_PREFIX = "jugglework.calendar.view:";

export function calendarViewStorageKey(scope: CalendarScope): string {
  return `${CALENDAR_VIEW_PREFIX}${calendarScopeIdentity(scope)}`;
}

export function parseCalendarViewMode(raw: string | null | undefined): CalendarViewMode {
  return raw === "day" || raw === "month" || raw === "week" ? raw : "week";
}

export function readCalendarViewMode(scope: CalendarScope, storage: Pick<Storage, "getItem"> | null = safeStorage()): CalendarViewMode {
  return parseCalendarViewMode(storage?.getItem(calendarViewStorageKey(scope)));
}

export function writeCalendarViewMode(scope: CalendarScope, view: CalendarViewMode, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  storage?.setItem(calendarViewStorageKey(scope), view);
}

export function calendarWeekStartDate(date: Temporal.PlainDate, weekStart: CalendarWeekday): Temporal.PlainDate {
  const offset = (date.dayOfWeek - weekStart + 7) % 7;
  return date.subtract({ days: offset });
}

export function calendarViewDays(
  selectedDate: Temporal.PlainDate,
  view: CalendarViewMode,
  weekStart: CalendarWeekday,
): Temporal.PlainDate[] {
  if (view === "day") return [selectedDate];
  if (view === "month") return calendarMonthGrid(selectedDate.toPlainYearMonth(), weekStart);
  const start = calendarWeekStartDate(selectedDate, weekStart);
  return Array.from({ length: 7 }, (_, index) => start.add({ days: index }));
}

export function calendarViewRange(
  selectedDate: Temporal.PlainDate,
  view: CalendarViewMode,
  weekStart: CalendarWeekday,
): { startDate: string; endDateExclusive: string } {
  const days = calendarViewDays(selectedDate, view, weekStart);
  return {
    startDate: days[0]!.toString(),
    endDateExclusive: days[days.length - 1]!.add({ days: 1 }).toString(),
  };
}

export function navigateCalendarView(
  selectedDate: Temporal.PlainDate,
  view: CalendarViewMode,
  direction: -1 | 1,
): Temporal.PlainDate {
  if (view === "day") return selectedDate.add({ days: direction });
  if (view === "week") return selectedDate.add({ weeks: direction });
  const targetMonth = selectedDate.toPlainYearMonth().add({ months: direction });
  return targetMonth.toPlainDate({ day: Math.min(selectedDate.day, targetMonth.daysInMonth) });
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

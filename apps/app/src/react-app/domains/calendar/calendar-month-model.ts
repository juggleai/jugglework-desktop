import { Temporal } from "@js-temporal/polyfill";

import type { CalendarScope } from "./calendar-scope";
import { calendarScopeIdentity } from "./calendar-scope";

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export type CalendarWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const CALENDAR_GRID_DAYS = 42;

export function calendarWeekStart(locale: string): CalendarWeekday {
  try {
    const intlLocale = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay?: number };
      weekInfo?: { firstDay?: number };
    };
    const firstDay = intlLocale.getWeekInfo?.().firstDay ?? intlLocale.weekInfo?.firstDay;
    if (firstDay && firstDay >= 1 && firstDay <= 7) return firstDay as CalendarWeekday;
  } catch {
    // Unknown locale: fall through to the ISO default.
  }
  return 1;
}

/** Always six full weeks so the grid height never jumps between months. */
export function calendarMonthGrid(month: Temporal.PlainYearMonth, weekStart: CalendarWeekday): Temporal.PlainDate[] {
  const first = month.toPlainDate({ day: 1 });
  const offset = (first.dayOfWeek - weekStart + 7) % 7;
  const start = first.subtract({ days: offset });
  return Array.from({ length: CALENDAR_GRID_DAYS }, (_, index) => start.add({ days: index }));
}

/** Half-open date range covered by the visible grid, used for bootstrap/range requests. */
export function calendarGridRange(month: Temporal.PlainYearMonth, weekStart: CalendarWeekday): { startDate: string; endDateExclusive: string } {
  const grid = calendarMonthGrid(month, weekStart);
  return { startDate: grid[0]!.toString(), endDateExclusive: grid[grid.length - 1]!.add({ days: 1 }).toString() };
}

export function calendarWeekdayOrder(weekStart: CalendarWeekday): CalendarWeekday[] {
  return Array.from({ length: 7 }, (_, index) => (((weekStart - 1 + index) % 7) + 1) as CalendarWeekday);
}

export function calendarToday(timeZone: string, now: Temporal.Instant = Temporal.Now.instant()): Temporal.PlainDate {
  return now.toZonedDateTimeISO(timeZone).toPlainDate();
}

export type CalendarMonthNavigation = { month: Temporal.PlainYearMonth; selectedDate: Temporal.PlainDate };

export function navigateCalendarMonth(state: CalendarMonthNavigation, delta: -1 | 1): CalendarMonthNavigation {
  const month = state.month.add({ months: delta });
  // Keep the same day-of-month when possible so the agenda stays meaningful.
  const day = Math.min(state.selectedDate.day, month.daysInMonth);
  return { month, selectedDate: month.toPlainDate({ day }) };
}

export function selectCalendarDate(date: Temporal.PlainDate): CalendarMonthNavigation {
  return { month: date.toPlainYearMonth(), selectedDate: date };
}

export function moveCalendarSelection(state: CalendarMonthNavigation, days: number): CalendarMonthNavigation {
  return selectCalendarDate(state.selectedDate.add({ days }));
}

/* ---- Local, per-scope visibility filter. Never written to the cloud. ---- */

const HIDDEN_CALENDARS_PREFIX = "jugglework.calendar.hidden:";

export function calendarHiddenStorageKey(scope: CalendarScope): string {
  return `${HIDDEN_CALENDARS_PREFIX}${calendarScopeIdentity(scope)}`;
}

export function parseHiddenCalendarIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim() !== ""))];
  } catch {
    return [];
  }
}

export function readHiddenCalendarIds(scope: CalendarScope, storage: Pick<Storage, "getItem"> | null = safeStorage()): string[] {
  return parseHiddenCalendarIds(storage?.getItem(calendarHiddenStorageKey(scope)));
}

export function writeHiddenCalendarIds(scope: CalendarScope, ids: readonly string[], storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): void {
  if (!storage) return;
  const unique = [...new Set(ids)];
  if (unique.length === 0) storage.removeItem(calendarHiddenStorageKey(scope));
  else storage.setItem(calendarHiddenStorageKey(scope), JSON.stringify(unique));
}

/** Drop ids of calendars no longer active (e.g. soft-deleted) so they cannot linger as filter entries. */
export function reconcileHiddenCalendarIds(hidden: readonly string[], activeCalendarIds: readonly string[]): string[] {
  const active = new Set(activeCalendarIds);
  return hidden.filter((id) => active.has(id));
}

export function visibleCalendarIds(activeCalendarIds: readonly string[], hidden: readonly string[]): string[] {
  const hiddenSet = new Set(hidden);
  return activeCalendarIds.filter((id) => !hiddenSet.has(id));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

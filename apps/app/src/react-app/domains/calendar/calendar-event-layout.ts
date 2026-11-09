import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent } from "@/app/lib/den";
import { calendarCoverageDates, parseCalendarEventTime, type CalendarTimeInterval } from "./calendar-time-adapter";

export const CALENDAR_DAY_CELL_CAPACITY = 3;

export type CalendarDayEntry = {
  event: DenCalendarEvent;
  interval: CalendarTimeInterval;
  /** True only on the date where the event begins (in its own semantics/zone). */
  startsToday: boolean;
  /** True when the event also occupies the previous / next date. */
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
};

type Placed = {
  event: DenCalendarEvent;
  interval: CalendarTimeInterval;
  startDate: Temporal.PlainDate;
  endDateExclusive: Temporal.PlainDate;
};

/**
 * All-day before timed; all-day by start date then id; timed by start instant then id.
 * The id tiebreak keeps the order stable across renders and devices.
 */
export function compareCalendarEntries(left: Placed, right: Placed): number {
  if (left.interval.kind !== right.interval.kind) return left.interval.kind === "allDay" ? -1 : 1;
  const byStart = left.interval.kind === "allDay"
    ? Temporal.PlainDate.compare(left.startDate, right.startDate)
    : Temporal.Instant.compare(left.interval.startInstant, (right.interval as Extract<CalendarTimeInterval, { kind: "timed" }>).startInstant);
  if (byStart !== 0) return byStart;
  return left.event.id < right.event.id ? -1 : left.event.id > right.event.id ? 1 : 0;
}

function place(event: DenCalendarEvent): Placed | null {
  try {
    const interval = parseCalendarEventTime(event.time);
    const { startDate, endDateExclusive } = calendarCoverageDates(interval);
    if (Temporal.PlainDate.compare(startDate, endDateExclusive) >= 0) return null;
    return { event, interval, startDate, endDateExclusive };
  } catch {
    // A malformed or unknown time union must not break the whole month.
    return null;
  }
}

/**
 * Bucket events into the dates of `days`. Each event occupies [startDate, endDateExclusive)
 * computed from its own semantics: all-day dates as-is, timed events in their stored IANA zone,
 * with the exclusive end never occupying an extra date (a midnight end stops the day before).
 */
export function layoutCalendarEvents(input: {
  events: readonly DenCalendarEvent[];
  days: readonly Temporal.PlainDate[];
  visibleCalendarIds: readonly string[];
}): Map<string, CalendarDayEntry[]> {
  const visible = new Set(input.visibleCalendarIds);
  const result = new Map<string, CalendarDayEntry[]>();
  for (const day of input.days) result.set(day.toString(), []);
  if (input.days.length === 0) return result;
  const firstDay = input.days[0]!;
  const lastDayExclusive = input.days[input.days.length - 1]!.add({ days: 1 });

  const seen = new Set<string>();
  const placed: Placed[] = [];
  for (const event of input.events) {
    if (!visible.has(event.calendarId) || seen.has(event.id)) continue;
    seen.add(event.id);
    const item = place(event);
    if (item) placed.push(item);
  }
  placed.sort(compareCalendarEntries);

  for (const item of placed) {
    let day = Temporal.PlainDate.compare(item.startDate, firstDay) > 0 ? item.startDate : firstDay;
    const stop = Temporal.PlainDate.compare(item.endDateExclusive, lastDayExclusive) < 0 ? item.endDateExclusive : lastDayExclusive;
    while (Temporal.PlainDate.compare(day, stop) < 0) {
      result.get(day.toString())?.push({
        event: item.event,
        interval: item.interval,
        startsToday: day.equals(item.startDate),
        continuesFromPrevious: Temporal.PlainDate.compare(day, item.startDate) > 0,
        continuesToNext: Temporal.PlainDate.compare(day.add({ days: 1 }), item.endDateExclusive) < 0,
      });
      day = day.add({ days: 1 });
    }
  }
  return result;
}

export function splitCalendarDayOverflow<T>(entries: readonly T[], capacity: number = CALENDAR_DAY_CELL_CAPACITY): { shown: T[]; hiddenCount: number } {
  if (entries.length <= capacity) return { shown: [...entries], hiddenCount: 0 };
  // Reserve one row for the "+N more" entry so the cell never grows past its capacity.
  const shown = entries.slice(0, Math.max(capacity - 1, 0));
  return { shown, hiddenCount: entries.length - shown.length };
}

/** Local start time shown on the start date of a timed event, in its stored zone. */
export function formatCalendarEntryStart(entry: CalendarDayEntry, locale: string): string | null {
  if (entry.interval.kind !== "timed" || !entry.startsToday) return null;
  return entry.interval.startInstant.toZonedDateTimeISO(entry.interval.timeZone).toLocaleString(locale, { hour: "numeric", minute: "2-digit" });
}

import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent } from "@/app/lib/den";
import { parseCalendarEventTime } from "./calendar-time-adapter";

export type CalendarTimedSegment = {
  event: DenCalendarEvent;
  date: Temporal.PlainDate;
  startMinute: number;
  endMinute: number;
  lane: number;
  laneCount: number;
  continuesFromPrevious: boolean;
  continuesToNext: boolean;
};

export type CalendarAllDaySpan = {
  event: DenCalendarEvent;
  startIndex: number;
  endIndexExclusive: number;
  row: number;
};

export type CalendarTimeLayout = {
  timedByDate: Map<string, CalendarTimedSegment[]>;
  allDaySpans: CalendarAllDaySpan[];
  allDayRowCount: number;
};

type PendingTimedSegment = Omit<CalendarTimedSegment, "lane" | "laneCount">;

function minuteOfDay(value: Temporal.ZonedDateTime): number {
  return value.hour * 60 + value.minute + value.second / 60;
}

function comparePending(left: PendingTimedSegment, right: PendingTimedSegment): number {
  if (left.startMinute !== right.startMinute) return left.startMinute - right.startMinute;
  const leftDuration = left.endMinute - left.startMinute;
  const rightDuration = right.endMinute - right.startMinute;
  if (leftDuration !== rightDuration) return rightDuration - leftDuration;
  return left.event.id.localeCompare(right.event.id);
}

function assignTimedLanes(segments: PendingTimedSegment[]): CalendarTimedSegment[] {
  const sorted = [...segments].sort(comparePending);
  const output: CalendarTimedSegment[] = [];
  let group: PendingTimedSegment[] = [];
  let groupEnd = -1;
  const flush = () => {
    if (group.length === 0) return;
    const laneEnds: number[] = [];
    const placed = group.map((segment) => {
      let lane = laneEnds.findIndex((end) => end <= segment.startMinute);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = segment.endMinute;
      return { ...segment, lane };
    });
    const laneCount = Math.max(laneEnds.length, 1);
    output.push(...placed.map((segment) => ({ ...segment, laneCount })));
    group = [];
    groupEnd = -1;
  };
  for (const segment of sorted) {
    if (group.length > 0 && segment.startMinute >= groupEnd) flush();
    group.push(segment);
    groupEnd = Math.max(groupEnd, segment.endMinute);
  }
  flush();
  return output;
}

function placeAllDaySpans(events: readonly DenCalendarEvent[], days: readonly Temporal.PlainDate[]): CalendarAllDaySpan[] {
  if (days.length === 0) return [];
  const first = days[0]!;
  const lastExclusive = days[days.length - 1]!.add({ days: 1 });
  const spans: Omit<CalendarAllDaySpan, "row">[] = [];
  for (const event of events) {
    try {
      const interval = parseCalendarEventTime(event.time);
      if (interval.kind !== "allDay") continue;
      const start = Temporal.PlainDate.compare(interval.startDate, first) < 0 ? first : interval.startDate;
      const end = Temporal.PlainDate.compare(interval.endDateExclusive, lastExclusive) > 0 ? lastExclusive : interval.endDateExclusive;
      if (Temporal.PlainDate.compare(start, end) >= 0) continue;
      spans.push({
        event,
        startIndex: first.until(start, { largestUnit: "day" }).days,
        endIndexExclusive: first.until(end, { largestUnit: "day" }).days,
      });
    } catch {
      // Ignore one malformed event without hiding the rest of the calendar.
    }
  }
  spans.sort((left, right) => left.startIndex - right.startIndex || right.endIndexExclusive - left.endIndexExclusive || left.event.id.localeCompare(right.event.id));
  const rowEnds: number[] = [];
  return spans.map((span) => {
    let row = rowEnds.findIndex((end) => end <= span.startIndex);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = span.endIndexExclusive;
    return { ...span, row };
  });
}

export function layoutCalendarTimeView(input: {
  events: readonly DenCalendarEvent[];
  days: readonly Temporal.PlainDate[];
  visibleCalendarIds: readonly string[];
  displayTimeZone: string;
}): CalendarTimeLayout {
  const visibleIds = new Set(input.visibleCalendarIds);
  const visibleEvents = input.events.filter((event) => visibleIds.has(event.calendarId));
  const timedByDate = new Map<string, CalendarTimedSegment[]>();
  for (const day of input.days) timedByDate.set(day.toString(), []);

  for (const day of input.days) {
    const pending: PendingTimedSegment[] = [];
    const dayStart = day.toZonedDateTime({ timeZone: input.displayTimeZone, plainTime: "00:00" });
    const nextDayStart = day.add({ days: 1 }).toZonedDateTime({ timeZone: input.displayTimeZone, plainTime: "00:00" });
    for (const event of visibleEvents) {
      try {
        const interval = parseCalendarEventTime(event.time);
        if (interval.kind !== "timed") continue;
        if (Temporal.Instant.compare(interval.startInstant, nextDayStart.toInstant()) >= 0 || Temporal.Instant.compare(interval.endInstantExclusive, dayStart.toInstant()) <= 0) continue;
        const startsBefore = Temporal.Instant.compare(interval.startInstant, dayStart.toInstant()) < 0;
        const endsAfter = Temporal.Instant.compare(interval.endInstantExclusive, nextDayStart.toInstant()) > 0;
        const start = startsBefore ? dayStart : interval.startInstant.toZonedDateTimeISO(input.displayTimeZone);
        const end = endsAfter ? nextDayStart : interval.endInstantExclusive.toZonedDateTimeISO(input.displayTimeZone);
        pending.push({
          event,
          date: day,
          startMinute: startsBefore ? 0 : minuteOfDay(start),
          endMinute: endsAfter || end.toPlainDate().equals(nextDayStart.toPlainDate()) ? 1440 : minuteOfDay(end),
          continuesFromPrevious: startsBefore,
          continuesToNext: endsAfter,
        });
      } catch {
        // Ignore one malformed event without hiding the rest of the calendar.
      }
    }
    timedByDate.set(day.toString(), assignTimedLanes(pending));
  }

  const allDaySpans = placeAllDaySpans(visibleEvents, input.days);
  return {
    timedByDate,
    allDaySpans,
    allDayRowCount: allDaySpans.reduce((count, span) => Math.max(count, span.row + 1), 0),
  };
}

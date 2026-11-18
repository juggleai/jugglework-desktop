import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendarEvent, DenCalendarEventTime, DenCalendarSchedulingOccurrence } from "@/app/lib/den";
import { calendarScopeKey, type CalendarScope } from "./calendar-scope";
import { parseCalendarEventTime } from "./calendar-time-adapter";

const MAX_LEAD_MINUTES = 2 * 24 * 60;
// Allow a late fetch or a throttled timer, without replaying a day's reminders on wake.
export const REMINDER_GRACE_MS = 2 * 60_000;

export function calendarReminderWindow(today: string, timeZone: string) {
  const day = Temporal.PlainDate.from(today);
  const midnight = day.toZonedDateTime(timeZone).toInstant();
  const rollover = day.add({ days: 1 }).toZonedDateTime(timeZone).toInstant();
  const start = midnight.subtract({ milliseconds: REMINDER_GRACE_MS });
  const end = rollover.add({ minutes: MAX_LEAD_MINUTES });
  // Date-based endpoints bucket timed events in their stored zone. Pad the UTC dates
  // on both sides; an occurrence in UTC+14 can be on tomorrow's calendar already.
  return {
    range: {
      startDate: start.toZonedDateTimeISO("UTC").toPlainDate().subtract({ days: 1 }).toString(),
      endDateExclusive: end.toZonedDateTimeISO("UTC").toPlainDate().add({ days: 2 }).toString(),
    },
    schedulingRange: { startInstant: start.toString(), endInstantExclusive: end.toString(), timeZone },
    rolloverMs: rollover.epochMilliseconds,
  };
}

export type CalendarReminderTarget = {
  scope: CalendarScope;
  eventId: string;
  calendarId: string;
  /** Calendar page date (in the event's zone for timed occurrences). */
  date: string;
  occurrenceIndex?: number;
} & ({ startDate: string; startInstant?: never } | { startInstant: string; startDate?: never });

type Occurrence = { event: DenCalendarEvent; time: DenCalendarEventTime; occurrenceIndex?: number };

export function calendarReminderOccurrences(events: readonly DenCalendarEvent[], expanded: readonly DenCalendarSchedulingOccurrence[]): Occurrence[] {
  const schedulingIds = new Set(expanded.map(({ event }) => event.id));
  const ordinary = new Map<string, DenCalendarEvent>();
  for (const event of events) {
    if (schedulingIds.has(event.id) || "attendees" in event) continue;
    if ((ordinary.get(event.id)?.version ?? -1) <= event.version) ordinary.set(event.id, event);
  }
  return [
    ...Array.from(ordinary.values(), (event) => ({ event, time: event.time })),
    ...expanded.map(({ event, time, occurrenceIndex }) => ({ event, time, occurrenceIndex: event.recurrence ? occurrenceIndex : undefined })),
  ];
}

export type CalendarReminder = {
  key: string;
  title: string;
  startMs: number;
  timeZone: string;
  dueMs: number;
  target: CalendarReminderTarget;
};

export function planCalendarReminders(scope: CalendarScope, localZone: string, occurrences: readonly Occurrence[], minutesByEvent: ReadonlyMap<string, readonly number[]>): CalendarReminder[] {
  const result = new Map<string, CalendarReminder>();
  for (const { event, time, occurrenceIndex } of occurrences) {
    if (event.organizationId !== scope.organizationId) continue;
    const minutes = minutesByEvent.get(event.id);
    if (!minutes?.length) continue;
    try {
      const interval = parseCalendarEventTime(time);
      const start = interval.kind === "allDay" ? interval.startDate.toZonedDateTime(localZone) : interval.startInstant.toZonedDateTimeISO(interval.timeZone);
      const date = start.toPlainDate().toString();
      const target: CalendarReminderTarget = { scope, calendarId: event.calendarId, eventId: event.id, date, occurrenceIndex,
        ...(time.kind === "allDay" ? { startDate: time.startDate } : { startInstant: time.startInstant }) };
      for (const lead of minutes) {
        if (!Number.isSafeInteger(lead) || lead < 0 || lead > MAX_LEAD_MINUTES) continue;
        const startMs = start.epochMilliseconds;
        const key = JSON.stringify([...calendarScopeKey(scope), event.id, occurrenceIndex ?? null, time.kind, startMs, lead]);
        result.set(key, { key, target, title: event.title, startMs, timeZone: start.timeZoneId, dueMs: startMs - lead * 60_000 });
      }
    } catch { /* Ignore a malformed interval without suppressing unrelated reminders. */ }
  }
  return [...result.values()].sort((a, b) => a.dueMs - b.dueMs || a.key.localeCompare(b.key));
}

/** Only entries in the current authoritative plan can be delivered; never round to a polling minute. */
export function calendarReminderTick(plan: readonly CalendarReminder[], now: number, delivered: ReadonlyMap<string, number>) {
  const due = plan.filter((r) => r.dueMs <= now && r.dueMs >= now - REMINDER_GRACE_MS && !delivered.has(r.key));
  const nextMs = plan.find((r) => r.dueMs > now)?.dueMs;
  return { due, nextMs };
}

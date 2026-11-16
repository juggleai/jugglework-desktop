import { Temporal } from "@js-temporal/polyfill";

import type {
  DenCalendarEvent,
  DenCalendarEventTime,
  DenCalendarSchedulingOccurrence,
} from "@/app/lib/den";

const OVERVIEW_PAST_DAYS = 30;
const OVERVIEW_FUTURE_DAYS = 31;

export type MeetingOverviewWindow = {
  from: Date;
  to: Date;
  calendarRange: { startDate: string; endDateExclusive: string };
  schedulingRange: { startInstant: string; endInstantExclusive: string; timeZone: string };
};

export type CalendarMeetingOccurrence = {
  key: string;
  eventId: string;
  occurrenceIndex?: number;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  recurring: boolean;
  description: string;
  attendeeMemberIds: string[];
  collapsedCount?: number;
};

/**
 * Keep both Meeting and Calendar reads on the same rolling window. Sixty-one
 * local days stays below Calendar's 62 * 24 hour API limit even across DST.
 */
export function meetingOverviewWindow(now: Temporal.Instant, timeZone: string): MeetingOverviewWindow {
  const today = now.toZonedDateTimeISO(timeZone).startOfDay();
  const start = today.subtract({ days: OVERVIEW_PAST_DAYS });
  const end = today.add({ days: OVERVIEW_FUTURE_DAYS });
  const startInstant = start.toInstant().toString();
  const endInstantExclusive = end.toInstant().toString();
  return {
    from: new Date(startInstant),
    to: new Date(endInstantExclusive),
    calendarRange: {
      startDate: start.toPlainDate().toString(),
      endDateExclusive: end.toPlainDate().toString(),
    },
    schedulingRange: { startInstant, endInstantExclusive, timeZone },
  };
}

export function calendarMeetingOccurrences(
  bootstrapEvents: readonly DenCalendarEvent[],
  schedulingOccurrences: readonly DenCalendarSchedulingOccurrence[],
  displayTimeZone: string,
): CalendarMeetingOccurrence[] {
  const schedulingEventIds = new Set(schedulingOccurrences.map((occurrence) => occurrence.event.id));
  const ordinary = bootstrapEvents
    .filter((event) => event.videoConferenceEnabled && !schedulingEventIds.has(event.id) && !("attendees" in event))
    .map((event) => toCalendarMeetingOccurrence(event, event.time, displayTimeZone));
  const expanded = schedulingOccurrences
    .filter((occurrence) => occurrence.event.videoConferenceEnabled)
    .map((occurrence) => toCalendarMeetingOccurrence(
      occurrence.event,
      occurrence.time,
      displayTimeZone,
      occurrence.occurrenceIndex,
    ));
  return [...ordinary, ...expanded];
}

/** Keep one latest row for each recurring series in history. */
export function collapseHistoricalCalendarOccurrences(
  occurrences: readonly CalendarMeetingOccurrence[],
): CalendarMeetingOccurrence[] {
  const result: CalendarMeetingOccurrence[] = [];
  const recurringByEvent = new Map<string, CalendarMeetingOccurrence>();
  for (const occurrence of occurrences) {
    if (!occurrence.recurring) {
      result.push(occurrence);
      continue;
    }
    const current = recurringByEvent.get(occurrence.eventId);
    const latest = !current || Date.parse(occurrence.startAt) > Date.parse(current.startAt)
      ? occurrence
      : current;
    recurringByEvent.set(occurrence.eventId, {
      ...latest,
      collapsedCount: (current?.collapsedCount ?? (current ? 1 : 0)) + 1,
    });
  }
  return [...result, ...recurringByEvent.values()];
}

function toCalendarMeetingOccurrence(
  event: DenCalendarEvent,
  time: DenCalendarEventTime,
  displayTimeZone: string,
  occurrenceIndex?: number,
): CalendarMeetingOccurrence {
  const instants = calendarEventInstants(time, displayTimeZone);
  return {
    key: occurrenceIndex === undefined
      ? `calendar:${event.id}`
      : `calendar:${event.id}:${occurrenceIndex}:${instants.startAt}`,
    eventId: event.id,
    occurrenceIndex,
    title: event.title,
    description: event.description,
    attendeeMemberIds: "attendees" in event && Array.isArray(event.attendees)
      ? event.attendees.map((attendee) => attendee.memberId)
      : [event.ownerMemberId],
    ...instants,
    recurring: occurrenceIndex !== undefined && "recurrence" in event && event.recurrence !== null,
  };
}

function calendarEventInstants(
  time: DenCalendarEventTime,
  displayTimeZone: string,
): { startAt: string; endAt: string; allDay: boolean } {
  if (time.kind === "timed") {
    return { startAt: time.startInstant, endAt: time.endInstantExclusive, allDay: false };
  }
  const startAt = Temporal.PlainDate.from(time.startDate)
    .toZonedDateTime({ timeZone: displayTimeZone, plainTime: Temporal.PlainTime.from("00:00") })
    .toInstant()
    .toString();
  const endAt = Temporal.PlainDate.from(time.endDateExclusive)
    .toZonedDateTime({ timeZone: displayTimeZone, plainTime: Temporal.PlainTime.from("00:00") })
    .toInstant()
    .toString();
  return { startAt, endAt, allDay: true };
}

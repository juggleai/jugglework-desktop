import { Temporal } from "@js-temporal/polyfill";

import type { CalendarEventTime } from "./calendar-types";

export type CalendarAllDayInterval = {
  kind: "allDay";
  startDate: Temporal.PlainDate;
  endDateExclusive: Temporal.PlainDate;
};

export type CalendarTimedInterval = {
  kind: "timed";
  startInstant: Temporal.Instant;
  endInstantExclusive: Temporal.Instant;
  timeZone: string;
};

export type CalendarTimeInterval = CalendarAllDayInterval | CalendarTimedInterval;
export type CalendarLocalTimeDisambiguation = "reject" | "earlier" | "later";
export type CalendarTimeForm =
  | { kind: "allDay"; startDate: string; endDateExclusive: string }
  | {
      kind: "timed";
      startDate: string;
      startTime: string;
      endDate: string;
      endTime: string;
      timeZone: string;
      startDisambiguation: CalendarLocalTimeDisambiguation;
      endDisambiguation: CalendarLocalTimeDisambiguation;
    };

export type CalendarTimeConversionStrategy =
  | { kind: "allDay"; timeZone: string }
  | {
      kind: "timed";
      timeZone: string;
      startTime: Temporal.PlainTime | string;
      endTime: Temporal.PlainTime | string;
      startDisambiguation: CalendarLocalTimeDisambiguation;
      endDisambiguation: CalendarLocalTimeDisambiguation;
    };

function assertExclusiveRange(start: Temporal.PlainDate | Temporal.Instant, end: Temporal.PlainDate | Temporal.Instant): void {
  const order = start instanceof Temporal.PlainDate
    ? Temporal.PlainDate.compare(start, end as Temporal.PlainDate)
    : Temporal.Instant.compare(start, end as Temporal.Instant);
  if (order >= 0) throw new RangeError("Calendar end must be after start.");
}

function assertIanaTimeZone(timeZone: string): void {
  if (/^[+-]/.test(timeZone)) throw new RangeError("Calendar time zone must be an IANA zone.");
  Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(timeZone);
}

export function parseCalendarEventTime(time: CalendarEventTime): CalendarTimeInterval {
  if (time.kind === "allDay") {
    const startDate = Temporal.PlainDate.from(time.startDate);
    const endDateExclusive = Temporal.PlainDate.from(time.endDateExclusive);
    assertExclusiveRange(startDate, endDateExclusive);
    return { kind: "allDay", startDate, endDateExclusive };
  }
  const startInstant = Temporal.Instant.from(time.startInstant);
  const endInstantExclusive = Temporal.Instant.from(time.endInstantExclusive);
  assertExclusiveRange(startInstant, endInstantExclusive);
  assertIanaTimeZone(time.timeZone);
  return { kind: "timed", startInstant, endInstantExclusive, timeZone: time.timeZone };
}

export function serializeCalendarEventTime(time: CalendarTimeInterval): CalendarEventTime {
  if (time.kind === "allDay") {
    assertExclusiveRange(time.startDate, time.endDateExclusive);
    return { kind: "allDay", startDate: time.startDate.toString(), endDateExclusive: time.endDateExclusive.toString() };
  }
  assertExclusiveRange(time.startInstant, time.endInstantExclusive);
  assertIanaTimeZone(time.timeZone);
  return {
    kind: "timed",
    startInstant: time.startInstant.toString(),
    endInstantExclusive: time.endInstantExclusive.toString(),
    timeZone: time.timeZone,
  };
}

export function resolveCalendarZonedDateTime(input: {
  date: Temporal.PlainDate | string;
  time: Temporal.PlainTime | string;
  timeZone: string;
  disambiguation: CalendarLocalTimeDisambiguation;
}): Temporal.ZonedDateTime {
  const date = Temporal.PlainDate.from(input.date);
  const time = Temporal.PlainTime.from(input.time);
  assertIanaTimeZone(input.timeZone);
  return Temporal.ZonedDateTime.from({
    timeZone: input.timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    second: time.second,
    millisecond: time.millisecond,
    microsecond: time.microsecond,
    nanosecond: time.nanosecond,
  }, { disambiguation: input.disambiguation });
}

export function createCalendarTimeFromForm(input:
  CalendarTimeForm,
): CalendarTimeInterval {
  if (input.kind === "allDay") {
    return parseCalendarEventTime(input);
  }
  const start = resolveCalendarZonedDateTime({
    date: input.startDate,
    time: input.startTime,
    timeZone: input.timeZone,
    disambiguation: input.startDisambiguation,
  });
  const end = resolveCalendarZonedDateTime({
    date: input.endDate,
    time: input.endTime,
    timeZone: input.timeZone,
    disambiguation: input.endDisambiguation,
  });
  assertExclusiveRange(start.toInstant(), end.toInstant());
  return { kind: "timed", startInstant: start.toInstant(), endInstantExclusive: end.toInstant(), timeZone: input.timeZone };
}

function calendarFormDisambiguation(value: Temporal.ZonedDateTime): CalendarLocalTimeDisambiguation {
  const input = {
    date: value.toPlainDate(),
    time: value.toPlainTime(),
    timeZone: value.timeZoneId,
  };
  const earlier = resolveCalendarZonedDateTime({ ...input, disambiguation: "earlier" }).toInstant();
  const later = resolveCalendarZonedDateTime({ ...input, disambiguation: "later" }).toInstant();
  if (Temporal.Instant.compare(earlier, later) === 0) return "reject";
  return Temporal.Instant.compare(value.toInstant(), earlier) === 0 ? "earlier" : "later";
}

export function calendarTimeToForm(time: CalendarTimeInterval): CalendarTimeForm {
  if (time.kind === "allDay") {
    return { kind: "allDay", startDate: time.startDate.toString(), endDateExclusive: time.endDateExclusive.toString() };
  }
  assertExclusiveRange(time.startInstant, time.endInstantExclusive);
  assertIanaTimeZone(time.timeZone);
  const start = time.startInstant.toZonedDateTimeISO(time.timeZone);
  const end = time.endInstantExclusive.toZonedDateTimeISO(time.timeZone);
  return {
    kind: "timed",
    startDate: start.toPlainDate().toString(),
    startTime: start.toPlainTime().toString(),
    endDate: end.toPlainDate().toString(),
    endTime: end.toPlainTime().toString(),
    timeZone: time.timeZone,
    startDisambiguation: calendarFormDisambiguation(start),
    endDisambiguation: calendarFormDisambiguation(end),
  };
}

export function convertCalendarTime(
  time: CalendarTimeInterval,
  strategy: CalendarTimeConversionStrategy,
): CalendarTimeInterval {
  if (time.kind === "timed") {
    if (strategy.kind !== "allDay") throw new TypeError("Calendar time conversion must change kind.");
    assertIanaTimeZone(strategy.timeZone);
    const startDate = time.startInstant.toZonedDateTimeISO(strategy.timeZone).toPlainDate();
    const end = time.endInstantExclusive.toZonedDateTimeISO(strategy.timeZone);
    const endsAtMidnight = Temporal.PlainTime.compare(end.toPlainTime(), Temporal.PlainTime.from("00:00")) === 0;
    return {
      kind: "allDay",
      startDate,
      endDateExclusive: endsAtMidnight ? end.toPlainDate() : end.toPlainDate().add({ days: 1 }),
    };
  }
  if (strategy.kind !== "timed") throw new TypeError("Calendar time conversion must change kind.");
  const inclusiveEndDate = time.endDateExclusive.subtract({ days: 1 });
  return createCalendarTimeFromForm({
    kind: "timed",
    startDate: time.startDate.toString(),
    startTime: Temporal.PlainTime.from(strategy.startTime).toString(),
    endDate: inclusiveEndDate.toString(),
    endTime: Temporal.PlainTime.from(strategy.endTime).toString(),
    timeZone: strategy.timeZone,
    startDisambiguation: strategy.startDisambiguation,
    endDisambiguation: strategy.endDisambiguation,
  });
}

export function calendarCoverageDates(time: CalendarTimeInterval): { startDate: Temporal.PlainDate; endDateExclusive: Temporal.PlainDate } {
  if (time.kind === "allDay") return { startDate: time.startDate, endDateExclusive: time.endDateExclusive };
  const start = time.startInstant.toZonedDateTimeISO(time.timeZone);
  const end = time.endInstantExclusive.toZonedDateTimeISO(time.timeZone);
  const endsAtMidnight = end.hour === 0 && end.minute === 0 && end.second === 0 && end.millisecond === 0 && end.microsecond === 0 && end.nanosecond === 0;
  return {
    startDate: start.toPlainDate(),
    endDateExclusive: endsAtMidnight ? end.toPlainDate() : end.toPlainDate().add({ days: 1 }),
  };
}

export function formatCalendarTime(time: CalendarTimeInterval, locale: string): string {
  if (time.kind === "allDay") {
    const inclusiveEnd = time.endDateExclusive.subtract({ days: 1 });
    const start = time.startDate.toLocaleString(locale, { dateStyle: "medium" });
    if (Temporal.PlainDate.compare(time.startDate, inclusiveEnd) === 0) return start;
    return `${start} - ${inclusiveEnd.toLocaleString(locale, { dateStyle: "medium" })}`;
  }
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  };
  const start = time.startInstant.toZonedDateTimeISO(time.timeZone);
  const end = time.endInstantExclusive.toZonedDateTimeISO(time.timeZone);
  return `${start.toLocaleString(locale, options)} - ${end.toLocaleString(locale, options)}`;
}

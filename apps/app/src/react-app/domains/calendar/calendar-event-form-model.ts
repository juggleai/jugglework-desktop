import { Temporal } from "@js-temporal/polyfill";

import type { DenApiError, DenCalendarEvent, DenCalendarEventTime } from "@/app/lib/den";
import {
  calendarTimeToForm,
  convertCalendarTime,
  createCalendarTimeFromForm,
  parseCalendarEventTime,
  serializeCalendarEventTime,
  type CalendarTimeForm,
} from "./calendar-time-adapter";

/** Must match jugglework-server CalendarEventTitleMaxLength / CalendarEventDescriptionMaxLength (code points). */
export const CALENDAR_EVENT_TITLE_MAX = 500;
export const CALENDAR_EVENT_DESCRIPTION_MAX = 20_000;

export type CalendarEventFormValues = {
  calendarId: string;
  title: string;
  description: string;
  time: CalendarTimeForm;
};

export type CalendarEventFormField = "title" | "calendarId" | "description" | "time";
export type CalendarEventFormErrors = Partial<Record<CalendarEventFormField, string>>;

/** i18n keys; the UI resolves them so this module stays framework-free. */
export const CALENDAR_FORM_ERROR = {
  titleRequired: "calendar.error_title_required",
  titleTooLong: "calendar.error_title_too_long",
  descriptionTooLong: "calendar.error_description_too_long",
  calendarRequired: "calendar.error_calendar_required",
  timeInvalid: "calendar.error_time_invalid",
  endNotAfterStart: "calendar.error_end_not_after_start",
  timeZoneInvalid: "calendar.error_time_zone_invalid",
  localTimeAmbiguous: "calendar.error_local_time_ambiguous",
} as const;

function codePointLength(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

export function defaultCalendarEventForm(input: {
  date: Temporal.PlainDate;
  calendarId: string;
  timeZone: string;
  kind?: "allDay" | "timed";
}): CalendarEventFormValues {
  const time: CalendarTimeForm = input.kind === "timed"
    ? {
        kind: "timed",
        startDate: input.date.toString(),
        startTime: "09:00",
        endDate: input.date.toString(),
        endTime: "10:00",
        timeZone: input.timeZone,
        startDisambiguation: "reject",
        endDisambiguation: "reject",
      }
    : { kind: "allDay", startDate: input.date.toString(), endDateExclusive: input.date.add({ days: 1 }).toString() };
  return { calendarId: input.calendarId, title: "", description: "", time };
}

export function calendarEventToForm(event: DenCalendarEvent): CalendarEventFormValues {
  return {
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    time: calendarTimeToForm(parseCalendarEventTime(event.time)),
  };
}

/**
 * Switch between all-day and timed explicitly. Timed → all-day keeps the covered local dates in
 * the event zone; all-day → timed keeps the date range with default hours.
 */
export function switchCalendarFormTimeKind(form: CalendarEventFormValues, kind: "allDay" | "timed", fallbackTimeZone: string): CalendarEventFormValues {
  if (form.time.kind === kind) return form;
  try {
    const interval = createCalendarTimeFromForm(form.time);
    const converted = kind === "allDay"
      ? convertCalendarTime(interval, { kind: "allDay", timeZone: form.time.kind === "timed" ? form.time.timeZone : fallbackTimeZone })
      : convertCalendarTime(interval, { kind: "timed", timeZone: fallbackTimeZone, startTime: "09:00", endTime: "10:00", startDisambiguation: "reject", endDisambiguation: "reject" });
    return { ...form, time: calendarTimeToForm(converted) };
  } catch {
    // Current values are invalid; fall back to a fresh range on the start date so the switch always works.
    const startDate = Temporal.PlainDate.from(form.time.startDate);
    const fresh = defaultCalendarEventForm({ date: startDate, calendarId: form.calendarId, timeZone: fallbackTimeZone, kind });
    return { ...form, time: fresh.time };
  }
}

function timeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/end must be after start/i.test(message)) return CALENDAR_FORM_ERROR.endNotAfterStart;
  if (/IANA|time ?zone/i.test(message)) return CALENDAR_FORM_ERROR.timeZoneInvalid;
  if (/ambiguous|disambiguation|multiple|does not exist|skipped|gap/i.test(message)) return CALENDAR_FORM_ERROR.localTimeAmbiguous;
  return CALENDAR_FORM_ERROR.timeInvalid;
}

export type CalendarEventFormValidation =
  | { ok: true; values: { calendarId: string; title: string; description: string; time: DenCalendarEventTime } }
  | { ok: false; errors: CalendarEventFormErrors };

export function validateCalendarEventForm(form: CalendarEventFormValues, activeCalendarIds: readonly string[]): CalendarEventFormValidation {
  const errors: CalendarEventFormErrors = {};
  const titleLength = codePointLength(form.title);
  if (form.title.trim() === "") errors.title = CALENDAR_FORM_ERROR.titleRequired;
  else if (titleLength > CALENDAR_EVENT_TITLE_MAX) errors.title = CALENDAR_FORM_ERROR.titleTooLong;
  if (codePointLength(form.description) > CALENDAR_EVENT_DESCRIPTION_MAX) errors.description = CALENDAR_FORM_ERROR.descriptionTooLong;
  if (!form.calendarId || !activeCalendarIds.includes(form.calendarId)) errors.calendarId = CALENDAR_FORM_ERROR.calendarRequired;

  let time: DenCalendarEventTime | null = null;
  try {
    // createCalendarTimeFromForm only reads the fields of the declared kind, so mixed state cannot leak through.
    time = serializeCalendarEventTime(createCalendarTimeFromForm(form.time));
  } catch (error) {
    errors.time = timeError(error);
  }
  if (Object.keys(errors).length > 0 || !time) return { ok: false, errors };
  return { ok: true, values: { calendarId: form.calendarId, title: form.title, description: form.description, time } };
}

/** Only the changed fields go into an update, so concurrent edits to other fields are not overwritten blindly. */
export function calendarEventUpdatePatch(
  original: DenCalendarEvent,
  next: { calendarId: string; title: string; description: string; time: DenCalendarEventTime },
): Partial<{ calendarId: string; title: string; description: string; time: DenCalendarEventTime }> {
  const patch: Partial<{ calendarId: string; title: string; description: string; time: DenCalendarEventTime }> = {};
  if (next.calendarId !== original.calendarId) patch.calendarId = next.calendarId;
  if (next.title !== original.title) patch.title = next.title;
  if (next.description !== original.description) patch.description = next.description;
  if (JSON.stringify(next.time) !== JSON.stringify(original.time)) patch.time = next.time;
  return patch;
}

export type CalendarSaveFailure =
  | { kind: "conflict"; message: string }
  | { kind: "validation"; message: string }
  | { kind: "auth"; message: string }
  | { kind: "not-found"; message: string }
  | { kind: "network"; message: string };

export function classifyCalendarSaveFailure(error: unknown): CalendarSaveFailure {
  const apiError = error as Partial<DenApiError> & { status?: number; code?: string };
  const status = typeof apiError?.status === "number" ? apiError.status : null;
  if (apiError?.code === "calendar_version_conflict" || status === 409) return { kind: "conflict", message: "calendar.error_conflict" };
  if (status === 401 || status === 403) return { kind: "auth", message: "calendar.error_auth" };
  if (status === 404) return { kind: "not-found", message: "calendar.error_not_found" };
  if (status === 400 || status === 422) return { kind: "validation", message: "calendar.error_server_validation" };
  return { kind: "network", message: "calendar.error_network" };
}

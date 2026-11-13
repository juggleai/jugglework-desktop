import { Temporal } from "@js-temporal/polyfill";

import type { DenApiError, DenCalendarEvent, DenCalendarEventTime, DenCalendarSchedulingEvent, DenCalendarSchedulingRecurrence } from "@/app/lib/den";
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
export const CALENDAR_EVENT_ATTENDEE_MAX = 20;

export type CalendarEventFormValues = {
  calendarId: string;
  title: string;
  description: string;
  videoConferenceEnabled: boolean;
  time: CalendarTimeForm;
  attendeeMemberIds: string[];
  recurrence: CalendarEventRecurrenceForm;
};

export type CalendarEventRecurrenceForm =
  | { frequency: "none" }
  | { frequency: "daily" | "weekly" | "monthly"; interval: number; endKind: "never" | "until" | "count"; untilDate: string; count: number };

export type CalendarEventFormField = "title" | "calendarId" | "description" | "time" | "attendees" | "recurrence";
export type CalendarEventFormErrors = Partial<Record<CalendarEventFormField, string>>;

export function hasAdvancedCalendarScheduling(values: Pick<CalendarEventFormValues, "attendeeMemberIds" | "recurrence">): boolean {
  return values.attendeeMemberIds.length > 0 || values.recurrence.frequency !== "none";
}

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
  attendeesTooMany: "calendar.error_attendees_too_many",
  recurrenceInvalid: "calendar.error_recurrence_invalid",
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
  creatorMemberId?: string;
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
  return {
    calendarId: input.calendarId,
    title: "",
    description: "",
    videoConferenceEnabled: true,
    time,
    attendeeMemberIds: input.creatorMemberId ? [input.creatorMemberId] : [],
    recurrence: { frequency: "none" },
  };
}

export function calendarEventToForm(event: DenCalendarEvent): CalendarEventFormValues {
  const scheduling = event as Partial<DenCalendarSchedulingEvent>;
  const recurrence = scheduling.recurrence ? recurrenceToForm(scheduling.recurrence) : { frequency: "none" as const };
  return {
    calendarId: event.calendarId,
    title: event.title,
    description: event.description,
    videoConferenceEnabled: event.videoConferenceEnabled,
    time: calendarTimeToForm(parseCalendarEventTime(event.time)),
    attendeeMemberIds: Array.isArray(scheduling.attendees) ? scheduling.attendees.map((attendee) => attendee.memberId) : [],
    recurrence,
  };
}

function recurrenceToForm(recurrence: DenCalendarSchedulingRecurrence): CalendarEventRecurrenceForm {
  return {
    frequency: recurrence.frequency,
    interval: recurrence.interval,
    endKind: recurrence.end.kind,
    untilDate: recurrence.end.kind === "until" ? recurrence.end.until : "",
    count: recurrence.end.kind === "count" ? recurrence.end.count : 10,
  };
}

export function defaultCalendarRecurrence(frequency: "daily" | "weekly" | "monthly", startDate: string): CalendarEventRecurrenceForm {
  const date = Temporal.PlainDate.from(startDate);
  return { frequency, interval: 1, endKind: "never", untilDate: date.add({ months: 1 }).toString(), count: 10 };
}

function serializeRecurrence(form: CalendarEventRecurrenceForm): DenCalendarSchedulingRecurrence | null {
  if (form.frequency === "none") return null;
  if (!Number.isSafeInteger(form.interval) || form.interval < 1 || form.interval > 365) throw new Error("recurrence");
  const end = form.endKind === "never" ? { kind: "never" as const }
    : form.endKind === "until" && /^\d{4}-\d{2}-\d{2}$/.test(form.untilDate) ? { kind: "until" as const, until: Temporal.PlainDate.from(form.untilDate).toString() }
    : form.endKind === "count" && Number.isSafeInteger(form.count) && form.count >= 1 && form.count <= 1000 ? { kind: "count" as const, count: form.count }
    : null;
  if (!end) throw new Error("recurrence");
  return { frequency: form.frequency, interval: form.interval, end };
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

function isThirtyMinuteTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):(?:00|30)(?::00(?:\.0+)?)?$/.test(value);
}

export type CalendarEventFormValidation =
  | { ok: true; values: { calendarId: string; title: string; description: string; videoConferenceEnabled: boolean; time: DenCalendarEventTime; attendeeMemberIds: string[]; recurrence: DenCalendarSchedulingRecurrence | null } }
  | { ok: false; errors: CalendarEventFormErrors };

export function validateCalendarEventForm(
  form: CalendarEventFormValues,
  activeCalendarIds: readonly string[],
  requiredAttendeeMemberId?: string,
): CalendarEventFormValidation {
  const errors: CalendarEventFormErrors = {};
  const attendeeMemberIds = [...new Set([
    ...(requiredAttendeeMemberId ? [requiredAttendeeMemberId] : []),
    ...form.attendeeMemberIds.filter(Boolean),
  ])];
  const titleLength = codePointLength(form.title);
  if (form.title.trim() === "") errors.title = CALENDAR_FORM_ERROR.titleRequired;
  else if (titleLength > CALENDAR_EVENT_TITLE_MAX) errors.title = CALENDAR_FORM_ERROR.titleTooLong;
  if (codePointLength(form.description) > CALENDAR_EVENT_DESCRIPTION_MAX) errors.description = CALENDAR_FORM_ERROR.descriptionTooLong;
  if (!form.calendarId || !activeCalendarIds.includes(form.calendarId)) errors.calendarId = CALENDAR_FORM_ERROR.calendarRequired;
  if (attendeeMemberIds.length > CALENDAR_EVENT_ATTENDEE_MAX) errors.attendees = CALENDAR_FORM_ERROR.attendeesTooMany;

  let time: DenCalendarEventTime | null = null;
  let recurrence: DenCalendarSchedulingRecurrence | null = null;
  try {
    if (form.time.kind === "timed" && (!isThirtyMinuteTime(form.time.startTime) || !isThirtyMinuteTime(form.time.endTime))) throw new Error("time must use 30-minute increments");
    // createCalendarTimeFromForm only reads the fields of the declared kind, so mixed state cannot leak through.
    time = serializeCalendarEventTime(createCalendarTimeFromForm(form.time));
  } catch (error) {
    errors.time = timeError(error);
  }
  try {
    recurrence = serializeRecurrence(form.recurrence);
  } catch {
    errors.recurrence = CALENDAR_FORM_ERROR.recurrenceInvalid;
  }
  if (Object.keys(errors).length > 0 || !time) return { ok: false, errors };
  return { ok: true, values: { calendarId: form.calendarId, title: form.title, description: form.description, videoConferenceEnabled: form.videoConferenceEnabled, time, attendeeMemberIds, recurrence } };
}

/** Only the changed fields go into an update, so concurrent edits to other fields are not overwritten blindly. */
export function calendarEventUpdatePatch(
  original: DenCalendarEvent,
  next: { calendarId: string; title: string; description: string; videoConferenceEnabled: boolean; time: DenCalendarEventTime; attendeeMemberIds: string[]; recurrence: DenCalendarSchedulingRecurrence | null },
): Partial<{ calendarId: string; title: string; description: string; videoConferenceEnabled: boolean; time: DenCalendarEventTime; attendeeMemberIds: string[]; recurrence: DenCalendarSchedulingRecurrence | null }> {
  const patch: Partial<{ calendarId: string; title: string; description: string; videoConferenceEnabled: boolean; time: DenCalendarEventTime; attendeeMemberIds: string[]; recurrence: DenCalendarSchedulingRecurrence | null }> = {};
  if (next.calendarId !== original.calendarId) patch.calendarId = next.calendarId;
  if (next.title !== original.title) patch.title = next.title;
  if (next.description !== original.description) patch.description = next.description;
  if (next.videoConferenceEnabled !== original.videoConferenceEnabled) patch.videoConferenceEnabled = next.videoConferenceEnabled;
  if (JSON.stringify(next.time) !== JSON.stringify(original.time)) patch.time = next.time;
  const originalAttendees = "attendees" in original ? (original as DenCalendarSchedulingEvent).attendees.map((attendee) => attendee.memberId) : [];
  const originalRecurrence = "recurrence" in original ? (original as DenCalendarSchedulingEvent).recurrence : null;
  const sortedNextAttendees = [...next.attendeeMemberIds].sort();
  const sortedOriginalAttendees = [...originalAttendees].sort();
  if (JSON.stringify(sortedNextAttendees) !== JSON.stringify(sortedOriginalAttendees)) patch.attendeeMemberIds = next.attendeeMemberIds;
  if (JSON.stringify(next.recurrence) !== JSON.stringify(originalRecurrence)) patch.recurrence = next.recurrence;
  return patch;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strictly reads the persisted form shape and upgrades legacy v1 scheduling defaults. */
export function normalizeCalendarEventDraftForm(value: unknown, schemaVersion: 1 | 2): CalendarEventFormValues | null {
  if (!record(value)) return null;
  const expected = schemaVersion === 1
    ? ["calendarId", "title", "description", "time"]
    : ["calendarId", "title", "description", "time", "attendeeMemberIds", "recurrence"];
  if (!exactKeys(value, expected) || typeof value.calendarId !== "string" || typeof value.title !== "string" || typeof value.description !== "string" || !record(value.time)) return null;
  let time: CalendarTimeForm;
  if (value.time.kind === "allDay" && exactKeys(value.time, ["kind", "startDate", "endDateExclusive"]) && typeof value.time.startDate === "string" && typeof value.time.endDateExclusive === "string") {
    time = { kind: "allDay", startDate: value.time.startDate, endDateExclusive: value.time.endDateExclusive };
  } else if (value.time.kind === "timed" && exactKeys(value.time, ["kind", "startDate", "startTime", "endDate", "endTime", "timeZone", "startDisambiguation", "endDisambiguation"]) &&
    typeof value.time.startDate === "string" && typeof value.time.startTime === "string" && typeof value.time.endDate === "string" && typeof value.time.endTime === "string" && typeof value.time.timeZone === "string" &&
    ["reject", "earlier", "later"].includes(String(value.time.startDisambiguation)) && ["reject", "earlier", "later"].includes(String(value.time.endDisambiguation))) {
    time = value.time as CalendarTimeForm;
  } else return null;
  if (schemaVersion === 1) return { calendarId: value.calendarId, title: value.title, description: value.description, videoConferenceEnabled: true, time, attendeeMemberIds: [], recurrence: { frequency: "none" } };
  if (!Array.isArray(value.attendeeMemberIds) || value.attendeeMemberIds.some((id) => typeof id !== "string" || !id) || !record(value.recurrence)) return null;
  let recurrence: CalendarEventRecurrenceForm;
  if (value.recurrence.frequency === "none" && exactKeys(value.recurrence, ["frequency"])) recurrence = { frequency: "none" };
  else if (["daily", "weekly", "monthly"].includes(String(value.recurrence.frequency)) && exactKeys(value.recurrence, ["frequency", "interval", "endKind", "untilDate", "count"]) && Number.isSafeInteger(value.recurrence.interval) && ["never", "until", "count"].includes(String(value.recurrence.endKind)) && typeof value.recurrence.untilDate === "string" && Number.isSafeInteger(value.recurrence.count)) {
    recurrence = value.recurrence as CalendarEventRecurrenceForm;
  } else return null;
  return { calendarId: value.calendarId, title: value.title, description: value.description, videoConferenceEnabled: true, time, attendeeMemberIds: [...new Set(value.attendeeMemberIds as string[])], recurrence };
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

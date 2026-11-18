import { t } from "@/i18n";
import { calendarScopeKey, type CalendarScope } from "./calendar-scope";

export const DEFAULT_CALENDAR_REMINDER_MINUTES = [5] as const;
export const CALENDAR_REMINDER_PREFERENCES_CHANGED = "jugglework:calendar-reminder-preferences-changed";

// eventId is the original event/series ID, never the occurrence's display ID.
function storageKey(scope: CalendarScope, eventId: string): string {
  return `jugglework.calendar.reminders:${JSON.stringify([...calendarScopeKey(scope), eventId])}`;
}

export function readCalendarReminderMinutes(scope: CalendarScope, eventId: string): number[] {
  try {
    const raw = localStorage.getItem(storageKey(scope, eventId));
    const minutes: unknown = raw === null ? null : JSON.parse(raw);
    if (Array.isArray(minutes) && minutes.every((m) => Number.isSafeInteger(m) && m >= 0)) return [...new Set<number>(minutes)];
  } catch { /* Storage may be unavailable or contain an invalid entry. */ }
  return [...DEFAULT_CALENDAR_REMINDER_MINUTES];
}

export function writeCalendarReminderMinutes(scope: CalendarScope, eventId: string, minutes: readonly number[]): void {
  const unique = [...new Set(minutes)];
  if (!unique.every((m) => Number.isSafeInteger(m) && m >= 0)) return;
  try {
    localStorage.setItem(storageKey(scope, eventId), JSON.stringify(unique));
  } catch { return; } // A local preference failure must not turn a saved event into a failed mutation.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CALENDAR_REMINDER_PREFERENCES_CHANGED, { detail: { scope, eventId, minutes: unique } }));
  }
}

export function reminderLabel(minutes: number): string {
  if (minutes === 0) return t("calendar.reminder_at_start");
  if (minutes % 1440 === 0) return t("calendar.reminder_days_before", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("calendar.reminder_hours_before", { count: minutes / 60 });
  return t("calendar.reminder_minutes_before", { count: minutes });
}

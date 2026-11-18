import { Temporal } from "@js-temporal/polyfill";
import type { CalendarReminderTarget } from "./calendar-reminder-schedule";

export type CalendarReminderNavigation = Readonly<CalendarReminderTarget>;

// A renderer-local, one-shot handoff. While /calendar is unmounted only the latest click matters.
let pending: CalendarReminderNavigation | null = null;
let receiver: ((intent: CalendarReminderNavigation) => void) | null = null;

/** Call before navigate("/calendar"); a mounted page receives the same request immediately. */
export function requestCalendarReminderNavigation(intent: CalendarReminderNavigation) {
  const request = { ...intent, scope: { ...intent.scope } };
  if (receiver) receiver(request);
  else pending = request;
}

export function receiveCalendarReminderNavigation(receive: (intent: CalendarReminderNavigation) => void) {
  receiver = receive;
  if (pending) {
    const request = pending;
    pending = null;
    receive(request);
  }
  return () => { if (receiver === receive) receiver = null; };
}

export function calendarReminderDate(intent: CalendarReminderNavigation, timeZone: string): Temporal.PlainDate | null {
  try {
    const eventDate = Temporal.PlainDate.from(intent.date);
    if (eventDate.toString() !== intent.date) return null;
    // Timed ranges are queried in the viewer's zone (which may differ from the notification's).
    if (intent.startInstant !== undefined) {
      const localDate = Temporal.Instant.from(intent.startInstant).toZonedDateTimeISO(timeZone).toPlainDate();
      return Math.abs(eventDate.until(localDate).days) <= 2 ? localDate : null;
    }
    return intent.startDate === intent.date ? eventDate : null;
  } catch { return null; }
}

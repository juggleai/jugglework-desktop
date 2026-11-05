import { calendarScopeKey, type CalendarScope } from "./calendar-scope";

function calendarFilterKey(calendarIds: readonly string[] | undefined): readonly string[] {
  return [...new Set(calendarIds ?? [])].sort();
}

export const calendarQueryKeys = {
  scope(scope: CalendarScope) {
    return ["calendar", ...calendarScopeKey(scope)] as const;
  },
  calendars(scope: CalendarScope) {
    return [...this.scope(scope), "calendars"] as const;
  },
  calendar(scope: CalendarScope, calendarId: string) {
    return [...this.calendars(scope), calendarId] as const;
  },
  bootstrap(scope: CalendarScope, range: { startDate: string; endDateExclusive: string; calendarIds?: readonly string[] }) {
    return [...this.scope(scope), "bootstrap", range.startDate, range.endDateExclusive, calendarFilterKey(range.calendarIds)] as const;
  },
  range(scope: CalendarScope, input: { startDate: string; endDateExclusive: string; calendarIds?: readonly string[]; cursor?: string; limit?: number }) {
    return [...this.scope(scope), "events", "range", input.startDate, input.endDateExclusive, calendarFilterKey(input.calendarIds), input.cursor ?? null, input.limit ?? null] as const;
  },
  search(scope: CalendarScope, input: { query: string; calendarIds?: readonly string[]; cursor?: string; limit?: number }) {
    return [...this.scope(scope), "events", "search", input.query, calendarFilterKey(input.calendarIds), input.cursor ?? null, input.limit ?? null] as const;
  },
  event(scope: CalendarScope, eventId: string) {
    return [...this.scope(scope), "events", "detail", eventId] as const;
  },
  changes(scope: CalendarScope, cursor: string, limit?: number) {
    return [...this.scope(scope), "changes", cursor, limit ?? null] as const;
  },
};

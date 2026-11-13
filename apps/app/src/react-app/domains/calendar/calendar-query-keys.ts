import { calendarScopeKey, type CalendarScope } from "./calendar-scope";

function calendarFilterKey(calendarIds: readonly string[] | undefined): readonly string[] {
  return [...new Set(calendarIds ?? [])].sort();
}

function cursorKey(cursor: string | undefined): string | null {
  return cursor || null;
}

export const calendarQueryKeys = {
  scope: (scope: CalendarScope) => ["calendar", ...calendarScopeKey(scope)] as const,
  calendars: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "calendars"] as const,
  collaboration: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "collaboration"] as const,
  organizationMembers: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "organization-members"] as const,
  scheduling: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "scheduling"] as const,
  schedulingEvents: (scope: CalendarScope, range: { startInstant: string; endInstantExclusive: string; timeZone: string }) =>
    [...calendarQueryKeys.scheduling(scope), "events", range.startInstant, range.endInstantExclusive, range.timeZone] as const,
  availability: (scope: CalendarScope, input: { memberIds: readonly string[]; startInstant: string; endInstantExclusive: string; timeZone: string }) =>
    [...calendarQueryKeys.scheduling(scope), "availability", [...new Set(input.memberIds)].sort(), input.startInstant, input.endInstantExclusive, input.timeZone] as const,
  memberships: (scope: CalendarScope, calendarId: string) => [...calendarQueryKeys.collaboration(scope), "memberships", calendarId] as const,
  teamSnapshots: (scope: CalendarScope) => [...calendarQueryKeys.collaboration(scope), "team-snapshots"] as const,
  teamSnapshot: (scope: CalendarScope, calendarId: string, authorizationVersion: number, range: { startDate: string; endDateExclusive: string }) =>
    [...calendarQueryKeys.teamSnapshots(scope), calendarId, authorizationVersion, range.startDate, range.endDateExclusive] as const,
  calendar: (scope: CalendarScope, calendarId: string) => [...calendarQueryKeys.calendars(scope), calendarId] as const,
  bootstraps: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "bootstrap"] as const,
  bootstrap: (scope: CalendarScope, range: { startDate: string; endDateExclusive: string; calendarIds?: readonly string[] }) =>
    [...calendarQueryKeys.bootstraps(scope), range.startDate, range.endDateExclusive, calendarFilterKey(range.calendarIds)] as const,
  events: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "events"] as const,
  ranges: (scope: CalendarScope) => [...calendarQueryKeys.events(scope), "range"] as const,
  range: (scope: CalendarScope, input: { startDate: string; endDateExclusive: string; calendarIds?: readonly string[]; cursor?: string; limit?: number }) =>
    [...calendarQueryKeys.ranges(scope), input.startDate, input.endDateExclusive, calendarFilterKey(input.calendarIds), cursorKey(input.cursor), input.limit ?? null] as const,
  searches: (scope: CalendarScope) => [...calendarQueryKeys.events(scope), "search"] as const,
  search: (scope: CalendarScope, input: { query: string; calendarIds?: readonly string[]; cursor?: string; limit?: number }) =>
    [...calendarQueryKeys.searches(scope), input.query, calendarFilterKey(input.calendarIds), cursorKey(input.cursor), input.limit ?? null] as const,
  event: (scope: CalendarScope, eventId: string) => [...calendarQueryKeys.events(scope), "detail", eventId] as const,
  changesRoot: (scope: CalendarScope) => [...calendarQueryKeys.scope(scope), "changes"] as const,
  changes: (scope: CalendarScope, cursor: string, limit?: number) => [...calendarQueryKeys.changesRoot(scope), cursor, limit ?? null] as const,
};

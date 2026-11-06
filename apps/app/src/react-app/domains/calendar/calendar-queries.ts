import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type {
  DenCalendar,
  DenCalendarBootstrap,
  DenCalendarChangePage,
  DenCalendarEvent,
  DenCalendarEventPage,
  DenCalendarRangeOptions,
  DenCalendarSearchOptions,
  DenClient,
} from "@/app/lib/den";
import { calendarQueryKeys } from "./calendar-query-keys";
import type { CalendarScope } from "./calendar-scope";
import { calendarRequestSignal, throwIfCalendarScopeStale, type CalendarScopeGeneration } from "./calendar-scope-lifecycle";

export type CalendarQueryClient = Pick<DenClient,
  | "listCalendars"
  | "getCalendar"
  | "getCalendarBootstrap"
  | "listCalendarEvents"
  | "searchCalendarEvents"
  | "getCalendarEvent"
  | "getCalendarChanges"
>;

const unavailableKey = (kind: string, scope: CalendarScope | null) => scope
  ? [...calendarQueryKeys.scope(scope), "unavailable", kind] as const
  : ["calendar", "unavailable", kind] as const;

function useCapturedScope(scope: CalendarScope | null): CalendarScope | null {
  return useMemo(
    () => scope ? Object.freeze({ ...scope }) : null,
    [scope?.deployment, scope?.organizationId, scope?.memberId],
  );
}

function useCapturedRange(input: DenCalendarRangeOptions): DenCalendarRangeOptions {
  const calendarIdsKey = JSON.stringify(input.calendarIds ?? null);
  const cursor = input.cursor || undefined;
  return useMemo(
    () => Object.freeze({
      ...input,
      cursor,
      calendarIds: input.calendarIds ? Object.freeze([...input.calendarIds]) as string[] : undefined,
    }),
    [input.startDate, input.endDateExclusive, calendarIdsKey, cursor, input.limit],
  );
}

function useCapturedSearch(input: DenCalendarSearchOptions): DenCalendarSearchOptions {
  const calendarIdsKey = JSON.stringify(input.calendarIds ?? null);
  const cursor = input.cursor || undefined;
  return useMemo(
    () => Object.freeze({
      ...input,
      cursor,
      calendarIds: input.calendarIds ? Object.freeze([...input.calendarIds]) as string[] : undefined,
    }),
    [input.query, calendarIdsKey, cursor, input.limit],
  );
}

export function setCanonicalCalendar(queryClient: QueryClient, scope: CalendarScope, incoming: DenCalendar): DenCalendar {
  let accepted = incoming;
  queryClient.setQueryData<DenCalendar>(calendarQueryKeys.calendar(scope, incoming.id), (cached) => {
    if (cached && cached.version >= incoming.version) {
      accepted = cached;
      return cached;
    }
    return incoming;
  });
  return accepted;
}

export function setCanonicalCalendarEvent(queryClient: QueryClient, scope: CalendarScope, incoming: DenCalendarEvent): DenCalendarEvent {
  let accepted = incoming;
  queryClient.setQueryData<DenCalendarEvent>(calendarQueryKeys.event(scope, incoming.id), (cached) => {
    if (cached && cached.version >= incoming.version) {
      accepted = cached;
      return cached;
    }
    return incoming;
  });
  return accepted;
}

function seedCalendars(queryClient: QueryClient, scope: CalendarScope, calendars: readonly DenCalendar[]): DenCalendar[] {
  return calendars.map((calendar) => setCanonicalCalendar(queryClient, scope, calendar));
}

function seedEvents(queryClient: QueryClient, scope: CalendarScope, events: readonly DenCalendarEvent[]): DenCalendarEvent[] {
  return events.map((event) => setCanonicalCalendarEvent(queryClient, scope, event));
}

type CalendarGenerationInput = { generation?: CalendarScopeGeneration | null };

export function useCalendarsQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  return useQuery<DenCalendar[]>({
    queryKey: scope ? calendarQueryKeys.calendars(scope) : unavailableKey("calendars", scope),
    enabled: (input.active ?? true) && scope !== null,
    queryFn: async ({ signal }) => {
      const calendars = await input.client.listCalendars(scope!.organizationId, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return seedCalendars(queryClient, scope!, calendars);
    },
  });
}

export function useCalendarQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; calendarId: string | null; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const calendarId = input.calendarId;
  const available = scope !== null && Boolean(calendarId);
  return useQuery<DenCalendar>({
    queryKey: available ? calendarQueryKeys.calendar(scope, calendarId!) : unavailableKey("calendar", scope),
    enabled: (input.active ?? true) && available,
    queryFn: async ({ signal }) => {
      const result = await input.client.getCalendar(scope!.organizationId, calendarId!, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return setCanonicalCalendar(queryClient, scope!, result);
    },
  });
}

export function useCalendarBootstrapQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; range: Omit<DenCalendarRangeOptions, "cursor" | "limit">; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const range = useCapturedRange(input.range);
  return useQuery<DenCalendarBootstrap>({
    queryKey: scope ? calendarQueryKeys.bootstrap(scope, range) : unavailableKey("bootstrap", scope),
    enabled: (input.active ?? true) && scope !== null,
    queryFn: async ({ signal }) => {
      const result = await input.client.getCalendarBootstrap(scope!.organizationId, range, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return {
        ...result,
        calendars: seedCalendars(queryClient, scope!, result.calendars),
        events: seedEvents(queryClient, scope!, result.events),
      };
    },
  });
}

export function useCalendarEventRangeQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; range: DenCalendarRangeOptions; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const range = useCapturedRange(input.range);
  return useQuery<DenCalendarEventPage>({
    queryKey: scope ? calendarQueryKeys.range(scope, range) : unavailableKey("range", scope),
    enabled: (input.active ?? true) && scope !== null,
    queryFn: async ({ signal }) => {
      const page = await input.client.listCalendarEvents(scope!.organizationId, range, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return { ...page, items: seedEvents(queryClient, scope!, page.items) };
    },
  });
}

export function useCalendarEventSearchQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; search: DenCalendarSearchOptions; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const search = useCapturedSearch(input.search);
  return useQuery<DenCalendarEventPage>({
    queryKey: scope ? calendarQueryKeys.search(scope, search) : unavailableKey("search", scope),
    enabled: (input.active ?? true) && scope !== null,
    queryFn: async ({ signal }) => {
      const page = await input.client.searchCalendarEvents(scope!.organizationId, search, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return { ...page, items: seedEvents(queryClient, scope!, page.items) };
    },
  });
}

export function useCalendarEventQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; eventId: string | null; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const eventId = input.eventId;
  const available = scope !== null && Boolean(eventId);
  return useQuery<DenCalendarEvent>({
    queryKey: available ? calendarQueryKeys.event(scope, eventId!) : unavailableKey("event", scope),
    enabled: (input.active ?? true) && available,
    queryFn: async ({ signal }) => {
      const result = await input.client.getCalendarEvent(scope!.organizationId, eventId!, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return setCanonicalCalendarEvent(queryClient, scope!, result);
    },
  });
}

export function useCalendarChangesQuery(input: { client: CalendarQueryClient; scope: CalendarScope | null; cursor: string | null; limit?: number; active?: boolean } & CalendarGenerationInput) {
  const scope = useCapturedScope(input.scope);
  const cursor = input.cursor || undefined;
  const limit = input.limit;
  const available = scope !== null && cursor !== undefined;
  return useQuery<DenCalendarChangePage>({
    queryKey: available ? calendarQueryKeys.changes(scope, cursor, limit) : unavailableKey("changes", scope),
    enabled: (input.active ?? true) && available,
    queryFn: async ({ signal }) => {
      const result = await input.client.getCalendarChanges(scope!.organizationId, cursor!, { limit, signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return result;
    },
  });
}

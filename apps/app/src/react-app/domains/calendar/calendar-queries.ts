import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import type {
  DenCalendar,
  DenCalendarBootstrap,
  DenCalendarChangePage,
  DenCalendarEvent,
  DenCalendarEventPage,
  DenCalendarRangeOptions,
  DenCalendarSearchOptions,
  DenCalendarCollaborationList,
  DenCalendarMembershipList,
  DenCalendarAvailability,
  DenCalendarAvailabilityInput,
  DenCalendarSchedulingOccurrenceList,
  DenCalendarSchedulingRange,
  DenOrganizationMember,
  DenTeamCalendarSnapshot,
  DenClient,
} from "@/app/lib/den";
import { DenApiError } from "@/app/lib/den";
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
export type CalendarCollaborationQueryClient = Pick<DenClient, "listCalendarCollaboration" | "getTeamCalendarSnapshot" | "listOrganizationMembers" | "listTeamCalendarMemberships">;
export type CalendarSchedulingQueryClient = Pick<DenClient, "listCalendarSchedulingEvents" | "getCalendarSchedulingAvailability">;

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

export function useCalendarCollaborationQuery(input: { client: CalendarCollaborationQueryClient; scope: CalendarScope | null; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  return useQuery<DenCalendarCollaborationList>({
    queryKey: scope ? calendarQueryKeys.collaboration(scope) : unavailableKey("collaboration", scope),
    enabled: (input.active ?? true) && scope !== null,
    queryFn: async ({ signal }) => {
      const calendars = await input.client.listCalendarCollaboration(scope!.organizationId, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      await reconcileCalendarAuthorization(queryClient, scope!, calendars);
      return calendars;
    },
  });
}

export function useCalendarOrganizationMembersQuery(input: { client: CalendarCollaborationQueryClient; scope: CalendarScope | null; active?: boolean } & CalendarGenerationInput) {
  const scope = useCapturedScope(input.scope);
  return useQuery<DenOrganizationMember[]>({
    queryKey: scope ? calendarQueryKeys.organizationMembers(scope) : unavailableKey("organization-members", scope),
    enabled: (input.active ?? true) && scope !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const members: DenOrganizationMember[] = [];
      let offset = 0;
      while (true) {
        const page = await input.client.listOrganizationMembers(scope!.organizationId, { limit: 200, offset }, { signal: calendarRequestSignal(signal, input.generation) });
        throwIfCalendarScopeStale(input.generation, signal);
        members.push(...page.members);
        offset += page.members.length;
        if (!page.members.length || offset >= page.total) return members;
      }
    },
  });
}

export function useCalendarSchedulingEventsQuery(input: { client: CalendarSchedulingQueryClient; scope: CalendarScope | null; range: DenCalendarSchedulingRange; active?: boolean } & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const range = useMemo(() => Object.freeze({ ...input.range }), [input.range.startInstant, input.range.endInstantExclusive, input.range.timeZone]);
  return useQuery<DenCalendarSchedulingOccurrenceList>({
    queryKey: scope ? calendarQueryKeys.schedulingEvents(scope, range) : unavailableKey("scheduling-events", scope),
    enabled: (input.active ?? true) && scope !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await input.client.listCalendarSchedulingEvents(scope!.organizationId, range, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      result.items.forEach((occurrence) => setCanonicalCalendarEvent(queryClient, scope!, occurrence.event));
      return result;
    },
  });
}

export function useCalendarAvailabilityQuery(input: { client: CalendarSchedulingQueryClient; scope: CalendarScope | null; request: DenCalendarAvailabilityInput | null; active?: boolean } & CalendarGenerationInput) {
  const scope = useCapturedScope(input.scope);
  const requestKey = input.request ? JSON.stringify({ ...input.request, memberIds: [...new Set(input.request.memberIds)].sort() }) : "";
  const request = useMemo(() => requestKey ? JSON.parse(requestKey) as DenCalendarAvailabilityInput : null, [requestKey]);
  return useQuery<DenCalendarAvailability>({
    queryKey: scope && request ? calendarQueryKeys.availability(scope, request) : unavailableKey("availability", scope),
    enabled: (input.active ?? true) && scope !== null && request !== null && request.memberIds.length > 0,
    retry: false,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const result = await input.client.getCalendarSchedulingAvailability(scope!.organizationId, request!, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      const requested = [...new Set(request!.memberIds)].sort();
      const returned = result.members.map((member) => member.memberId).sort();
      if (requested.length !== returned.length || requested.some((memberId, index) => memberId !== returned[index])) {
        throw new DenApiError(500, "invalid_calendar_scheduling_payload", "Calendar availability members did not match the request.");
      }
      return result;
    },
  });
}

export function useTeamCalendarMembershipsQuery(input: { client: CalendarCollaborationQueryClient; scope: CalendarScope | null; calendarId: string | null; active?: boolean } & CalendarGenerationInput) {
  const scope = useCapturedScope(input.scope);
  const available = scope !== null && Boolean(input.calendarId);
  return useQuery<DenCalendarMembershipList>({
    queryKey: available ? calendarQueryKeys.memberships(scope, input.calendarId!) : unavailableKey("memberships", scope),
    enabled: (input.active ?? true) && available,
    retry: false,
    queryFn: async ({ signal }) => {
      const result = await input.client.listTeamCalendarMemberships(scope!.organizationId, input.calendarId!, { signal: calendarRequestSignal(signal, input.generation) });
      throwIfCalendarScopeStale(input.generation, signal);
      return result;
    },
  });
}

export function useTeamCalendarSnapshotsQuery(input: {
  client: CalendarCollaborationQueryClient;
  scope: CalendarScope | null;
  calendars: readonly { id: string; authorizationVersion: number }[];
  range: { startDate: string; endDateExclusive: string };
  active?: boolean;
} & CalendarGenerationInput) {
  const queryClient = useQueryClient();
  const scope = useCapturedScope(input.scope);
  const calendarsKey = JSON.stringify([...new Map(input.calendars.map((calendar) => [calendar.id, calendar])).values()].sort((left, right) => left.id.localeCompare(right.id)));
  const calendars = useMemo(() => JSON.parse(calendarsKey) as Array<{ id: string; authorizationVersion: number }>, [calendarsKey]);
  return useQueries({
    queries: calendars.map(({ id: calendarId, authorizationVersion }) => ({
      queryKey: scope ? calendarQueryKeys.teamSnapshot(scope, calendarId, authorizationVersion, input.range) : unavailableKey(`team-snapshot:${calendarId}`, scope),
      enabled: (input.active ?? true) && scope !== null,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const snapshot = await input.client.getTeamCalendarSnapshot(scope!.organizationId, calendarId, input.range, { signal: calendarRequestSignal(signal, input.generation) });
        throwIfCalendarScopeStale(input.generation, signal);
        const previous = queryClient.getQueryData<DenTeamCalendarSnapshot>(calendarQueryKeys.teamSnapshot(scope!, calendarId, authorizationVersion, input.range));
        const incomingIds = new Set(snapshot.events.map((event) => event.id));
        previous?.events.filter((event) => !incomingIds.has(event.id)).forEach((event) => queryClient.removeQueries({ queryKey: calendarQueryKeys.event(scope!, event.id), exact: true }));
        snapshot.events.forEach((event) => setCanonicalCalendarEvent(queryClient, scope!, event));
        return snapshot;
      },
    })),
    combine: (results) => ({
      data: results.flatMap((result) => !result.isError && result.data ? [result.data as DenTeamCalendarSnapshot] : []),
      isError: results.some((result) => result.isError),
      isFetching: results.some((result) => result.isFetching),
    }),
  });
}

async function reconcileCalendarAuthorization(queryClient: QueryClient, scope: CalendarScope, incoming: DenCalendarCollaborationList): Promise<void> {
  const previous = queryClient.getQueryData<DenCalendarCollaborationList>(calendarQueryKeys.collaboration(scope));
  if (!previous || previous.authorizationGeneration === incoming.authorizationGeneration && previous.items.every((item) => incoming.items.some((next) => next.id === item.id && next.authorizationVersion === item.authorizationVersion && next.capabilities.canViewDetails === item.capabilities.canViewDetails && next.capabilities.canManage === item.capabilities.canManage))) return;

  const nextById = new Map(incoming.items.map((calendar) => [calendar.id, calendar]));
  const resetIds = new Set(previous.items.filter((calendar) => {
    if (calendar.kind !== "team") return false;
    const next = nextById.get(calendar.id);
    return !next || next.authorizationVersion !== calendar.authorizationVersion || next.capabilities.canViewDetails !== calendar.capabilities.canViewDetails;
  }).map((calendar) => calendar.id));
  const managerResetIds = new Set(previous.items.filter((calendar) => {
    const next = nextById.get(calendar.id);
    return calendar.kind === "team" && calendar.capabilities.canManage && (!next || !next.capabilities.canManage);
  }).map((calendar) => calendar.id));

  const eventIds = new Set<string>();
  for (const [, snapshot] of queryClient.getQueriesData<DenTeamCalendarSnapshot>({ queryKey: calendarQueryKeys.teamSnapshots(scope) })) {
    if (snapshot && resetIds.has(snapshot.calendar.id)) snapshot.events.forEach((event) => eventIds.add(event.id));
  }
  for (const [, event] of queryClient.getQueriesData<DenCalendarEvent>({ queryKey: calendarQueryKeys.events(scope) })) {
    if (event && resetIds.has(event.calendarId)) eventIds.add(event.id);
  }
  await Promise.all([...resetIds].map((calendarId) => queryClient.cancelQueries({ queryKey: [...calendarQueryKeys.teamSnapshots(scope), calendarId] })));
  resetIds.forEach((calendarId) => queryClient.removeQueries({ queryKey: [...calendarQueryKeys.teamSnapshots(scope), calendarId] }));
  eventIds.forEach((eventId) => queryClient.removeQueries({ queryKey: calendarQueryKeys.event(scope, eventId), exact: true }));
  new Set([...resetIds, ...managerResetIds]).forEach((calendarId) => queryClient.removeQueries({ queryKey: calendarQueryKeys.memberships(scope, calendarId), exact: true }));
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

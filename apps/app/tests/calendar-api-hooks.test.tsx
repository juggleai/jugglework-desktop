import { afterAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
  if ((timeout ?? 0) >= 1_000) return 0 as unknown as ReturnType<typeof setTimeout>;
  return originalSetTimeout(handler, timeout, ...args);
}) as typeof globalThis.setTimeout;

import {
  DenApiError,
  type DenCalendar,
  type DenCalendarDeleteResult,
  type DenCalendarEvent,
  type DenCalendarCollaborationList,
  type DenTeamCalendarSnapshot,
  type DenCalendarResult,
} from "../src/app/lib/den";
import {
  calendarMutationConflict,
  useCreateCalendarEventMutation,
  useCreateCalendarMutation,
  useDeleteCalendarEventMutation,
  useDeleteCalendarMutation,
  useUpdateCalendarEventMutation,
  useUpdateCalendarMutation,
  type CalendarMutationClient,
} from "../src/react-app/domains/calendar/calendar-mutations";
import {
  useCalendarBootstrapQuery,
  useCalendarCollaborationQuery,
  useCalendarChangesQuery,
  useCalendarEventQuery,
  useCalendarEventRangeQuery,
  useCalendarEventSearchQuery,
  useCalendarQuery,
  useCalendarSchedulingEventsQuery,
  useCalendarAvailabilityQuery,
  useCalendarsQuery,
  setCanonicalCalendar,
  type CalendarQueryClient,
  type CalendarCollaborationQueryClient,
} from "../src/react-app/domains/calendar/calendar-queries";
import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";
import { createCalendarScope, type CalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

async function inAct(action: () => void | Promise<void>): Promise<void> {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  try {
    await act(action);
  } finally {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  }
}

const scopeA = createCalendarScope({ deploymentBaseUrl: "https://one.test/api", organizationId: "org-a", memberId: "member-a" })!;
const scopeB = createCalendarScope({ deploymentBaseUrl: "https://one.test/api", organizationId: "org-b", memberId: "member-a" })!;

function calendar(version: number, overrides: Partial<DenCalendar> = {}): DenCalendar {
  return {
    id: "calendar-1",
    organizationId: "org-a",
    ownerMemberId: "member-a",
    name: `Calendar ${version}`,
    color: null,
    isDefault: false,
    version,
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}

function event(version: number, overrides: Partial<DenCalendarEvent> = {}): DenCalendarEvent {
  return {
    id: "event-1",
    organizationId: "org-a",
    ownerMemberId: "member-a",
    calendarId: "calendar-1",
    title: `Event ${version}`,
    description: "",
    time: { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" },
    version,
    createdAt: "2026-11-05T00:00:00Z",
    updatedAt: "2026-11-05T00:00:00Z",
    ...overrides,
  };
}

function queryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retryDelay: 0 } } });
}

const views: ReactTestRenderer[] = [];
afterAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  for (const view of views) view.unmount();
  globalThis.setTimeout = originalSetTimeout;
});

async function renderHook<T>(client: QueryClient, hook: () => T): Promise<{ current: T; rerender: () => Promise<void> }> {
  const result = { current: undefined as T };
  let view: ReactTestRenderer;
  function Probe() {
    result.current = hook();
    return null;
  }
  const tree = () => createElement(QueryClientProvider, { client, children: createElement(Probe) });
  await inAct(async () => { view = create(tree()); });
  views.push(view!);
  return {
    get current() { return result.current; },
    rerender: async () => { await inAct(async () => { view.update(tree()); }); },
  };
}

async function flushQueries(client: QueryClient): Promise<void> {
  await inAct(async () => {
    for (let attempt = 0; attempt < 20 && client.isFetching(); attempt++) await Promise.resolve();
  });
}

function completeQueryClient(overrides: Partial<CalendarQueryClient> = {}): CalendarQueryClient {
  const fail = () => Promise.reject(new Error("unexpected query"));
  return {
    listCalendars: fail,
    getCalendar: fail,
    getCalendarBootstrap: fail,
    listCalendarEvents: fail,
    searchCalendarEvents: fail,
    getCalendarEvent: fail,
    getCalendarChanges: fail,
    ...overrides,
  } as CalendarQueryClient;
}

function completeMutationClient(overrides: Partial<CalendarMutationClient> = {}): CalendarMutationClient {
  const fail = () => Promise.reject(new Error("unexpected mutation"));
  return {
    createCalendar: fail,
    updateCalendar: fail,
    deleteCalendar: fail,
    createCalendarEvent: fail,
    updateCalendarEvent: fail,
    deleteCalendarEvent: fail,
    ...overrides,
  } as CalendarMutationClient;
}

describe("calendar query hooks", () => {
  test("replaces revoked team authorization namespaces and removes cached event details", async () => {
    const query = queryClient();
    const team = {
      id: "team-1", organizationId: scopeA.organizationId, ownerMemberId: scopeA.memberId, kind: "team" as const, name: "Team", color: "#3366CC", role: "manager" as const,
      capabilities: { canViewFreeBusy: true, canViewDetails: true, canEditEvents: true, canManage: true },
      version: 1, authorizationVersion: 2, createdAt: "2026-11-05T00:00:00Z", updatedAt: "2026-11-05T00:00:00Z",
    };
    const previous: DenCalendarCollaborationList = { items: [team], authorizationGeneration: 3, reset: { mode: "replace", namespace: "calendar-collaboration" } };
    const teamEvent = event(1, { id: "team-event", calendarId: team.id });
    const range = { startDate: "2026-11-01", endDateExclusive: "2026-12-01" };
    const snapshot: DenTeamCalendarSnapshot = { calendar: team, events: [teamEvent], coverage: { ...range, calendarIds: [team.id] }, authorizationVersion: 2, reset: { mode: "replace", namespace: `calendar:${team.id}` } };
    query.setQueryData(calendarQueryKeys.collaboration(scopeA), previous);
    query.setQueryData(calendarQueryKeys.teamSnapshot(scopeA, team.id, 2, range), snapshot);
    query.setQueryData(calendarQueryKeys.event(scopeA, teamEvent.id), teamEvent);
    query.setQueryData(calendarQueryKeys.memberships(scopeA, team.id), { items: [], authorizationVersion: 2 });
    const client = {
      listCalendarCollaboration: async () => ({ items: [], authorizationGeneration: 4, reset: { mode: "replace" as const, namespace: "calendar-collaboration" as const } }),
      getTeamCalendarSnapshot: async () => { throw new Error("unexpected snapshot"); },
      listOrganizationMembers: async () => { throw new Error("unexpected directory"); },
      listTeamCalendarMemberships: async () => { throw new Error("unexpected memberships"); },
    } as CalendarCollaborationQueryClient;

    await renderHook(query, () => useCalendarCollaborationQuery({ client, scope: scopeA }));
    await flushQueries(query);

    expect(query.getQueryData(calendarQueryKeys.teamSnapshot(scopeA, team.id, 2, range))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, teamEvent.id))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.memberships(scopeA, team.id))).toBeUndefined();
    expect(query.getQueryData<DenCalendarCollaborationList>(calendarQueryKeys.collaboration(scopeA))?.authorizationGeneration).toBe(4);
  });

  test("disables every query for a missing scope or inactive hook", async () => {
    let calls = 0;
    const client = completeQueryClient({
      listCalendars: async () => { calls++; return []; },
      getCalendar: async () => { calls++; return calendar(1); },
      getCalendarBootstrap: async () => { calls++; return { calendars: [], events: [], coverage: { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: [] }, cursor: "cursor" }; },
      listCalendarEvents: async () => { calls++; return { items: [], nextCursor: null, hasMore: false }; },
      searchCalendarEvents: async () => { calls++; return { items: [], nextCursor: null, hasMore: false }; },
      getCalendarEvent: async () => { calls++; return event(1); },
      getCalendarChanges: async () => { calls++; return { items: [], nextCursor: "next", hasMore: false }; },
    });
    const query = queryClient();
    await renderHook(query, () => {
      useCalendarsQuery({ client, scope: null });
      useCalendarQuery({ client, scope: null, calendarId: "calendar-1" });
      useCalendarBootstrapQuery({ client, scope: null, range: { startDate: "2026-11-01", endDateExclusive: "2026-12-01" } });
      useCalendarEventRangeQuery({ client, scope: null, range: { startDate: "2026-11-01", endDateExclusive: "2026-12-01" } });
      useCalendarEventSearchQuery({ client, scope: null, search: { query: "review" } });
      useCalendarEventQuery({ client, scope: null, eventId: "event-1" });
      useCalendarChangesQuery({ client, scope: null, cursor: "cursor" });
      useCalendarsQuery({ client, scope: scopeA, active: false });
      useCalendarQuery({ client, scope: scopeA, calendarId: "" });
      useCalendarEventQuery({ client, scope: scopeA, eventId: "" });
      useCalendarChangesQuery({ client, scope: scopeA, cursor: "" });
      return null;
    });
    await flushQueries(query);
    expect(calls).toBe(0);
    const unavailableKeys = query.getQueryCache().getAll().map(({ queryKey }) => JSON.stringify(queryKey));
    expect(unavailableKeys).toContain(JSON.stringify(["calendar", ...calendarQueryKeys.scope(scopeA).slice(1), "unavailable", "calendar"]));
    expect(unavailableKeys).toContain(JSON.stringify(["calendar", "unavailable", "calendar"]));
  });

  test("returns canonical entities from aggregate queries without applying changes pages", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(9));
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-1"), event(9));
    const seenSignals: AbortSignal[] = [];
    const client = completeQueryClient({
      listCalendars: async (_org, options) => { seenSignals.push(options.signal!); return [calendar(1)]; },
      getCalendarBootstrap: async (_org, _range, options) => { seenSignals.push(options.signal!); return { calendars: [calendar(2)], events: [event(2)], coverage: { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: [] }, cursor: "cursor" }; },
      listCalendarEvents: async (_org, _range, options) => { seenSignals.push(options.signal!); return { items: [event(3)], nextCursor: null, hasMore: false }; },
      searchCalendarEvents: async (_org, _search, options) => { seenSignals.push(options.signal!); return { items: [event(4)], nextCursor: null, hasMore: false }; },
      getCalendarChanges: async (_org, _cursor, options) => { seenSignals.push(options.signal!); return { items: [
        { sequence: 1, kind: "upsert", entityType: "calendar", entity: calendar(20) },
        { sequence: 2, kind: "upsert", entityType: "event", entity: event(20) },
        { sequence: 3, kind: "delete", entityType: "event", entityId: "event-1", version: 21, deletedAt: "2026-11-05T01:00:00Z" },
      ], nextCursor: "next", hasMore: false }; },
    });
    await renderHook(query, () => {
      useCalendarsQuery({ client, scope: scopeA });
      useCalendarBootstrapQuery({ client, scope: scopeA, range: { startDate: "2026-11-01", endDateExclusive: "2026-12-01" } });
      useCalendarEventRangeQuery({ client, scope: scopeA, range: { startDate: "2026-11-01", endDateExclusive: "2026-12-01" } });
      useCalendarEventSearchQuery({ client, scope: scopeA, search: { query: "review" } });
      useCalendarChangesQuery({ client, scope: scopeA, cursor: "cursor" });
      return null;
    });
    await flushQueries(query);
    expect(seenSignals).toHaveLength(5);
    expect(seenSignals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-1"))?.version).toBe(9);
    expect(query.getQueryData<DenCalendarEvent>(calendarQueryKeys.event(scopeA, "event-1"))?.version).toBe(9);
    expect(query.getQueryData<DenCalendar[]>(calendarQueryKeys.calendars(scopeA))?.[0]?.version).toBe(9);
    expect(query.getQueryData<{ calendars: DenCalendar[]; events: DenCalendarEvent[] }>(calendarQueryKeys.bootstrap(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toMatchObject({ calendars: [{ version: 9 }], events: [{ version: 9 }] });
    expect(query.getQueryData<{ items: DenCalendarEvent[] }>(calendarQueryKeys.range(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toMatchObject({ items: [{ version: 9 }] });
    expect(query.getQueryData<{ items: DenCalendarEvent[] }>(calendarQueryKeys.search(scopeA, { query: "review" }))).toMatchObject({ items: [{ version: 9 }] });
    expect(query.getQueryData<{ items: Array<{ kind: string }> }>(calendarQueryKeys.changes(scopeA, "cursor"))?.items).toHaveLength(3);
  });

  test("normalizes empty range and search cursors in both keys and requests", async () => {
    const query = queryClient();
    const requests: Array<{ kind: "range" | "search"; cursor?: string }> = [];
    const client = completeQueryClient({
      listCalendarEvents: async (_org, input) => { requests.push({ kind: "range", cursor: input.cursor }); return { items: [], nextCursor: null, hasMore: false }; },
      searchCalendarEvents: async (_org, input) => { requests.push({ kind: "search", cursor: input.cursor }); return { items: [], nextCursor: null, hasMore: false }; },
    });
    await renderHook(query, () => {
      useCalendarEventRangeQuery({ client, scope: scopeA, range: { startDate: "2026-11-01", endDateExclusive: "2026-12-01", cursor: "" } });
      useCalendarEventSearchQuery({ client, scope: scopeA, search: { query: "review", cursor: "" } });
      return null;
    });
    await flushQueries(query);
    expect(requests).toEqual([{ kind: "range", cursor: undefined }, { kind: "search", cursor: undefined }]);
    expect(query.getQueryData(calendarQueryKeys.range(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toBeDefined();
    expect(query.getQueryData(calendarQueryKeys.search(scopeA, { query: "review" }))).toBeDefined();
  });

  test("canonical version gate rejects an old response that arrives late", () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(4));
    expect(setCanonicalCalendar(query, scopeA, calendar(2)).version).toBe(4);
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-1"))?.version).toBe(4);
  });

  test("scheduling occurrences seed the canonical series event for version-checked edits", async () => {
    const query = queryClient();
    const scheduled = { ...event(3), status: "active" as const, attendees: [{ memberId: "member-b", responseStatus: "needs-action" as const }], recurrence: null };
    const range = { startInstant: "2026-11-01T00:00:00Z", endInstantExclusive: "2026-12-01T00:00:00Z", timeZone: "UTC" };
    const client = { listCalendarSchedulingEvents: async () => ({ items: [{ event: scheduled, occurrenceIndex: 1, time: scheduled.time }] }), getCalendarSchedulingAvailability: async () => ({ members: [] }) };
    await renderHook(query, () => useCalendarSchedulingEventsQuery({ client, scope: scopeA, range }));
    await flushQueries(query);
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, scheduled.id))).toEqual(scheduled);
  });

  test("availability rejects a response whose member set differs from the request", async () => {
    const query = queryClient();
    const request = { memberIds: ["member-a", "member-b"], startInstant: "2026-11-01T00:00:00Z", endInstantExclusive: "2026-11-02T00:00:00Z", timeZone: "UTC" };
    const client = { listCalendarSchedulingEvents: async () => ({ items: [] }), getCalendarSchedulingAvailability: async () => ({ members: [{ memberId: "member-a", busy: [] }] }) };
    const hook = await renderHook(query, () => useCalendarAvailabilityQuery({ client, scope: scopeA, request }));
    await flushQueries(query);
    await hook.rerender();
    expect(hook.current.error).toMatchObject({ code: "invalid_calendar_scheduling_payload" });
    expect(hook.current.data).toBeUndefined();
  });

});

describe("calendar mutation hooks", () => {
  test("retries network errors with identical prepared wire input, then creates a new key and reads the new version", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(3));
    const wire: Array<{ expectedVersion: number; idempotencyKey: string; name?: string }> = [];
    const keys = ["calendar.calendar-update.key-1", "calendar.calendar-update.key-2"];
    const client = completeMutationClient({
      updateCalendar: async (_org, _id, input) => {
        wire.push({ ...input });
        if (wire.length === 1) throw new Error("network");
        const next = wire.length === 2 ? calendar(4, { name: "SERVER ONE" }) : calendar(8, { name: "SERVER TWO" });
        return { calendar: next, replayed: false };
      },
    });
    const hook = await renderHook(query, () => useUpdateCalendarMutation(client, scopeA, { retryDelay: 0, idempotencyKeyFactory: () => keys.shift()! }));
    await inAct(async () => { await hook.current.mutateAsync({ calendarId: "calendar-1", expectedVersion: 3, patch: { name: "draft one" } }); });
    expect(wire[0]).toEqual(wire[1]);
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-1"))?.name).toBe("SERVER ONE");
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(7));
    await inAct(async () => { await hook.current.mutateAsync({ calendarId: "calendar-1", expectedVersion: 7, patch: { name: "draft two" } }); });
    expect(wire[2]?.idempotencyKey).not.toBe(wire[1]?.idempotencyKey);
    expect(wire[2]?.expectedVersion).toBe(7);
  });

  test("does not retry conflict, preserves public input, exposes current, and never changes cache", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-1"), event(5, { title: "AUTHORITATIVE" }));
    let calls = 0;
    const current = event(6, { title: "REMOTE" });
    const conflict = new DenApiError(409, "calendar_version_conflict", "conflict", { current });
    const client = completeMutationClient({ updateCalendarEvent: async () => { calls++; throw conflict; } });
    const hook = await renderHook(query, () => useUpdateCalendarEventMutation(client, scopeA, { retryDelay: 0, idempotencyKeyFactory: () => "calendar.event-update.conflict" }));
    const publicInput = { eventId: "event-1", expectedVersion: 5, patch: { title: "MY DRAFT" } };
    let caught: unknown;
    await inAct(async () => { try { await hook.current.mutateAsync(publicInput); } catch (error) { caught = error; } });
    await hook.rerender();
    expect(calls).toBe(1);
    expect(caught).toBe(conflict);
    expect(hook.current.variables).toEqual(publicInput);
    expect(calendarMutationConflict(caught)).toEqual(current);
    expect(query.getQueryData<DenCalendarEvent>(calendarQueryKeys.event(scopeA, "event-1"))?.title).toBe("AUTHORITATIVE");
    expect(hook.current.canRetryLast).toBe(false);
    await expect(hook.current.retryLastAsync()).rejects.toThrow("no uncertain failed");
  });

  test("does not retry an ordinary client failure or fake a saved entity", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(2, { name: "AUTHORITATIVE" }));
    let calls = 0;
    const client = completeMutationClient({
      updateCalendar: async () => {
        calls++;
        throw new DenApiError(400, "invalid_calendar_request", "invalid");
      },
    });
    const hook = await renderHook(query, () => useUpdateCalendarMutation(client, scopeA, { retryDelay: 0, idempotencyKeyFactory: () => "calendar.calendar-update.invalid" }));
    await expect(hook.current.mutateAsync({ calendarId: "calendar-1", expectedVersion: 2, patch: { name: "UNSAVED" } })).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-1"))?.name).toBe("AUTHORITATIVE");
    await expect(hook.current.retryLastAsync()).rejects.toThrow("no uncertain failed");
  });

  test("rejects a stale public expectedVersion before calling Den and preserves the input", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-1"), event(6));
    let calls = 0;
    const client = completeMutationClient({ updateCalendarEvent: async () => { calls++; return { event: event(7), replayed: false }; } });
    const hook = await renderHook(query, () => useUpdateCalendarEventMutation(client, scopeA, { retryDelay: 0 }));
    const publicInput = { eventId: "event-1", expectedVersion: 5, patch: { title: "STALE DRAFT" } };
    await expect(hook.current.mutateAsync(publicInput)).rejects.toThrow("stale edit");
    await hook.rerender();
    expect(calls).toBe(0);
    expect(hook.current.variables).toEqual(publicInput);
    expect(query.getQueryData<DenCalendarEvent>(calendarQueryKeys.event(scopeA, "event-1"))?.version).toBe(6);
  });

  test("retries the last uncertain terminal failure with the exact prepared create payload", async () => {
    const query = queryClient();
    const wire: Array<{ name: string; idempotencyKey: string }> = [];
    let failures = 3;
    const keys = ["calendar.calendar-create.key-1", "calendar.calendar-create.key-2"];
    const client = completeMutationClient({
      createCalendar: async (_org, input) => {
        wire.push({ ...input });
        if (failures-- > 0) throw new Error("network");
        return { calendar: calendar(1, { id: "calendar-retried", name: "SERVER" }), replayed: true };
      },
    });
    const hook = await renderHook(query, () => useCreateCalendarMutation(client, scopeA, { retryDelay: 0, idempotencyKeyFactory: () => keys.shift()! }));
    await inAct(async () => { await expect(hook.current.mutateAsync({ name: "draft" })).rejects.toThrow("network"); });
    await hook.rerender();
    expect(wire).toHaveLength(3);
    expect(wire[0]).toEqual(wire[1]);
    expect(wire[1]).toEqual(wire[2]);
    expect(hook.current.canRetryLast).toBe(true);
    await inAct(async () => { await hook.current.retryLastAsync(); });
    expect(wire[3]).toEqual(wire[2]);
    await hook.rerender();
    expect(hook.current.canRetryLast).toBe(false);
    await inAct(async () => { await hook.current.mutateAsync({ name: "next action" }); });
    expect(wire[4]?.idempotencyKey).toBe("calendar.calendar-create.key-2");
    expect(wire[4]?.idempotencyKey).not.toBe(wire[3]?.idempotencyKey);
  });

  test("rejects a missing scope before calling Den", async () => {
    let calls = 0;
    const client = completeMutationClient({ deleteCalendar: async () => { calls++; return { tombstone: { entityType: "calendar", entityId: "calendar-1", version: 2, deletedAt: "2026-11-05T00:00:00Z" }, replayed: false }; } });
    const missingScope = await renderHook(queryClient(), () => useDeleteCalendarMutation(client, null, { retryDelay: 0 }));
    await expect(missingScope.current.mutateAsync({ calendarId: "calendar-1", expectedVersion: 1 })).rejects.toThrow("scope");
    expect(calls).toBe(0);
  });

  test("rejects a missing canonical version before calling Den", async () => {
    let calls = 0;
    const client = completeMutationClient({ deleteCalendar: async () => { calls++; return { tombstone: { entityType: "calendar", entityId: "calendar-1", version: 2, deletedAt: "2026-11-05T00:00:00Z" }, replayed: false }; } });
    const missingVersion = await renderHook(queryClient(), () => useDeleteCalendarMutation(client, scopeA, { retryDelay: 0 }));
    await expect(missingVersion.current.mutateAsync({ calendarId: "calendar-1", expectedVersion: 1 })).rejects.toThrow("version");
    expect(calls).toBe(0);
  });

  test("fences a late scope A success and writes normalized authority only to A", async () => {
    const query = queryClient();
    let activeScope: CalendarScope | null = scopeA;
    let resolveRequest!: (value: DenCalendarResult) => void;
    const response = new Promise<DenCalendarResult>((resolve) => { resolveRequest = resolve; });
    const client = completeMutationClient({ createCalendar: async () => response });
    const hook = await renderHook(query, () => useCreateCalendarMutation(client, activeScope, { retryDelay: 0, idempotencyKeyFactory: () => "calendar.calendar-create.scope-a" }));
    const pending = hook.current.mutateAsync({ name: " raw " });
    activeScope = scopeB;
    await hook.rerender();
    await inAct(async () => { resolveRequest({ calendar: calendar(1, { name: "Normalized" }), replayed: false }); await pending; });
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-1"))?.name).toBe("Normalized");
    expect(query.getQueryData(calendarQueryKeys.calendar(scopeB, "calendar-1"))).toBeUndefined();
  });


  test("covers all six mutation wire strategies and success cache policy", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendars(scopeA), [calendar(2)]);
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(2));
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-1"), event(3));
    const calls: string[] = [];
    const deletedCalendar: DenCalendarDeleteResult = { tombstone: { entityType: "calendar", entityId: "calendar-1", version: 4, deletedAt: "2026-11-05T01:00:00Z" }, replayed: false };
    const deletedEvent: DenCalendarDeleteResult = { tombstone: { entityType: "event", entityId: "event-1", version: 5, deletedAt: "2026-11-05T01:00:00Z" }, replayed: false };
    const client = completeMutationClient({
      createCalendar: async (_org, input) => { calls.push(`cc:${input.idempotencyKey}`); return { calendar: calendar(1, { id: "calendar-2", name: "Created" }), replayed: false }; },
      updateCalendar: async (_org, _id, input) => { calls.push(`uc:${input.expectedVersion}`); return { calendar: calendar(3, { name: "Updated" }), replayed: false }; },
      deleteCalendar: async (_org, _id, input) => { calls.push(`dc:${input.expectedVersion}`); return deletedCalendar; },
      createCalendarEvent: async (_org, input) => { calls.push(`ce:${input.idempotencyKey}`); return { event: event(1, { id: "event-2", title: "Created" }), replayed: false }; },
      updateCalendarEvent: async (_org, _id, input) => { calls.push(`ue:${input.expectedVersion}`); return { event: event(4, { title: "Updated" }), replayed: false }; },
      deleteCalendarEvent: async (_org, _id, input) => { calls.push(`de:${input.expectedVersion}`); return deletedEvent; },
    });
    let keyIndex = 0;
    const options = { retryDelay: 0, idempotencyKeyFactory: (operation: string) => `calendar.${operation}.${++keyIndex}` };
    const hooks = await renderHook(query, () => ({
      createCalendar: useCreateCalendarMutation(client, scopeA, options),
      updateCalendar: useUpdateCalendarMutation(client, scopeA, options),
      deleteCalendar: useDeleteCalendarMutation(client, scopeA, options),
      createEvent: useCreateCalendarEventMutation(client, scopeA, options),
      updateEvent: useUpdateCalendarEventMutation(client, scopeA, options),
      deleteEvent: useDeleteCalendarEventMutation(client, scopeA, options),
    }));
    await inAct(async () => {
      await hooks.current.createCalendar.mutateAsync({ name: "draft" });
      await hooks.current.updateCalendar.mutateAsync({ calendarId: "calendar-1", expectedVersion: 2, patch: { name: "draft" } });
      await hooks.current.createEvent.mutateAsync({ calendarId: "calendar-1", title: "draft", time: { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" } });
      await hooks.current.updateEvent.mutateAsync({ eventId: "event-1", expectedVersion: 3, patch: { title: "draft" } });
      await hooks.current.deleteEvent.mutateAsync({ eventId: "event-1", expectedVersion: 4 });
      await hooks.current.deleteCalendar.mutateAsync({ calendarId: "calendar-1", expectedVersion: 3 });
    });
    expect(calls).toEqual([
      "cc:calendar.calendar-create.1", "uc:2", "ce:calendar.event-create.3", "ue:3", "de:4", "dc:3",
    ]);
    expect(query.getQueryData<DenCalendar>(calendarQueryKeys.calendar(scopeA, "calendar-2"))?.name).toBe("Created");
    expect(query.getQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, "event-2"))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, "event-1"))).toBeUndefined();
  });

  test("clears aggregate caches after successful deletes without touching another scope", async () => {
    const query = queryClient();
    query.setQueryData(calendarQueryKeys.calendars(scopeA), [calendar(2)]);
    query.setQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"), calendar(2));
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-1"), event(3));
    query.setQueryData(calendarQueryKeys.bootstrap(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }), { stale: "a" });
    query.setQueryData(calendarQueryKeys.range(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }), { stale: "a" });
    query.setQueryData(calendarQueryKeys.search(scopeA, { query: "review" }), { stale: "a" });
    query.setQueryData(calendarQueryKeys.event(scopeB, "event-1"), event(3, { organizationId: "org-b" }));
    query.setQueryData(calendarQueryKeys.bootstrap(scopeB, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }), { safe: "b" });
    const client = completeMutationClient({
      deleteCalendarEvent: async () => ({ tombstone: { entityType: "event", entityId: "event-1", version: 4, deletedAt: "2026-11-05T01:00:00Z" }, replayed: false }),
      deleteCalendar: async () => ({ tombstone: { entityType: "calendar", entityId: "calendar-1", version: 3, deletedAt: "2026-11-05T01:00:00Z" }, replayed: false }),
    });
    const hooks = await renderHook(query, () => ({
      deleteEvent: useDeleteCalendarEventMutation(client, scopeA, { retryDelay: 0 }),
      deleteCalendar: useDeleteCalendarMutation(client, scopeA, { retryDelay: 0 }),
    }));
    await hooks.current.deleteEvent.mutateAsync({ eventId: "event-1", expectedVersion: 3 });
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, "event-1"))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.bootstrap(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.range(scopeA, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.search(scopeA, { query: "review" }))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.event(scopeB, "event-1"))).toBeDefined();
    query.setQueryData(calendarQueryKeys.event(scopeA, "event-2"), event(1, { id: "event-2" }));
    query.setQueryData(calendarQueryKeys.range(scopeA, { startDate: "2026-12-01", endDateExclusive: "2027-01-01" }), { stale: "a" });
    await hooks.current.deleteCalendar.mutateAsync({ calendarId: "calendar-1", expectedVersion: 2 });
    expect(query.getQueryData(calendarQueryKeys.calendar(scopeA, "calendar-1"))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.event(scopeA, "event-2"))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.range(scopeA, { startDate: "2026-12-01", endDateExclusive: "2027-01-01" }))).toBeUndefined();
    expect(query.getQueryData(calendarQueryKeys.bootstrap(scopeB, { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toEqual({ safe: "b" });
  });
});

import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import type { DenCalendar, DenCalendarBootstrap, DenCalendarEvent, DenCalendarEventPage } from "../src/app/lib/den";
import {
  fetchAndPersistCalendarRange,
  persistCalendarBootstrapBaseline,
  readCachedCalendarRange,
} from "../src/react-app/domains/calendar/calendar-cache-baseline";
import { CalendarIndexedDbAdapter } from "../src/react-app/domains/calendar/calendar-cache";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
const november = { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["calendar-a"] };
const december = { startDate: "2026-12-01", endDateExclusive: "2027-01-01", calendarIds: ["calendar-a"] };

function cache(factory = new IDBFactory()) {
  return new CalendarIndexedDbAdapter({ indexedDB: factory, IDBKeyRange });
}

function calendar(id = "calendar-a", name = "Work"): DenCalendar {
  return {
    id,
    organizationId: scope.organizationId,
    ownerMemberId: scope.memberId,
    name,
    color: "#123456",
    isDefault: false,
    version: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function event(id: string, startDate = "2026-11-05", endDateExclusive = "2026-11-06"): DenCalendarEvent {
  return {
    id,
    organizationId: scope.organizationId,
    ownerMemberId: scope.memberId,
    calendarId: "calendar-a",
    title: id,
    description: "",
    time: { kind: "allDay", startDate, endDateExclusive },
    version: 1,
    createdAt: "2026-11-01T00:00:00Z",
    updatedAt: "2026-11-01T00:00:00Z",
  };
}

function bootstrap(events: DenCalendarEvent[], overrides: Partial<DenCalendarBootstrap> = {}): DenCalendarBootstrap {
  return {
    calendars: [calendar()],
    events,
    coverage: november,
    cursor: "change-cursor-1",
    ...overrides,
  };
}

describe("calendar cache baselines", () => {
  test("atomically persists bootstrap entities, exact coverage, cursor, and refresh time across restart", async () => {
    const factory = new IDBFactory();
    const first = cache(factory);
    await persistCalendarBootstrapBaseline({
      cache: first,
      scope,
      bootstrap: bootstrap([event("event-a")]),
      refreshedAt: "2026-11-05T04:00:00Z",
    });
    await first.close();

    const reopened = cache(factory);
    expect((await reopened.listEntities(scope, "calendar")).map((record) => record.entity.id)).toEqual(["calendar-a"]);
    expect((await reopened.listEntities(scope, "event")).map((record) => record.entity.id)).toEqual(["event-a"]);
    expect(await reopened.getCoverage(scope, november)).toEqual({ schemaVersion: 1, ...november, eventIds: ["event-a"] });
    expect(await reopened.getSync(scope)).toEqual({ schemaVersion: 1, cursor: "change-cursor-1", refreshedAt: "2026-11-05T04:00:00Z" });
  });

  test("rolls back the complete bootstrap when one record is invalid", async () => {
    const current = cache();
    await persistCalendarBootstrapBaseline({ cache: current, scope, bootstrap: bootstrap([event("old")]), refreshedAt: "2026-11-05T04:00:00Z" });
    const invalid = event("invalid");
    invalid.organizationId = "org-b";

    await expect(persistCalendarBootstrapBaseline({
      cache: current,
      scope,
      bootstrap: bootstrap([event("new"), invalid], { cursor: "must-not-commit" }),
      refreshedAt: "2026-11-06T04:00:00Z",
    })).rejects.toThrow(/owner/);

    expect((await current.listEntities(scope, "event")).map((record) => record.entity.id)).toEqual(["old"]);
    expect((await current.getSync(scope))?.cursor).toBe("change-cursor-1");
  });

  test("records an empty covered month without treating an adjacent month as empty", async () => {
    const current = cache();
    await persistCalendarBootstrapBaseline({ cache: current, scope, bootstrap: bootstrap([]), refreshedAt: "2026-11-05T04:00:00Z" });
    expect(await readCachedCalendarRange({ cache: current, scope, range: november })).toEqual({
      state: "covered",
      coverage: { schemaVersion: 1, ...november, eventIds: [] },
      events: [],
    });
    expect(await readCachedCalendarRange({ cache: current, scope, range: december })).toEqual({ state: "uncovered" });
  });

  test("only writes events and coverage after all range pages succeed", async () => {
    const current = cache();
    const pages: DenCalendarEventPage[] = [
      { items: [event("page-one")], nextCursor: "range-cursor-1", hasMore: true },
      { items: [event("page-two")], nextCursor: null, hasMore: false },
    ];
    let calls = 0;
    const client = {
      listCalendarEvents: async () => pages[calls++],
    } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"];

    const result = await fetchAndPersistCalendarRange({ cache: current, client, scope, range: november });
    expect(result.items.map((item) => item.id)).toEqual(["page-one", "page-two"]);
    expect((await current.listEntities(scope, "event")).map((record) => record.entity.id)).toEqual(["page-one", "page-two"]);
    expect(await current.getCoverage(scope, november)).toBeDefined();
    expect(await current.getSync(scope)).toBeUndefined();
  });

  test("does not persist a partial page when a later request fails", async () => {
    const current = cache();
    let calls = 0;
    const client = {
      listCalendarEvents: async (): Promise<DenCalendarEventPage> => {
        calls += 1;
        if (calls === 1) return { items: [event("partial")], nextCursor: "continue", hasMore: true };
        throw new Error("network failed");
      },
    } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"];

    await expect(fetchAndPersistCalendarRange({ cache: current, client, scope, range: november })).rejects.toThrow("network failed");
    expect(await current.listEntities(scope, "event")).toEqual([]);
    expect(await current.getCoverage(scope, november)).toBeUndefined();
  });

  test("fails closed on pagination that does not advance", async () => {
    const current = cache();
    let calls = 0;
    const client = {
      listCalendarEvents: async (): Promise<DenCalendarEventPage> => ({
        items: [],
        nextCursor: "same-cursor",
        hasMore: ++calls < 3,
      }),
    } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"];

    await expect(fetchAndPersistCalendarRange({ cache: current, client, scope, range: november })).rejects.toThrow(/did not advance/);
    expect(await current.getCoverage(scope, november)).toBeUndefined();
  });

  test("keeps coverage filters and scopes independent", async () => {
    const current = cache();
    const otherScope = createCalendarScope({ deploymentBaseUrl: scope.deployment, organizationId: "org-b", memberId: scope.memberId })!;
    await persistCalendarBootstrapBaseline({ cache: current, scope, bootstrap: bootstrap([]), refreshedAt: "2026-11-05T04:00:00Z" });
    expect(await readCachedCalendarRange({ cache: current, scope, range: { ...november, calendarIds: ["calendar-b"] } })).toEqual({ state: "uncovered" });
    expect(await readCachedCalendarRange({ cache: current, scope: otherScope, range: november })).toEqual({ state: "uncovered" });
  });

  test("invalidates another range when a previously shared event leaves the refreshed range", async () => {
    const current = cache();
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: december,
      client: { listCalendarEvents: async () => ({ items: [event("shared", "2026-11-30", "2026-12-02")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [event("shared", "2026-11-30", "2026-12-02")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });

    const cachedDecember = await readCachedCalendarRange({ cache: current, scope, range: december });
    expect(cachedDecember).toEqual({ state: "uncovered" });
  });

  test("invalidates old ranges before advancing a bootstrap high-watermark", async () => {
    const current = cache();
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: december,
      client: { listCalendarEvents: async () => ({ items: [event("old-december", "2026-12-05", "2026-12-06")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await persistCalendarBootstrapBaseline({ cache: current, scope, bootstrap: bootstrap([]), refreshedAt: "2026-11-06T04:00:00Z" });

    expect(await readCachedCalendarRange({ cache: current, scope, range: december })).toEqual({ state: "uncovered" });
    expect(await readCachedCalendarRange({ cache: current, scope, range: november })).toEqual({
      state: "covered",
      coverage: { schemaVersion: 1, ...november, eventIds: [] },
      events: [],
    });
    expect((await current.getSync(scope))?.cursor).toBe("change-cursor-1");
  });

  test("invalidates another coverage when an incoming event moves into it", async () => {
    const current = cache();
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: december,
      client: { listCalendarEvents: async () => ({ items: [], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [event("moved", "2026-11-30", "2026-12-02")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });

    expect(await readCachedCalendarRange({ cache: current, scope, range: december })).toEqual({ state: "uncovered" });
  });

  test("invalidates a previously empty destination range when an event leaves the refreshed range", async () => {
    const current = cache();
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: december,
      client: { listCalendarEvents: async () => ({ items: [], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [event("moving")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });

    expect(await readCachedCalendarRange({ cache: current, scope, range: december })).toEqual({ state: "uncovered" });
  });

  test("rejects an event outside the declared range and rolls back the range write", async () => {
    const current = cache();
    await expect(fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: november,
      client: { listCalendarEvents: async () => ({ items: [event("outside", "2026-12-05", "2026-12-06")], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    })).rejects.toThrow(/outside its declared coverage/);
    expect(await current.getEntity(scope, "event", "outside")).toBeUndefined();
    expect(await current.getCoverage(scope, november)).toBeUndefined();
  });

  test("invalidates coverage and removes events for Calendars missing from a complete bootstrap", async () => {
    const current = cache();
    const removedCalendar = calendar("calendar-b", "Removed");
    const removedEvent = { ...event("removed-event", "2026-12-05", "2026-12-06"), calendarId: removedCalendar.id };
    await persistCalendarBootstrapBaseline({
      cache: current,
      scope,
      bootstrap: bootstrap([removedEvent], { calendars: [calendar(), removedCalendar], coverage: { ...december, calendarIds: [removedCalendar.id] } }),
      refreshedAt: "2026-11-05T04:00:00Z",
    });
    await persistCalendarBootstrapBaseline({ cache: current, scope, bootstrap: bootstrap([]), refreshedAt: "2026-11-06T04:00:00Z" });

    expect(await current.getEntity(scope, "calendar", removedCalendar.id)).toBeUndefined();
    expect(await current.getEntity(scope, "event", removedEvent.id)).toBeUndefined();
    expect(await readCachedCalendarRange({ cache: current, scope, range: { ...december, calendarIds: [removedCalendar.id] } })).toEqual({ state: "uncovered" });
  });
});

import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import type { DenCalendar, DenCalendarChangePage, DenCalendarEvent } from "../src/app/lib/den";
import { applyCalendarChangePage, CalendarChangeCursorMismatchError } from "../src/react-app/domains/calendar/calendar-cache-changes";
import { CalendarIndexedDbAdapter, type CalendarCoverageRecord, type CalendarEntityRecord } from "../src/react-app/domains/calendar/calendar-cache";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;

function cache() {
  return new CalendarIndexedDbAdapter({ indexedDB: new IDBFactory(), IDBKeyRange });
}

function calendar(version = 1, id = "calendar-a"): DenCalendar {
  return { id, organizationId: scope.organizationId, ownerMemberId: scope.memberId, name: `Calendar v${version}`, color: null, isDefault: false, version, createdAt: "2026-11-01T00:00:00Z", updatedAt: `2026-11-0${Math.min(version, 9)}T00:00:00Z` };
}

function event(version = 1, input: Partial<DenCalendarEvent> = {}): DenCalendarEvent {
  return {
    id: "event-a", organizationId: scope.organizationId, ownerMemberId: scope.memberId, calendarId: "calendar-a",
    title: `Event v${version}`, description: "", time: { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" },
    version, createdAt: "2026-11-01T00:00:00Z", updatedAt: `2026-11-0${Math.min(version, 9)}T00:00:00Z`, ...input,
  };
}

function entityRecord(entity: DenCalendar | DenCalendarEvent): CalendarEntityRecord {
  return "calendarId" in entity
    ? { schemaVersion: 1, entityType: "event", entity, calendarId: entity.calendarId, coverageStartDate: "", coverageEndDateExclusive: "" }
    : { schemaVersion: 1, entityType: "calendar", entity };
}

const coverage: CalendarCoverageRecord = { schemaVersion: 1, startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: ["calendar-a"], eventIds: [] };

async function seed(current: CalendarIndexedDbAdapter) {
  await current.putSync(scope, { schemaVersion: 1, cursor: "cursor-1", refreshedAt: "2026-11-01T00:00:00Z" });
  await current.putCoverage(scope, coverage);
}

function page(items: DenCalendarChangePage["items"], nextCursor = "cursor-2"): DenCalendarChangePage {
  return { items, nextCursor, hasMore: false };
}

describe("calendar change page cache", () => {
  test("applies event upserts and deletes with coverage, tombstones, and cursor in one page", async () => {
    const current = cache();
    await seed(current);
    const first = await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "upsert", entityType: "event", entity: event(1) }]), refreshedAt: "2026-11-02T00:00:00Z" });
    expect(first).toEqual({ applied: 1, ignored: 0, cursor: "cursor-2" });
    expect((await current.getCoverage(scope, coverage))?.eventIds).toEqual(["event-a"]);

    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-2", page: page([{ sequence: 2, kind: "delete", entityType: "event", entityId: "event-a", version: 2, deletedAt: "2026-11-03T00:00:00Z" }], "cursor-3"), refreshedAt: "2026-11-03T00:00:00Z" });
    expect(await current.getEntity(scope, "event", "event-a")).toBeUndefined();
    expect((await current.getTombstone(scope, "event", "event-a"))?.version).toBe(2);
    expect((await current.getCoverage(scope, coverage))?.eventIds).toEqual([]);
    expect((await current.getSync(scope))?.cursor).toBe("cursor-3");
  });

  test("ignores stale and duplicate changes while advancing the page cursor", async () => {
    const current = cache();
    await seed(current);
    await current.putEntity(scope, entityRecord(event(3)));
    const result = await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([
      { sequence: 1, kind: "upsert", entityType: "event", entity: event(2) },
      { sequence: 2, kind: "delete", entityType: "event", entityId: "event-a", version: 3, deletedAt: "2026-11-03T00:00:00Z" },
    ]), refreshedAt: "2026-11-03T00:00:00Z" });
    expect(result).toEqual({ applied: 0, ignored: 2, cursor: "cursor-2" });
    expect((await current.getEntity(scope, "event", "event-a"))?.entity.version).toBe(3);
  });

  test("a tombstone prevents stale resurrection but a newer upsert supersedes it", async () => {
    const current = cache();
    await seed(current);
    await current.putTombstone(scope, { schemaVersion: 1, entityType: "event", id: "event-a", version: 5, deletedAt: "2026-11-05T00:00:00Z" });
    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "upsert", entityType: "event", entity: event(4) }]), refreshedAt: "2026-11-06T00:00:00Z" });
    expect(await current.getEntity(scope, "event", "event-a")).toBeUndefined();
    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-2", page: page([{ sequence: 2, kind: "upsert", entityType: "event", entity: event(6) }], "cursor-3"), refreshedAt: "2026-11-07T00:00:00Z" });
    expect((await current.getEntity(scope, "event", "event-a"))?.entity.version).toBe(6);
    expect(await current.getTombstone(scope, "event", "event-a")).toBeUndefined();
  });

  test("calendar delete removes children, invalidates explicit coverage, and blocks child resurrection", async () => {
    const current = cache();
    await seed(current);
    await current.putEntity(scope, entityRecord(calendar(1)));
    await current.putEntity(scope, entityRecord(event(1)));
    await current.putCoverage(scope, { ...coverage, eventIds: ["event-a"] });
    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "delete", entityType: "calendar", entityId: "calendar-a", version: 2, deletedAt: "2026-11-03T00:00:00Z" }]), refreshedAt: "2026-11-03T00:00:00Z" });
    expect(await current.getEntity(scope, "calendar", "calendar-a")).toBeUndefined();
    expect(await current.getEntity(scope, "event", "event-a")).toBeUndefined();
    expect(await current.getCoverage(scope, coverage)).toBeUndefined();
    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-2", page: page([{ sequence: 2, kind: "upsert", entityType: "event", entity: event(2) }], "cursor-3"), refreshedAt: "2026-11-04T00:00:00Z" });
    expect(await current.getEntity(scope, "event", "event-a")).toBeUndefined();
  });

  test("rejects stale pages and rolls back all stores when cursor persistence fails", async () => {
    const current = cache();
    await seed(current);
    await expect(applyCalendarChangePage({ cache: current, scope, fromCursor: "wrong", page: page([]), refreshedAt: "2026-11-02T00:00:00Z" })).rejects.toBeInstanceOf(CalendarChangeCursorMismatchError);
    const failing = {
      transaction: (targetScope: typeof scope, stores: Parameters<CalendarIndexedDbAdapter["transaction"]>[1], mode: IDBTransactionMode, action: Parameters<CalendarIndexedDbAdapter["transaction"]>[3]) => current.transaction(targetScope, stores, mode, (transaction) => action({ ...transaction, putSync: async () => { throw new Error("sync write failed"); } })),
    } as Pick<CalendarIndexedDbAdapter, "transaction">;
    await expect(applyCalendarChangePage({ cache: failing, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "upsert", entityType: "calendar", entity: calendar(1) }]), refreshedAt: "2026-11-02T00:00:00Z" })).rejects.toThrow("sync write failed");
    expect(await current.getEntity(scope, "calendar", "calendar-a")).toBeUndefined();
    expect((await current.getSync(scope))?.cursor).toBe("cursor-1");
  });

  test("does not cache a new event outside every covered range", async () => {
    const current = cache();
    await seed(current);
    const outside = event(1, { id: "outside", time: { kind: "allDay", startDate: "2027-01-05", endDateExclusive: "2027-01-06" } });
    const result = await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "upsert", entityType: "event", entity: outside }]), refreshedAt: "2026-11-02T00:00:00Z" });
    expect(result).toEqual({ applied: 0, ignored: 1, cursor: "cursor-2" });
    expect(await current.getEntity(scope, "event", "outside")).toBeUndefined();
  });

  test("a delayed range response cannot overwrite a newer entity or resurrect a tombstoned event", async () => {
    const current = cache();
    await seed(current);
    await current.putEntity(scope, entityRecord(event(6)));
    const { fetchAndPersistCalendarRange } = await import("../src/react-app/domains/calendar/calendar-cache-baseline");
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: { startDate: coverage.startDate, endDateExclusive: coverage.endDateExclusive, calendarIds: coverage.calendarIds },
      client: { listCalendarEvents: async () => ({ items: [event(5)], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    expect((await current.getEntity(scope, "event", "event-a"))?.entity.version).toBe(6);

    await current.putTombstone(scope, { schemaVersion: 1, entityType: "event", id: "event-a", version: 7, deletedAt: "2026-11-07T00:00:00Z" });
    await current.deleteEntity(scope, "event", "event-a");
    await fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: { startDate: coverage.startDate, endDateExclusive: coverage.endDateExclusive, calendarIds: coverage.calendarIds },
      client: { listCalendarEvents: async () => ({ items: [event(6)], nextCursor: null, hasMore: false }) } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    expect(await current.getEntity(scope, "event", "event-a")).toBeUndefined();
    expect((await current.getCoverage(scope, coverage))?.eventIds).toEqual([]);
  });

  test("rejects a delayed empty range after changes advanced the sync cursor", async () => {
    const current = cache();
    await seed(current);
    const { fetchAndPersistCalendarRange } = await import("../src/react-app/domains/calendar/calendar-cache-baseline");
    let release!: () => void;
    const delayed = fetchAndPersistCalendarRange({
      cache: current,
      scope,
      range: { startDate: coverage.startDate, endDateExclusive: coverage.endDateExclusive, calendarIds: coverage.calendarIds },
      client: { listCalendarEvents: async () => { await new Promise<void>((resolve) => { release = resolve; }); return { items: [], nextCursor: null, hasMore: false }; } } as unknown as Parameters<typeof fetchAndPersistCalendarRange>[0]["client"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await applyCalendarChangePage({ cache: current, scope, fromCursor: "cursor-1", page: page([{ sequence: 1, kind: "upsert", entityType: "event", entity: event(1) }]), refreshedAt: "2026-11-02T00:00:00Z" });
    release();
    await expect(delayed).rejects.toThrow(/stale relative/);
    expect((await current.getCoverage(scope, coverage))?.eventIds).toEqual(["event-a"]);
  });
});

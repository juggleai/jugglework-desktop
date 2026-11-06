import type {
  DenCalendarBootstrap,
  DenCalendarEvent,
  DenCalendarRangeOptions,
  DenClient,
} from "@/app/lib/den";

import {
  CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
  type CalendarCoverageRecord,
  type CalendarCoverageSelector,
  type CalendarEntityRecord,
  type CalendarIndexedDbAdapter,
} from "./calendar-cache";
import type { CalendarScope } from "./calendar-scope";

type CalendarBaselineCache = Pick<CalendarIndexedDbAdapter, "transaction">;
type CalendarRangeClient = Pick<DenClient, "listCalendarEvents">;
type CalendarRangeRequest = Omit<DenCalendarRangeOptions, "cursor">;

export type CachedCalendarRange =
  | { state: "uncovered" }
  | { state: "covered"; coverage: CalendarCoverageRecord; events: DenCalendarEvent[] };

function cloneChecked<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${label} must be structured-cloneable.`);
  }
}

function snapshotScope(scope: CalendarScope): CalendarScope {
  if (!scope || typeof scope !== "object") throw new TypeError("Calendar baseline requires a complete scope.");
  const { deployment, organizationId, memberId } = scope;
  if (!deployment?.trim() || !organizationId?.trim() || !memberId?.trim()) throw new TypeError("Calendar baseline requires a complete scope.");
  return Object.freeze({ deployment, organizationId, memberId });
}

function coverageRecord(input: CalendarCoverageSelector, eventIds: readonly string[]): CalendarCoverageRecord {
  return {
    schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
    startDate: input.startDate,
    endDateExclusive: input.endDateExclusive,
    calendarIds: [...new Set(input.calendarIds)].sort(),
    eventIds: [...new Set(eventIds)].sort(),
  };
}

function entityRecord(entity: DenCalendarBootstrap["calendars"][number] | DenCalendarEvent): CalendarEntityRecord {
  if ("calendarId" in entity) {
    return {
      schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
      entityType: "event",
      entity,
      calendarId: entity.calendarId,
      coverageStartDate: "",
      coverageEndDateExclusive: "",
    };
  }
  return { schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION, entityType: "calendar", entity };
}

function eventBelongsToCoverage(record: CalendarEntityRecord, coverage: CalendarCoverageRecord): boolean {
  if (record.entityType !== "event") return false;
  const selected = coverage.calendarIds.length === 0 || coverage.calendarIds.includes(record.calendarId);
  return selected && record.coverageStartDate < coverage.endDateExclusive && record.coverageEndDateExclusive > coverage.startDate;
}

function sameCoverage(left: CalendarCoverageRecord, right: CalendarCoverageRecord): boolean {
  return left.startDate === right.startDate
    && left.endDateExclusive === right.endDateExclusive
    && left.calendarIds.length === right.calendarIds.length
    && left.calendarIds.every((id, index) => id === right.calendarIds[index]);
}

async function storeCoveredEvents(
  transaction: Parameters<Parameters<CalendarBaselineCache["transaction"]>[3]>[0],
  currentCoverage: CalendarCoverageRecord,
  events: readonly DenCalendarEvent[],
): Promise<string[]> {
  const existingCoverage = await transaction.listCoverage();
  const visibleEventIds: string[] = [];
  for (const event of events) {
    const existing = await transaction.getEntity("event", event.id);
    const tombstone = await transaction.getTombstone("event", event.id);
    const parentTombstone = await transaction.getTombstone("calendar", event.calendarId);
    const currentVersion = Math.max(existing?.entity.version ?? 0, tombstone?.version ?? 0);
    if (!parentTombstone && event.version > currentVersion) {
      await transaction.putEntity(entityRecord(event));
      await transaction.deleteTombstone("event", event.id);
    }
    const stored = await transaction.getEntity("event", event.id);
    if (!stored || stored.entityType !== "event" || !eventBelongsToCoverage(stored, currentCoverage)) {
      if (tombstone || parentTombstone || (existing && existing.entity.version > event.version)) continue;
      throw new TypeError("Calendar range returned an event outside its declared coverage.");
    }
    visibleEventIds.push(event.id);
    for (const coverage of existingCoverage) {
      if (sameCoverage(coverage, currentCoverage)) continue;
      const wasMember = coverage.eventIds.includes(event.id);
      const isMember = eventBelongsToCoverage(stored, coverage);
      if (wasMember !== isMember) await transaction.deleteCoverage(coverage);
    }
  }
  return visibleEventIds;
}

export function persistCalendarBootstrapBaseline(input: {
  cache: CalendarBaselineCache;
  scope: CalendarScope;
  bootstrap: DenCalendarBootstrap;
  refreshedAt: string;
}): Promise<void> {
  const scope = snapshotScope(input.scope);
  const bootstrap = cloneChecked(input.bootstrap, "Calendar bootstrap");
  const refreshedAt = input.refreshedAt;
  const coverage = coverageRecord(bootstrap.coverage, []);

  return input.cache.transaction(scope, ["entities", "tombstones", "coverage", "sync"], "readwrite", async (transaction) => {
    const incomingCalendarIds = new Set(bootstrap.calendars.map((calendar) => calendar.id));
    const removedCalendarIds = new Set<string>();
    for (const existing of await transaction.listEntities("calendar")) {
      if (!incomingCalendarIds.has(existing.entity.id)) {
        removedCalendarIds.add(existing.entity.id);
        await transaction.deleteEntity("calendar", existing.entity.id);
      }
    }
    if (removedCalendarIds.size > 0) {
      for (const existing of await transaction.listEntities("event")) {
        if (existing.entityType === "event" && removedCalendarIds.has(existing.calendarId)) {
          await transaction.deleteEntity("event", existing.entity.id);
        }
      }
    }
    for (const existing of await transaction.listCoverage()) await transaction.deleteCoverage(existing);
    for (const calendar of bootstrap.calendars) {
      const existing = await transaction.getEntity("calendar", calendar.id);
      const tombstone = await transaction.getTombstone("calendar", calendar.id);
      if (calendar.version > Math.max(existing?.entity.version ?? 0, tombstone?.version ?? 0)) {
        await transaction.putEntity(entityRecord(calendar));
        await transaction.deleteTombstone("calendar", calendar.id);
      }
    }
    const visibleEventIds = await storeCoveredEvents(transaction, coverage, bootstrap.events);
    await transaction.putCoverage({ ...coverage, eventIds: visibleEventIds });
    await transaction.putSync({
      schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
      cursor: bootstrap.cursor,
      refreshedAt,
    });
  });
}

export function fetchAndPersistCalendarRange(input: {
  cache: CalendarBaselineCache;
  client: CalendarRangeClient;
  scope: CalendarScope;
  range: CalendarRangeRequest;
  signal?: AbortSignal;
}): Promise<{ items: DenCalendarEvent[]; coverage: CalendarCoverageRecord }> {
  const scope = snapshotScope(input.scope);
  const range = cloneChecked(input.range, "Calendar range request");
  const coverageSelector = {
    startDate: range.startDate,
    endDateExclusive: range.endDateExclusive,
    calendarIds: range.calendarIds ?? [],
  };

  return (async () => {
    const startingSync = await input.cache.transaction(scope, ["sync"], "readonly", (transaction) => transaction.getSync());
    const items: DenCalendarEvent[] = [];
    const entityIds = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;

    for (;;) {
      if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Calendar range request was aborted.", "AbortError");
      const page = await input.client.listCalendarEvents(scope.organizationId, { ...range, cursor }, { signal: input.signal });
      for (const event of page.items) {
        if (entityIds.has(event.id)) throw new TypeError("Calendar range pagination returned a duplicate event.");
        entityIds.add(event.id);
        items.push(event);
      }
      if (!page.hasMore) break;
      if (!page.nextCursor || cursors.has(page.nextCursor)) throw new TypeError("Calendar range pagination did not advance its cursor.");
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Calendar range request was aborted.", "AbortError");

    const coverage = coverageRecord(coverageSelector, []);
    await input.cache.transaction(scope, ["entities", "tombstones", "coverage", "sync"], "readwrite", async (transaction) => {
      const currentSync = await transaction.getSync();
      if ((currentSync?.cursor ?? null) !== (startingSync?.cursor ?? null)) {
        throw new TypeError("Calendar range response is stale relative to the synchronized cursor.");
      }
      const previous = await transaction.getCoverage(coverageSelector);
      if (previous) {
        const incomingIds = new Set(coverage.eventIds);
        const departedIds = previous.eventIds.filter((id) => !incomingIds.has(id));
        if (departedIds.length > 0) {
          for (const existing of await transaction.listCoverage()) {
            if (!sameCoverage(existing, previous)) await transaction.deleteCoverage(existing);
          }
        }
      }
      const visibleEventIds = await storeCoveredEvents(transaction, coverage, items);
      coverage.eventIds = visibleEventIds;
      await transaction.putCoverage(coverage);
    });
    return { items: cloneChecked(items, "Calendar range items"), coverage: cloneChecked(coverage, "Calendar range coverage") };
  })();
}

export function readCachedCalendarRange(input: {
  cache: CalendarBaselineCache;
  scope: CalendarScope;
  range: CalendarCoverageSelector;
}): Promise<CachedCalendarRange> {
  const scope = snapshotScope(input.scope);
  const range = cloneChecked(input.range, "Calendar cached range");
  return input.cache.transaction(scope, ["entities", "coverage"], "readonly", async (transaction) => {
    const coverage = await transaction.getCoverage(range);
    if (!coverage) return { state: "uncovered" };
    const events: DenCalendarEvent[] = [];
    for (const eventId of coverage.eventIds) {
      const record = await transaction.getEntity("event", eventId);
      if (!record) return { state: "uncovered" };
      if (!eventBelongsToCoverage(record, coverage)) return { state: "uncovered" };
      events.push(record.entity as DenCalendarEvent);
    }
    return { state: "covered", coverage, events };
  });
}

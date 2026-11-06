import type { DenCalendar, DenCalendarChange, DenCalendarChangePage, DenCalendarEvent } from "@/app/lib/den";

import {
  CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
  type CalendarCacheTransaction,
  type CalendarCoverageRecord,
  type CalendarEntityRecord,
  type CalendarIndexedDbAdapter,
  type CalendarTombstoneRecord,
} from "./calendar-cache";
import type { CalendarScope } from "./calendar-scope";
import { calendarCoverageDates, parseCalendarEventTime } from "./calendar-time-adapter";

type CalendarChangeCache = Pick<CalendarIndexedDbAdapter, "transaction">;
type CalendarDeleteChange = Extract<DenCalendarChange, { kind: "delete" }>;

export class CalendarChangeCursorMismatchError extends Error {
  constructor(readonly expectedCursor: string, readonly actualCursor: string | null) {
    super("Calendar change page cursor does not match the persisted cursor.");
    this.name = "CalendarChangeCursorMismatchError";
  }
}

export type ApplyCalendarChangePageResult = {
  applied: number;
  ignored: number;
  cursor: string;
};

function cloneChecked<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${label} must be structured-cloneable.`);
  }
}

function entityRecord(entity: DenCalendar | DenCalendarEvent): CalendarEntityRecord {
  if ("calendarId" in entity) {
    const projected = calendarCoverageDates(parseCalendarEventTime(entity.time));
    return {
      schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
      entityType: "event",
      entity,
      calendarId: entity.calendarId,
      coverageStartDate: projected.startDate.toString(),
      coverageEndDateExclusive: projected.endDateExclusive.toString(),
    };
  }
  return { schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION, entityType: "calendar", entity };
}

function currentVersion(entity: CalendarEntityRecord | undefined, tombstone: CalendarTombstoneRecord | undefined): number {
  return Math.max(entity?.entity.version ?? 0, tombstone?.version ?? 0);
}

function eventBelongsToCoverage(record: Extract<CalendarEntityRecord, { entityType: "event" }>, coverage: CalendarCoverageRecord): boolean {
  const selected = coverage.calendarIds.length === 0 || coverage.calendarIds.includes(record.calendarId);
  return selected && record.coverageStartDate < coverage.endDateExclusive && record.coverageEndDateExclusive > coverage.startDate;
}

async function updateEventCoverage(transaction: CalendarCacheTransaction, record: Extract<CalendarEntityRecord, { entityType: "event" }>): Promise<void> {
  for (const coverage of await transaction.listCoverage()) {
    const hasEvent = coverage.eventIds.includes(record.entity.id);
    const shouldHaveEvent = eventBelongsToCoverage(record, coverage);
    if (hasEvent === shouldHaveEvent) continue;
    await transaction.putCoverage({
      ...coverage,
      eventIds: shouldHaveEvent
        ? [...coverage.eventIds, record.entity.id]
        : coverage.eventIds.filter((id) => id !== record.entity.id),
    });
  }
}

async function removeEventFromCoverage(transaction: CalendarCacheTransaction, eventId: string): Promise<void> {
  for (const coverage of await transaction.listCoverage()) {
    if (!coverage.eventIds.includes(eventId)) continue;
    await transaction.putCoverage({ ...coverage, eventIds: coverage.eventIds.filter((id) => id !== eventId) });
  }
}

async function applyUpsert(transaction: CalendarCacheTransaction, change: Extract<DenCalendarChange, { kind: "upsert" }>): Promise<boolean> {
  const id = change.entity.id;
  const entity = await transaction.getEntity(change.entityType, id);
  const tombstone = await transaction.getTombstone(change.entityType, id);
  if (change.entity.version <= currentVersion(entity, tombstone)) return false;

  if (change.entityType === "event") {
    const parentTombstone = await transaction.getTombstone("calendar", change.entity.calendarId);
    if (parentTombstone) return false;
    const coverage = await transaction.listCoverage();
    const candidate = entityRecord(change.entity);
    if (candidate.entityType !== "event") throw new TypeError("Calendar event change has an invalid entity type.");
    if (!entity && !tombstone && !coverage.some((record) => eventBelongsToCoverage(candidate, record))) return false;
    await transaction.putEntity(entityRecord(change.entity));
    const stored = await transaction.getEntity("event", id);
    if (!stored || stored.entityType !== "event") throw new TypeError("Calendar event upsert could not be read back.");
    await updateEventCoverage(transaction, stored);
  } else {
    await transaction.putEntity(entityRecord(change.entity));
  }
  await transaction.deleteTombstone(change.entityType, id);
  return true;
}

async function applyEventDelete(transaction: CalendarCacheTransaction, change: CalendarDeleteChange): Promise<boolean> {
  const entity = await transaction.getEntity("event", change.entityId);
  const tombstone = await transaction.getTombstone("event", change.entityId);
  if (change.version <= currentVersion(entity, tombstone)) return false;
  await transaction.deleteEntity("event", change.entityId);
  await transaction.putTombstone({
    schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
    entityType: "event",
    id: change.entityId,
    version: change.version,
    deletedAt: change.deletedAt,
  });
  await removeEventFromCoverage(transaction, change.entityId);
  return true;
}

async function applyCalendarDelete(transaction: CalendarCacheTransaction, change: CalendarDeleteChange): Promise<boolean> {
  const entity = await transaction.getEntity("calendar", change.entityId);
  const tombstone = await transaction.getTombstone("calendar", change.entityId);
  if (change.version <= currentVersion(entity, tombstone)) return false;

  const childIds = new Set<string>();
  for (const event of await transaction.listEntities("event")) {
    if (event.entityType !== "event" || event.calendarId !== change.entityId) continue;
    childIds.add(event.entity.id);
    await transaction.deleteEntity("event", event.entity.id);
  }
  for (const coverage of await transaction.listCoverage()) {
    if (coverage.calendarIds.includes(change.entityId)) {
      await transaction.deleteCoverage(coverage);
    } else if (coverage.eventIds.some((id) => childIds.has(id))) {
      await transaction.putCoverage({ ...coverage, eventIds: coverage.eventIds.filter((id) => !childIds.has(id)) });
    }
  }
  await transaction.deleteEntity("calendar", change.entityId);
  await transaction.putTombstone({
    schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION,
    entityType: "calendar",
    id: change.entityId,
    version: change.version,
    deletedAt: change.deletedAt,
  });
  return true;
}

async function applyChange(transaction: CalendarCacheTransaction, change: DenCalendarChange): Promise<boolean> {
  if (change.kind === "upsert") return applyUpsert(transaction, change);
  if (change.entityType === "event") return applyEventDelete(transaction, change);
  return applyCalendarDelete(transaction, change);
}

export function applyCalendarChangePage(input: {
  cache: CalendarChangeCache;
  scope: CalendarScope;
  fromCursor: string;
  page: DenCalendarChangePage;
  refreshedAt: string;
}): Promise<ApplyCalendarChangePageResult> {
  const scope = cloneChecked(input.scope, "Calendar change scope");
  const page = cloneChecked(input.page, "Calendar change page");
  const fromCursor = input.fromCursor;
  const refreshedAt = input.refreshedAt;

  if (!fromCursor.trim() || !page.nextCursor.trim()) throw new TypeError("Calendar change cursors must be non-empty.");
  return input.cache.transaction(scope, ["entities", "tombstones", "coverage", "sync"], "readwrite", async (transaction) => {
    const sync = await transaction.getSync();
    if (!sync || sync.cursor !== fromCursor) throw new CalendarChangeCursorMismatchError(fromCursor, sync?.cursor ?? null);
    let applied = 0;
    let ignored = 0;
    for (const change of page.items) {
      if (await applyChange(transaction, change)) applied += 1;
      else ignored += 1;
    }
    await transaction.putSync({ schemaVersion: CALENDAR_CACHE_RECORD_SCHEMA_VERSION, cursor: page.nextCursor, refreshedAt });
    return { applied, ignored, cursor: page.nextCursor };
  });
}

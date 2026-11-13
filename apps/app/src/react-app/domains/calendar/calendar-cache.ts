import { Temporal } from "@js-temporal/polyfill";

import { normalizeDenCalendar, normalizeDenCalendarEvent, normalizeDenCalendarSchedulingEvent } from "../../../app/lib/den";
import { normalizeCalendarEventDraftForm } from "./calendar-event-form-model";
import { calendarCoverageDates, parseCalendarEventTime } from "./calendar-time-adapter";
import type { CalendarScope } from "./calendar-scope";
import type { Calendar, CalendarEvent } from "./calendar-types";

export const CALENDAR_CACHE_DB_NAME = "jugglework.calendar";
export const CALENDAR_CACHE_DB_VERSION = 1;
export const CALENDAR_CACHE_RECORD_SCHEMA_VERSION = 1 as const;

export const CALENDAR_CACHE_STORES = ["entities", "tombstones", "coverage", "sync", "drafts"] as const;
export type CalendarCacheStoreName = (typeof CALENDAR_CACHE_STORES)[number];

export type CalendarEntityRecord =
  | {
      schemaVersion: 1;
      entityType: "calendar";
      entity: Calendar;
    }
  | {
      schemaVersion: 1;
      entityType: "event";
      entity: CalendarEvent;
      calendarId: string;
      coverageStartDate: string;
      coverageEndDateExclusive: string;
    };

export type CalendarTombstoneRecord = {
  schemaVersion: 1;
  entityType: "calendar" | "event";
  id: string;
  version: number;
  deletedAt: string;
};

export type CalendarCoverageRecord = {
  schemaVersion: 1;
  startDate: string;
  endDateExclusive: string;
  calendarIds: string[];
  eventIds: string[];
};

export type CalendarSyncRecord = {
  schemaVersion: 1;
  cursor: string;
  refreshedAt: string;
};

type CalendarDraftBase = {
  schemaVersion: 2;
  id: string;
  entityType: "calendar" | "event";
  unsynced: true;
  values: unknown;
};

type LegacyCalendarDraftRecord = Omit<CalendarDraftRecord, "schemaVersion"> & { schemaVersion: 1 };

export type CalendarDraftRecord =
  | (CalendarDraftBase & { operation: "create"; baseEntity: null })
  | (CalendarDraftBase & { operation: "edit"; baseEntity: { id: string; version: number } });

export type CalendarCoverageSelector = Pick<CalendarCoverageRecord, "startDate" | "endDateExclusive" | "calendarIds">;
export type CalendarEntityType = CalendarEntityRecord["entityType"];
export type CalendarScopeCompatibilityResult = "compatible" | "cleared-incompatible";

export class CalendarCacheUnavailableError extends Error {
  constructor(message = "Calendar cache is unavailable because IndexedDB is not supported.") {
    super(message);
    this.name = "CalendarCacheUnavailableError";
  }
}

export class CalendarCacheCorruptRecordError extends Error {
  constructor(store: CalendarCacheStoreName) {
    super(`Calendar cache contains an invalid ${store} record.`);
    this.name = "CalendarCacheCorruptRecordError";
  }
}

export interface CalendarCacheTransaction {
  getEntity(entityType: CalendarEntityType, id: string): Promise<CalendarEntityRecord | undefined>;
  listEntities(entityType: CalendarEntityType): Promise<CalendarEntityRecord[]>;
  putEntity(record: CalendarEntityRecord): Promise<void>;
  deleteEntity(entityType: CalendarEntityType, id: string): Promise<void>;
  getTombstone(entityType: CalendarEntityType, id: string): Promise<CalendarTombstoneRecord | undefined>;
  listTombstones(entityType?: CalendarEntityType): Promise<CalendarTombstoneRecord[]>;
  putTombstone(record: CalendarTombstoneRecord): Promise<void>;
  deleteTombstone(entityType: CalendarEntityType, id: string): Promise<void>;
  getCoverage(selector: CalendarCoverageSelector): Promise<CalendarCoverageRecord | undefined>;
  listCoverage(calendarIds?: readonly string[]): Promise<CalendarCoverageRecord[]>;
  putCoverage(record: CalendarCoverageRecord): Promise<void>;
  deleteCoverage(selector: CalendarCoverageSelector): Promise<void>;
  getSync(): Promise<CalendarSyncRecord | undefined>;
  putSync(record: CalendarSyncRecord): Promise<void>;
  deleteSync(): Promise<void>;
  getDraft(id: string): Promise<CalendarDraftRecord | undefined>;
  listDrafts(entityType?: CalendarEntityType): Promise<CalendarDraftRecord[]>;
  putDraft(record: CalendarDraftRecord): Promise<void>;
  deleteDraft(id: string): Promise<void>;
}

type StoredRecord = Record<string, unknown> & {
  key: IDBValidKey;
  scopeKey: string;
  recordType: string;
  schemaVersion: number;
};

type CalendarCacheOptions = {
  indexedDB?: IDBFactory | null;
  IDBKeyRange?: typeof IDBKeyRange | null;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function cloneChecked<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch {
    throw new TypeError(`${label} must be structured-cloneable.`);
  }
}

function assertOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
}

function assertPositiveVersion(value: unknown, label = "Calendar record version"): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
}

function assertInstant(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") throw new TypeError(`${label} must be an RFC 3339 instant.`);
  try {
    Temporal.Instant.from(value);
  } catch {
    throw new TypeError(`${label} must be an RFC 3339 instant.`);
  }
}

function assertEntityType(value: unknown): asserts value is CalendarEntityType {
  if (value !== "calendar" && value !== "event") throw new TypeError("Calendar entity type must be calendar or event.");
}

function normalizeCalendarIds(calendarIds: readonly string[]): string[] {
  if (!Array.isArray(calendarIds)) throw new TypeError("Calendar coverage calendarIds must be an array.");
  for (const calendarId of calendarIds) {
    assertOpaqueId(calendarId, "Calendar coverage calendarId");
  }
  return [...new Set(calendarIds)].sort();
}

function normalizeEventIds(eventIds: readonly string[]): string[] {
  if (!Array.isArray(eventIds)) throw new TypeError("Calendar coverage eventIds must be an array.");
  for (const eventId of eventIds) assertOpaqueId(eventId, "Calendar coverage eventId");
  return [...new Set(eventIds)].sort();
}

function coverageFilterKey(calendarIds: readonly string[]): string {
  return JSON.stringify(normalizeCalendarIds(calendarIds));
}

function validateCoverageInterval(startDate: unknown, endDateExclusive: unknown): void {
  if (typeof startDate !== "string" || typeof endDateExclusive !== "string") {
    throw new TypeError("Calendar coverage must use date strings.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDateExclusive)) {
    throw new TypeError("Calendar coverage must use strict YYYY-MM-DD dates.");
  }
  parseCalendarEventTime({ kind: "allDay", startDate, endDateExclusive });
}

function snapshotScope(scope: CalendarScope): Readonly<CalendarScope> {
  if (!scope || typeof scope !== "object") throw new TypeError("Calendar cache requires a complete scope.");
  const { deployment, organizationId, memberId } = scope as CalendarScope;
  if (typeof deployment !== "string" || !deployment.trim() || typeof organizationId !== "string" || !organizationId.trim() || typeof memberId !== "string" || !memberId.trim()) {
    throw new TypeError("Calendar cache requires deployment, organizationId, and memberId.");
  }
  return Object.freeze({ deployment, organizationId, memberId });
}

function scopeKeyFor(scope: CalendarScope): string {
  return JSON.stringify([scope.deployment, scope.organizationId, scope.memberId]);
}

function equalKey(left: unknown, right: readonly IDBValidKey[]): boolean {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Calendar IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new DOMException("Calendar cache transaction aborted.", "AbortError"));
    transaction.onerror = () => undefined;
  });
}

function createIndexes(store: IDBObjectStore, typeKeyPath: string | string[]): void {
  store.createIndex("byScope", "scopeKey", { unique: false });
  store.createIndex("byScopeType", typeKeyPath, { unique: false });
}

function createSchema(database: IDBDatabase): void {
  const entities = database.createObjectStore("entities", { keyPath: "key" });
  createIndexes(entities, ["scopeKey", "entityType"]);

  const tombstones = database.createObjectStore("tombstones", { keyPath: "key" });
  createIndexes(tombstones, ["scopeKey", "entityType"]);

  const coverage = database.createObjectStore("coverage", { keyPath: "key" });
  createIndexes(coverage, ["scopeKey", "recordType"]);
  coverage.createIndex("byScopeFilter", ["scopeKey", "filterKey"], { unique: false });

  const sync = database.createObjectStore("sync", { keyPath: "key" });
  createIndexes(sync, ["scopeKey", "recordType"]);

  const drafts = database.createObjectStore("drafts", { keyPath: "key" });
  createIndexes(drafts, ["scopeKey", "entityType"]);
  drafts.createIndex("byScopeBaseEntity", ["scopeKey", "baseEntityId"], { unique: false });
}

function validateEntity(scope: CalendarScope, record: CalendarEntityRecord): CalendarEntityRecord {
  if (!record || record.schemaVersion !== CALENDAR_CACHE_RECORD_SCHEMA_VERSION) throw new TypeError("Calendar entity schema version is invalid.");
  assertEntityType(record.entityType);
  if (!record.entity || typeof record.entity !== "object") throw new TypeError("Calendar entity is required.");
  if (record.entityType === "calendar") {
    const entity = normalizeDenCalendar(record.entity);
    if (!entity) throw new TypeError("Calendar entity payload is invalid.");
    if (entity.organizationId !== scope.organizationId || entity.ownerMemberId !== scope.memberId) {
      throw new TypeError("Calendar entity owner does not match the cache scope.");
    }
    return { schemaVersion: 1, entityType: "calendar", entity };
  }
  const event = normalizeDenCalendarSchedulingEvent(record.entity) ?? normalizeDenCalendarEvent(record.entity);
  if (!event) throw new TypeError("Calendar entity payload is invalid.");
  if (event.organizationId !== scope.organizationId || event.ownerMemberId !== scope.memberId) {
    throw new TypeError("Calendar entity owner does not match the cache scope.");
  }
  assertOpaqueId(event.calendarId, "Calendar event calendarId");
  const coverage = calendarCoverageDates(parseCalendarEventTime(event.time));
  return {
    schemaVersion: 1,
    entityType: "event",
    entity: clone(event),
    calendarId: event.calendarId,
    coverageStartDate: coverage.startDate.toString(),
    coverageEndDateExclusive: coverage.endDateExclusive.toString(),
  };
}

function validateTombstone(record: CalendarTombstoneRecord): CalendarTombstoneRecord {
  if (!record || record.schemaVersion !== 1) throw new TypeError("Calendar tombstone schema version is invalid.");
  assertEntityType(record.entityType);
  assertOpaqueId(record.id, "Calendar tombstone id");
  assertPositiveVersion(record.version, "Calendar tombstone version");
  assertInstant(record.deletedAt, "Calendar tombstone deletedAt");
  return { schemaVersion: 1, entityType: record.entityType, id: record.id, version: record.version, deletedAt: record.deletedAt };
}

function validateCoverage(record: CalendarCoverageRecord): CalendarCoverageRecord {
  if (!record || record.schemaVersion !== 1) throw new TypeError("Calendar coverage schema version is invalid.");
  validateCoverageInterval(record.startDate, record.endDateExclusive);
  return {
    schemaVersion: 1,
    startDate: record.startDate,
    endDateExclusive: record.endDateExclusive,
    calendarIds: normalizeCalendarIds(record.calendarIds),
    eventIds: normalizeEventIds(record.eventIds),
  };
}

function validateSync(record: CalendarSyncRecord): CalendarSyncRecord {
  if (!record || record.schemaVersion !== 1) throw new TypeError("Calendar sync schema version is invalid.");
  assertOpaqueId(record.cursor, "Calendar sync cursor");
  assertInstant(record.refreshedAt, "Calendar sync refreshedAt");
  return { schemaVersion: 1, cursor: record.cursor, refreshedAt: record.refreshedAt };
}

function validateDraft(input: CalendarDraftRecord | LegacyCalendarDraftRecord, allowLegacy = false): CalendarDraftRecord {
  if (!input || input.schemaVersion !== 2 && (!allowLegacy || input.schemaVersion !== 1)) throw new TypeError("Calendar draft schema version is invalid.");
  const record = input;
  assertOpaqueId(record.id, "Calendar draft id");
  assertEntityType(record.entityType);
  if (record.unsynced !== true) throw new TypeError("Calendar drafts must be marked unsynced.");
  let values = cloneChecked(record.values, "Calendar draft values");
  if (record.schemaVersion === 1) {
    if (record.entityType !== "event" || !values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length !== 1 || !("form" in values)) {
      throw new TypeError("Legacy calendar draft values are invalid.");
    }
    const form = normalizeCalendarEventDraftForm((values as { form: unknown }).form, 1);
    if (!form) throw new TypeError("Legacy calendar draft values are invalid.");
    values = { form };
  }
  if (record.operation === "create") {
    if (record.baseEntity !== null) throw new TypeError("Calendar create drafts must have a null base entity.");
    return { schemaVersion: 2, id: record.id, entityType: record.entityType, operation: "create", baseEntity: null, unsynced: true, values };
  }
  if (record.operation !== "edit" || !record.baseEntity) throw new TypeError("Calendar draft operation is invalid.");
  assertOpaqueId(record.baseEntity.id, "Calendar draft base entity id");
  assertPositiveVersion(record.baseEntity.version, "Calendar draft base entity version");
  return {
    schemaVersion: 2,
    id: record.id,
    entityType: record.entityType,
    operation: "edit",
    baseEntity: { id: record.baseEntity.id, version: record.baseEntity.version },
    unsynced: true,
    values,
  };
}

export class CalendarIndexedDbAdapter {
  private readonly factory: IDBFactory;
  private readonly keyRange: typeof IDBKeyRange;
  private database: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase> | null = null;
  private closing: Promise<void> | null = null;
  private activeOperations = 0;
  private operationIdleResolvers = new Set<() => void>();

  constructor(options: CalendarCacheOptions = {}) {
    const globalFactory = typeof globalThis.indexedDB === "undefined" ? null : globalThis.indexedDB;
    const globalKeyRange = typeof globalThis.IDBKeyRange === "undefined" ? null : globalThis.IDBKeyRange;
    const factory = options.indexedDB === undefined ? globalFactory : options.indexedDB;
    const keyRange = options.IDBKeyRange === undefined ? globalKeyRange : options.IDBKeyRange;
    if (!factory || !keyRange) throw new CalendarCacheUnavailableError();
    this.factory = factory;
    this.keyRange = keyRange;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return Promise.resolve(this.database);
    if (this.opening) return this.opening;

    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.factory.open(CALENDAR_CACHE_DB_NAME, CALENDAR_CACHE_DB_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      request.onupgradeneeded = (event) => {
        if (event.oldVersion === 0) createSchema(request.result);
      };
      request.onerror = () => {
        settled = true;
        reject(request.error ?? new CalendarCacheUnavailableError("Unable to open the calendar IndexedDB cache."));
      };
      request.onblocked = () => {
        settled = true;
        reject(new CalendarCacheUnavailableError("Opening the calendar IndexedDB cache was blocked."));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (settled) {
          database.close();
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (this.database === database) this.database = null;
        };
        database.addEventListener("close", () => {
          if (this.database === database) this.database = null;
        });
        this.database = database;
        resolve(database);
      };
    });
    this.opening = opening;
    void opening.then(
      () => {
        if (this.opening === opening) this.opening = null;
      },
      () => {
        if (this.opening === opening) this.opening = null;
      },
    );
    return opening;
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = (async () => {
      if (this.activeOperations > 0) {
        await new Promise<void>((resolve) => this.operationIdleResolvers.add(resolve));
      }
      this.database?.close();
      this.database = null;
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = null;
    }
  }

  async clearScope(scope: CalendarScope): Promise<void> {
    const scopeSnapshot = snapshotScope(scope);
    const closing = this.closing;
    if (closing) await closing;
    this.activeOperations += 1;
    try {
      const database = await this.open();
      const transaction = database.transaction([...CALENDAR_CACHE_STORES], "readwrite");
      const completion = transactionCompletion(transaction);
      const scopeKey = scopeKeyFor(scopeSnapshot);
      try {
        await Promise.all(CALENDAR_CACHE_STORES.map(async (storeName) => {
          const store = transaction.objectStore(storeName);
          const keys = await requestResult(store.index("byScope").getAllKeys(this.keyRange.only(scopeKey)));
          for (const key of keys) await requestResult(store.delete(key));
        }));
      } catch (error) {
        try { transaction.abort(); } catch { /* The transaction may already have failed. */ }
        await completion.catch(() => undefined);
        throw error;
      }
      await completion;
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.operationIdleResolvers) resolve();
        this.operationIdleResolvers.clear();
      }
    }
  }

  async ensureScopeCompatibility(scope: CalendarScope): Promise<CalendarScopeCompatibilityResult> {
    const scopeSnapshot = snapshotScope(scope);
    try {
      await this.transaction(scopeSnapshot, CALENDAR_CACHE_STORES, "readonly", async (transaction) => {
        await Promise.all([
          transaction.listEntities("calendar"),
          transaction.listEntities("event"),
          transaction.listTombstones(),
          transaction.listCoverage(),
          transaction.getSync(),
          transaction.listDrafts(),
        ]);
      });
      return "compatible";
    } catch (error) {
      if (!(error instanceof CalendarCacheCorruptRecordError)) throw error;
      await this.clearScope(scopeSnapshot);
      return "cleared-incompatible";
    }
  }

  async transaction<T>(
    scope: CalendarScope,
    stores: readonly CalendarCacheStoreName[],
    mode: IDBTransactionMode,
    action: (transaction: CalendarCacheTransaction) => T | Promise<T>,
  ): Promise<T> {
    const scopeSnapshot = snapshotScope(scope);
    const storeSnapshot = Object.freeze([...stores]) as readonly CalendarCacheStoreName[];
    const closing = this.closing;
    if (closing) await closing;
    this.activeOperations += 1;
    try {
      return await this.runTransaction(scopeSnapshot, storeSnapshot, mode, action);
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.operationIdleResolvers) resolve();
        this.operationIdleResolvers.clear();
      }
    }
  }

  private async runTransaction<T>(
    scope: CalendarScope,
    stores: readonly CalendarCacheStoreName[],
    mode: IDBTransactionMode,
    action: (transaction: CalendarCacheTransaction) => T | Promise<T>,
  ): Promise<T> {
    const scopeKey = scopeKeyFor(scope);
    if (!stores.length || new Set(stores).size !== stores.length || stores.some((store) => !CALENDAR_CACHE_STORES.includes(store))) {
      throw new TypeError("Calendar cache transaction requires distinct known stores.");
    }
    if (mode !== "readonly" && mode !== "readwrite") throw new TypeError("Calendar cache transaction mode must be readonly or readwrite.");
    const database = await this.open();
    const nativeTransaction = database.transaction([...stores], mode);
    const completion = transactionCompletion(nativeTransaction).then(
      () => ({ status: "complete" as const }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    let keepAlive = true;
    const keepAliveStore = nativeTransaction.objectStore(stores[0]);
    const ping = () => {
      if (!keepAlive) return;
      const request = keepAliveStore.count();
      request.onsuccess = ping;
      request.onerror = () => undefined;
    };
    ping();

    const requireStore = (store: CalendarCacheStoreName): IDBObjectStore => {
      if (!stores.includes(store)) throw new TypeError(`Calendar cache transaction does not include the ${store} store.`);
      return nativeTransaction.objectStore(store);
    };
    const requireWrite = (): void => {
      if (mode !== "readwrite") throw new TypeError("Calendar cache write requires a readwrite transaction.");
    };
    const decodeStored = <TRecord>(storeName: CalendarCacheStoreName, stored: StoredRecord, decode: (record: StoredRecord) => TRecord): TRecord => {
      const supportedSchema = storeName === "drafts" ? stored.schemaVersion === 1 || stored.schemaVersion === 2 : stored.schemaVersion === 1;
      if (!supportedSchema) throw new CalendarCacheCorruptRecordError(storeName);
      try {
        return decode(stored);
      } catch (error) {
        if (error instanceof CalendarCacheCorruptRecordError) throw error;
        throw new CalendarCacheCorruptRecordError(storeName);
      }
    };
    const readOne = async <TRecord>(storeName: CalendarCacheStoreName, key: readonly IDBValidKey[], decode: (stored: StoredRecord) => TRecord): Promise<TRecord | undefined> => {
      const stored = await requestResult(requireStore(storeName).get([...key])) as StoredRecord | undefined;
      if (stored === undefined) return undefined;
      if (!equalKey(stored.key, key) || stored.scopeKey !== scopeKey) throw new CalendarCacheCorruptRecordError(storeName);
      return clone(decodeStored(storeName, stored, decode));
    };
    const readMany = async <TRecord>(
      storeName: CalendarCacheStoreName,
      indexName: string,
      indexKey: IDBValidKey,
      decode: (stored: StoredRecord) => TRecord,
    ): Promise<TRecord[]> => {
      const stored = await requestResult(requireStore(storeName).index(indexName).getAll(this.keyRange.only(indexKey))) as StoredRecord[];
      return stored.map((item) => {
        if (item.scopeKey !== scopeKey || !Array.isArray(item.key) || item.key[0] !== scopeKey) {
          throw new CalendarCacheCorruptRecordError(storeName);
        }
        return clone(decodeStored(storeName, item, decode));
      });
    };

    const api: CalendarCacheTransaction = {
      getEntity: (entityType, id) => {
        assertEntityType(entityType);
        assertOpaqueId(id, "Calendar entity id");
        return readOne("entities", [scopeKey, entityType, id], (stored) => {
          if (stored.entityType !== entityType || (stored.entity as Calendar | CalendarEvent)?.id !== id) throw new CalendarCacheCorruptRecordError("entities");
          return validateEntity(scope, stored as unknown as CalendarEntityRecord);
        });
      },
      listEntities: (entityType) => {
        assertEntityType(entityType);
        return readMany("entities", "byScopeType", [scopeKey, entityType], (stored) => {
          const id = (stored.entity as Calendar | CalendarEvent)?.id;
          if (stored.entityType !== entityType || typeof id !== "string" || !equalKey(stored.key, [scopeKey, entityType, id])) {
            throw new CalendarCacheCorruptRecordError("entities");
          }
          return validateEntity(scope, stored as unknown as CalendarEntityRecord);
        });
      },
      putEntity: async (input) => {
        requireWrite();
        const record = validateEntity(scope, cloneChecked(input, "Calendar entity record"));
        const stored = { ...record, key: [scopeKey, record.entityType, record.entity.id], scopeKey, recordType: record.entityType };
        await requestResult(requireStore("entities").put(stored));
      },
      deleteEntity: async (entityType, id) => {
        requireWrite();
        assertEntityType(entityType);
        assertOpaqueId(id, "Calendar entity id");
        await requestResult(requireStore("entities").delete([scopeKey, entityType, id]));
      },
      getTombstone: (entityType, id) => {
        assertEntityType(entityType);
        assertOpaqueId(id, "Calendar tombstone id");
        return readOne("tombstones", [scopeKey, entityType, id], (stored) => {
          if (stored.entityType !== entityType || stored.id !== id) throw new CalendarCacheCorruptRecordError("tombstones");
          return validateTombstone(stored as unknown as CalendarTombstoneRecord);
        });
      },
      listTombstones: (entityType) => {
        if (entityType !== undefined) {
          assertEntityType(entityType);
          return readMany("tombstones", "byScopeType", [scopeKey, entityType], (stored) => {
            if (stored.entityType !== entityType || typeof stored.id !== "string" || !equalKey(stored.key, [scopeKey, entityType, stored.id])) {
              throw new CalendarCacheCorruptRecordError("tombstones");
            }
            return validateTombstone(stored as unknown as CalendarTombstoneRecord);
          });
        }
        return readMany("tombstones", "byScope", scopeKey, (stored) => {
          if ((stored.entityType !== "calendar" && stored.entityType !== "event") || typeof stored.id !== "string" || !equalKey(stored.key, [scopeKey, stored.entityType, stored.id])) {
            throw new CalendarCacheCorruptRecordError("tombstones");
          }
          return validateTombstone(stored as unknown as CalendarTombstoneRecord);
        });
      },
      putTombstone: async (input) => {
        requireWrite();
        const record = validateTombstone(input);
        const stored = { ...record, key: [scopeKey, record.entityType, record.id], scopeKey, recordType: record.entityType };
        await requestResult(requireStore("tombstones").put(stored));
      },
      deleteTombstone: async (entityType, id) => {
        requireWrite();
        assertEntityType(entityType);
        assertOpaqueId(id, "Calendar tombstone id");
        await requestResult(requireStore("tombstones").delete([scopeKey, entityType, id]));
      },
      getCoverage: (selector) => {
        const { startDate, endDateExclusive } = selector;
        validateCoverageInterval(startDate, endDateExclusive);
        const calendarIds = normalizeCalendarIds(selector.calendarIds);
        const filterKey = coverageFilterKey(calendarIds);
        return readOne("coverage", [scopeKey, filterKey, startDate, endDateExclusive], (stored) => {
          if (stored.filterKey !== filterKey || stored.startDate !== startDate || stored.endDateExclusive !== endDateExclusive) {
            throw new CalendarCacheCorruptRecordError("coverage");
          }
          const record = validateCoverage(stored as unknown as CalendarCoverageRecord);
          if (coverageFilterKey(record.calendarIds) !== filterKey || !equalKey(stored.key, [scopeKey, filterKey, record.startDate, record.endDateExclusive])) {
            throw new CalendarCacheCorruptRecordError("coverage");
          }
          return record;
        });
      },
      listCoverage: (calendarIds) => {
        if (calendarIds !== undefined) {
          const filterKey = coverageFilterKey(calendarIds);
          return readMany("coverage", "byScopeFilter", [scopeKey, filterKey], (stored) => {
            const record = validateCoverage(stored as unknown as CalendarCoverageRecord);
            if (stored.filterKey !== filterKey || coverageFilterKey(record.calendarIds) !== filterKey || !equalKey(stored.key, [scopeKey, filterKey, record.startDate, record.endDateExclusive])) {
              throw new CalendarCacheCorruptRecordError("coverage");
            }
            return record;
          });
        }
        return readMany("coverage", "byScope", scopeKey, (stored) => {
          const record = validateCoverage(stored as unknown as CalendarCoverageRecord);
          if (typeof stored.filterKey !== "string" || coverageFilterKey(record.calendarIds) !== stored.filterKey || !equalKey(stored.key, [scopeKey, stored.filterKey, record.startDate, record.endDateExclusive])) {
            throw new CalendarCacheCorruptRecordError("coverage");
          }
          return record;
        });
      },
      putCoverage: async (input) => {
        requireWrite();
        const record = validateCoverage(input);
        const filterKey = coverageFilterKey(record.calendarIds);
        const stored = { ...record, key: [scopeKey, filterKey, record.startDate, record.endDateExclusive], scopeKey, filterKey, recordType: "coverage" };
        await requestResult(requireStore("coverage").put(stored));
      },
      deleteCoverage: async (selector) => {
        requireWrite();
        validateCoverageInterval(selector.startDate, selector.endDateExclusive);
        const calendarIds = normalizeCalendarIds(selector.calendarIds);
        await requestResult(requireStore("coverage").delete([scopeKey, coverageFilterKey(calendarIds), selector.startDate, selector.endDateExclusive]));
      },
      getSync: () => readOne("sync", [scopeKey], (stored) => validateSync(stored as unknown as CalendarSyncRecord)),
      putSync: async (input) => {
        requireWrite();
        const record = validateSync(input);
        await requestResult(requireStore("sync").put({ ...record, key: [scopeKey], scopeKey, recordType: "sync" }));
      },
      deleteSync: async () => {
        requireWrite();
        await requestResult(requireStore("sync").delete([scopeKey]));
      },
      getDraft: (id) => {
        assertOpaqueId(id, "Calendar draft id");
        return readOne("drafts", [scopeKey, id], (stored) => {
          if (stored.id !== id) throw new CalendarCacheCorruptRecordError("drafts");
          return validateDraft(stored as unknown as CalendarDraftRecord | LegacyCalendarDraftRecord, true);
        });
      },
      listDrafts: (entityType) => {
        if (entityType !== undefined) {
          assertEntityType(entityType);
          return readMany("drafts", "byScopeType", [scopeKey, entityType], (stored) => {
            if (stored.entityType !== entityType || typeof stored.id !== "string" || !equalKey(stored.key, [scopeKey, stored.id])) {
              throw new CalendarCacheCorruptRecordError("drafts");
            }
            return validateDraft(stored as unknown as CalendarDraftRecord | LegacyCalendarDraftRecord, true);
          });
        }
        return readMany("drafts", "byScope", scopeKey, (stored) => {
          if (typeof stored.id !== "string" || !equalKey(stored.key, [scopeKey, stored.id])) throw new CalendarCacheCorruptRecordError("drafts");
          return validateDraft(stored as unknown as CalendarDraftRecord | LegacyCalendarDraftRecord, true);
        });
      },
      putDraft: async (input) => {
        requireWrite();
        const record = validateDraft(input);
        const baseEntityId = record.baseEntity?.id;
        const stored = { ...record, key: [scopeKey, record.id], scopeKey, recordType: "draft", ...(baseEntityId === undefined ? {} : { baseEntityId }) };
        await requestResult(requireStore("drafts").put(stored));
      },
      deleteDraft: async (id) => {
        requireWrite();
        assertOpaqueId(id, "Calendar draft id");
        await requestResult(requireStore("drafts").delete([scopeKey, id]));
      },
    };

    const actionResult = Promise.resolve().then(() => action(api)).then(
      (value) => ({ status: "complete" as const, value }),
      (error: unknown) => ({ status: "failed" as const, error }),
    );
    const first = await Promise.race([
      actionResult.then((outcome) => ({ source: "action" as const, outcome })),
      completion.then((outcome) => ({ source: "transaction" as const, outcome })),
    ]);

    if (first.source === "transaction") {
      keepAlive = false;
      if (first.outcome.status === "failed") throw first.outcome.error;
      const outcome = await actionResult;
      if (outcome.status === "failed") throw outcome.error;
      return outcome.value;
    }

    if (first.outcome.status === "failed") {
      keepAlive = false;
      try {
        nativeTransaction.abort();
      } catch {
        // The transaction may already have failed or completed.
      }
      await completion;
      throw first.outcome.error;
    }

    keepAlive = false;
    const transactionResult = await completion;
    if (transactionResult.status === "failed") throw transactionResult.error;
    return first.outcome.value;
  }

  getEntity(scope: CalendarScope, entityType: CalendarEntityType, id: string) {
    return this.transaction(scope, ["entities"], "readonly", (transaction) => transaction.getEntity(entityType, id));
  }

  listEntities(scope: CalendarScope, entityType: CalendarEntityType) {
    return this.transaction(scope, ["entities"], "readonly", (transaction) => transaction.listEntities(entityType));
  }

  putEntity(scope: CalendarScope, record: CalendarEntityRecord) {
    const snapshot = cloneChecked(record, "Calendar entity record");
    return this.transaction(scope, ["entities"], "readwrite", (transaction) => transaction.putEntity(snapshot));
  }

  deleteEntity(scope: CalendarScope, entityType: CalendarEntityType, id: string) {
    return this.transaction(scope, ["entities"], "readwrite", (transaction) => transaction.deleteEntity(entityType, id));
  }

  getTombstone(scope: CalendarScope, entityType: CalendarEntityType, id: string) {
    return this.transaction(scope, ["tombstones"], "readonly", (transaction) => transaction.getTombstone(entityType, id));
  }

  listTombstones(scope: CalendarScope, entityType?: CalendarEntityType) {
    return this.transaction(scope, ["tombstones"], "readonly", (transaction) => transaction.listTombstones(entityType));
  }

  putTombstone(scope: CalendarScope, record: CalendarTombstoneRecord) {
    const snapshot = cloneChecked(record, "Calendar tombstone record");
    return this.transaction(scope, ["tombstones"], "readwrite", (transaction) => transaction.putTombstone(snapshot));
  }

  deleteTombstone(scope: CalendarScope, entityType: CalendarEntityType, id: string) {
    return this.transaction(scope, ["tombstones"], "readwrite", (transaction) => transaction.deleteTombstone(entityType, id));
  }

  getCoverage(scope: CalendarScope, selector: CalendarCoverageSelector) {
    const snapshot = cloneChecked(selector, "Calendar coverage selector");
    return this.transaction(scope, ["coverage"], "readonly", (transaction) => transaction.getCoverage(snapshot));
  }

  listCoverage(scope: CalendarScope, calendarIds?: readonly string[]) {
    const snapshot = calendarIds === undefined ? undefined : cloneChecked(calendarIds, "Calendar coverage calendarIds");
    return this.transaction(scope, ["coverage"], "readonly", (transaction) => transaction.listCoverage(snapshot));
  }

  putCoverage(scope: CalendarScope, record: CalendarCoverageRecord) {
    const snapshot = cloneChecked(record, "Calendar coverage record");
    return this.transaction(scope, ["coverage"], "readwrite", (transaction) => transaction.putCoverage(snapshot));
  }

  deleteCoverage(scope: CalendarScope, selector: CalendarCoverageSelector) {
    const snapshot = cloneChecked(selector, "Calendar coverage selector");
    return this.transaction(scope, ["coverage"], "readwrite", (transaction) => transaction.deleteCoverage(snapshot));
  }

  getSync(scope: CalendarScope) {
    return this.transaction(scope, ["sync"], "readonly", (transaction) => transaction.getSync());
  }

  putSync(scope: CalendarScope, record: CalendarSyncRecord) {
    const snapshot = cloneChecked(record, "Calendar sync record");
    return this.transaction(scope, ["sync"], "readwrite", (transaction) => transaction.putSync(snapshot));
  }

  deleteSync(scope: CalendarScope) {
    return this.transaction(scope, ["sync"], "readwrite", (transaction) => transaction.deleteSync());
  }

  getDraft(scope: CalendarScope, id: string) {
    return this.transaction(scope, ["drafts"], "readonly", (transaction) => transaction.getDraft(id));
  }

  listDrafts(scope: CalendarScope, entityType?: CalendarEntityType) {
    return this.transaction(scope, ["drafts"], "readonly", (transaction) => transaction.listDrafts(entityType));
  }

  putDraft(scope: CalendarScope, record: CalendarDraftRecord) {
    const snapshot = cloneChecked(record, "Calendar draft record");
    return this.transaction(scope, ["drafts"], "readwrite", (transaction) => transaction.putDraft(snapshot));
  }

  deleteDraft(scope: CalendarScope, id: string) {
    return this.transaction(scope, ["drafts"], "readwrite", (transaction) => transaction.deleteDraft(id));
  }
}

export { CalendarIndexedDbAdapter as CalendarCacheAdapter };

import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import {
  CALENDAR_CACHE_DB_NAME,
  CALENDAR_CACHE_DB_VERSION,
  CALENDAR_CACHE_STORES,
  CalendarCacheUnavailableError,
  CalendarIndexedDbAdapter,
  type CalendarCoverageRecord,
  type CalendarDraftRecord,
  type CalendarEntityRecord,
  type CalendarSyncRecord,
  type CalendarTombstoneRecord,
} from "../src/react-app/domains/calendar/calendar-cache";
import { calendarScopeKey, createCalendarScope, type CalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

const scope = createCalendarScope({
  deploymentBaseUrl: "https://den.example/api",
  organizationId: "org-a",
  memberId: "member-a",
})!;

function adapter(factory = new IDBFactory()) {
  return new CalendarIndexedDbAdapter({ indexedDB: factory, IDBKeyRange });
}

function calendarRecord(currentScope: CalendarScope = scope, id = "calendar-a", name = "Work"): CalendarEntityRecord {
  return {
    schemaVersion: 1,
    entityType: "calendar",
    entity: {
      id,
      organizationId: currentScope.organizationId,
      ownerMemberId: currentScope.memberId,
      name,
      color: "#123456",
      isDefault: false,
      version: 1,
      createdAt: "2026-11-05T01:00:00Z",
      updatedAt: "2026-11-05T01:00:00Z",
    },
  };
}

function eventRecord(currentScope: CalendarScope = scope, id = "event-a"): CalendarEntityRecord {
  return {
    schemaVersion: 1,
    entityType: "event",
    entity: {
      id,
      organizationId: currentScope.organizationId,
      ownerMemberId: currentScope.memberId,
      calendarId: "calendar-a",
      title: "Review",
      description: "Quarterly review",
      time: {
        kind: "timed",
        startInstant: "2026-11-05T15:00:00Z",
        endInstantExclusive: "2026-11-06T17:00:00Z",
        timeZone: "Asia/Shanghai",
      },
      version: 2,
      createdAt: "2026-11-05T01:00:00Z",
      updatedAt: "2026-11-05T02:00:00Z",
    },
    calendarId: "ignored-input-projection",
    coverageStartDate: "2000-01-01",
    coverageEndDateExclusive: "2000-01-02",
  };
}

const tombstone: CalendarTombstoneRecord = {
  schemaVersion: 1,
  entityType: "event",
  id: "event-deleted",
  version: 3,
  deletedAt: "2026-11-05T03:00:00Z",
};

const coverage: CalendarCoverageRecord = {
  schemaVersion: 1,
  startDate: "2026-11-01",
  endDateExclusive: "2026-12-01",
  calendarIds: ["z", " a", "z"],
  eventIds: ["event-z", "event-a", "event-z"],
};

const sync: CalendarSyncRecord = {
  schemaVersion: 1,
  cursor: "opaque|cursor::one",
  refreshedAt: "2026-11-05T04:00:00Z",
};

const draft: CalendarDraftRecord = {
  schemaVersion: 1,
  id: "draft-a",
  entityType: "event",
  operation: "edit",
  baseEntity: { id: "event-a", version: 2 },
  unsynced: true,
  values: { title: "Local title", nested: ["cloneable"] },
};

function openDatabase(factory: IDBFactory, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? factory.open(CALENDAR_CACHE_DB_NAME) : factory.open(CALENDAR_CACHE_DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("IndexedDB open was blocked"));
  });
}

describe("calendar IndexedDB cache", () => {
  test("uses the stable versioned schema and required indexes", async () => {
    const factory = new IDBFactory();
    const cache = adapter(factory);
    await cache.putSync(scope, sync);
    const database = await openDatabase(factory);
    expect(database.name).toBe(CALENDAR_CACHE_DB_NAME);
    expect(database.version).toBe(CALENDAR_CACHE_DB_VERSION);
    expect([...database.objectStoreNames]).toEqual([...CALENDAR_CACHE_STORES].sort());

    const transaction = database.transaction([...CALENDAR_CACHE_STORES], "readonly");
    for (const storeName of CALENDAR_CACHE_STORES) {
      const store = transaction.objectStore(storeName);
      expect(store.keyPath).toBe("key");
      const indexes = [...store.indexNames];
      expect(indexes).toContain("byScope");
      expect(indexes).toContain("byScopeType");
      expect(store.index("byScope").keyPath).toBe("scopeKey");
      expect(store.index("byScope").unique).toBe(false);
      expect(store.index("byScope").multiEntry).toBe(false);
      expect(store.index("byScopeType").keyPath).toEqual(["scopeKey", storeName === "coverage" || storeName === "sync" ? "recordType" : "entityType"]);
      expect(store.index("byScopeType").unique).toBe(false);
      expect(store.index("byScopeType").multiEntry).toBe(false);
    }
    expect(transaction.objectStore("coverage").index("byScopeFilter").keyPath).toEqual(["scopeKey", "filterKey"]);
    expect(transaction.objectStore("drafts").index("byScopeBaseEntity").keyPath).toEqual(["scopeKey", "baseEntityId"]);
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = transaction.objectStore("sync").get([JSON.stringify(calendarScopeKey(scope))]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(stored.schemaVersion).toBe(1);
    expect(stored.scopeKey).toBe(JSON.stringify(calendarScopeKey(scope)));
    expect(stored.key).toEqual([JSON.stringify(calendarScopeKey(scope))]);
    database.close();
    await cache.close();
  });

  test("fails clearly without IndexedDB dependencies and rejects incomplete scopes", async () => {
    expect(() => new CalendarIndexedDbAdapter({ indexedDB: null, IDBKeyRange: null })).toThrow(CalendarCacheUnavailableError);
    const cache = adapter();
    await expect(cache.getSync(null as unknown as CalendarScope)).rejects.toThrow(/complete scope/);
    await expect(cache.getSync({ deployment: "https://den.example", organizationId: " ", memberId: "member" })).rejects.toThrow(/deployment, organizationId, and memberId/);
  });

  test("round-trips and deletes Calendar and Event entities with derived event projection", async () => {
    const cache = adapter();
    await cache.putEntity(scope, calendarRecord());
    await cache.putEntity(scope, eventRecord());
    expect((await cache.getEntity(scope, "calendar", "calendar-a"))?.entity).toEqual(calendarRecord().entity);
    const event = await cache.getEntity(scope, "event", "event-a");
    expect(event).toMatchObject({
      entityType: "event",
      calendarId: "calendar-a",
      coverageStartDate: "2026-11-05",
      coverageEndDateExclusive: "2026-11-08",
    });
    expect(await cache.listEntities(scope, "calendar")).toHaveLength(1);
    expect(await cache.listEntities(scope, "event")).toHaveLength(1);
    await cache.deleteEntity(scope, "calendar", "calendar-a");
    await cache.deleteEntity(scope, "event", "event-a");
    expect(await cache.listEntities(scope, "calendar")).toEqual([]);
    expect(await cache.listEntities(scope, "event")).toEqual([]);
  });

  test("round-trips and deletes tombstones", async () => {
    const cache = adapter();
    await cache.putTombstone(scope, tombstone);
    expect(await cache.getTombstone(scope, "event", tombstone.id)).toEqual(tombstone);
    expect(await cache.listTombstones(scope, "event")).toEqual([tombstone]);
    expect(await cache.listTombstones(scope)).toEqual([tombstone]);
    await cache.deleteTombstone(scope, "event", tombstone.id);
    expect(await cache.getTombstone(scope, "event", tombstone.id)).toBeUndefined();
  });

  test("round-trips coverage with opaque, deduplicated, sorted filter IDs", async () => {
    const cache = adapter();
    await cache.putCoverage(scope, coverage);
    const normalized = { ...coverage, calendarIds: [" a", "z"], eventIds: ["event-a", "event-z"] };
    expect(await cache.getCoverage(scope, { ...coverage, calendarIds: ["z", " a"] })).toEqual(normalized);
    expect(await cache.listCoverage(scope, [" a", "z"])).toEqual([normalized]);
    expect(await cache.listCoverage(scope)).toEqual([normalized]);
    await cache.deleteCoverage(scope, { ...coverage, calendarIds: ["z", " a"] });
    expect(await cache.listCoverage(scope)).toEqual([]);
    await expect(cache.putCoverage(scope, { ...coverage, startDate: "2026-11-1" })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(cache.putCoverage(scope, { ...coverage, endDateExclusive: coverage.startDate })).rejects.toThrow();
    await expect(cache.putCoverage(scope, { ...coverage, calendarIds: [""] })).rejects.toThrow(/non-empty/);
    await expect(cache.putCoverage(scope, { ...coverage, eventIds: [""] })).rejects.toThrow(/non-empty/);
  });

  test("round-trips the single sync record per scope", async () => {
    const cache = adapter();
    await cache.putSync(scope, sync);
    expect(await cache.getSync(scope)).toEqual(sync);
    const newer = { ...sync, cursor: "cursor-two", refreshedAt: "2026-11-05T05:00:00Z" };
    await cache.putSync(scope, newer);
    expect(await cache.getSync(scope)).toEqual(newer);
    await cache.deleteSync(scope);
    expect(await cache.getSync(scope)).toBeUndefined();
    await expect(cache.putSync(scope, { ...sync, cursor: "" })).rejects.toThrow(/non-empty/);
  });

  test("round-trips separate create/edit drafts and returns cloned DTOs", async () => {
    const cache = adapter();
    const createDraft: CalendarDraftRecord = {
      schemaVersion: 1,
      id: "draft-create",
      entityType: "calendar",
      operation: "create",
      baseEntity: null,
      unsynced: true,
      values: { name: "Personal" },
    };
    await cache.putDraft(scope, draft);
    await cache.putDraft(scope, createDraft);
    const read = await cache.getDraft(scope, draft.id);
    expect(read).toEqual(draft);
    (read!.values as { title: string }).title = "mutated";
    expect(await cache.getDraft(scope, draft.id)).toEqual(draft);
    expect(await cache.listDrafts(scope, "event")).toEqual([draft]);
    expect(await cache.listDrafts(scope)).toEqual(expect.arrayContaining([draft, createDraft]));
    await cache.deleteDraft(scope, draft.id);
    expect(await cache.getDraft(scope, draft.id)).toBeUndefined();
    await expect(cache.putDraft(scope, { ...draft, unsynced: false } as unknown as CalendarDraftRecord)).rejects.toThrow(/unsynced/);
  });

  test("persists across close/reopen in one profile and isolates different factories", async () => {
    const factory = new IDBFactory();
    const first = adapter(factory);
    await first.putEntity(scope, calendarRecord());
    await first.close();
    const reopened = adapter(factory);
    expect(await reopened.getEntity(scope, "calendar", "calendar-a")).toBeDefined();
    await reopened.close();
    expect(await reopened.getEntity(scope, "calendar", "calendar-a")).toBeDefined();
    expect(await adapter(new IDBFactory()).getEntity(scope, "calendar", "calendar-a")).toBeUndefined();
  });

  test("isolates identical IDs across deployment host, path, organization, and member", async () => {
    const cache = adapter();
    const scopes = [
      scope,
      createCalendarScope({ deploymentBaseUrl: "https://other.example/api", organizationId: "org-a", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://den.example/other", organizationId: "org-a", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-b", memberId: "member-a" })!,
      createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-b" })!,
    ];
    for (const [index, currentScope] of scopes.entries()) {
      await cache.putEntity(currentScope, calendarRecord(currentScope, "shared-id", `scope-${index}`));
    }
    for (const [index, currentScope] of scopes.entries()) {
      const result = await cache.getEntity(currentScope, "calendar", "shared-id");
      expect(result?.entity.name).toBe(`scope-${index}`);
      expect(await cache.listEntities(currentScope, "calendar")).toHaveLength(1);
    }
    await cache.deleteEntity(scopes[0], "calendar", "shared-id");
    expect(await cache.getEntity(scopes[0], "calendar", "shared-id")).toBeUndefined();
    for (const currentScope of scopes.slice(1)) expect(await cache.getEntity(currentScope, "calendar", "shared-id")).toBeDefined();
  });

  test("keeps all five record classes isolated during scoped reads, lists, and deletes", async () => {
    const cache = adapter();
    const otherScope = createCalendarScope({ deploymentBaseUrl: scope.deployment, organizationId: scope.organizationId, memberId: "member-b" })!;
    for (const currentScope of [scope, otherScope]) {
      await cache.putEntity(currentScope, calendarRecord(currentScope));
      await cache.putTombstone(currentScope, tombstone);
      await cache.putCoverage(currentScope, coverage);
      await cache.putSync(currentScope, sync);
      await cache.putDraft(currentScope, draft);
    }
    await cache.deleteEntity(scope, "calendar", "calendar-a");
    await cache.deleteTombstone(scope, "event", tombstone.id);
    await cache.deleteCoverage(scope, coverage);
    await cache.deleteSync(scope);
    await cache.deleteDraft(scope, draft.id);
    expect(await cache.listEntities(scope, "calendar")).toEqual([]);
    expect(await cache.listTombstones(scope)).toEqual([]);
    expect(await cache.listCoverage(scope)).toEqual([]);
    expect(await cache.getSync(scope)).toBeUndefined();
    expect(await cache.listDrafts(scope)).toEqual([]);
    expect(await cache.listEntities(otherScope, "calendar")).toHaveLength(1);
    expect(await cache.listTombstones(otherScope)).toHaveLength(1);
    expect(await cache.listCoverage(otherScope)).toHaveLength(1);
    expect(await cache.getSync(otherScope)).toEqual(sync);
    expect(await cache.listDrafts(otherScope)).toHaveLength(1);
  });

  test("clears every record class only for the requested scope", async () => {
    const current = adapter();
    const otherScope = createCalendarScope({ deploymentBaseUrl: scope.deployment, organizationId: "org-b", memberId: scope.memberId })!;
    for (const currentScope of [scope, otherScope]) {
      await current.putEntity(currentScope, calendarRecord(currentScope));
      await current.putTombstone(currentScope, tombstone);
      await current.putCoverage(currentScope, coverage);
      await current.putSync(currentScope, sync);
      await current.putDraft(currentScope, draft);
    }
    await current.clearScope(scope);
    expect(await current.listEntities(scope, "calendar")).toEqual([]);
    expect(await current.listTombstones(scope)).toEqual([]);
    expect(await current.listCoverage(scope)).toEqual([]);
    expect(await current.getSync(scope)).toBeUndefined();
    expect(await current.listDrafts(scope)).toEqual([]);
    expect(await current.listEntities(otherScope, "calendar")).toHaveLength(1);
    expect(await current.listTombstones(otherScope)).toHaveLength(1);
    expect(await current.listCoverage(otherScope)).toHaveLength(1);
    expect(await current.getSync(otherScope)).toEqual(sync);
    expect(await current.listDrafts(otherScope)).toHaveLength(1);
  });

  test("rebuilds only an incompatible scope and preserves compatible identities", async () => {
    const factory = new IDBFactory();
    const current = adapter(factory);
    const otherScope = createCalendarScope({ deploymentBaseUrl: "https://other.example/api", organizationId: scope.organizationId, memberId: scope.memberId })!;
    await current.putSync(scope, sync);
    await current.putDraft(scope, draft);
    await current.putSync(otherScope, sync);
    await current.putDraft(otherScope, draft);
    await current.close();

    const database = await openDatabase(factory);
    const transaction = database.transaction("sync", "readwrite");
    const targetScopeKey = JSON.stringify(calendarScopeKey(scope));
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = transaction.objectStore("sync").get([targetScopeKey]);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const request = transaction.objectStore("sync").put({ ...stored, schemaVersion: 999 });
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    database.close();

    const reopened = adapter(factory);
    expect(await reopened.ensureScopeCompatibility(scope)).toBe("cleared-incompatible");
    expect(await reopened.getSync(scope)).toBeUndefined();
    expect(await reopened.listDrafts(scope)).toEqual([]);
    expect(await reopened.ensureScopeCompatibility(otherScope)).toBe("compatible");
    expect(await reopened.getSync(otherScope)).toEqual(sync);
    expect(await reopened.listDrafts(otherScope)).toEqual([draft]);
  });

  test("rejects owner and organization mismatches without writing", async () => {
    const cache = adapter();
    const wrongOrganization = calendarRecord();
    wrongOrganization.entity.organizationId = "org-b";
    await expect(cache.putEntity(scope, wrongOrganization)).rejects.toThrow(/owner/);
    const wrongOwner = calendarRecord();
    wrongOwner.entity.ownerMemberId = "member-b";
    await expect(cache.putEntity(scope, wrongOwner)).rejects.toThrow(/owner/);
    expect(await cache.listEntities(scope, "calendar")).toEqual([]);
  });

  test("rejects malformed or extended entity payloads", async () => {
    const cache = adapter();
    const malformedCalendar = calendarRecord();
    malformedCalendar.entity.name = 42 as unknown as string;
    await expect(cache.putEntity(scope, malformedCalendar)).rejects.toThrow(/payload is invalid/);
    const extendedEvent = eventRecord();
    (extendedEvent.entity as CalendarEntityRecord["entity"] & { secret?: string }).secret = "must-not-persist";
    await expect(cache.putEntity(scope, extendedEvent)).rejects.toThrow(/payload is invalid/);
    expect(await cache.listEntities(scope, "calendar")).toEqual([]);
    expect(await cache.listEntities(scope, "event")).toEqual([]);
  });

  test("snapshots mutable scope and entity inputs before asynchronous work", async () => {
    const cache = adapter();
    let organizationReads = 0;
    const mutableScope = {
      deployment: scope.deployment,
      get organizationId() {
        organizationReads += 1;
        return organizationReads === 1 ? scope.organizationId : "org-b";
      },
      memberId: scope.memberId,
    } as CalendarScope;
    const record = calendarRecord();
    const write = cache.putEntity(mutableScope, record);
    record.entity.name = "changed-after-call";
    await write;
    expect(organizationReads).toBe(1);
    expect((await cache.getEntity(scope, "calendar", "calendar-a"))?.entity.name).toBe("Work");
  });

  test("snapshots all composite public inputs before asynchronous work", async () => {
    const current = adapter();
    const syncInput = { ...sync };
    const coverageInput = structuredClone(coverage);
    const draftInput = structuredClone(draft);
    const syncWrite = current.putSync(scope, syncInput);
    const coverageWrite = current.putCoverage(scope, coverageInput);
    const draftWrite = current.putDraft(scope, draftInput);
    syncInput.cursor = "mutated";
    coverageInput.eventIds.push("mutated");
    (draftInput.values as { title: string }).title = "mutated";
    await Promise.all([syncWrite, coverageWrite, draftWrite]);
    expect((await current.getSync(scope))?.cursor).toBe(sync.cursor);
    expect((await current.getCoverage(scope, coverage))?.eventIds).toEqual(["event-a", "event-z"]);
    expect(await current.getDraft(scope, draft.id)).toEqual(draft);
  });

  test("waits for operations that started before close and then reopens safely", async () => {
    const current = adapter();
    await current.putSync(scope, sync);
    const read = current.transaction(scope, ["sync"], "readonly", async (transaction) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return transaction.getSync();
    });
    const closing = current.close();
    expect(await read).toEqual(sync);
    await closing;
    expect(await current.getSync(scope)).toEqual(sync);
  });

  test("snapshots scope and stores before waiting for an in-progress close", async () => {
    const current = adapter();
    await current.putSync(scope, sync);
    let release!: () => void;
    const blocker = current.transaction(scope, ["sync"], "readonly", async (transaction) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return transaction.getSync();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const closing = current.close();
    const mutableScope = { ...scope };
    const mutableStores: ("sync" | "drafts")[] = ["sync"];
    const queued = current.transaction(mutableScope, mutableStores, "readonly", (transaction) => transaction.getSync());
    mutableScope.organizationId = "org-b";
    mutableStores[0] = "drafts";
    release();
    await blocker;
    await closing;
    expect(await queued).toEqual(sync);
  });

  test("snapshots a transaction coverage selector before the request settles", async () => {
    const current = adapter();
    await current.putCoverage(scope, coverage);
    await current.transaction(scope, ["coverage"], "readonly", async (transaction) => {
      const selector = { startDate: coverage.startDate, endDateExclusive: coverage.endDateExclusive, calendarIds: [...coverage.calendarIds] };
      const read = transaction.getCoverage(selector);
      selector.startDate = "2026-10-01";
      selector.calendarIds.push("mutated");
      expect(await read).toEqual({ ...coverage, calendarIds: [" a", "z"], eventIds: ["event-a", "event-z"] });
    });
  });

  test("does not collide opaque IDs containing separators", async () => {
    const cache = adapter();
    const ids = ["a|b", "a::b", "a,b", '["a","b"]', " a "];
    for (const id of ids) await cache.putEntity(scope, calendarRecord(scope, id, id));
    expect((await cache.listEntities(scope, "calendar")).map((record) => record.entity.id).sort()).toEqual([...ids].sort());
    for (const id of ids) expect((await cache.getEntity(scope, "calendar", id))?.entity.name).toBe(id);
  });

  test("fails closed when a stored tuple claims another scope", async () => {
    const factory = new IDBFactory();
    const cache = adapter(factory);
    await cache.putEntity(scope, calendarRecord());
    const database = await openDatabase(factory);
    const transaction = database.transaction("entities", "readwrite");
    const store = transaction.objectStore("entities");
    const key = [JSON.stringify(calendarScopeKey(scope)), "calendar", "calendar-a"];
    const stored = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    stored.scopeKey = JSON.stringify([scope.deployment, scope.organizationId, "member-b"]);
    await new Promise<void>((resolve, reject) => {
      const request = store.put(stored);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    database.close();
    await expect(cache.getEntity(scope, "calendar", "calendar-a")).rejects.toThrow(/invalid entities record/);
  });

  test("aborts all stores when a scoped transaction callback throws", async () => {
    const cache = adapter();
    await expect(cache.transaction(scope, ["entities", "sync"], "readwrite", async (transaction) => {
      await transaction.putEntity(calendarRecord());
      await new Promise((resolve) => setTimeout(resolve, 0));
      await transaction.putSync(sync);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect(await cache.getEntity(scope, "calendar", "calendar-a")).toBeUndefined();
    expect(await cache.getSync(scope)).toBeUndefined();
  });

  test("closes its cached connection on versionchange without blocking an upgrade", async () => {
    const factory = new IDBFactory();
    const cache = adapter(factory);
    await cache.putSync(scope, sync);
    const upgraded = await openDatabase(factory, CALENDAR_CACHE_DB_VERSION + 1);
    expect(upgraded.version).toBe(CALENDAR_CACHE_DB_VERSION + 1);
    upgraded.close();
  });
});

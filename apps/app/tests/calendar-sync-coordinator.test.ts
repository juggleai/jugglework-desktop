import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { DenApiError, type DenCalendarBootstrap, type DenCalendarChangePage } from "../src/app/lib/den";
import { CalendarIndexedDbAdapter } from "../src/react-app/domains/calendar/calendar-cache";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";
import { CalendarChangesPaginationError, createCalendarSyncCoordinator } from "../src/react-app/domains/calendar/calendar-sync-coordinator";
import { CalendarScopeStaleError } from "../src/react-app/domains/calendar/calendar-scope-lifecycle";

const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
const range = { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: [] as string[] };
const baseline: DenCalendarBootstrap = { calendars: [], events: [], coverage: range, cursor: "bootstrap-cursor" };

function cache() { return new CalendarIndexedDbAdapter({ indexedDB: new IDBFactory(), IDBKeyRange }); }

describe("calendar sync coordinator", () => {
  test("bootstraps when no cursor exists", async () => {
    const current = cache();
    let bootstrapCalls = 0;
    const coordinator = createCalendarSyncCoordinator({
      scope, cache: current, bootstrapRange: range, now: () => "2026-11-01T00:00:00Z",
      client: { getCalendarBootstrap: async () => { bootstrapCalls += 1; return baseline; }, getCalendarChanges: async () => { throw new Error("unexpected"); } },
    });
    expect(await coordinator.trigger("foreground")).toEqual({ mode: "bootstrap", pages: 0, applied: 0, ignored: 0, cursor: "bootstrap-cursor", triggers: ["foreground"] });
    expect(bootstrapCalls).toBe(1);
  });

  test("applies multiple change pages in cursor order", async () => {
    const current = cache();
    await current.putSync(scope, { schemaVersion: 1, cursor: "c0", refreshedAt: "2026-11-01T00:00:00Z" });
    const requested: string[] = [];
    const pages: Record<string, DenCalendarChangePage> = { c0: { items: [], nextCursor: "c1", hasMore: true }, c1: { items: [], nextCursor: "c2", hasMore: false } };
    const coordinator = createCalendarSyncCoordinator({ scope, cache: current, bootstrapRange: range, now: () => "2026-11-02T00:00:00Z", client: {
      getCalendarBootstrap: async () => baseline,
      getCalendarChanges: async (_org, cursor) => { requested.push(cursor); return pages[cursor]; },
    } });
    expect((await coordinator.trigger("online")).cursor).toBe("c2");
    expect(requested).toEqual(["c0", "c1"]);
  });

  test("invalidates coverage and bootstraps after a resync response", async () => {
    const current = cache();
    await current.putSync(scope, { schemaVersion: 1, cursor: "expired", refreshedAt: "2026-11-01T00:00:00Z" });
    await current.putCoverage(scope, { schemaVersion: 1, ...range, eventIds: [] });
    const coordinator = createCalendarSyncCoordinator({ scope, cache: current, bootstrapRange: range, now: () => "2026-11-02T00:00:00Z", client: {
      getCalendarChanges: async () => { throw new DenApiError(409, "calendar_cursor_resync_required", "expired", { reason: "expired" }); },
      getCalendarBootstrap: async () => baseline,
    } });
    expect((await coordinator.trigger("manual")).mode).toBe("resync-bootstrap");
    expect((await current.getSync(scope))?.cursor).toBe("bootstrap-cursor");
  });

  test("fails closed on a cursor cycle", async () => {
    const current = cache();
    await current.putSync(scope, { schemaVersion: 1, cursor: "c0", refreshedAt: "2026-11-01T00:00:00Z" });
    const coordinator = createCalendarSyncCoordinator({ scope, cache: current, bootstrapRange: range, now: () => "2026-11-02T00:00:00Z", client: {
      getCalendarBootstrap: async () => baseline,
      getCalendarChanges: async (_org, cursor) => cursor === "c0" ? { items: [], nextCursor: "c1", hasMore: true } : { items: [], nextCursor: "c0", hasMore: true },
    } });
    await expect(coordinator.trigger("foreground")).rejects.toBeInstanceOf(CalendarChangesPaginationError);
    expect((await current.getSync(scope))?.cursor).toBe("c1");
  });

  test("coalesces concurrent triggers and runs one trailing sync", async () => {
    const current = cache();
    await current.putSync(scope, { schemaVersion: 1, cursor: "c0", refreshedAt: "2026-11-01T00:00:00Z" });
    let release!: () => void;
    let calls = 0;
    const coordinator = createCalendarSyncCoordinator({ scope, cache: current, bootstrapRange: range, now: () => "2026-11-02T00:00:00Z", client: {
      getCalendarBootstrap: async () => baseline,
      getCalendarChanges: async (_org, cursor) => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => { release = resolve; });
        return { items: [], nextCursor: `${cursor}-next`, hasMore: false };
      },
    } });
    const first = coordinator.trigger("foreground");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = coordinator.trigger("mutation");
    coordinator.trigger("online");
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(2);
    expect(coordinator.getState()).toBe("idle");
  });

  test("cancels the active generation and drops a late response from a client that ignores abort", async () => {
    const current = cache();
    await current.putSync(scope, { schemaVersion: 1, cursor: "c0", refreshedAt: "2026-11-01T00:00:00Z" });
    let release!: (page: DenCalendarChangePage) => void;
    let seenSignal: AbortSignal | undefined;
    const coordinator = createCalendarSyncCoordinator({ scope, cache: current, bootstrapRange: range, now: () => "2026-11-02T00:00:00Z", client: {
      getCalendarBootstrap: async () => baseline,
      getCalendarChanges: async (_org, _cursor, options) => {
        seenSignal = options.signal;
        return new Promise<DenCalendarChangePage>((resolve) => { release = resolve; });
      },
    } });
    const active = coordinator.trigger("foreground");
    await new Promise((resolve) => setTimeout(resolve, 0));
    coordinator.cancel();
    expect(coordinator.getState()).toBe("cancelled");
    expect(seenSignal?.aborted).toBe(true);
    release({ items: [], nextCursor: "c1", hasMore: false });
    await expect(active).rejects.toBeInstanceOf(CalendarScopeStaleError);
    expect((await current.getSync(scope))?.cursor).toBe("c0");
    await expect(coordinator.trigger("online")).rejects.toBeInstanceOf(CalendarScopeStaleError);
  });
});

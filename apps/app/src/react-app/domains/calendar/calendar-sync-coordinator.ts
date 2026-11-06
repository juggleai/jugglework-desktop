import { DenApiError, type DenCalendarBootstrap, type DenCalendarChangePage, type DenClient } from "@/app/lib/den";

import { persistCalendarBootstrapBaseline } from "./calendar-cache-baseline";
import { applyCalendarChangePage } from "./calendar-cache-changes";
import type { CalendarIndexedDbAdapter } from "./calendar-cache";
import type { CalendarScope } from "./calendar-scope";
import { CalendarScopeStaleError } from "./calendar-scope-lifecycle";

export type CalendarSyncTrigger = "foreground" | "online" | "mutation" | "low-frequency" | "manual";
export type CalendarSyncRunResult = {
  mode: "changes" | "bootstrap" | "resync-bootstrap";
  pages: number;
  applied: number;
  ignored: number;
  cursor: string;
  triggers: readonly CalendarSyncTrigger[];
};

export class CalendarChangesPaginationError extends Error {
  constructor() {
    super("Calendar changes pagination did not advance.");
    this.name = "CalendarChangesPaginationError";
  }
}

type CalendarSyncClient = Pick<DenClient, "getCalendarChanges" | "getCalendarBootstrap">;
type CalendarSyncCache = Pick<CalendarIndexedDbAdapter, "transaction" | "getSync">;

function snapshot<T>(value: T): T {
  return structuredClone(value);
}

export function invalidateCalendarSyncBaseline(cache: CalendarSyncCache, scope: CalendarScope): Promise<void> {
  return cache.transaction(scope, ["coverage", "sync"], "readwrite", async (transaction) => {
    for (const coverage of await transaction.listCoverage()) await transaction.deleteCoverage(coverage);
    await transaction.deleteSync();
  });
}

export function createCalendarSyncCoordinator(input: {
  scope: CalendarScope;
  client: CalendarSyncClient;
  cache: CalendarSyncCache;
  bootstrapRange: { startDate: string; endDateExclusive: string; calendarIds?: string[] };
  now: () => string;
  changesLimit?: number;
  signal?: AbortSignal;
}) {
  const scope = Object.freeze(snapshot(input.scope));
  const bootstrapRange = Object.freeze(snapshot(input.bootstrapRange));
  let drainPromise: Promise<CalendarSyncRunResult> | null = null;
  let pendingTriggers = new Set<CalendarSyncTrigger>();
  const controller = new AbortController();
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener("abort", () => controller.abort(input.signal!.reason), { once: true });
  }
  const signal = controller.signal;
  const checkCurrent = () => {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new CalendarScopeStaleError();
  };

  const bootstrap = async (mode: "bootstrap" | "resync-bootstrap", triggers: readonly CalendarSyncTrigger[]): Promise<CalendarSyncRunResult> => {
    checkCurrent();
    const result = await input.client.getCalendarBootstrap(scope.organizationId, bootstrapRange, { signal });
    checkCurrent();
    await persistCalendarBootstrapBaseline({ cache: input.cache, scope, bootstrap: result, refreshedAt: input.now() });
    return { mode, pages: 0, applied: 0, ignored: 0, cursor: result.cursor, triggers };
  };

  const runOnce = async (triggers: readonly CalendarSyncTrigger[]): Promise<CalendarSyncRunResult> => {
    const sync = await input.cache.getSync(scope);
    checkCurrent();
    if (!sync) return bootstrap("bootstrap", triggers);

    let cursor = sync.cursor;
    let pages = 0;
    let applied = 0;
    let ignored = 0;
    const seenCursors = new Set<string>();
    try {
      for (;;) {
        if (seenCursors.has(cursor)) throw new CalendarChangesPaginationError();
        seenCursors.add(cursor);
        checkCurrent();
        const page = await input.client.getCalendarChanges(scope.organizationId, cursor, { limit: input.changesLimit, signal });
        checkCurrent();
        if (page.hasMore && page.nextCursor === cursor) throw new CalendarChangesPaginationError();
        if (page.nextCursor !== cursor && seenCursors.has(page.nextCursor)) throw new CalendarChangesPaginationError();
        const result = await applyCalendarChangePage({ cache: input.cache, scope, fromCursor: cursor, page, refreshedAt: input.now() });
        pages += 1;
        applied += result.applied;
        ignored += result.ignored;
        cursor = result.cursor;
        if (!page.hasMore) return { mode: "changes", pages, applied, ignored, cursor, triggers };
      }
    } catch (error) {
      if (!(error instanceof DenApiError) || error.code !== "calendar_cursor_resync_required") throw error;
      checkCurrent();
      await invalidateCalendarSyncBaseline(input.cache, scope);
      return bootstrap("resync-bootstrap", triggers);
    }
  };

  const drain = async (): Promise<CalendarSyncRunResult> => {
    let result: CalendarSyncRunResult | undefined;
    do {
      const triggers = [...pendingTriggers];
      pendingTriggers = new Set();
      try {
        result = await runOnce(triggers);
      } catch (error) {
        pendingTriggers.clear();
        throw error;
      }
    } while (pendingTriggers.size > 0);
    return result!;
  };

  return {
    trigger(reason: CalendarSyncTrigger): Promise<CalendarSyncRunResult> {
      if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new CalendarScopeStaleError());
      pendingTriggers.add(reason);
      if (!drainPromise) {
        const current = drain();
        const tracked = current.finally(() => {
          if (drainPromise === tracked) drainPromise = null;
        });
        drainPromise = tracked;
      }
      return drainPromise;
    },
    cancel(reason: unknown = new CalendarScopeStaleError()): void {
      pendingTriggers.clear();
      controller.abort(reason);
    },
    getState(): "idle" | "running" | "cancelled" {
      return signal.aborted ? "cancelled" : drainPromise ? "running" : "idle";
    },
  };
}

import * as React from "react";
import { Temporal } from "@js-temporal/polyfill";

import type { DenCalendar, DenCalendarBootstrap, DenCalendarEvent } from "@/app/lib/den";
import { CalendarIndexedDbAdapter, type CalendarDraftRecord } from "./calendar-cache";
import { persistCalendarBootstrapBaseline } from "./calendar-cache-baseline";
import { discardCalendarDraft, readCalendarRangeAvailability, saveCalendarDraft, type CalendarRangeAvailability } from "./calendar-offline-drafts";
import type { CalendarEventFormValues } from "./calendar-event-form-model";
import type { CalendarScope } from "./calendar-scope";

export type CalendarOnlineSource = {
  isOnline: () => boolean;
  subscribe: (listener: () => void) => () => void;
};

export type CalendarOfflineCache = Pick<CalendarIndexedDbAdapter, "transaction" | "getDraft" | "putDraft" | "deleteDraft" | "listDrafts" | "ensureScopeCompatibility">;

/** Injectable so tests can drive connectivity and use an in-memory IndexedDB. */
export type CalendarOfflineRuntime = {
  online: CalendarOnlineSource;
  /** null when IndexedDB is unavailable: offline then always reports the range as unavailable. */
  cache: CalendarOfflineCache | null;
  now: () => Temporal.Instant;
};

const browserOnlineSource: CalendarOnlineSource = {
  // Unknown connectivity counts as online: the server stays authoritative and write failures surface normally.
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  subscribe: (listener) => {
    const target = typeof window === "undefined" ? null : window;
    if (!target || typeof target.addEventListener !== "function") return () => undefined;
    target.addEventListener("online", listener);
    target.addEventListener("offline", listener);
    return () => {
      target.removeEventListener("online", listener);
      target.removeEventListener("offline", listener);
    };
  },
};

let sharedCache: CalendarOfflineCache | null | undefined;
function defaultCache(): CalendarOfflineCache | null {
  if (sharedCache !== undefined) return sharedCache;
  try {
    sharedCache = new CalendarIndexedDbAdapter();
  } catch {
    sharedCache = null;
  }
  return sharedCache;
}

export function defaultCalendarOfflineRuntime(): CalendarOfflineRuntime {
  return { online: browserOnlineSource, cache: defaultCache(), now: () => Temporal.Now.instant() };
}

export function useCalendarOnline(source: CalendarOnlineSource): boolean {
  return React.useSyncExternalStore(source.subscribe, source.isOnline, source.isOnline);
}

/** Store the latest authoritative month baseline so the same range can be shown read-only offline. */
export function useCalendarBaselinePersistence(input: {
  runtime: CalendarOfflineRuntime;
  scope: CalendarScope;
  bootstrap: DenCalendarBootstrap | undefined;
  online: boolean;
}) {
  const { runtime, scope, bootstrap, online } = input;
  React.useEffect(() => {
    if (!online || !bootstrap || !runtime.cache) return;
    // Cache persistence is best-effort; failure must never block or alter the online view.
    void persistCalendarBootstrapBaseline({ cache: runtime.cache, scope, bootstrap, refreshedAt: runtime.now().toString() }).catch(() => undefined);
  }, [bootstrap, online, runtime, scope]);
}

export type CalendarOfflineView =
  | { state: "online" }
  | { state: "loading" }
  | { state: "offline-covered"; calendars: DenCalendar[]; events: DenCalendarEvent[]; refreshedAt: string | null }
  | { state: "offline-uncovered"; calendars: DenCalendar[]; refreshedAt: string | null };

export function useCalendarOfflineView(input: {
  runtime: CalendarOfflineRuntime;
  scope: CalendarScope;
  range: { startDate: string; endDateExclusive: string };
  online: boolean;
}): CalendarOfflineView {
  const { runtime, scope, online } = input;
  const { startDate, endDateExclusive } = input.range;
  const [view, setView] = React.useState<CalendarOfflineView>(online ? { state: "online" } : { state: "loading" });
  React.useEffect(() => {
    if (online) {
      setView({ state: "online" });
      return;
    }
    const cache = runtime.cache;
    if (!cache) {
      setView({ state: "offline-uncovered", calendars: [], refreshedAt: null });
      return;
    }
    let cancelled = false;
    setView({ state: "loading" });
    (async () => {
      const calendarRecords = await cache.transaction(scope, ["entities"], "readonly", (transaction) => transaction.listEntities("calendar"));
      const calendars = calendarRecords.map((record) => record.entity as DenCalendar);
      // The server records coverage for the active calendar set it resolved, and each baseline
      // replaces the cached calendar list, so that set is the cached calendars' IDs.
      const availability = await readCalendarRangeAvailability({
        cache, scope, range: { startDate, endDateExclusive, calendarIds: calendars.map((calendar) => calendar.id) }, online: false,
      });
      return { availability, calendars };
    })()
      .then(({ availability, calendars }: { availability: CalendarRangeAvailability; calendars: DenCalendar[] }) => {
        if (cancelled) return;
        setView(availability.state === "offline-covered"
          ? { state: "offline-covered", calendars, events: availability.events, refreshedAt: availability.refreshedAt }
          : { state: "offline-uncovered", calendars, refreshedAt: availability.state === "offline-uncovered" ? availability.refreshedAt : null });
      })
      .catch(() => { if (!cancelled) setView({ state: "offline-uncovered", calendars: [], refreshedAt: null }); });
    return () => { cancelled = true; };
  }, [endDateExclusive, online, runtime, scope, startDate]);
  return view;
}

export type CalendarEventDraftValues = { form: CalendarEventFormValues };

export function eventDraftRecord(input: { id: string; form: CalendarEventFormValues; base?: { id: string; version: number } }): CalendarDraftRecord {
  const values: CalendarEventDraftValues = { form: structuredClone(input.form) };
  return input.base
    ? { schemaVersion: 1, id: input.id, entityType: "event", operation: "edit", baseEntity: { id: input.base.id, version: input.base.version }, unsynced: true, values }
    : { schemaVersion: 1, id: input.id, entityType: "event", operation: "create", baseEntity: null, unsynced: true, values };
}

export function draftForm(draft: CalendarDraftRecord): CalendarEventFormValues | null {
  const values = draft.values as Partial<CalendarEventDraftValues> | null;
  return values && typeof values === "object" && values.form ? values.form : null;
}

export function useCalendarEventDrafts(runtime: CalendarOfflineRuntime, scope: CalendarScope) {
  const [drafts, setDrafts] = React.useState<CalendarDraftRecord[]>([]);
  const reload = React.useCallback(async () => {
    if (!runtime.cache) return;
    try {
      setDrafts(await runtime.cache.listDrafts(scope, "event"));
    } catch {
      setDrafts([]);
    }
  }, [runtime, scope]);
  React.useEffect(() => { void reload(); }, [reload]);
  const save = React.useCallback(async (draft: CalendarDraftRecord) => {
    if (!runtime.cache) throw new Error("Calendar drafts are unavailable without local storage.");
    await saveCalendarDraft({ cache: runtime.cache, scope, draft });
    await reload();
  }, [reload, runtime, scope]);
  const discard = React.useCallback(async (draftId: string) => {
    if (!runtime.cache) return;
    await discardCalendarDraft({ cache: runtime.cache, scope, draftId });
    await reload();
  }, [reload, runtime, scope]);
  return { drafts, available: runtime.cache !== null, save, discard, reload };
}

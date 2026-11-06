import type { DenCalendar, DenCalendarEvent } from "@/app/lib/den";

import { readCachedCalendarRange, type CachedCalendarRange } from "./calendar-cache-baseline";
import type {
  CalendarCoverageSelector,
  CalendarDraftRecord,
  CalendarEntityRecord,
  CalendarIndexedDbAdapter,
  CalendarSyncRecord,
  CalendarTombstoneRecord,
} from "./calendar-cache";
import type { CalendarScope } from "./calendar-scope";

type CalendarOfflineCache = Pick<CalendarIndexedDbAdapter, "transaction">;
type CalendarDraftCache = Pick<CalendarIndexedDbAdapter, "getDraft" | "putDraft" | "deleteDraft" | "transaction">;

export type CalendarRangeAvailability =
  | { state: "online"; readOnly: false }
  | { state: "offline-uncovered"; readOnly: true; refreshedAt: string | null }
  | { state: "offline-covered"; readOnly: true; stale: true; refreshedAt: string | null; events: DenCalendarEvent[] };

export class CalendarOfflineWriteError extends Error {
  constructor() {
    super("Calendar authoritative writes are unavailable offline; save a local draft instead.");
    this.name = "CalendarOfflineWriteError";
  }
}

export type CalendarDraftConflict =
  | { state: "create-ready"; draft: CalendarDraftRecord & { operation: "create" } }
  | { state: "edit-ready"; draft: CalendarDraftRecord & { operation: "edit" }; current: DenCalendar | DenCalendarEvent }
  | { state: "updated"; draft: CalendarDraftRecord & { operation: "edit" }; current: DenCalendar | DenCalendarEvent }
  | { state: "deleted"; draft: CalendarDraftRecord & { operation: "edit" }; tombstone: CalendarTombstoneRecord }
  | { state: "unavailable"; draft: CalendarDraftRecord & { operation: "edit" } };

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function requireCalendarOnlineWrite(online: boolean): void {
  if (!online) throw new CalendarOfflineWriteError();
}

export async function readCalendarRangeAvailability(input: {
  cache: CalendarOfflineCache;
  scope: CalendarScope;
  range: CalendarCoverageSelector;
  online: boolean;
}): Promise<CalendarRangeAvailability> {
  if (input.online) return { state: "online", readOnly: false };
  const [range, sync] = await Promise.all([
    readCachedCalendarRange(input),
    input.cache.transaction(input.scope, ["sync"], "readonly", (transaction) => transaction.getSync()),
  ]);
  if (range.state === "uncovered") return { state: "offline-uncovered", readOnly: true, refreshedAt: sync?.refreshedAt ?? null };
  return { state: "offline-covered", readOnly: true, stale: true, refreshedAt: sync?.refreshedAt ?? null, events: range.events };
}

export async function saveCalendarDraft(input: { cache: CalendarDraftCache; scope: CalendarScope; draft: CalendarDraftRecord }): Promise<CalendarDraftRecord> {
  const draft = clone(input.draft);
  await input.cache.putDraft(input.scope, draft);
  return draft;
}

export function restoreCalendarDraft(input: { cache: CalendarDraftCache; scope: CalendarScope; draftId: string }): Promise<CalendarDraftRecord | undefined> {
  return input.cache.getDraft(input.scope, input.draftId);
}

export function discardCalendarDraft(input: { cache: CalendarDraftCache; scope: CalendarScope; draftId: string }): Promise<void> {
  return input.cache.deleteDraft(input.scope, input.draftId);
}

export async function inspectCalendarDraft(input: { cache: CalendarDraftCache; scope: CalendarScope; draftId: string }): Promise<CalendarDraftConflict | null> {
  return input.cache.transaction(input.scope, ["drafts", "entities", "tombstones"], "readonly", async (transaction) => {
    const draft = await transaction.getDraft(input.draftId);
    if (!draft) return null;
    if (draft.operation === "create") return { state: "create-ready", draft };
    const tombstone = await transaction.getTombstone(draft.entityType, draft.baseEntity.id);
    if (tombstone && tombstone.version >= draft.baseEntity.version) return { state: "deleted", draft, tombstone };
    const record = await transaction.getEntity(draft.entityType, draft.baseEntity.id);
    if (!record) return { state: "unavailable", draft };
    if (record.entity.version !== draft.baseEntity.version) return { state: "updated", draft, current: record.entity };
    return { state: "edit-ready", draft, current: record.entity };
  });
}

export async function submitCalendarDraft<T>(input: {
  cache: CalendarDraftCache;
  scope: CalendarScope;
  draftId: string;
  online: boolean;
  refresh: () => Promise<void>;
  submit: (draft: CalendarDraftRecord) => Promise<T>;
}): Promise<{ result: T; draft: CalendarDraftRecord }> {
  requireCalendarOnlineWrite(input.online);
  await input.refresh();
  const state = await inspectCalendarDraft(input);
  if (!state) throw new TypeError("Calendar draft no longer exists.");
  if (state.state === "updated" || state.state === "deleted" || state.state === "unavailable") {
    throw new CalendarDraftConflictError(state);
  }
  const draft = state.draft;
  const result = await input.submit(clone(draft));
  await input.cache.deleteDraft(input.scope, input.draftId);
  return { result, draft };
}

export class CalendarDraftConflictError extends Error {
  readonly conflict: Extract<CalendarDraftConflict, { state: "updated" | "deleted" | "unavailable" }>;

  constructor(conflict: Extract<CalendarDraftConflict, { state: "updated" | "deleted" | "unavailable" }>) {
    super(`Calendar draft requires explicit conflict resolution: ${conflict.state}.`);
    this.name = "CalendarDraftConflictError";
    this.conflict = conflict;
  }
}

import { describe, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

import { CalendarIndexedDbAdapter, type CalendarDraftRecord, type CalendarEntityRecord } from "../src/react-app/domains/calendar/calendar-cache";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";
import {
  CalendarDraftConflictError,
  CalendarOfflineWriteError,
  inspectCalendarDraft,
  readCalendarRangeAvailability,
  requireCalendarOnlineWrite,
  restoreCalendarDraft,
  saveCalendarDraft,
  submitCalendarDraft,
} from "../src/react-app/domains/calendar/calendar-offline-drafts";

const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
const range = { startDate: "2026-11-01", endDateExclusive: "2026-12-01", calendarIds: [] as string[] };
const draft: CalendarDraftRecord = { schemaVersion: 1, id: "draft-a", entityType: "event", operation: "edit", baseEntity: { id: "event-a", version: 1 }, unsynced: true, values: { title: "Local input" } };

function cache() { return new CalendarIndexedDbAdapter({ indexedDB: new IDBFactory(), IDBKeyRange }); }
function event(version: number): CalendarEntityRecord {
  return { schemaVersion: 1, entityType: "event", calendarId: "calendar-a", coverageStartDate: "", coverageEndDateExclusive: "", entity: {
    id: "event-a", organizationId: "org-a", ownerMemberId: "member-a", calendarId: "calendar-a", title: `Event ${version}`, description: "",
    time: { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" }, version,
    createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  } };
}

describe("calendar offline state and drafts", () => {
  test("distinguishes a covered offline month from an uncovered month and marks cached data stale", async () => {
    const current = cache();
    await current.putEntity(scope, event(1));
    await current.putCoverage(scope, { schemaVersion: 1, ...range, eventIds: ["event-a"] });
    await current.putSync(scope, { schemaVersion: 1, cursor: "c1", refreshedAt: "2026-11-05T01:00:00Z" });
    expect(await readCalendarRangeAvailability({ cache: current, scope, range, online: false })).toMatchObject({ state: "offline-covered", readOnly: true, stale: true, refreshedAt: "2026-11-05T01:00:00Z", events: [{ id: "event-a" }] });
    expect(await readCalendarRangeAvailability({ cache: current, scope, range: { ...range, startDate: "2026-12-01", endDateExclusive: "2027-01-01" }, online: false })).toEqual({ state: "offline-uncovered", readOnly: true, refreshedAt: "2026-11-05T01:00:00Z" });
  });

  test("blocks authoritative offline writes rather than queuing or deleting cached data", async () => {
    const current = cache();
    await current.putEntity(scope, event(1));
    expect(() => requireCalendarOnlineWrite(false)).toThrow(CalendarOfflineWriteError);
    expect((await current.getEntity(scope, "event", "event-a"))?.entity.version).toBe(1);
  });

  test("restores drafts only from their complete scope", async () => {
    const current = cache();
    await saveCalendarDraft({ cache: current, scope, draft });
    expect(await restoreCalendarDraft({ cache: current, scope, draftId: draft.id })).toEqual(draft);
    const other = createCalendarScope({ deploymentBaseUrl: scope.deployment, organizationId: scope.organizationId, memberId: "member-b" })!;
    expect(await restoreCalendarDraft({ cache: current, scope: other, draftId: draft.id })).toBeUndefined();
  });

  test("preserves user input and reports remote update or deletion conflicts", async () => {
    const updated = cache();
    await updated.putDraft(scope, draft);
    await updated.putEntity(scope, event(2));
    expect(await inspectCalendarDraft({ cache: updated, scope, draftId: draft.id })).toMatchObject({ state: "updated", draft: { values: { title: "Local input" } }, current: { version: 2 } });
    const deleted = cache();
    await deleted.putDraft(scope, draft);
    await deleted.putTombstone(scope, { schemaVersion: 1, entityType: "event", id: "event-a", version: 2, deletedAt: "2026-11-05T02:00:00Z" });
    expect(await inspectCalendarDraft({ cache: deleted, scope, draftId: draft.id })).toMatchObject({ state: "deleted", draft: { values: { title: "Local input" } }, tombstone: { version: 2 } });
  });

  test("refreshes before explicit submit, keeps conflicts/failures, and clears only after cloud success", async () => {
    const current = cache();
    await current.putDraft(scope, draft);
    await current.putEntity(scope, event(1));
    const order: string[] = [];
    const submitted = await submitCalendarDraft({ cache: current, scope, draftId: draft.id, online: true, refresh: async () => { order.push("refresh"); }, submit: async () => { order.push("submit"); return "saved"; } });
    expect(submitted.result).toBe("saved");
    expect(order).toEqual(["refresh", "submit"]);
    expect(await current.getDraft(scope, draft.id)).toBeUndefined();

    await current.putDraft(scope, draft);
    await current.putEntity(scope, event(2));
    await expect(submitCalendarDraft({ cache: current, scope, draftId: draft.id, online: true, refresh: async () => {}, submit: async () => "unexpected" })).rejects.toBeInstanceOf(CalendarDraftConflictError);
    expect(await current.getDraft(scope, draft.id)).toEqual(draft);
  });
});

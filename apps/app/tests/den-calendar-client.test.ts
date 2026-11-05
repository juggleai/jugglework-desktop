import { afterEach, describe, expect, test } from "bun:test";

import {
  createDenClient,
  DenApiError,
  normalizeDenCalendar,
  normalizeDenCalendarEvent,
  normalizeDenDesktopConfig,
} from "../src/app/lib/den";

const fixture = await Bun.file(new URL("./fixtures/desktop-calendar-contract-v1.json", import.meta.url)).json();
const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

function fixtureError(code: string) {
  const entry = fixture.errors.find((candidate: { response: { error: string } }) => candidate.response.error === code);
  if (!entry) throw new Error(`Missing fixture error ${code}`);
  return entry as { status: number; response: Record<string, unknown> };
}

function calendarClient() {
  return createDenClient({ baseUrl: "https://work.example/deployment/", token: "token_one" });
}

async function captureError(response: unknown, status: number, action: (client: ReturnType<typeof createDenClient>) => Promise<unknown> = (client) => client.listCalendars("org_one")) {
  globalThis.fetch = async () => Response.json(response, { status });
  try {
    await action(calendarClient());
    throw new Error("expected request to fail");
  } catch (error) {
    return error;
  }
}

describe("Den calendar contract", () => {
  test("uses the server canonical fixture structure", () => {
    expect(fixture.version).toBe("calendar-v1");
    expect(fixture.routes).toEqual([
      "GET /v1/calendars",
      "POST /v1/calendars",
      "GET /v1/calendars/:calendarId",
      "PATCH /v1/calendars/:calendarId",
      "DELETE /v1/calendars/:calendarId",
      "GET /v1/calendar-events",
      "GET /v1/calendar-events/search",
      "POST /v1/calendar-events",
      "GET /v1/calendar-events/:eventId",
      "PATCH /v1/calendar-events/:eventId",
      "DELETE /v1/calendar-events/:eventId",
      "GET /v1/calendar/bootstrap",
      "GET /v1/calendar/changes",
    ]);
    expect(fixture.cursorResyncReasons).toEqual(["invalid", "scope_mismatch", "expired", "version_unsupported"]);
    expect(fixture.limits.bootstrapEventMax).toBe(5000);
    expect(normalizeDenCalendar(fixture.calendar)).toEqual(fixture.calendar);
    expect(normalizeDenCalendarEvent(fixture.allDayEvent)).toEqual(fixture.allDayEvent);
    expect(normalizeDenCalendarEvent(fixture.timedEvent)).toEqual(fixture.timedEvent);
  });

  test("normalizes calendar capability projection fail closed", () => {
    expect(normalizeDenDesktopConfig({})).toMatchObject({ calendarEnabled: false, calendarWriteEnabled: false });
    expect(normalizeDenDesktopConfig({ calendarEnabled: "true", calendarWriteEnabled: true })).toMatchObject({ calendarEnabled: false, calendarWriteEnabled: false });
    expect(normalizeDenDesktopConfig({ calendarEnabled: true, calendarWriteEnabled: "true" })).toMatchObject({ calendarEnabled: true, calendarWriteEnabled: false });
    expect(normalizeDenDesktopConfig(fixture.featureCapability)).toMatchObject(fixture.featureCapability);
  });

  test("normalizes list, get, mutation, delete, bootstrap, and every change variant", async () => {
    const calendarTombstone = { entityType: "calendar", entityId: fixture.calendar.id, version: 2, deletedAt: "2026-11-05T01:06:00Z" };
    const eventTombstone = { entityType: "event", entityId: fixture.timedEvent.id, version: 3, deletedAt: "2026-11-05T01:06:00Z" };
    const responses = [
      { items: [fixture.calendar] },
      { calendar: fixture.calendar },
      { calendar: fixture.calendar, replayed: false },
      { calendar: fixture.calendar, replayed: true },
      { tombstone: calendarTombstone, replayed: false },
      { items: [fixture.allDayEvent, fixture.timedEvent], nextCursor: null, hasMore: false },
      { items: [fixture.timedEvent], nextCursor: "search_cursor", hasMore: true },
      { event: fixture.timedEvent },
      { event: fixture.allDayEvent, replayed: false },
      { event: fixture.timedEvent, replayed: true },
      { tombstone: eventTombstone, replayed: true },
      fixture.bootstrap,
      fixture.changes,
    ];
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), init });
      const response = responses.shift();
      if (!response) throw new Error("unexpected request");
      return Response.json(response);
    };
    const client = calendarClient();

    expect(await client.listCalendars("org_one")).toEqual([fixture.calendar]);
    expect(await client.getCalendar("org_one", fixture.calendar.id)).toEqual(fixture.calendar);
    expect(await client.createCalendar("org_one", { idempotencyKey: "calendar-create", name: "My calendar" })).toEqual({ calendar: fixture.calendar, replayed: false });
    expect(await client.updateCalendar("org_one", fixture.calendar.id, { idempotencyKey: "calendar-update", expectedVersion: 1, color: "#3366CC" })).toEqual({ calendar: fixture.calendar, replayed: true });
    expect(await client.deleteCalendar("org_one", fixture.calendar.id, { idempotencyKey: "calendar-delete", expectedVersion: 1 })).toEqual({ tombstone: calendarTombstone, replayed: false });
    expect(await client.listCalendarEvents("org_one", { startDate: "2026-11-01", endDateExclusive: "2026-12-01" })).toEqual({ items: [fixture.allDayEvent, fixture.timedEvent], nextCursor: null, hasMore: false });
    expect(await client.searchCalendarEvents("org_one", { query: "Design" })).toEqual({ items: [fixture.timedEvent], nextCursor: "search_cursor", hasMore: true });
    expect(await client.getCalendarEvent("org_one", fixture.timedEvent.id)).toEqual(fixture.timedEvent);
    expect(await client.createCalendarEvent("org_one", { idempotencyKey: "event-create", calendarId: fixture.calendar.id, title: fixture.allDayEvent.title, time: fixture.allDayEvent.time })).toEqual({ event: fixture.allDayEvent, replayed: false });
    expect(await client.updateCalendarEvent("org_one", fixture.timedEvent.id, { idempotencyKey: "event-update", expectedVersion: 1, title: fixture.timedEvent.title })).toEqual({ event: fixture.timedEvent, replayed: true });
    expect(await client.deleteCalendarEvent("org_one", fixture.timedEvent.id, { idempotencyKey: "event-delete", expectedVersion: 2 })).toEqual({ tombstone: eventTombstone, replayed: true });
    expect(await client.getCalendarBootstrap("org_one", { startDate: "2026-11-01", endDateExclusive: "2026-12-01" })).toEqual(fixture.bootstrap);
    expect(await client.getCalendarChanges("org_one", fixture.bootstrap.cursor)).toEqual(fixture.changes);

    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "GET", "POST", "PATCH", "DELETE", "GET", "GET", "GET", "POST", "PATCH", "DELETE", "GET", "GET"]);
    expect(new Headers(requests[8]?.init?.headers).get("x-jugglework-legacy-org-id")).toBe("org_one");
    expect(JSON.parse(String(requests[8]?.init?.body))).toEqual({
      idempotencyKey: "event-create",
      calendarId: fixture.calendar.id,
      title: fixture.allDayEvent.title,
      time: fixture.allDayEvent.time,
    });
  });

  test("keeps calendar IDs opaque while using stable set query semantics", async () => {
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      requests.push(String(input));
      return Response.json({ items: [], nextCursor: null, hasMore: false });
    };
    const client = calendarClient();
    const options = {
      startDate: "2026-11-01",
      endDateExclusive: "2026-12-01",
      calendarIds: ["calendar/two", " calendar one ", "calendar/two"],
    };
    await client.listCalendarEvents("org_one", options);
    await client.listCalendarEvents("org_one", { ...options, calendarIds: [...options.calendarIds].reverse() });

    const expected = "?startDate=2026-11-01&endDateExclusive=2026-12-01&calendarId=+calendar+one+&calendarId=calendar%2Ftwo";
    expect(requests[0]).toEndWith(expected);
    expect(requests[1]).toEndWith(expected);
  });

  test("preserves every valid canonical Calendar error with normalized details", async () => {
    for (const entry of fixture.errors as Array<{ status: number; response: Record<string, unknown> }>) {
      const error = await captureError(entry.response, entry.status);
      expect(error).toBeInstanceOf(DenApiError);
      expect(error).toMatchObject({
        status: entry.status,
        code: entry.response.error,
        details: entry.response.details,
      });
    }

    const conflict = fixtureError("calendar_version_conflict");
    const eventConflict = { ...conflict.response, details: { current: fixture.timedEvent } };
    expect(await captureError(eventConflict, conflict.status)).toMatchObject({
      status: 409,
      code: "calendar_version_conflict",
      details: { current: fixture.timedEvent },
    });

    const resync = fixtureError("calendar_cursor_resync_required");
    for (const reason of fixture.cursorResyncReasons) {
      expect(await captureError({ ...resync.response, details: { reason } }, resync.status)).toMatchObject({
        status: 409,
        code: "calendar_cursor_resync_required",
        details: { reason },
      });
    }
  });

  test("rejects malformed known Calendar error envelopes and details", async () => {
    const conflict = fixtureError("calendar_version_conflict");
    const resync = fixtureError("calendar_cursor_resync_required");
    const resultTooLarge = fixtureError("calendar_result_too_large");
    const noDetails = fixtureError("calendar_not_found");
    const invalidRequest = fixtureError("invalid_calendar_request");
    const malformed = [
      { status: conflict.status, response: { ...conflict.response, details: {} } },
      { status: conflict.status, response: { ...conflict.response, details: { current: { ...fixture.calendar, extra: true } } } },
      { status: conflict.status, response: { ...conflict.response, details: { current: fixture.calendar, extra: true } } },
      { status: resync.status, response: { ...resync.response, details: {} } },
      { status: resync.status, response: { ...resync.response, details: { reason: "future_reason" } } },
      { status: resync.status, response: { ...resync.response, details: { reason: "invalid", extra: true } } },
      { status: resultTooLarge.status, response: { ...resultTooLarge.response, details: { limit: 4999 } } },
      { status: resultTooLarge.status, response: { ...resultTooLarge.response, details: { limit: 5000, extra: true } } },
      { status: noDetails.status, response: { ...noDetails.response, details: {} } },
      { status: invalidRequest.status, response: { ...invalidRequest.response, details: { time: { reason: "mixed" } } } },
      { status: invalidRequest.status, response: { ...invalidRequest.response, extra: true } },
      { status: conflict.status, response: { error: conflict.response.error, details: conflict.response.details } },
      { status: 400, response: conflict.response },
    ];

    for (const entry of malformed) {
      expect(await captureError(entry.response, entry.status)).toMatchObject({ status: 500, code: "invalid_calendar_payload" });
    }
  });

  test("does not alter non-Calendar errors", async () => {
    for (const code of ["task_conflict", "toString"]) {
      const response = { error: code, message: "Task changed.", details: { unexpected: { nested: true } }, extra: true };
      expect(await captureError(response, 418)).toMatchObject({
        status: 418,
        code,
        details: response.details,
      });
    }
  });

  test("rejects malformed success envelopes, time unions, pages, and reversed changes", async () => {
    expect(normalizeDenCalendarEvent({ ...fixture.allDayEvent, time: { kind: "floating", startDate: "2026-11-05", endDateExclusive: "2026-11-06" } })).toBeNull();
    expect(normalizeDenCalendarEvent({ ...fixture.allDayEvent, time: { ...fixture.allDayEvent.time, startInstant: "2026-11-05T00:00:00Z" } })).toBeNull();
    expect(normalizeDenCalendarEvent({ ...fixture.timedEvent, time: { ...fixture.timedEvent.time, futureField: true } })).toBeNull();

    const malformedLists = [
      { items: [fixture.calendar], extra: true },
      { items: [{ ...fixture.calendar, version: 0 }] },
      { calendars: [fixture.calendar] },
    ];
    for (const response of malformedLists) {
      expect(await captureError(response, 200)).toMatchObject({ code: "invalid_calendar_payload" });
    }

    const malformedEnvelopes: Array<{ response: unknown; action: (client: ReturnType<typeof createDenClient>) => Promise<unknown> }> = [
      { response: { calendar: fixture.calendar, extra: true }, action: (client) => client.getCalendar("org_one", fixture.calendar.id) },
      { response: { calendar: fixture.calendar, replayed: "false" }, action: (client) => client.createCalendar("org_one", { idempotencyKey: "create", name: fixture.calendar.name }) },
      { response: { event: fixture.timedEvent, extra: true }, action: (client) => client.getCalendarEvent("org_one", fixture.timedEvent.id) },
      { response: { event: fixture.timedEvent, replayed: false, extra: true }, action: (client) => client.updateCalendarEvent("org_one", fixture.timedEvent.id, { idempotencyKey: "update", expectedVersion: 1, title: fixture.timedEvent.title }) },
      { response: { tombstone: { entityType: "calendar", entityId: fixture.timedEvent.id, version: 3, deletedAt: "2026-11-05T01:06:00Z" }, replayed: false }, action: (client) => client.deleteCalendarEvent("org_one", fixture.timedEvent.id, { idempotencyKey: "delete", expectedVersion: 2 }) },
      { response: { ...fixture.bootstrap, extra: true }, action: (client) => client.getCalendarBootstrap("org_one", { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }) },
      { response: { ...fixture.changes, extra: true }, action: (client) => client.getCalendarChanges("org_one", fixture.bootstrap.cursor) },
    ];
    for (const entry of malformedEnvelopes) {
      expect(await captureError(entry.response, 200, entry.action)).toMatchObject({ code: "invalid_calendar_payload" });
    }

    const malformedPages = [
      { items: [fixture.allDayEvent], nextCursor: null, hasMore: true },
      { items: [fixture.allDayEvent], nextCursor: "", hasMore: false },
      { items: [{ ...fixture.allDayEvent, version: 0 }], nextCursor: null, hasMore: false },
      { items: [fixture.allDayEvent], nextCursor: null, hasMore: false, extra: true },
    ];
    for (const response of malformedPages) {
      expect(await captureError(response, 200, (client) => client.listCalendarEvents("org_one", { startDate: "2026-11-01", endDateExclusive: "2026-12-01" }))).toMatchObject({ code: "invalid_calendar_payload" });
    }

    const reversed = { ...fixture.changes, items: [fixture.changes.items[1], fixture.changes.items[0], fixture.changes.items[2]] };
    expect(await captureError(reversed, 200, (client) => client.getCalendarChanges("org_one", fixture.bootstrap.cursor))).toMatchObject({ code: "invalid_calendar_payload" });
  });
});

import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import type { DenCalendar, DenCalendarEvent, DenCalendarEventTime, DenCalendarSchedulingEvent } from "../src/app/lib/den";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => { consoleError.mockRestore(); });

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); }, clear: () => values.clear(), key: () => null, get length() { return values.size; } },
});

const fixedNow = Temporal.Instant.from("2026-11-09T04:00:00Z");
const clock = { now: () => fixedNow, timeZone: () => "Asia/Shanghai" };
mock.module("../src/i18n", () => ({ t: (key: string) => key, currentLocale: () => "en" }));
mock.module("../src/react-app/shell/app-navigation-rail", () => ({ APP_NAVIGATION_RAIL_WIDTH: 48, AppNavigationRail: () => <nav /> }));

const calendar = (id: string, name: string): DenCalendar => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", name, color: "#2563eb", isDefault: id === "cal-1",
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

let calendars: DenCalendar[] = [];
let events: DenCalendarEvent[] = [];
const bootstrapRanges: string[] = [];
const schedulingRanges: Array<{ startInstant: string; endInstantExclusive: string; timeZone: string }> = [];
const writes: string[] = [];
let schedulingItems: Array<{ event: DenCalendarSchedulingEvent; occurrenceIndex: number; time: DenCalendarEventTime }> = [];
let schedulingFailure: Error | null = null;
let schedulingGate: Promise<void> | null = null;
const client = {
  listCalendars: async () => calendars,
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => {
    bootstrapRanges.push(`${range.startDate}/${range.endDateExclusive}`);
    return { calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" };
  },
  listCalendarSchedulingEvents: async (_org: string, range: { startInstant: string; endInstantExclusive: string; timeZone: string }) => {
    schedulingRanges.push({ ...range });
    if (schedulingGate) await schedulingGate;
    if (schedulingFailure) throw schedulingFailure;
    return { items: schedulingItems };
  },
  getCalendarSchedulingAvailability: async () => ({ members: [] }),
  createCalendar: async () => { writes.push("create"); throw new Error("unexpected write"); },
  updateCalendar: async () => { writes.push("update"); throw new Error("unexpected write"); },
  deleteCalendar: async () => { writes.push("delete"); throw new Error("unexpected write"); },
};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com" }, activeOrganization: { id: "org-a", orgMemberId: "member-a" }, client }),
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => ({ loading: false, config: { calendarEnabled: true, calendarWriteEnabled: true } }),
}));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");

const calendarEvent = (id: string, time: DenCalendarEventTime, calendarId = "cal-1"): DenCalendarEvent => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", calendarId, title: `Title ${id}`, description: "", time,
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

beforeEach(() => {
  values.clear(); writes.length = 0; bootstrapRanges.length = 0; schedulingRanges.length = 0; schedulingItems = []; schedulingFailure = null; schedulingGate = null; events = [];
  calendars = [calendar("cal-1", "Personal"), calendar("cal-2", "Side project")];
});

async function render(prepare?: (queryClient: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  prepare?.(queryClient);
  const noop = () => undefined;
  let renderer!: TestRenderer.ReactTestRenderer;
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/calendar"]}>
        <CalendarPage workspaceId="" sessionPath="/session" clock={clock} onOpenAccount={noop} onOpenApps={noop} onOpenChat={noop} onOpenReviews={noop} onOpenSettings={noop} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => { renderer = TestRenderer.create(tree()); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { renderer, queryClient, rerender: async () => { await act(async () => { renderer.update(tree()); }); } };
}

const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.find((node) => node.props["data-testid"] === id);
const has = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const click = async (renderer: TestRenderer.ReactTestRenderer, id: string) => { await act(async () => { byId(renderer, id).props.onClick(); }); };

test("opens on today's month with a six-week grid spanning the month boundary", async () => {
  const { renderer } = await render();
  try {
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("November 2026");
    // en-US weeks start on Sunday: Nov 2026 begins on a Sunday, so the 6-week grid runs Nov 1 – Dec 12.
    const cells = renderer.root.findAll((node) => typeof node.props["data-testid"] === "string" && /^calendar-day-\d{4}-\d{2}-\d{2}$/.test(node.props["data-testid"]));
    expect(cells).toHaveLength(42);
    expect(cells[0]!.props["data-testid"]).toBe("calendar-day-2026-11-01");
    expect(cells[41]!.props["data-testid"]).toBe("calendar-day-2026-12-12");
    expect(byId(renderer, "calendar-day-2026-11-30").props["data-outside-month"]).toBeUndefined();
    expect(byId(renderer, "calendar-day-2026-12-01").props["data-outside-month"]).toBe("true");
    expect(byId(renderer, "calendar-day-2026-11-09").props["aria-selected"]).toBe(true);
    expect(byId(renderer, "calendar-day-button-2026-11-09").props["aria-current"]).toBe("date");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("previous, next, and today move the main grid and the selected day", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-next-month");
    await click(renderer, "calendar-next-month");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("January 2027");
    await click(renderer, "calendar-previous-month");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("December 2026");
    await click(renderer, "calendar-today");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("November 2026");
    expect(byId(renderer, "calendar-day-2026-11-09").props["aria-selected"]).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("mini-month previous and next buttons synchronize the main navigation", async () => {
  const { renderer } = await render();
  try {
    expect(byId(renderer, "calendar-mini-previous-month").props["aria-label"]).toBe("calendar.previous_month");
    expect(byId(renderer, "calendar-mini-next-month").props["aria-label"]).toBe("calendar.next_month");
    await click(renderer, "calendar-mini-next-month");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("December 2026");
    expect(byId(renderer, "calendar-day-2026-12-09").props["aria-selected"]).toBe(true);
    await click(renderer, "calendar-mini-previous-month");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("November 2026");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("selecting a mini-month date outside the visible month switches the main grid", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-mini-day-2026-12-03");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("December 2026");
    expect(byId(renderer, "calendar-day-2026-12-03").props["aria-selected"]).toBe(true);
    expect(byId(renderer, "calendar-mini-day-2026-12-03").props["aria-selected"]).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("arrow keys move the selected day across month boundaries", async () => {
  const { renderer } = await render();
  try {
    const grid = () => byId(renderer, "calendar-month-grid").findByProps({ role: "grid" });
    const press = async (key: string) => { await act(async () => { grid().props.onKeyDown({ key, preventDefault: () => undefined }); }); };
    await press("ArrowDown");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(byId(renderer, "calendar-day-2026-11-30").props["aria-selected"]).toBe(true);
    await press("ArrowRight");
    expect(text(byId(renderer, "calendar-visible-month"))).toBe("December 2026");
    expect(byId(renderer, "calendar-day-2026-12-01").props["aria-selected"]).toBe(true);
    expect(byId(renderer, "calendar-day-button-2026-12-01").props.tabIndex).toBe(0);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("hiding a calendar is local only and survives a remount without any cloud write", async () => {
  let { renderer } = await render();
  try {
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-1,cal-2");
    await act(async () => { byId(renderer, "calendar-filter-cal-2").props.onChange({ target: { checked: false } }); });
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-1");
    expect(writes).toEqual([]);
  } finally { await act(async () => { renderer.unmount(); }); }
  ({ renderer } = await render());
  try {
    expect(byId(renderer, "calendar-filter-cal-2").props.checked).toBe(false);
    await act(async () => { byId(renderer, "calendar-filter-cal-2").props.onChange({ target: { checked: true } }); });
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-1,cal-2");
    expect(writes).toEqual([]);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("calendar filters are grouped, collapsible, and retain the existing checkboxes", async () => {
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-filter-group-managed")).toBe(true);
    expect(has(renderer, "calendar-filter-group-subscribed")).toBe(true);
    const toggle = byId(renderer, "calendar-filter-group-managed-toggle");
    expect(toggle.props["aria-expanded"]).toBe(true);
    await click(renderer, "calendar-filter-group-managed-toggle");
    expect(byId(renderer, "calendar-filter-group-managed-toggle").props["aria-expanded"]).toBe(false);
    expect(byId(renderer, "calendar-filter-group-managed-region").props.hidden).toBe(true);
    expect(byId(renderer, "calendar-filter-cal-1").props.checked).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("shows the signed-in nickname for only the default personal calendar", async () => {
  const { renderer } = await render();
  try {
    const defaultCalendarRow = byId(renderer, "calendar-filter-cal-1").parent;
    const additionalCalendarRow = byId(renderer, "calendar-filter-cal-2").parent;
    expect(text(defaultCalendarRow)).toContain("Ada");
    expect(text(defaultCalendarRow)).not.toContain("Personal");
    expect(text(additionalCalendarRow)).toContain("Side project");
    expect(byId(renderer, "calendar-page-actions").findAll((node) => node.type === "button" && node.props["data-testid"] === "calendar-create-event")).toHaveLength(1);
    expect(byId(renderer, "calendar-view-toolbar").findAll((node) => node.type === "button" && node.props["data-testid"] === "calendar-create-event")).toHaveLength(0);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("does not offer event creation without an authoritative writable default calendar", async () => {
  calendars = calendars.map((item) => ({ ...item, isDefault: false }));
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-create-event")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a soft-deleted calendar leaves the filter list and its hidden entry", async () => {
  const { renderer, queryClient } = await render();
  try {
    await act(async () => { byId(renderer, "calendar-filter-cal-2").props.onChange({ target: { checked: false } }); });
    calendars = [calendar("cal-1", "Personal")];
    await act(async () => { await queryClient.invalidateQueries(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(has(renderer, "calendar-filter-cal-2")).toBe(false);
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-1");
    expect([...values.values()].some((value) => value.includes("cal-2"))).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("requests exactly the visible six-week range and refetches on month change", async () => {
  const { renderer } = await render();
  try {
    expect(bootstrapRanges).toEqual(["2026-11-01/2026-12-13"]);
    expect(schedulingRanges).toEqual([{ startInstant: "2026-10-31T16:00:00Z", endInstantExclusive: "2026-12-12T16:00:00Z", timeZone: "Asia/Shanghai" }]);
    expect(Temporal.Instant.from(schedulingRanges[0]!.endInstantExclusive).since(Temporal.Instant.from(schedulingRanges[0]!.startInstant)).total("days")).toBe(42);
    await click(renderer, "calendar-next-month");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(bootstrapRanges.at(-1)).toBe("2026-11-29/2027-01-10");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("merges scheduling occurrences into the default 42-day month without showing the series master", async () => {
  const series = {
    ...calendarEvent("series", { kind: "allDay", startDate: "2026-11-02", endDateExclusive: "2026-11-03" }),
    status: "active" as const,
    attendees: [{ memberId: "member-b", responseStatus: "needs-action" as const }],
    recurrence: { frequency: "weekly" as const, interval: 1, end: { kind: "never" as const } },
  };
  events = [calendarEvent("series", series.time)];
  schedulingItems = [{ event: series, occurrenceIndex: 3, time: { kind: "allDay", startDate: "2026-11-23", endDateExclusive: "2026-11-24" } }];
  const { renderer } = await render();
  try {
    expect(schedulingRanges[0]).toEqual({ startInstant: "2026-10-31T16:00:00Z", endInstantExclusive: "2026-12-12T16:00:00Z", timeZone: "Asia/Shanghai" });
    expect(has(renderer, "calendar-day-event-2026-11-02-series")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-23-scheduling:series:3")).toBe(true);
    await click(renderer, "calendar-day-event-2026-11-23-scheduling:series:3");
    expect(has(renderer, "calendar-occurrence-read-only")).toBe(true);
    expect(has(renderer, "calendar-event-detail-edit")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a cold-cache scheduling error leaves bootstrap details visible but blocks edit and delete", async () => {
  events = [calendarEvent("possibly-series", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" })];
  schedulingFailure = new Error("scheduling unavailable");
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-scheduling-events-error")).toBe(true);
    await click(renderer, "calendar-day-event-2026-11-09-possibly-series");
    expect(has(renderer, "calendar-scheduling-edit-error")).toBe(true);
    expect(has(renderer, "calendar-event-detail-edit")).toBe(false);
    expect(has(renderer, "calendar-form-delete")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a cold-cache pending scheduling query blocks edit and delete until classification succeeds", async () => {
  events = [calendarEvent("possibly-series", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" })];
  let release!: () => void;
  schedulingGate = new Promise<void>((resolve) => { release = resolve; });
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-possibly-series");
    expect(has(renderer, "calendar-scheduling-edit-loading")).toBe(true);
    expect(has(renderer, "calendar-event-detail-edit")).toBe(false);
    expect(has(renderer, "calendar-form-delete")).toBe(false);
  } finally {
    release();
    await act(async () => { await schedulingGate; renderer.unmount(); });
  }
});

test("a one-time attendee scheduling event keeps its real ID and remains editable and deletable", async () => {
  const aggregate: DenCalendarSchedulingEvent = {
    ...calendarEvent("attendee-event", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }),
    title: "Authoritative attendee event",
    status: "active",
    attendees: [{ memberId: "member-b", responseStatus: "accepted" }],
    recurrence: null,
  };
  events = [calendarEvent("attendee-event", aggregate.time)];
  schedulingItems = [{ event: aggregate, occurrenceIndex: 0, time: aggregate.time }];
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-day-event-2026-11-09-attendee-event")).toBe(true);
    expect(has(renderer, "calendar-day-event-2026-11-09-scheduling:attendee-event:0")).toBe(false);
    await click(renderer, "calendar-day-event-2026-11-09-attendee-event");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Authoritative attendee event");
    expect(has(renderer, "calendar-occurrence-read-only")).toBe(false);
    expect(has(renderer, "calendar-event-detail-edit")).toBe(true);
    await click(renderer, "calendar-event-detail-edit");
    expect(has(renderer, "calendar-form-delete")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("renders multi-day and timed events on the dates they cover, titles as plain text", async () => {
  events = [
    calendarEvent("trip", { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-08" }),
    calendarEvent("late", { kind: "timed", startInstant: "2026-11-05T14:00:00Z", endInstantExclusive: "2026-11-05T18:00:00Z", timeZone: "Asia/Shanghai" }),
    { ...calendarEvent("xss", { kind: "allDay", startDate: "2026-11-10", endDateExclusive: "2026-11-11" }), title: "<img src=x onerror=alert(1)>" },
  ];
  const { renderer } = await render();
  try {
    for (const day of ["2026-11-05", "2026-11-06", "2026-11-07"]) expect(has(renderer, `calendar-day-event-${day}-trip`)).toBe(true);
    expect(has(renderer, "calendar-day-event-2026-11-08-trip")).toBe(false);
    expect(byId(renderer, "calendar-day-event-2026-11-06-trip").props["data-continues-from-previous"]).toBe("true");
    expect(has(renderer, "calendar-day-event-2026-11-05-late")).toBe(true);
    expect(has(renderer, "calendar-day-event-2026-11-06-late")).toBe(true);
    expect(has(renderer, "calendar-day-event-2026-11-07-late")).toBe(false);
    const xss = byId(renderer, "calendar-day-event-2026-11-10-xss");
    expect(text(xss)).toBe("<img src=x onerror=alert(1)>");
    expect(xss.findAll((node) => node.type === "img")).toHaveLength(0);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("hiding a calendar removes its events from the grid", async () => {
  events = [calendarEvent("a", { kind: "allDay", startDate: "2026-11-05", endDateExclusive: "2026-11-06" }, "cal-2")];
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-day-event-2026-11-05-a")).toBe(true);
    await act(async () => { byId(renderer, "calendar-filter-cal-2").props.onChange({ target: { checked: false } }); });
    expect(has(renderer, "calendar-day-event-2026-11-05-a")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("an overflowing day shows a +N more entry that selects that day", async () => {
  events = ["e1", "e2", "e3", "e4", "e5"].map((id) => calendarEvent(id, { kind: "allDay", startDate: "2026-11-12", endDateExclusive: "2026-11-13" }));
  const { renderer } = await render();
  try {
    const shown = renderer.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("calendar-day-event-2026-11-12-"));
    expect(shown).toHaveLength(2);
    expect(text(byId(renderer, "calendar-day-more-2026-11-12"))).toBe("calendar.more_events");
    await click(renderer, "calendar-day-more-2026-11-12");
    expect(byId(renderer, "calendar-day-2026-11-12").props["aria-selected"]).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("the view switcher replaces the right agenda with day, week, and month surfaces", async () => {
  events = [
    calendarEvent("timed", { kind: "timed", startInstant: "2026-11-09T02:00:00Z", endInstantExclusive: "2026-11-09T03:00:00Z", timeZone: "Asia/Shanghai" }),
    calendarEvent("all-day", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-11" }),
  ];
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-day-panel")).toBe(false);
    expect(text(byId(renderer, "calendar-view-day"))).toBe("calendar.day");
    expect(text(byId(renderer, "calendar-view-week"))).toBe("calendar.week");
    expect(text(byId(renderer, "calendar-view-month"))).toBe("calendar.month");
    expect(byId(renderer, "calendar-view-switcher").props.className).toContain("dark:bg-dls-surface-muted");
    expect(byId(renderer, "calendar-view-month").props.className).toContain("dark:bg-white");
    expect(byId(renderer, "calendar-view-month").props.className).toContain("dark:text-black");
    expect(byId(renderer, "calendar-view-month").props["aria-pressed"]).toBe(true);
    await click(renderer, "calendar-view-week");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(has(renderer, "calendar-week-view")).toBe(true);
    expect(has(renderer, "calendar-all-day-event-all-day")).toBe(true);
    expect(has(renderer, "calendar-time-event-2026-11-09-timed")).toBe(true);
    expect(bootstrapRanges.at(-1)).toBe("2026-11-08/2026-11-15");
    await click(renderer, "calendar-view-day");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(has(renderer, "calendar-day-view")).toBe(true);
    expect(bootstrapRanges.at(-1)).toBe("2026-11-09/2026-11-10");
    await click(renderer, "calendar-view-month");
    expect(has(renderer, "calendar-month-grid")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("all-day details show a date range, timed details show local time and zone, text stays plain", async () => {
  events = [
    { ...calendarEvent("trip", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-11" }), description: "Line one\n<b>not bold</b>" },
    calendarEvent("call", { kind: "timed", startInstant: "2026-11-09T06:00:00Z", endInstantExclusive: "2026-11-09T07:00:00Z", timeZone: "Asia/Shanghai" }),
  ];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-trip");
    expect(text(byId(renderer, "calendar-event-detail-time"))).toBe("Nov 9, 2026 - Nov 10, 2026(calendar.all_day)");
    expect(has(renderer, "calendar-event-detail-zone")).toBe(false);
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Personal");
    expect(text(byId(renderer, "calendar-event-detail-description"))).toBe("Line one\n<b>not bold</b>");
    expect(byId(renderer, "calendar-event-detail").findAll((node) => node.type === "b")).toHaveLength(0);
    await click(renderer, "calendar-day-event-2026-11-09-call");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title call");
    // Separator wording ("," vs "at") varies by ICU version; assert the meaningful parts.
    const timedLabel = text(byId(renderer, "calendar-event-detail-time"));
    expect(timedLabel).toContain("2:00 PM");
    expect(timedLabel).toContain("3:00 PM");
    expect(timedLabel).not.toContain("calendar.all_day");
    expect(text(byId(renderer, "calendar-event-detail-zone"))).toBe("Asia/Shanghai");
    await click(renderer, "calendar-event-detail-close");
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("opening an event from a month cell selects its day and shows its detail", async () => {
  events = [calendarEvent("a", { kind: "allDay", startDate: "2026-11-18", endDateExclusive: "2026-11-19" })];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-18-a");
    expect(byId(renderer, "calendar-day-2026-11-18").props["aria-selected"]).toBe(true);
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title a");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("an event deleted on another client closes its detail and leaves the grid", async () => {
  events = [calendarEvent("a", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" })];
  const { renderer, queryClient } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-a");
    expect(has(renderer, "calendar-event-detail")).toBe(true);
    events = [];
    await act(async () => { await queryClient.invalidateQueries(); await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-09-a")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

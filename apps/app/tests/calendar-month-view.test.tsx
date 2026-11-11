import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import type { DenCalendar, DenCalendarEvent, DenCalendarEventTime } from "../src/app/lib/den";

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
const writes: string[] = [];
const client = {
  listCalendars: async () => calendars,
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => {
    bootstrapRanges.push(`${range.startDate}/${range.endDateExclusive}`);
    return { calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" };
  },
  createCalendar: async () => { writes.push("create"); throw new Error("unexpected write"); },
  updateCalendar: async () => { writes.push("update"); throw new Error("unexpected write"); },
  deleteCalendar: async () => { writes.push("delete"); throw new Error("unexpected write"); },
};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", activeOrganization: { id: "org-a", orgMemberId: "member-a" }, client }),
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
  values.clear(); writes.length = 0; bootstrapRanges.length = 0; events = [];
  calendars = [calendar("cal-1", "Personal"), calendar("cal-2", "Side project")];
});

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
    await click(renderer, "calendar-next-month");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(bootstrapRanges.at(-1)).toBe("2026-11-29/2027-01-10");
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

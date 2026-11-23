import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { createDenClient, type DenCalendar, type DenCalendarEvent, type DenCalendarEventTime, type DenCalendarSchedulingEvent, type DenCalendarSchedulingListOptions, type DenCalendarSchedulingOccurrence, type DenOrganizationMember } from "../src/app/lib/den";
import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";
import { calendarViewStorageKey } from "../src/react-app/domains/calendar/calendar-view-model";

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
const calendarScope = { deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" } as const;
mock.module("../src/i18n", () => ({ t: (key: string) => key, currentLocale: () => "en" }));
mock.module("../src/react-app/shell/app-navigation-rail", () => ({ APP_NAVIGATION_RAIL_WIDTH: 48, AppNavigationRail: () => <nav /> }));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) => open === false ? null : <>{children}</>,
  DialogContent: ({ children, showCloseButton: _showCloseButton, finalFocus: _finalFocus, ...props }: React.ComponentProps<"section"> & { showCloseButton?: boolean; finalFocus?: unknown }) => <section {...props}>{children}</section>,
  DialogDescription: (props: React.ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogHeader: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogTitle: (props: React.ComponentProps<"h2">) => <h2 {...props} />,
}));
const PopoverOpenContext = React.createContext<((open: boolean) => void) | null>(null);
mock.module("../src/components/ui/popover", () => ({
  Popover: ({ children, onOpenChange }: { children: React.ReactNode; onOpenChange: (open: boolean) => void }) => <PopoverOpenContext.Provider value={onOpenChange}>{children}</PopoverOpenContext.Provider>,
  PopoverTrigger: ({ children, render }: { children: React.ReactNode; render: React.ReactElement }) => {
    const onOpenChange = React.useContext(PopoverOpenContext);
    return React.cloneElement(render, { onClick: () => onOpenChange?.(true) }, children);
  },
  PopoverContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
}));
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children, render }: { children: React.ReactNode; render: React.ReactElement }) => React.cloneElement(render, {}, children),
  DropdownMenuContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: React.ComponentProps<"button">) => <button type="button" {...props}>{children}</button>,
  DropdownMenuSub: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuSubTrigger: ({ children, ...props }: React.ComponentProps<"button">) => <button type="button" {...props}>{children}</button>,
  DropdownMenuSubContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
}));

const calendar = (id: string, name: string): DenCalendar => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", name, color: "#2563eb", isDefault: id === "cal-1",
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

let calendars: DenCalendar[] = [];
let organizationMembers: DenOrganizationMember[] = [];
let events: DenCalendarEvent[] = [];
const bootstrapRanges: string[] = [];
const schedulingRanges: DenCalendarSchedulingListOptions[] = [];
const writes: string[] = [];
const schedulingWrites: Array<{ op: string; eventId: string; input: Record<string, unknown> }> = [];
let schedulingItems: Array<{ event: DenCalendarSchedulingEvent; occurrenceIndex: number; time: DenCalendarEventTime }> = [];
let schedulingFailure: Error | null = null;
let schedulingGate: Promise<void> | null = null;
const client = {
  listCalendars: async () => calendars,
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => {
    bootstrapRanges.push(`${range.startDate}/${range.endDateExclusive}`);
    return { calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" };
  },
  listCalendarSchedulingEvents: async (_org: string, range: DenCalendarSchedulingListOptions) => {
    schedulingRanges.push({ ...range });
    if (schedulingGate) await schedulingGate;
    if (schedulingFailure) throw schedulingFailure;
    return { items: schedulingItems };
  },
  getCalendarSchedulingAvailability: async () => ({ members: [] }),
  listOrganizationMembers: async (_org: string, input: { limit: number; offset: number }) => ({ members: organizationMembers.slice(input.offset, input.offset + input.limit), total: organizationMembers.length, limit: input.limit, offset: input.offset }),
  createCalendar: async () => { writes.push("create"); throw new Error("unexpected write"); },
  updateCalendar: async () => { writes.push("update"); throw new Error("unexpected write"); },
  deleteCalendar: async () => { writes.push("delete"); throw new Error("unexpected write"); },
  deleteCalendarSchedulingEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    schedulingWrites.push({ op: "delete", eventId, input });
    const current = schedulingItems.find((item) => item.event.id === eventId)!.event;
    schedulingItems = [];
    return { event: { ...current, version: current.version + 1 }, tombstone: null, replayed: false };
  },
  rsvpCalendarSchedulingEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    schedulingWrites.push({ op: "rsvp", eventId, input });
    const current = schedulingItems.find((item) => item.event.id === eventId)!.event;
    const updated = { ...current, version: current.version + 1, attendees: current.attendees.map((attendee) => attendee.memberId === "member-a" ? { ...attendee, responseStatus: input.responseStatus as "accepted" | "declined" | "tentative" } : attendee) };
    schedulingItems = schedulingItems.map((item) => item.event.id === eventId ? { ...item, event: updated } : item);
    return { event: updated, replayed: false };
  },
};
let activeOrgId = "org-a";
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com" }, activeOrganization: { id: activeOrgId, kind: "personal", orgMemberId: "member-a" }, client }),
}));
mock.module("../src/react-app/domains/meeting/meeting-page", () => ({ MeetingPrejoin: () => null }));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");

const calendarEvent = (id: string, time: DenCalendarEventTime, calendarId = "cal-1"): DenCalendarEvent => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", calendarId, title: `Title ${id}`, description: "", time,
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

beforeEach(() => {
  values.clear(); writes.length = 0; schedulingWrites.length = 0; bootstrapRanges.length = 0; schedulingRanges.length = 0; schedulingItems = []; schedulingFailure = null; schedulingGate = null; events = [];
  values.set(calendarViewStorageKey(calendarScope), "month");
  calendars = [calendar("cal-1", "Personal"), calendar("cal-2", "Side project")]; organizationMembers = [];
  activeOrgId = "org-a";
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
  await settle();
  return { renderer, queryClient, rerender: async () => { await act(async () => { renderer.update(tree()); }); } };
}

const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.find((node) => node.props["data-testid"] === id);
const has = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const click = async (renderer: TestRenderer.ReactTestRenderer, id: string) => { await act(async () => { byId(renderer, id).props.onClick(); }); };
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const toggle = async (renderer: TestRenderer.ReactTestRenderer, id: string, checked: boolean) => {
  await act(async () => { byId(renderer, id).props.onChange({ target: { checked } }); });
};

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
    for (const day of ["08", "09", "10", "11", "12", "13", "14"]) expect(byId(renderer, `calendar-day-2026-11-${day}`).props["data-current-week"]).toBe("true");
    expect(byId(renderer, "calendar-day-2026-11-07").props["data-current-week"]).toBeUndefined();
    expect(byId(renderer, "calendar-day-2026-11-15").props["data-current-week"]).toBeUndefined();
    expect(byId(renderer, "calendar-day-2026-11-09").props.className).toContain("color-mix");
    expect(byId(renderer, "calendar-day-button-2026-11-09").props.className).toContain("dark:text-black");
    expect(byId(renderer, "calendar-mini-day-2026-11-09").props.className).toContain("dark:text-black");
    expect(byId(renderer, "calendar-mini-day-2026-11-10").props.className).not.toContain("--dls-accent-rgb");
    expect(byId(renderer, "calendar-mini-day-2026-11-10").props.className).not.toContain("dark:bg-[color:color-mix");
    expect(renderer.root.findAll((node) => node.props["data-current-weekday"] === "true")).toHaveLength(2);
    for (const header of renderer.root.findAll((node) => node.props["data-current-weekday"] === "true")) expect(header.props.className).toContain("color-mix");
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
    expect(byId(renderer, "calendar-filter-check-cal-1").props.style.backgroundColor).toBe("#2563eb");
    expect(String(byId(renderer, "calendar-filter-check-cal-1").findByType("svg").props.className)).toContain("text-white");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("calendar row menu changes its display color locally and keeps it after remount", async () => {
  events = [calendarEvent("colored-event", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }, "cal-2")];
  let { renderer } = await render();
  try {
    expect(byId(renderer, "calendar-filter-check-cal-2").props.style.backgroundColor).toBe("#2563eb");
    expect(String(byId(renderer, "calendar-filter-check-cal-2").findByType("svg").props.className)).toContain("text-white");
    expect(byId(renderer, "calendar-day-event-2026-11-09-colored-event").props.style.backgroundColor).toBe("#2563eb");
    expect(byId(renderer, "calendar-color-cal-2-d84fa3").props["aria-pressed"]).toBe(false);
    await click(renderer, "calendar-color-cal-2-d84fa3");
    expect(byId(renderer, "calendar-filter-check-cal-2").props.style.backgroundColor).toBe("#d84fa3");
    expect(byId(renderer, "calendar-day-event-2026-11-09-colored-event").props.style.backgroundColor).toBe("#d84fa3");
    expect(byId(renderer, "calendar-color-cal-2-d84fa3").props["aria-pressed"]).toBe(true);
    expect(writes).toEqual([]);
  } finally { await act(async () => { renderer.unmount(); }); }
  ({ renderer } = await render());
  try {
    expect(byId(renderer, "calendar-filter-check-cal-2").props.style.backgroundColor).toBe("#d84fa3");
    expect(byId(renderer, "calendar-day-event-2026-11-09-colored-event").props.style.backgroundColor).toBe("#d84fa3");
    expect(byId(renderer, "calendar-color-cal-2-d84fa3").props["aria-pressed"]).toBe(true);
    expect(writes).toEqual([]);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("calendar row menu can show only one calendar", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-show-only-cal-2");
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-2");
    expect(byId(renderer, "calendar-filter-cal-1").props.checked).toBe(false);
    expect(byId(renderer, "calendar-filter-cal-2").props.checked).toBe(true);
    expect(writes).toEqual([]);
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

test("the header create action defaults to today and the next half-hour boundary", async () => {
  const { renderer } = await render();
  try {
    await act(async () => { byId(renderer, "calendar-day-button-2026-11-20").props.onClick(); });
    await click(renderer, "calendar-create-event");
    expect(text(byId(renderer, "calendar-form-start-date"))).toContain("Nov 9, 2026");
    expect(text(byId(renderer, "calendar-form-end-date"))).toContain("Nov 9, 2026");
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("12:30");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:00");
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
    expect(schedulingRanges).toEqual([{ startInstant: "2026-10-31T16:00:00Z", endInstantExclusive: "2026-12-12T16:00:00Z", timeZone: "Asia/Shanghai", includeInvited: true }]);
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
    expect(has(renderer, "calendar-day-event-2026-11-02-series")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-23-scheduling:series:3")).toBe(true);
    await click(renderer, "calendar-day-event-2026-11-23-scheduling:series:3");
    expect(has(renderer, "calendar-occurrence-read-only")).toBe(true);
    expect(has(renderer, "calendar-event-detail-edit")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("invitations follow the default personal calendar in month, week, and day and stay scoped across navigation", async () => {
  const day = "2026-11-09";
  const allDay = { kind: "allDay", startDate: day, endDateExclusive: "2026-11-10" } as const;
  // Sunday in the organizer's zone, Monday in the viewer's zone.
  const timed = { kind: "timed", startInstant: "2026-11-08T19:30:00Z", endInstantExclusive: "2026-11-08T20:00:00Z", timeZone: "America/Los_Angeles" } as const;
  const invite: DenCalendarSchedulingEvent = {
    ...calendarEvent("invited", allDay, "organizer-calendar"), ownerMemberId: "member-b", status: "active", recurrence: null,
    attendees: [{ memberId: "member-a", responseStatus: "declined" }],
  };
  const owner: DenCalendarSchedulingEvent = { ...invite, ...calendarEvent("owned", allDay) };
  const unrelated = { ...invite, id: "unrelated", calendarId: "cal-1", attendees: [{ memberId: "member-b", responseStatus: "accepted" as const }] };
  const otherOrg = { ...invite, id: "other-org", organizationId: "org-b", calendarId: "cal-1" };
  schedulingItems = [invite, { ...invite, id: "invited-timed", time: timed }, owner, unrelated, otherOrg].map((event) => ({ event, occurrenceIndex: 1, time: event.time }));
  const { renderer, rerender } = await render();
  try {
    await click(renderer, "calendar-filter-toggle");
    expect(has(renderer, "calendar-filter-invited")).toBe(false);
    expect(has(renderer, "calendar-filter-organizer-calendar")).toBe(false);
    expect(byId(renderer, "calendar-ready").props["data-visible-calendar-ids"]).toBe("cal-1,cal-2");
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-calendar");
    expect(byId(renderer, "calendar-form-calendar-menu").findAll((node) => node.type === "button" && node.props.role === "option").map((node) => node.props["data-testid"])).toEqual([
      "calendar-form-calendar-option-cal-1", "calendar-form-calendar-option-cal-2",
    ]);
    await click(renderer, "calendar-form-cancel");
    expect(has(renderer, `calendar-day-event-${day}-unrelated`)).toBe(false);
    expect(has(renderer, `calendar-day-event-${day}-other-org`)).toBe(false);
    for (const view of ["month", "week", "day"]) {
      await click(renderer, `calendar-view-${view}`);
      await settle();
      const allDayPrefix = view === "month" ? `calendar-day-event-${day}-` : "calendar-all-day-event-";
      const timedPrefix = view === "month" ? allDayPrefix : `calendar-time-event-${day}-`;
      expect(has(renderer, `${allDayPrefix}invited`)).toBe(true);
      expect(has(renderer, `${timedPrefix}invited-timed`)).toBe(true);
      await click(renderer, `${allDayPrefix}invited`);
      expect(has(renderer, "calendar-event-detail-rsvp")).toBe(true);
      await toggle(renderer, "calendar-filter-cal-1", false);
      expect(has(renderer, `${allDayPrefix}invited`)).toBe(false);
      expect(has(renderer, `${timedPrefix}invited-timed`)).toBe(false);
      expect(has(renderer, `${allDayPrefix}owned`)).toBe(false);
      await toggle(renderer, "calendar-filter-cal-1", true);
      expect(has(renderer, "calendar-event-detail")).toBe(false);
    }
    await click(renderer, "calendar-all-day-event-invited");
    await click(renderer, "calendar-next-day");
    await settle();
    expect(has(renderer, "calendar-all-day-event-invited")).toBe(false);
    await click(renderer, "calendar-today");
    expect(has(renderer, "calendar-all-day-event-invited")).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    await click(renderer, "calendar-all-day-event-invited");
    // Even the same occurrence ID in the new organization cannot retain the old selection.
    activeOrgId = "org-b";
    schedulingItems = [{ event: { ...invite, organizationId: "org-b" }, occurrenceIndex: 1, time: allDay }];
    await rerender();
    await settle();
    expect(has(renderer, "calendar-all-day-event-invited")).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("RSVP for an occurrence in another member's calendar uses the real Den client and leaves owner caches alone", async () => {
  const series: DenCalendarSchedulingEvent = {
    ...calendarEvent("series/with:syntax", { kind: "allDay", startDate: "2026-11-02", endDateExclusive: "2026-11-03" }, "organizer/calendar"),
    ownerMemberId: "member-b",
    version: 7,
    videoConferenceEnabled: true,
    status: "active",
    attendees: [{ memberId: "member-a", responseStatus: "needs-action" }],
    recurrence: { frequency: "weekly", interval: 1, end: { kind: "never" } },
  };
  const occurrenceTime = { kind: "allDay" as const, startDate: "2026-11-23", endDateExclusive: "2026-11-24" };
  let occurrence: DenCalendarSchedulingOccurrence = { event: series, occurrenceIndex: 3, time: occurrenceTime };
  const range = { startInstant: "2026-10-31T16:00:00Z", endInstantExclusive: "2026-12-12T16:00:00Z", timeZone: "Asia/Shanghai" };
  const ownerKey = calendarQueryKeys.schedulingEvents(calendarScope, range);
  const writes: { path: string; input: Record<string, unknown> }[] = [];
  let keepInvitation = true;
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (init?.method === "GET" && url.pathname.endsWith("/calendar-scheduling/events")) {
      expect(Object.fromEntries(url.searchParams)).toEqual({ ...range, includeInvited: "true" });
      return Response.json({ items: keepInvitation ? [occurrence] : [] });
    }
    if (init?.method === "PUT" && url.pathname.endsWith("/rsvp")) {
      expect(new Headers(init.headers).get("x-jugglework-legacy-org-id")).toBe("org-a");
      const body = JSON.parse(String(init.body));
      writes.push({ path: url.pathname, input: body });
      const event = { ...series, version: occurrence.event.version + 1 };
      occurrence = { ...occurrence, event: { ...event, attendees: [{ memberId: "member-a", responseStatus: body.responseStatus }] } };
      // Per-occurrence RSVP returns the series aggregate, not the effective occurrence response.
      return Response.json({ event, tombstone: null, replayed: false });
    }
    throw new Error(`Unexpected request: ${init?.method} ${url.pathname}`);
  });
  const den = createDenClient({ baseUrl: "https://den.example", token: "test-token" });
  const list = spyOn(client, "listCalendarSchedulingEvents").mockImplementation(den.listCalendarSchedulingEvents);
  const rsvp = spyOn(client, "rsvpCalendarSchedulingEvent").mockImplementation(den.rsvpCalendarSchedulingEvent);
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    const rendered = await render((queryClient) => queryClient.setQueryData(ownerKey, { items: [] }));
    renderer = rendered.renderer;
    const { queryClient } = rendered;
    const inviteKey = calendarQueryKeys.schedulingEvents(calendarScope, { ...range, includeInvited: true });
    const detailKey = calendarQueryKeys.event(calendarScope, series.id);
    expect(queryClient.getQueryData(inviteKey)).toEqual({ items: [occurrence] });
    expect(queryClient.getQueryData(ownerKey)).toEqual({ items: [] });
    expect(queryClient.getQueryData(detailKey)).toBeUndefined();
    await click(renderer, "calendar-day-event-2026-11-23-scheduling:series%2Fwith%3Asyntax:3");
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Ada");
    const responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses.map((button) => text(button))).toEqual(["calendar.rsvp_accept", "calendar.rsvp_decline", "calendar.rsvp_tentative"]);
    await act(async () => { responses[0]!.props.onClick(); });
    expect(has(renderer, "calendar-event-rsvp-scope")).toBe(true);
    await click(renderer, "calendar-event-rsvp-scope-this");
    await click(renderer, "calendar-event-rsvp-scope-confirm");
    await settle();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/jwork/api/v1/calendar-scheduling/events/series%2Fwith%3Asyntax/rsvp");
    const { idempotencyKey, ...body } = writes[0]!.input;
    expect(idempotencyKey).toMatch(/^calendar\.scheduling-rsvp\./);
    expect(body).toEqual({ expectedVersion: 7, scope: "this", occurrence: { occurrenceIndex: 3, startDate: "2026-11-23" }, responseStatus: "accepted" });
    expect(byId(renderer, "calendar-event-detail-rsvp").props["data-response-status"]).toBe("accepted");
    for (const action of ["detail-edit", "detail-delete", "start-meeting"]) expect(has(renderer, `calendar-event-${action}`)).toBe(false);
    expect(queryClient.getQueryData(ownerKey)).toEqual({ items: [] });
    expect(queryClient.getQueryState(ownerKey)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryData(detailKey)).toBeUndefined();

    // Removal during the post-RSVP refresh also wins over the successful write response.
    await act(async () => { byId(renderer!, "calendar-event-detail-rsvp").findAll((node) => node.type === "button")[1]!.props.onClick(); });
    keepInvitation = false;
    await click(renderer, "calendar-event-rsvp-scope-confirm");
    await settle();
    expect(writes[1]).toMatchObject({ input: { expectedVersion: 8, responseStatus: "declined" } });
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-23-scheduling:series%2Fwith%3Asyntax:3")).toBe(false);
    expect(queryClient.getQueryData(inviteKey)).toEqual({ items: [] });
  } finally {
    await act(async () => { renderer?.unmount(); });
    list.mockRestore(); rsvp.mockRestore(); fetch.mockRestore();
  }
});

test("foreground focus and minute polling reconcile invitations without polling while unfocused", async () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  let focused = true;
  const host = Object.assign(new EventTarget(), { innerWidth: 1024, innerHeight: 768 });
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible", hasFocus: () => focused });
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  const realSetInterval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const timer = spyOn(globalThis, "setInterval").mockImplementation((callback, ms, ...args) => {
    if (ms === 60_000) tick = callback as () => void;
    return realSetInterval(callback, ms, ...args);
  });
  const event: DenCalendarSchedulingEvent = {
    ...calendarEvent("invite", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }, "organizer-calendar"),
    ownerMemberId: "member-b", status: "active", recurrence: null, attendees: [{ memberId: "member-a", responseStatus: "needs-action" }],
  };
  const item = { event, occurrenceIndex: 1, time: event.time };
  const chip = "calendar-day-event-2026-11-09-invite";
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    ({ renderer } = await render());
    expect(has(renderer, chip)).toBe(false);
    const reads = schedulingRanges.length;
    schedulingItems = [item];
    focused = false;
    await act(async () => { tick!(); });
    expect(schedulingRanges).toHaveLength(reads);
    focused = true;
    await act(async () => { host.dispatchEvent(new Event("focus")); });
    await settle();
    expect(has(renderer, chip)).toBe(true);
    await click(renderer, chip);
    expect(has(renderer, "calendar-event-detail")).toBe(true);

    schedulingItems = [];
    await act(async () => { tick!(); });
    await settle();
    expect(has(renderer, chip)).toBe(false);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    schedulingItems = [item];
    await act(async () => { tick!(); });
    await settle();
    expect(has(renderer, chip)).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    await click(renderer, chip);
    schedulingFailure = new Error("Calendar authorization unavailable");
    await act(async () => { tick!(); });
    await settle();
    expect(has(renderer, chip)).toBe(false);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    timer.mockRestore();
    if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor);
    else Reflect.deleteProperty(globalThis, "document");
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("RSVP buttons show completed labels, disable only the active response, and allow switching", async () => {
  const event: DenCalendarSchedulingEvent = {
    ...calendarEvent("rsvp-states", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }),
    ownerMemberId: "member-b",
    status: "active",
    attendees: [
      { memberId: "member-a", responseStatus: "needs-action" },
      { memberId: "member-b", responseStatus: "accepted" },
    ],
    recurrence: null,
  };
  schedulingItems = [{ event, occurrenceIndex: 1, time: event.time }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-rsvp-states");
    let responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(byId(renderer, "calendar-event-detail-rsvp").props["data-response-status"]).toBe("needs-action");
    expect(responses.map((button) => text(button))).toEqual(["calendar.rsvp_accept", "calendar.rsvp_decline", "calendar.rsvp_tentative"]);
    expect(responses.map((button) => button.props.disabled)).toEqual([false, false, false]);
    expect(responses.map((button) => button.props["aria-pressed"])).toEqual([false, false, false]);
    expect(schedulingWrites).toHaveLength(0);

    await act(async () => { responses[1]!.props.onClick(); });
    await act(async () => {});
    responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses.map((button) => text(button))).toEqual(["calendar.rsvp_accept", "calendar.rsvp_declined", "calendar.rsvp_tentative"]);
    expect(responses.map((button) => button.props.disabled)).toEqual([false, true, false]);
    expect(responses[1]!.props.className).toContain("bg-[#fff1f0]");
    expect(byId(renderer, "calendar-day-event-2026-11-09-rsvp-states").props.className).toContain("line-through");
    expect(byId(renderer, "calendar-day-event-2026-11-09-rsvp-states").props.className).not.toContain("bg-[#f2f3f5]");
    expect(byId(renderer, "calendar-day-event-2026-11-09-rsvp-states").props.style).toBeUndefined();
    expect(byId(renderer, "calendar-day-declined-marker-2026-11-09-rsvp-states").props.className).toContain("bg-transparent");

    await act(async () => { responses[2]!.props.onClick(); });
    await act(async () => {});
    responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses.map((button) => text(button))).toEqual(["calendar.rsvp_accept", "calendar.rsvp_decline", "calendar.rsvp_tentative_selected"]);
    expect(responses.map((button) => button.props.disabled)).toEqual([false, false, true]);
    expect(responses[2]!.props.className).toContain("bg-[#f2f3f5]");

    await act(async () => { responses[0]!.props.onClick(); });
    await act(async () => {});
    responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses.map((button) => text(button))).toEqual(["calendar.rsvp_accepted", "calendar.rsvp_decline", "calendar.rsvp_tentative"]);
    expect(responses.map((button) => button.props.disabled)).toEqual([true, false, false]);
    expect(responses[0]!.props.className).toContain("bg-[#e5f8e5]");
    expect(schedulingWrites.filter((write) => write.op === "rsvp").map((write) => write.input.responseStatus)).toEqual(["declined", "tentative", "accepted"]);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("attendee avatars show badges only for explicit accepted, declined, and tentative responses", async () => {
  const event: DenCalendarSchedulingEvent = {
    ...calendarEvent("attendee-badges", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" }),
    status: "active",
    attendees: [
      { memberId: "member-a", responseStatus: "accepted" },
      { memberId: "member-b", responseStatus: "declined" },
      { memberId: "member-c", responseStatus: "needs-action" },
      { memberId: "member-d", responseStatus: "tentative" },
    ],
    recurrence: null,
  };
  schedulingItems = [{ event, occurrenceIndex: 1, time: event.time }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-attendee-badges");
    const statuses = byId(renderer, "calendar-event-detail").findAll((node) => typeof node.props["data-response-status"] === "string").map((node) => node.props["data-response-status"]);
    expect(statuses).toContain("accepted");
    expect(statuses).toContain("declined");
    expect(statuses).toContain("needs-action");
    expect(statuses).toContain("tentative");
    const badges = byId(renderer, "calendar-event-detail").findAll((node) => typeof node.props["data-response-badge"] === "string").map((node) => node.props["data-response-badge"]);
    expect(badges).toContain("accepted");
    expect(badges).toContain("declined");
    expect(badges).toContain("tentative");
    expect(badges).not.toContain("needs-action");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("recurring organizer detail shows accepted RSVP and sends canonical identity for scoped delete", async () => {
  const series: DenCalendarSchedulingEvent = {
    ...calendarEvent("series/with:syntax", { kind: "allDay", startDate: "2026-11-02", endDateExclusive: "2026-11-03" }),
    status: "active",
    attendees: [
      { memberId: "member-a", responseStatus: "accepted" },
      { memberId: "member-b", responseStatus: "needs-action" },
    ],
    recurrence: { frequency: "weekly", interval: 1, end: { kind: "never" } },
  };
  const occurrenceTime = { kind: "allDay" as const, startDate: "2026-11-23", endDateExclusive: "2026-11-24" };
  schedulingItems = [{ event: series, occurrenceIndex: 3, time: occurrenceTime }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-23-scheduling:series%2Fwith%3Asyntax:3");
    const responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses.map((button) => button.props["aria-pressed"])).toEqual([true, false, false]);
    await click(renderer, "calendar-event-detail-delete");
    expect(has(renderer, "calendar-event-delete-scope")).toBe(true);
    await click(renderer, "calendar-event-delete-scope-all");
    await click(renderer, "calendar-event-delete-scope-confirm");
    expect(schedulingWrites[0]).toMatchObject({ op: "delete", eventId: "series/with:syntax", input: { scope: "this-and-following", occurrence: { occurrenceIndex: 3, startDate: "2026-11-23" } } });
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
    attendees: [
      { memberId: "member-a", responseStatus: "accepted" },
      { memberId: "member-b", responseStatus: "needs-action" },
    ],
    recurrence: null,
  };
  events = [calendarEvent("attendee-event", aggregate.time)];
  schedulingItems = [{ event: aggregate, occurrenceIndex: 1, time: aggregate.time }];
  const { renderer } = await render();
  try {
    expect(has(renderer, "calendar-day-event-2026-11-09-attendee-event")).toBe(true);
    expect(has(renderer, "calendar-day-event-2026-11-09-scheduling:attendee-event:1")).toBe(false);
    await click(renderer, "calendar-day-event-2026-11-09-attendee-event");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Authoritative attendee event");
    expect(byId(renderer, "calendar-event-panel").props.className).toContain("left-1/2");
    expect(byId(renderer, "calendar-event-panel").props.style.maxHeight).toBe(576);
    expect(byId(renderer, "calendar-event-panel").props.style.width).toBe(350);
    expect(byId(renderer, "calendar-event-panel").props["data-detail-layout"]).toBe("uniform");
    expect(byId(renderer, "calendar-event-detail").props.className).toContain("min-h-0");
    expect(byId(renderer, "calendar-event-detail-hero").props.className).toContain("linear-gradient");
    expect(byId(renderer, "calendar-event-detail-hero").props.className).toContain("pb-3");
    expect(byId(renderer, "calendar-event-detail-hero").props.className).toContain("pt-2");
    expect(byId(renderer, "calendar-event-detail-actions").props.className).toContain("h-8");
    expect(byId(renderer, "calendar-event-detail-body").props.className).toContain("overflow-y-auto");
    expect(byId(renderer, "calendar-event-detail-body").props.className).toContain("py-3");
    expect(has(renderer, "calendar-event-detail-delete")).toBe(true);
    expect(has(renderer, "calendar-event-detail-share")).toBe(false);
    expect(has(renderer, "calendar-event-detail-more")).toBe(false);
    expect(text(byId(renderer, "calendar-event-detail-attendees"))).toContain("member-a");
    expect(text(byId(renderer, "calendar-event-detail-attendees"))).toContain("member-b");
    expect(text(byId(renderer, "calendar-event-detail-reminder"))).toBe("calendar.reminder_minutes_before");
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Ada");
    expect(byId(renderer, "calendar-event-detail-calendar-icon").props.style).toBeUndefined();
    const responses = byId(renderer, "calendar-event-detail-rsvp").findAll((node) => node.type === "button");
    expect(responses).toHaveLength(3);
    expect(responses.map((button) => button.props["aria-pressed"])).toEqual([true, false, false]);
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

test("an overflowing day opens every event and anchors detail near the selected overflow item", async () => {
  events = ["e1", "e2", "e3", "e4", "e5"].map((id) => calendarEvent(id, { kind: "allDay", startDate: "2026-11-12", endDateExclusive: "2026-11-13" }));
  const { renderer } = await render();
  try {
    const shown = renderer.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("calendar-day-event-2026-11-12-"));
    expect(shown).toHaveLength(2);
    expect(text(byId(renderer, "calendar-day-more-2026-11-12"))).toBe("calendar.more_events");
    await click(renderer, "calendar-day-more-2026-11-12");
    expect(byId(renderer, "calendar-day-2026-11-12").props["aria-selected"]).toBe(true);
    expect(has(renderer, "calendar-day-overflow-2026-11-12")).toBe(true);
    expect(byId(renderer, "calendar-day-overflow-2026-11-12").props.role).toBe("dialog");
    for (const id of ["e1", "e2", "e3", "e4", "e5"]) expect(text(byId(renderer, `calendar-day-overflow-event-2026-11-12-${id}`))).toContain(`Title ${id}`);

    await act(async () => {
      byId(renderer, "calendar-day-overflow-event-2026-11-12-e5").props.onClick({
        currentTarget: { getBoundingClientRect: () => ({ left: 200, right: 300, top: 220, bottom: 250, width: 100, height: 30, x: 200, y: 220, toJSON: () => ({}) }) },
      });
    });
    expect(has(renderer, "calendar-day-overflow-2026-11-12")).toBe(false);
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title e5");
    expect(byId(renderer, "calendar-event-panel").props["data-detail-anchored"]).toBe("true");
    expect(byId(renderer, "calendar-event-panel").props["data-detail-layout"]).toBe("uniform");
    expect(byId(renderer, "calendar-event-panel").props.style.maxHeight).toBe(576);
    expect(byId(renderer, "calendar-event-panel").props.style.width).toBe(350);
    expect(byId(renderer, "calendar-event-panel").props.className).toContain("fixed");
    expect(byId(renderer, "calendar-event-panel").props.style.left).toBe(306);
    expect(byId(renderer, "calendar-event-panel").props.style.top).toBe(220);
    expect(byId(renderer, "calendar-event-panel").props.style.height).toBeUndefined();
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("week timed declined events use a subdued dark-mode surface without inline light colors", async () => {
  const event: DenCalendarSchedulingEvent = {
    ...calendarEvent("declined-timed", { kind: "timed", startInstant: "2026-11-09T05:30:00Z", endInstantExclusive: "2026-11-09T06:30:00Z", timeZone: "Asia/Shanghai" }),
    ownerMemberId: "member-b",
    status: "active",
    attendees: [{ memberId: "member-a", responseStatus: "declined" }],
    recurrence: null,
  };
  schedulingItems = [{ event, occurrenceIndex: 1, time: event.time }];
  const { renderer } = await render();
  try {
    const monthEvent = byId(renderer, "calendar-day-event-2026-11-09-declined-timed");
    expect(monthEvent.props.className).toContain("line-through");
    expect(monthEvent.props.className).not.toContain("bg-[#f2f3f5]");
    expect(byId(renderer, "calendar-day-declined-marker-2026-11-09-declined-timed").props.className).toContain("border-[#b8bdc5]");

    await click(renderer, "calendar-view-week");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const weekEvent = byId(renderer, "calendar-time-event-2026-11-09-declined-timed");
    expect(weekEvent.props.className).toContain("dark:bg-white/[0.07]");
    expect(weekEvent.props.className).toContain("dark:text-white/25");
    expect(weekEvent.props.className).toContain("dark:border-l-white/15");
    expect(weekEvent.props.style.backgroundColor).toBeUndefined();
    expect(weekEvent.props.style.color).toBeUndefined();
    expect(weekEvent.props.style.borderLeftColor).toBeUndefined();
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("the view switcher replaces the right agenda with day, week, and month surfaces", async () => {
  events = [
    calendarEvent("timed", { kind: "timed", startInstant: "2026-11-09T02:00:00Z", endInstantExclusive: "2026-11-09T03:00:00Z", timeZone: "Asia/Shanghai" }),
    calendarEvent("timed-parallel", { kind: "timed", startInstant: "2026-11-09T02:00:00Z", endInstantExclusive: "2026-11-09T03:00:00Z", timeZone: "Asia/Shanghai" }),
    calendarEvent("short-timed", { kind: "timed", startInstant: "2026-11-09T03:00:00Z", endInstantExclusive: "2026-11-09T03:30:00Z", timeZone: "Asia/Shanghai" }),
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
    expect(has(renderer, "calendar-time-event-2026-11-09-timed-parallel")).toBe(true);
    expect(has(renderer, "calendar-time-event-2026-11-09-short-timed")).toBe(true);
    expect(text(byId(renderer, "calendar-time-hour-9"))).toBe("09:00");
    expect(text(byId(renderer, "calendar-time-hour-0"))).toBe("00:00");
    expect(byId(renderer, "calendar-time-hour-0").props.className).toContain("translate-y-1");
    expect(byId(renderer, "calendar-time-hour-0").props.className).not.toContain("-translate-y-1/2");
    expect(byId(renderer, "calendar-time-hour-1").props.className).toContain("-translate-y-1/2");
    expect(text(byId(renderer, "calendar-current-time-label"))).toBe("12:00");
    expect(byId(renderer, "calendar-current-time").props["data-current-day-index"]).toBe(1);
    expect(byId(renderer, "calendar-current-time").props.className).toContain("inset-x-0");
    expect(byId(renderer, "calendar-time-day-2026-11-09").props.className).toContain("text-left");
    expect(byId(renderer, "calendar-time-day-2026-11-09").props.className).toContain("min-h-[4.5rem]");
    expect(byId(renderer, "calendar-time-day-2026-11-09").findAll((node) => node.type === "span")[0]!.props.className).toContain("text-xs");
    expect(byId(renderer, "calendar-time-day-2026-11-09").findAll((node) => node.type === "span")[0]!.props.className).toContain("leading-4");
    expect(byId(renderer, "calendar-time-day-2026-11-09").findAll((node) => node.type === "span")[1]!.props.className).toContain("text-xl");
    expect(byId(renderer, "calendar-time-day-2026-11-09").findAll((node) => node.type === "span")[1]!.props.className).toContain("size-8");
    expect(byId(renderer, "calendar-time-day-2026-11-09").props["data-today"]).toBe("true");
    expect(byId(renderer, "calendar-time-day-2026-11-09").props.className).toContain("--dls-accent-rgb");
    expect(byId(renderer, "calendar-time-day-2026-11-09").props.className).toContain("color-mix");
    expect(byId(renderer, "calendar-time-day-2026-11-09").findAll((node) => node.type === "span")[1]!.props.className).toContain("dark:text-black");
    expect(byId(renderer, "calendar-time-column-2026-11-09").props["data-today"]).toBe("true");
    expect(byId(renderer, "calendar-time-column-2026-11-09").props.className).toContain("--dls-accent-rgb");
    expect(byId(renderer, "calendar-all-day-column-2026-11-09").props["data-today"]).toBe("true");
    expect(byId(renderer, "calendar-time-day-2026-11-10").props["data-today"]).toBeUndefined();
    expect(byId(renderer, "calendar-time-event-2026-11-09-timed").props["data-compact"]).toBeUndefined();
    expect(byId(renderer, "calendar-time-event-2026-11-09-timed").props.style.width).toBe("calc(50% - 14px - 4px)");
    expect(byId(renderer, "calendar-time-event-2026-11-09-timed-parallel").props.style.width).toBe("calc(50% - 14px - 4px)");
    expect(byId(renderer, "calendar-time-event-2026-11-09-timed-parallel").props.style.left).toBe("calc(50% - 14px + 2px)");
    expect(byId(renderer, "calendar-time-create-alongside-2026-11-09-600-660").props.style.left).toBe("calc(100% - 26px)");
    expect(byId(renderer, "calendar-time-create-alongside-2026-11-09-600-660").props.style.width).toBe(24);
    expect(byId(renderer, "calendar-time-event-2026-11-09-short-timed").props["data-compact"]).toBe("true");
    expect(byId(renderer, "calendar-time-event-2026-11-09-short-timed").props.style.width).toBe("calc(100% - 28px - 4px)");
    expect(byId(renderer, "calendar-time-create-alongside-2026-11-09-660-690").props.style.left).toBe("calc(100% - 26px)");
    expect(byId(renderer, "calendar-time-event-2026-11-09-short-timed").props.className).toContain("items-center");
    expect(byId(renderer, "calendar-time-event-2026-11-09-short-timed").props.className).toContain("py-0");
    expect(text(byId(renderer, "calendar-time-event-2026-11-09-short-timed"))).toContain("· ");
    await act(async () => {
      byId(renderer, "calendar-time-create-alongside-2026-11-09-600-660").props.onClick({
        detail: 1,
        clientX: 700,
        clientY: 500,
        stopPropagation: () => undefined,
        currentTarget: { getBoundingClientRect: () => ({ left: 650, right: 750, top: 480, bottom: 528, width: 100, height: 48, x: 650, y: 480, toJSON: () => ({}) }) },
      });
    });
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("10:00");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("11:00");
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-09").props.className).toContain("inset-x-0");
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-09").props.className).toContain("z-[3]");
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-09").props.style.left).toBeUndefined();
    await click(renderer, "calendar-quick-create-dismiss");
    expect(bootstrapRanges.at(-1)).toBe("2026-11-08/2026-11-15");
    await click(renderer, "calendar-view-day");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(has(renderer, "calendar-day-view")).toBe(true);
    expect(bootstrapRanges.at(-1)).toBe("2026-11-09/2026-11-10");
    await click(renderer, "calendar-view-month");
    expect(has(renderer, "calendar-month-grid")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("clicking an empty week slot opens a half-hour quick create and more options preserves edits", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-view-week");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => {
      byId(renderer, "calendar-time-create-2026-11-10").props.onClick({
        detail: 1,
        clientX: 640,
        clientY: 624,
        currentTarget: { getBoundingClientRect: () => ({ left: 500, right: 700, top: 0, bottom: 1152, width: 200, height: 1152, x: 500, y: 0, toJSON: () => ({}) }) },
      });
    });
    expect(has(renderer, "calendar-quick-create")).toBe(true);
    expect(has(renderer, "calendar-quick-create-positioner")).toBe(true);
    expect(has(renderer, "calendar-quick-create-preview-2026-11-10")).toBe(true);
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-10").props["data-compact"]).toBe("true");
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-10").props.className).toContain("items-center");
    expect(byId(renderer, "calendar-quick-create-preview-2026-11-10").props.className).toContain("py-0");
    expect(text(byId(renderer, "calendar-quick-create-preview-2026-11-10"))).toContain("calendar.create_event");
    expect(text(byId(renderer, "calendar-quick-create-preview-2026-11-10"))).toContain("13:00 – 13:30");
    expect(has(renderer, "calendar-form-attendees-trigger")).toBe(true);
    expect(has(renderer, "calendar-form-video-conference")).toBe(true);
    expect(has(renderer, "calendar-form-description")).toBe(true);
    expect(has(renderer, "calendar-form-calendar")).toBe(true);
    expect(byId(renderer, "calendar-quick-more-options").props.className).toContain("color-mix");
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("13:00");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:30");
    expect(text(byId(renderer, "calendar-form-start-date"))).toContain("Nov 10, 2026");
    expect(text(byId(renderer, "calendar-form-end-date"))).toContain("Nov 10, 2026");

    await act(async () => { byId(renderer, "calendar-form-title").props.onChange({ target: { value: "Quick planning" } }); });
    await act(async () => { byId(renderer, "calendar-form-start-time").props.onChange({ target: { value: "14:00" } }); });
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("14:30");
    expect(text(byId(renderer, "calendar-quick-create-preview-2026-11-10"))).toContain("Quick planning");
    expect(text(byId(renderer, "calendar-quick-create-preview-2026-11-10"))).toContain("14:00 – 14:30");
    await click(renderer, "calendar-form-video-conference-remove");
    expect(has(renderer, "calendar-form-video-conference")).toBe(false);
    expect(has(renderer, "calendar-form-video-conference-add")).toBe(true);
    await act(async () => { byId(renderer, "calendar-form-description").props.onChange({ target: { value: "Quick notes" } }); });
    await click(renderer, "calendar-quick-more-options");

    expect(has(renderer, "calendar-quick-create")).toBe(false);
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Quick planning");
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("14:00");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("14:30");
    expect(text(byId(renderer, "calendar-form-start-date"))).toContain("Nov 10, 2026");
    expect(text(byId(renderer, "calendar-form-calendar"))).toContain("Ada");
    expect(byId(renderer, "calendar-form-description").props.value).toBe("Quick notes");
    expect(has(renderer, "calendar-form-video-conference")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("clicking empty space in a month cell opens an all-day quick create that can add the next half-hour", async () => {
  const { renderer } = await render();
  try {
    const cell = byId(renderer, "calendar-day-2026-11-10");
    const hitTarget = {};
    await act(async () => {
      cell.props.onClick({ target: hitTarget, currentTarget: hitTarget, clientX: 480, clientY: 260 });
    });

    expect(has(renderer, "calendar-quick-create")).toBe(true);
    expect(has(renderer, "calendar-month-quick-create-preview-2026-11-10")).toBe(true);
    expect(text(byId(renderer, "calendar-month-quick-create-preview-2026-11-10"))).toContain("calendar.create_event");
    expect(text(byId(renderer, "calendar-form-start-date"))).toContain("Nov 10, 2026");
    expect(text(byId(renderer, "calendar-form-end-date"))).toContain("Nov 10, 2026");
    expect(has(renderer, "calendar-form-start-time")).toBe(false);
    expect(has(renderer, "calendar-form-end-time")).toBe(false);
    expect(has(renderer, "calendar-quick-add-time")).toBe(true);

    await act(async () => { byId(renderer, "calendar-form-title").props.onChange({ target: { value: "Month planning" } }); });
    expect(text(byId(renderer, "calendar-month-quick-create-preview-2026-11-10"))).toContain("Month planning");

    await click(renderer, "calendar-quick-add-time");
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("12:30");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:00");
    expect(text(byId(renderer, "calendar-month-quick-create-preview-2026-11-10"))).toContain("12:30");
    expect(has(renderer, "calendar-quick-add-time")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("clicking a month event opens its detail without starting quick create", async () => {
  events = [calendarEvent("existing", { kind: "allDay", startDate: "2026-11-10", endDateExclusive: "2026-11-11" })];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-10-existing");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title existing");
    expect(has(renderer, "calendar-quick-create")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("defaults to week and restores the selected view after leaving and returning", async () => {
  values.delete(calendarViewStorageKey(calendarScope));
  const first = await render();
  try {
    expect(has(first.renderer, "calendar-week-view")).toBe(true);
    expect(byId(first.renderer, "calendar-view-week").props["aria-pressed"]).toBe(true);
    await click(first.renderer, "calendar-view-day");
    expect(has(first.renderer, "calendar-day-view")).toBe(true);
    expect(values.get(calendarViewStorageKey(calendarScope))).toBe("day");
  } finally { await act(async () => { first.renderer.unmount(); }); }

  const second = await render();
  try {
    expect(has(second.renderer, "calendar-day-view")).toBe(true);
    expect(byId(second.renderer, "calendar-view-day").props["aria-pressed"]).toBe(true);
  } finally { await act(async () => { second.renderer.unmount(); }); }
});

test("all-day details show a date range, timed details show local time and zone, text stays plain", async () => {
  events = [
    { ...calendarEvent("trip", { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-11" }), description: "Line one\n<b>not bold</b>" },
    calendarEvent("call", { kind: "timed", startInstant: "2026-11-09T06:00:00Z", endInstantExclusive: "2026-11-09T07:00:00Z", timeZone: "Asia/Shanghai" }, "cal-2"),
  ];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-trip");
    expect(text(byId(renderer, "calendar-event-detail-time"))).toBe("Nov 9, 2026 - Nov 10, 2026(calendar.all_day)");
    expect(has(renderer, "calendar-event-detail-zone")).toBe(false);
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Ada");
    expect(text(byId(renderer, "calendar-event-detail-description"))).toBe("Line one\n<b>not bold</b>");
    expect(byId(renderer, "calendar-event-detail").findAll((node) => node.type === "b")).toHaveLength(0);
    await click(renderer, "calendar-day-event-2026-11-09-call");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title call");
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Side project");
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

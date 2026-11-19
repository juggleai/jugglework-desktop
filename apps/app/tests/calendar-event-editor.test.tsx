import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import * as ReactDOM from "react-dom";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter, useLocation } from "react-router-dom";

import { DenApiError, type DenCalendar, type DenCalendarCollaborationList, type DenCalendarEvent, type DenCalendarSchedulingEvent } from "../src/app/lib/den";
import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";
import { CALENDAR_REMINDER_PREFERENCES_CHANGED, readCalendarReminderMinutes, writeCalendarReminderMinutes } from "../src/react-app/domains/calendar/calendar-reminder-preferences";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";
import { calendarViewStorageKey } from "../src/react-app/domains/calendar/calendar-view-model";
import type { Meeting } from "../src/react-app/domains/meeting/types";

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
const calendarScope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
mock.module("../src/react-app/shell/app-navigation-rail", () => ({ APP_NAVIGATION_RAIL_WIDTH: 48, AppNavigationRail: () => <nav /> }));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children, open, onOpenChange }: { children: React.ReactNode; open?: boolean; onOpenChange?: (open: boolean) => void }) => open === false ? null : <div data-testid="mock-dialog-root" data-close={() => onOpenChange?.(false)}>{children}</div>,
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
    return React.cloneElement(render, { onClick: () => onOpenChange?.(true), children } as React.HTMLAttributes<HTMLElement>);
  },
  PopoverContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
}));

const calendar = (id: string, name: string): DenCalendar => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", name, color: "#2563eb", isDefault: id === "cal-1",
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});

let calendars: DenCalendar[] = [];
let events: DenCalendarEvent[] = [];
type Call = { op: string; input: Record<string, unknown> };
const calls: Call[] = [];
/** Per-test server behaviour; returning undefined falls through to the default success path. */
let failNext: ((op: string) => unknown) | null = null;
let createGate: Promise<void> | null = null;
let version = 1;
let organizationMembers: Array<{ id: string; userId: string; role: "member"; user: { id: string; name: string; account: string; email: string; avatar: null } }> = [];
let availabilityBusy: Record<string, Array<{ startInstant: string; endInstantExclusive: string }>> = {};
let staleSchedulingRead = false;
let workspaceKind: "organization" | undefined;
const client = {
  listCalendars: async () => calendars,
  listCalendarCollaboration: async (): Promise<DenCalendarCollaborationList> => ({ items: [], authorizationGeneration: 1, reset: { mode: "replace", namespace: "calendar-collaboration" } }),
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => ({ calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" }),
  listCalendarSchedulingEvents: async () => ({ items: (staleSchedulingRead ? [] : events).filter((event) => "attendees" in event).map((event) => ({ event, occurrenceIndex: 1, time: event.time })) }),
  getCalendarSchedulingAvailability: async (_org: string, input: { memberIds: string[] }) => ({ members: input.memberIds.map((memberId) => ({ memberId, busy: availabilityBusy[memberId] ?? [] })) }),
  listOrganizationMembers: async () => ({ members: organizationMembers, total: organizationMembers.length, limit: 200, offset: 0 }),
  createCalendar: async () => { throw new Error("unexpected calendar write"); },
  updateCalendar: async () => { throw new Error("unexpected calendar write"); },
  deleteCalendar: async () => { throw new Error("unexpected calendar write"); },
  createCalendarEvent: async (_org: string, input: Record<string, unknown>) => {
    calls.push({ op: "create", input });
    const failure = failNext?.("create"); if (failure) throw failure;
    if (createGate) await createGate;
    const { idempotencyKey: _key, ...rest } = input;
    const created = { ...baseEvent(`new-${calls.length}`), ...rest, description: (rest.description as string) ?? "" } as DenCalendarEvent;
    events = [...events, created];
    return { event: created };
  },
  createCalendarSchedulingEvent: async (_org: string, input: Record<string, unknown>) => {
    calls.push({ op: "create", input });
    const failure = failNext?.("create"); if (failure) throw failure;
    if (createGate) await createGate;
    const existing = events.find((event) => (event as DenCalendarEvent & { _idempotencyKey?: string })._idempotencyKey === input.idempotencyKey);
    if (existing) return { event: existing, replayed: true };
    const { idempotencyKey: _key, ...rest } = input;
    const attendees = Array.isArray(rest.attendees) ? rest.attendees.map((attendee) => ({ ...(attendee as { memberId: string }), responseStatus: "needs-action" as const })) : [];
    const created = { ...baseEvent(`new-${calls.length}`), ...rest, attendees, recurrence: rest.recurrence ?? null, description: (rest.description as string) ?? "", status: "active", _idempotencyKey: input.idempotencyKey } as DenCalendarEvent;
    events = [...events, created];
    return { event: created, replayed: false };
  },
  updateCalendarSchedulingEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    calls.push({ op: "scheduling-update", input: { eventId, ...input } });
    const failure = failNext?.("update"); if (failure) throw failure;
    const current = events.find((event) => event.id === eventId)!;
    const { idempotencyKey: _key, expectedVersion: _v, attendees, ...patch } = input;
    const normalizedAttendees = Array.isArray(attendees) ? attendees.map((attendee) => ({ ...(attendee as { memberId: string }), responseStatus: "needs-action" as const })) : undefined;
    const updated = { ...current, ...patch, ...(normalizedAttendees ? { attendees: normalizedAttendees } : {}), recurrence: "recurrence" in patch ? patch.recurrence : "recurrence" in current ? current.recurrence : null, status: "active", version: current.version + 1 } as DenCalendarEvent;
    events = events.map((event) => event.id === eventId ? updated : event);
    return { event: updated, replayed: false };
  },
  deleteCalendarSchedulingEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    calls.push({ op: "scheduling-delete", input: { eventId, ...input } });
    const current = events.find((event) => event.id === eventId)! as DenCalendarSchedulingEvent;
    events = events.filter((event) => event.id !== eventId);
    return { event: null, tombstone: { entityType: "event", entityId: eventId, version: current.version + 1, deletedAt: "2026-11-09T05:00:00Z" }, replayed: false };
  },
  rsvpCalendarSchedulingEvent: async () => { throw new Error("unexpected RSVP"); },
  updateCalendarEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    calls.push({ op: "update", input });
    const failure = failNext?.("update"); if (failure) throw failure;
    const { idempotencyKey: _key, expectedVersion: _v, ...patch } = input;
    const current = events.find((event) => event.id === eventId)!;
    const updated = { ...current, ...patch, version: current.version + 1 } as DenCalendarEvent;
    events = events.map((event) => event.id === eventId ? updated : event);
    return { event: updated };
  },
  deleteCalendarEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    calls.push({ op: "delete", input });
    const failure = failNext?.("delete"); if (failure) throw failure;
    events = events.filter((event) => event.id !== eventId);
    return { deleted: true };
  },
};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", activeOrganization: { id: "org-a", orgMemberId: "member-a", kind: workspaceKind }, client }),
}));
const meetingCalls: Array<{ op: string; value?: unknown }> = [];
const createdMeeting: Meeting = {
  id: "meeting-1", code: "123456", organizationId: "org-a", title: "Title meeting-event", description: "Daily planning",
  sourceKind: "workbench", sourceId: "", organizerId: "user-a", hostId: "user-a", status: "live", version: 1,
  startAt: fixedNow.toString(), endAt: fixedNow.add({ minutes: 30 }).toString(), timezone: clock.timeZone(),
  locked: false, invites: {}, participants: {},
};
mock.module("../src/react-app/domains/meeting/api", () => ({
  meetingAPI: {
    settings: async () => { meetingCalls.push({ op: "settings" }); return { ready: true, settings: { enabled: true } }; },
    create: async (input: unknown, key: string) => { meetingCalls.push({ op: "create", value: { input, key } }); return { meeting: createdMeeting }; },
    notify: async (id: string) => { meetingCalls.push({ op: "notify", value: id }); },
  },
}));
const meetingState = {
  phase: "idle",
  join: async (meeting: Meeting, mic: boolean, camera: boolean) => { meetingCalls.push({ op: "join", value: { meeting, mic, camera } }); },
};
mock.module("../src/react-app/domains/meeting/store", () => ({
  useMeetingStore: Object.assign((select: (state: typeof meetingState) => unknown) => select(meetingState), { getState: () => meetingState }),
}));
mock.module("../src/react-app/domains/jugglechat/store", () => ({ useJuggleChatStore: (select: (state: { user: null }) => unknown) => select({ user: null }) }));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");
const { CalendarEventDetail } = await import("../src/react-app/domains/calendar/calendar-agenda");
const { CalendarEventCreateDialog } = await import("../src/react-app/domains/calendar/calendar-event-create-dialog");
const { t } = await import("../src/i18n");

function baseEvent(id: string): DenCalendarEvent {
  return {
    id, organizationId: "org-a", ownerMemberId: "member-a", calendarId: "cal-1", title: `Title ${id}`, description: "",
    time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" },
    version: version, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
}

beforeEach(() => {
  values.clear(); calls.length = 0; events = []; failNext = null; createGate = null; version = 1;
  values.set(calendarViewStorageKey(calendarScope), "month");
  organizationMembers = [];
  availabilityBusy = {};
  meetingCalls.length = 0;
  staleSchedulingRead = false;
  workspaceKind = undefined;
  calendars = [calendar("cal-1", "Personal"), calendar("cal-2", "Side project")];
});

function CurrentPath() { return <output data-testid="current-path">{useLocation().pathname}</output>; }

async function render(initialEntry: string | { pathname: string; state?: unknown } = "/calendar", options?: TestRenderer.TestRendererOptions) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => undefined;
  let renderer!: TestRenderer.ReactTestRenderer;
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <CurrentPath />
        <CalendarPage workspaceId="" sessionPath="/session" clock={clock} onOpenAccount={noop} onOpenApps={noop} onOpenChat={noop} onOpenReviews={noop} onOpenSettings={noop} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => { renderer = TestRenderer.create(tree(), options); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { renderer, queryClient };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.find((node) => node.props["data-testid"] === id);
const has = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const click = async (renderer: TestRenderer.ReactTestRenderer, id: string) => { await act(async () => { byId(renderer, id).props.onClick(); }); await settle(); };
const change = async (renderer: TestRenderer.ReactTestRenderer, id: string, value: string | boolean) => {
  if (id === "calendar-form-calendar" || id === "calendar-form-recurrence") {
    await click(renderer, id);
    await click(renderer, `${id}-option-${value}`);
    return;
  }
  await act(async () => { byId(renderer, id).props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } }); });
};
const submit = async (renderer: TestRenderer.ReactTestRenderer) => {
  await act(async () => { byId(renderer, "calendar-event-form").props.onSubmit({ preventDefault: () => undefined }); });
  await settle();
};
const formStatus = (renderer: TestRenderer.ReactTestRenderer) => byId(renderer, "calendar-event-form").props["data-status"];

test("cross-page create entry saves in place without desktop config", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return <CalendarEventCreateDialog open={open} onOpenChange={setOpen} now={clock.now} timeZone={clock.timeZone} />;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
  });
  await settle();
  try {
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(byId(renderer, "calendar-form-video-conference-remove")).toBeTruthy();
    await change(renderer, "calendar-form-title", "Scheduled from meetings");
    await submit(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "create", input: { calendarId: "cal-1", title: "Scheduled from meetings" } });
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("meeting reservation opens without a calendar snapshot or completed team discovery", async () => {
  workspaceKind = "organization";
  const bootstrap = spyOn(client, "getCalendarBootstrap").mockImplementation(() => new Promise(() => {}));
  let completeDiscovery!: (result: DenCalendarCollaborationList) => void;
  const discoveryResult = new Promise<DenCalendarCollaborationList>((resolve) => { completeDiscovery = resolve; });
  const discovery = spyOn(client, "listCalendarCollaboration").mockReturnValue(discoveryResult);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<QueryClientProvider client={queryClient}>
        <CalendarEventCreateDialog open onOpenChange={() => {}} now={clock.now} timeZone={clock.timeZone} />
      </QueryClientProvider>);
    });
    await settle();
    expect(bootstrap).not.toHaveBeenCalled();
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(has(renderer, "calendar-create-status-dialog")).toBe(false);
    expect(text(byId(renderer, "calendar-form-calendar"))).toContain("Personal");
    await change(renderer, "calendar-form-title", "Reservation in progress");

    const team = {
      ...calendar("team-editable", "Editable team"), kind: "team" as const, role: "editor" as const, authorizationVersion: 1,
      capabilities: { canViewFreeBusy: true, canViewDetails: true, canEditEvents: true, canManage: false },
    };
    await act(async () => { completeDiscovery({
      authorizationGeneration: 1,
      reset: { mode: "replace", namespace: "calendar-collaboration" },
      items: [team, { ...team, id: "team-read-only", role: "viewer", capabilities: { ...team.capabilities, canEditEvents: false } }],
    }); });
    await settle();
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Reservation in progress");
    await click(renderer, "calendar-form-calendar");
    expect(has(renderer, "calendar-form-calendar-option-team-editable")).toBe(true);
    expect(has(renderer, "calendar-form-calendar-option-team-read-only")).toBe(false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    bootstrap.mockRestore();
    discovery.mockRestore();
  }
});

test("meeting reservation offers a retry when the initial calendar list fails", async () => {
  const list = spyOn(client, "listCalendars").mockRejectedValueOnce(new Error("Calendar service unavailable"));
  const queryClient = new QueryClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<QueryClientProvider client={queryClient}>
        <CalendarEventCreateDialog open onOpenChange={() => {}} now={clock.now} timeZone={clock.timeZone} />
      </QueryClientProvider>);
    });
    await settle();
    expect(text(byId(renderer, "calendar-create-status-dialog"))).toContain(t("calendar.events_unavailable"));
    expect(list).toHaveBeenCalledTimes(1);
    await click(renderer, "calendar-create-retry");
    expect(list).toHaveBeenCalledTimes(2);
    expect(has(renderer, "calendar-event-form")).toBe(true);
  } finally {
    await act(async () => { renderer?.unmount(); });
    list.mockRestore();
  }
});

test("the cross-page create entry does not fetch or submit while offline", async () => {
  const navigatorState = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { onLine: false } });
  const bootstrap = spyOn(client, "getCalendarBootstrap");
  const list = spyOn(client, "listCalendars");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => {
      renderer = TestRenderer.create(<QueryClientProvider client={queryClient}>
        <CalendarEventCreateDialog open onOpenChange={() => {}} now={clock.now} timeZone={clock.timeZone} />
      </QueryClientProvider>);
    });
    expect(text(byId(renderer, "calendar-create-status-dialog"))).toContain(t("calendar.offline_form_unavailable"));
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(bootstrap).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  } finally {
    await act(async () => { renderer?.unmount(); });
    bootstrap.mockRestore();
    list.mockRestore();
    if (navigatorState) Object.defineProperty(globalThis, "navigator", navigatorState);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("creating a timed event shows it only after the authoritative response", async () => {
  staleSchedulingRead = true;
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    expect(byId(renderer, "calendar-event-dialog").props["aria-label"]).toBe(t("calendar.create_event"));
    expect(String(byId(renderer, "calendar-event-dialog").props.className)).toContain("sm:max-w-[960px]");
    expect(String(byId(renderer, "calendar-event-dialog").props.className)).toContain("bg-dls-sidebar");
    expect(byId(renderer, "calendar-form-title").props.placeholder).toBe(t("calendar.field_title_placeholder"));
    expect(byId(renderer, "calendar-form-all-day").props.checked).toBe(false);
    expect(text(byId(renderer, "calendar-form-attendees-trigger"))).not.toContain("member-a");
    expect(has(renderer, "calendar-availability-vertical-timeline")).toBe(true);
    await change(renderer, "calendar-form-title", "Planning");
    await change(renderer, "calendar-form-calendar", "cal-2");
    await submit(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ calendarId: "cal-2", title: "Planning", description: "", time: { kind: "timed", startInstant: "2026-11-09T04:30:00Z", endInstantExclusive: "2026-11-09T05:00:00Z", timeZone: "Asia/Shanghai" } });
    expect(calls[0]!.input).toMatchObject({ attendees: [{ memberId: "member-a" }], recurrence: null });
    expect(typeof calls[0]!.input.idempotencyKey).toBe("string");
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    await click(renderer, "calendar-day-event-2026-11-09-new-1");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Planning");
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Side project");
    expect(has(renderer, "calendar-day-event-2026-11-09-new-1")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("quick create saves the clicked half-hour slot through the authoritative create flow", async () => {
  staleSchedulingRead = true;
  values.set(calendarViewStorageKey(calendarScope), "week");
  const { renderer } = await render();
  try {
    await act(async () => {
      byId(renderer, "calendar-time-create-2026-11-09").props.onClick({
        detail: 1,
        clientX: 520,
        clientY: 624,
        currentTarget: { getBoundingClientRect: () => ({ left: 400, right: 600, top: 0, bottom: 1152, width: 200, height: 1152, x: 400, y: 0, toJSON: () => ({}) }) },
      });
    });
    expect(has(renderer, "calendar-quick-create")).toBe(true);
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("13:00");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:30");
    await change(renderer, "calendar-form-title", "Quick sync");
    await act(async () => { byId(renderer, "calendar-quick-create").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({
      calendarId: "cal-1",
      title: "Quick sync",
      time: { kind: "timed", startInstant: "2026-11-09T05:00:00Z", endInstantExclusive: "2026-11-09T05:30:00Z", timeZone: "Asia/Shanghai" },
      attendees: [{ memberId: "member-a" }],
      recurrence: null,
    });
    expect(has(renderer, "calendar-quick-create")).toBe(false);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    await act(async () => {
      byId(renderer, "calendar-time-event-2026-11-09-new-1").props.onClick({ detail: 1, clientX: 980, clientY: 740, currentTarget: { getBoundingClientRect: () => ({ left: 800, right: 990, top: 710, bottom: 750 }) } });
    });
    expect(byId(renderer, "calendar-event-panel").props.style).toMatchObject({ left: 444, top: 710, maxHeight: 576 });
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Quick sync");
    for (const [top, expected] of [[100, { top: 146 }], [600, { bottom: 174 }]] as const) {
      await click(renderer, "calendar-event-detail-close");
      await act(async () => {
        byId(renderer, "calendar-time-event-2026-11-09-new-1").props.onClick({
          currentTarget: { getBoundingClientRect: () => ({ left: 80, right: 990, top, bottom: top + 40 }) },
        });
      });
      expect(byId(renderer, "calendar-event-panel").props.style).toMatchObject({ left: 80, ...expected });
    }
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("saving succeeds when an availability query is already cached", async () => {
  organizationMembers = [{ id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
    await change(renderer, "calendar-form-title", "Cached availability");
    await submit(renderer);
    expect(has(renderer, "calendar-form-failure-network")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-09-new-1")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("the creator is implicit and is not offered in the attendee picker", async () => {
  organizationMembers = [{ id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-attendees-trigger");
    expect(has(renderer, "calendar-attendee-member-a")).toBe(false);
    expect(text(byId(renderer, "calendar-form-attendees-trigger"))).not.toContain("Ada");
    await change(renderer, "calendar-form-title", "Creator required");
    await submit(renderer);
    expect(calls[0]).toMatchObject({ op: "create", input: { attendees: [{ memberId: "member-a" }] } });
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("validation errors block the request and are announced per field", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "  ");
    await change(renderer, "calendar-form-end-time", "09:00");
    await submit(renderer);
    expect(calls).toHaveLength(0);
    expect(formStatus(renderer)).toBe("validation");
    expect(text(byId(renderer, "calendar-form-error-title"))).toBe(t("calendar.error_title_required"));
    expect(text(byId(renderer, "calendar-form-error-time"))).toBe(t("calendar.error_end_not_after_start"));
    expect(byId(renderer, "calendar-form-title").props["aria-invalid"]).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("dialog close requests cancel creation, but are ignored while a save is pending", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await act(async () => { byId(renderer, "mock-dialog-root").props["data-close"](); });
    await settle();
    expect(has(renderer, "calendar-event-dialog")).toBe(false);

    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Pending");
    let release!: () => void;
    createGate = new Promise<void>((resolve) => { release = resolve; });
    await act(async () => { void byId(renderer, "calendar-event-form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(formStatus(renderer)).toBe("pending");
    expect(byId(renderer, "calendar-form-cancel").props.disabled).toBe(true);
    await act(async () => { byId(renderer, "mock-dialog-root").props["data-close"](); });
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    await act(async () => { release(); });
    await settle();
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("timed inputs use 30-minute options and 09:00-09:30 sends a timed union", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Call");
    expect(byId(renderer, "calendar-form-all-day").props.checked).toBe(false);
    await click(renderer, "calendar-form-zone-trigger");
    expect(text(byId(renderer, "calendar-form-zone"))).toContain("Asia/Shanghai");
    expect(byId(renderer, "calendar-form-start-time").props.inputMode).toBe("numeric");
    await click(renderer, "calendar-form-start-time");
    expect(byId(renderer, "calendar-form-start-time-menu").findAll((node) => String(node.props["data-testid"] ?? "").startsWith("calendar-form-start-time-option-"))).toHaveLength(48);
    await click(renderer, "calendar-form-start-time-option-0900");
    await click(renderer, "calendar-form-end-time");
    await click(renderer, "calendar-form-end-time-option-0930");
    await submit(renderer);
    expect(calls[0]!.input.time).toEqual({ kind: "timed", startInstant: "2026-11-09T01:00:00Z", endInstantExclusive: "2026-11-09T01:30:00Z", timeZone: "Asia/Shanghai" });
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("meeting, growing description, reminder, and calendar controls follow the requested defaults", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    expect(has(renderer, "calendar-form-video-conference")).toBe(true);
    expect(has(renderer, "calendar-form-video-conference-add")).toBe(false);
    expect(byId(renderer, "calendar-form-description").props.rows).toBe(1);
    expect(byId(renderer, "calendar-form-description").props.placeholder).toBe(t("calendar.field_description_placeholder"));
    expect(text(byId(renderer, "calendar-form-reminder"))).toContain(t("calendar.reminder_minutes_before", { count: 5 }));
    expect(text(byId(renderer, "calendar-form-calendar"))).toBe("Personal");

    await click(renderer, "calendar-form-video-conference-remove");
    expect(has(renderer, "calendar-form-video-conference")).toBe(false);
    expect(has(renderer, "calendar-form-video-conference-add")).toBe(true);

    await click(renderer, "calendar-form-reminder-trigger");
    expect(has(renderer, "calendar-form-reminder-menu")).toBe(true);
    await click(renderer, "calendar-form-reminder-option-30");
    expect(text(byId(renderer, "calendar-form-reminder"))).toContain(t("calendar.reminder_minutes_before", { count: 30 }));
    await click(renderer, "calendar-form-reminder-remove");
    expect(text(byId(renderer, "calendar-form-reminder"))).toContain(t("calendar.reminder_add"));

    await change(renderer, "calendar-form-calendar", "cal-2");
    expect(text(byId(renderer, "calendar-form-calendar"))).toBe("Side project");
  } finally { await act(async () => { renderer.unmount(); }); }
});

// TestRenderer has no DOM container for portals. Keep the real dialog and its controls in the test tree.
function inlineMeetingDialog() {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  if (!originalElement) Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: class {} });
  Object.defineProperty(globalThis, "document", { configurable: true, value: Object.assign(new EventTarget(), { body: {}, querySelector: () => null }) });
  const portal = spyOn(ReactDOM, "createPortal").mockImplementation(children => children as React.ReactPortal);
  return () => {
    portal.mockRestore();
    if (!originalElement) Reflect.deleteProperty(globalThis, "HTMLElement");
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
  };
}

const meetingButton = (dialog: TestRenderer.ReactTestInstance, label: RegExp) =>
  dialog.find(node => node.type === "button" && label.test(node.props["aria-label"] || text(node)));
const dialogOptions: TestRenderer.TestRendererOptions = {
  createNodeMock(node) {
    if (node.type === "dialog") return { ownerDocument: document, showModal() {}, close() {} };
    if (node.type === "span") return { ownerDocument: document, closest: () => null };
    return null;
  },
};

test("calendar meeting preview keeps the route and detail; only confirmation creates, notifies and joins", async () => {
  organizationMembers = [
    { id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } },
    { id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben", account: "ben", email: "ben@example.com", avatar: null } },
  ];
  const event: DenCalendarSchedulingEvent = {
    ...baseEvent("meeting-event"), description: "Daily planning", videoConferenceEnabled: true, status: "active", recurrence: null,
    attendees: [{ memberId: "member-a", responseStatus: "accepted" }, { memberId: "member-b", responseStatus: "needs-action" }],
  };
  events = [event];
  const restoreDialog = inlineMeetingDialog();
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    ({ renderer } = await render("/calendar", dialogOptions));
    const preview = () => renderer.root.findByType("dialog");
    const expectCalendarDetail = () => {
      expect(text(byId(renderer, "current-path"))).toBe("/calendar");
      expect(text(byId(renderer, "calendar-event-detail-title"))).toBe(event.title);
    };
    await click(renderer, "calendar-day-event-2026-11-09-meeting-event");
    expect(has(renderer, "calendar-event-start-meeting")).toBe(true);
    await click(renderer, "calendar-event-start-meeting");
    expectCalendarDetail();
    expect(text(preview())).toContain("Title meeting-event");
    expect(meetingCalls).toEqual([]);
    await act(async () => { meetingButton(preview(), /^取消$/).props.onClick(); });
    expect(renderer.root.findAllByType("dialog")).toHaveLength(0);
    expectCalendarDetail();
    expect(meetingCalls).toEqual([]);

    await click(renderer, "calendar-event-start-meeting");
    expect(meetingCalls).toEqual([]);
    await act(async () => { meetingButton(preview(), /^开始会议$/).props.onClick(); });
    expect(meetingCalls).toEqual([
      { op: "settings" },
      { op: "create", value: { key: expect.any(String), input: expect.objectContaining({
        title: event.title, description: event.description, invitees: ["user-b"], immediate: true,
        startAt: "2026-11-09T04:00:00Z", endAt: "2026-11-09T04:30:00Z", timezone: "Asia/Shanghai",
      }) } },
      { op: "notify", value: "meeting-1" },
      { op: "join", value: { meeting: createdMeeting, mic: false, camera: false } },
    ]);
    expect(renderer.root.findAllByType("dialog")).toHaveLength(0);
    expectCalendarDetail();
    await click(renderer, "calendar-event-detail-dismiss-layer");
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally {
    await act(async () => { renderer?.unmount(); });
    restoreDialog();
  }
});

test("calendar prejoin waits for the created meeting before joining, even on a repeated confirmation", async () => {
  const { MeetingPrejoin } = await import("../src/react-app/domains/meeting/meeting-page");
  const restoreDialog = inlineMeetingDialog();
  const close = mock(() => {});
  let resolve!: (meeting: Meeting) => void;
  const pending = new Promise<Meeting>(done => { resolve = done; });
  const start = mock(() => pending);
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<MeetingPrejoin calendarTitle="Planning" startCalendarMeeting={start} onClose={close} />, dialogOptions); });
    expect(start).not.toHaveBeenCalled();
    const confirm = meetingButton(renderer.root.findByType("dialog"), /^开始会议$/);
    await act(async () => { confirm.props.onClick(); confirm.props.onClick(); });
    expect(start).toHaveBeenCalledTimes(1);
    expect(confirm.props.disabled).toBe(true);
    expect(meetingCalls).toEqual([]);
    expect(close).not.toHaveBeenCalled();
    await act(async () => { resolve(createdMeeting); });
    expect(meetingCalls).toEqual([{ op: "join", value: { meeting: createdMeeting, mic: false, camera: false } }]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    restoreDialog();
  }
});

test("prejoin for an existing meeting joins it directly without creating or notifying", async () => {
  const { MeetingPrejoin } = await import("../src/react-app/domains/meeting/meeting-page");
  const restoreDialog = inlineMeetingDialog();
  const close = mock(() => {});
  let renderer!: TestRenderer.ReactTestRenderer;
  try {
    await act(async () => { renderer = TestRenderer.create(<MeetingPrejoin meeting={createdMeeting} onClose={close} />); });
    const dialog = renderer.root.findByProps({ role: "dialog", "aria-modal": "true" });
    expect(text(dialog)).toContain(createdMeeting.code);
    expect(meetingCalls).toEqual([]);
    await act(async () => { meetingButton(dialog, /^加入会议$/).props.onClick(); });
    expect(meetingCalls).toEqual([{ op: "join", value: { meeting: createdMeeting, mic: false, camera: false } }]);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => renderer?.unmount());
    restoreDialog();
  }
});

test("availability lays attendees left to right and busy intervals top to bottom", async () => {
  organizationMembers = [
    { id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } },
    { id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben", account: "ben", email: "ben@example.com", avatar: null } },
  ];
  availabilityBusy = { "member-a": [{ startInstant: "2026-11-08T17:00:00Z", endInstantExclusive: "2026-11-08T18:00:00Z" }] };
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-attendees-trigger");
    await click(renderer, "calendar-attendee-member-b");
    expect(has(renderer, "calendar-availability-loading")).toBe(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await settle();
    expect(has(renderer, "calendar-availability-vertical-timeline")).toBe(true);
    expect(text(byId(renderer, "calendar-availability-member-member-a"))).toContain("Ada");
    expect(text(byId(renderer, "calendar-availability-member-member-b"))).toContain("Ben");
    expect(text(byId(renderer, "calendar-attendee-list"))).toContain(t("calendar.attendees_count", { count: 2 }));
    expect(byId(renderer, "calendar-attendee-availability-member-b").props["aria-pressed"]).toBe(true);
    const busy = byId(renderer, "calendar-busy-member-a-0");
    expect(busy.props.style.top).toBe("4.166666666666666%");
    expect(busy.props.style.height).toBe("4.166666666666666%");
    expect(busy.props.style.left).toBeUndefined();

    await click(renderer, "calendar-attendee-availability-member-b");
    expect(byId(renderer, "calendar-attendee-availability-member-b").props["aria-pressed"]).toBe(false);
    expect(has(renderer, "calendar-availability-member-member-b")).toBe(false);
    expect(has(renderer, "calendar-selected-attendee-member-b")).toBe(true);

    await click(renderer, "calendar-selected-attendee-remove-member-b");
    expect(has(renderer, "calendar-selected-attendee-member-b")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("created attendee event keeps every selected member in detail and when editing again", async () => {
  organizationMembers = [
    { id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } },
    { id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben", account: "ben", email: "ben@example.com", avatar: null } },
  ];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Two-person planning");
    await click(renderer, "calendar-form-attendees-trigger");
    await click(renderer, "calendar-attendee-member-b");
    expect(text(byId(renderer, "calendar-attendee-list"))).toContain(t("calendar.attendees_count", { count: 2 }));
    await submit(renderer);

    expect(calls[0]).toMatchObject({ op: "create", input: { attendees: [{ memberId: "member-a" }, { memberId: "member-b" }] } });
    await click(renderer, "calendar-day-event-2026-11-09-new-1");
    expect(text(byId(renderer, "calendar-event-detail-attendees"))).toContain("Ada");
    expect(text(byId(renderer, "calendar-event-detail-attendees"))).toContain("Ben");
    expect(text(byId(renderer, "calendar-event-detail"))).toContain(t("calendar.attendees_count", { count: 2 }));

    await click(renderer, "calendar-event-detail-edit");
    expect(text(byId(renderer, "calendar-attendee-list"))).toContain(t("calendar.attendees_count", { count: 2 }));
    expect(has(renderer, "calendar-selected-attendee-member-a")).toBe(true);
    expect(has(renderer, "calendar-selected-attendee-member-b")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("availability marks the current time only when viewing today", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-availability-today");
    expect(has(renderer, "calendar-availability-now")).toBe(true);
    expect(String(byId(renderer, "calendar-availability-now").props.style.top)).toMatch(/%$/);
    await click(renderer, "calendar-availability-next");
    expect(has(renderer, "calendar-availability-now")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("09:17 is rejected without sending a request", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Invalid time");
    expect(byId(renderer, "calendar-form-all-day").props.checked).toBe(false);
    await change(renderer, "calendar-form-start-time", "09:17");
    await change(renderer, "calendar-form-end-time", "10:00");
    await submit(renderer);
    expect(calls).toHaveLength(0);
    expect(formStatus(renderer)).toBe("validation");
    expect(text(byId(renderer, "calendar-form-error-time"))).toBe(t("calendar.error_time_invalid"));
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("recurring creates and core event upgrades use the complete scheduling PATCH contract", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Weekly planning");
    await change(renderer, "calendar-form-recurrence", "weekly");
    await submit(renderer);
    expect(calls[0]).toMatchObject({ op: "create", input: { attendees: [{ memberId: "member-a" }], recurrence: { frequency: "weekly", interval: 1, end: { kind: "never" } } } });

    events = [baseEvent("core-event")];
    organizationMembers = [{ id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben", account: "ben", email: "ben@example.com", avatar: null } }];
    const { renderer: editor } = await render();
    try {
      await click(editor, "calendar-day-event-2026-11-09-core-event");
      await click(editor, "calendar-event-detail-edit");
      await click(editor, "calendar-form-attendees-trigger");
      await click(editor, "calendar-attendee-member-b");
      await change(editor, "calendar-form-recurrence", "monthly");
      await submit(editor);
      const patch = calls.at(-1)!;
      expect(patch).toMatchObject({ op: "scheduling-update", input: { eventId: "core-event", expectedVersion: 1, attendees: [{ memberId: "member-a" }, { memberId: "member-b" }], recurrence: { frequency: "monthly", interval: 1, end: { kind: "never" } } } });
      expect(typeof patch.input.idempotencyKey).toBe("string");
      expect(Object.keys(patch.input).sort()).toEqual(["attendees", "eventId", "expectedVersion", "idempotencyKey", "recurrence"]);
      expect(patch.input).not.toHaveProperty("status");
    } finally { await act(async () => { editor.unmount(); }); }
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("editing with attendees re-seeds an evicted canonical event before scheduling PATCH", async () => {
  events = [baseEvent("core-event")];
  organizationMembers = [{ id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben", account: "ben", email: "ben@example.com", avatar: null } }];
  const { renderer, queryClient } = await render();
  try {
    const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
    await click(renderer, "calendar-day-event-2026-11-09-core-event");
    await click(renderer, "calendar-event-detail-edit");
    queryClient.removeQueries({ queryKey: calendarQueryKeys.event(scope, "core-event"), exact: true });
    expect(queryClient.getQueryData(calendarQueryKeys.event(scope, "core-event"))).toBeUndefined();
    await click(renderer, "calendar-form-attendees-trigger");
    await click(renderer, "calendar-attendee-member-b");
    await submit(renderer);
    expect(calls.at(-1)).toMatchObject({ op: "scheduling-update", input: { eventId: "core-event", expectedVersion: 1, attendees: [{ memberId: "member-a" }, { memberId: "member-b" }] } });
    expect(has(renderer, "calendar-form-failure-network")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("editor deletes a scheduling aggregate through scheduling API", async () => {
  events = [{ ...baseEvent("scheduled"), status: "active", attendees: [{ memberId: "member-a", responseStatus: "accepted" }], recurrence: null } satisfies DenCalendarSchedulingEvent];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-scheduled");
    await click(renderer, "calendar-event-detail-edit");
    await click(renderer, "calendar-form-delete");
    await click(renderer, "calendar-form-delete-confirm-button");
    expect(calls.at(-1)).toMatchObject({ op: "scheduling-delete", input: { eventId: "scheduled", expectedVersion: 1, scope: "this", occurrence: { occurrenceIndex: 1, startDate: "2026-11-09" } } });
    expect(calls.some((call) => call.op === "delete")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a network failure keeps the draft, never reports saved, and retry reuses the idempotency key", async () => {
  const { renderer } = await render();
  try {
    failNext = () => new TypeError("Failed to fetch");
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Offline-ish");
    await submit(renderer);
    // Built-in retries run with a 1s delay; wait for them to exhaust.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    expect(formStatus(renderer)).toBe("failed");
    expect(has(renderer, "calendar-form-failure-network")).toBe(true);
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Offline-ish");
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    const firstKey = calls[0]!.input.idempotencyKey;
    expect(calls.every((call) => call.input.idempotencyKey === firstKey)).toBe(true);
    failNext = null;
    await submit(renderer);
    expect(calls.at(-1)!.input.idempotencyKey).toBe(firstKey);
    const created = events.find((event) => event.title === "Offline-ish");
    expect(created).toBeDefined();
    expect(has(renderer, `calendar-day-event-2026-11-09-${created!.id}`)).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
}, 10_000);

test("editing sends only changed fields with the loaded version", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    expect(has(renderer, "calendar-event-detail")).toBe(true);
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
    await click(renderer, "calendar-event-detail-edit");
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    await change(renderer, "calendar-form-title", "Renamed");
    await submit(renderer);
    expect(calls[0]).toMatchObject({ op: "scheduling-update", input: { eventId: "e1", title: "Renamed", expectedVersion: 1, attendees: [{ memberId: "member-a" }] } });
    expect(Object.keys(calls[0]!.input).sort()).toEqual(["attendees", "eventId", "expectedVersion", "idempotencyKey", "title"]);
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Renamed");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a version conflict keeps my edits and offers explicit resolution", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine");
    const theirs = { ...baseEvent("e1"), title: "Theirs", version: 2 };
    failNext = (op) => op === "update" && calls.length === 1 ? new DenApiError(409, "calendar_version_conflict", "conflict", { current: theirs }) : null;
    await submit(renderer);
    expect(formStatus(renderer)).toBe("conflict");
    expect(byId(renderer, "calendar-form-save").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Mine");
    events = [theirs];
    await click(renderer, "calendar-form-conflict-keep-mine");
    await submit(renderer);
    expect(calls[1]).toMatchObject({ op: "scheduling-update", input: { eventId: "e1", title: "Mine", expectedVersion: 2, attendees: [{ memberId: "member-a" }] } });
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Mine");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a background scheduling refresh preserves edits and requires explicit conflict resolution", async () => {
  events = [baseEvent("e1")];
  const { renderer, queryClient } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine");
    events = [{
      ...baseEvent("e1"),
      title: "Theirs",
      version: 2,
      status: "active",
      attendees: [{ memberId: "member-b", responseStatus: "needs-action" }],
      recurrence: null,
    }];
    await act(async () => { await queryClient.invalidateQueries(); });
    await settle();
    expect(formStatus(renderer)).toBe("conflict");
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Mine");
    expect(byId(renderer, "calendar-form-save").props.disabled).toBe(true);
    await click(renderer, "calendar-form-conflict-keep-mine");
    await submit(renderer);
    expect(calls.at(-1)).toMatchObject({ op: "scheduling-update", input: { eventId: "e1", title: "Mine", expectedVersion: 2 } });
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a scheduling refresh that removes the last attendee still requires explicit conflict resolution", async () => {
  events = [baseEvent("e1")];
  const { renderer, queryClient } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine");
    events = [{
      ...baseEvent("e1"),
      title: "Theirs",
      version: 2,
      status: "active",
      attendees: [],
      recurrence: null,
    }];
    await act(async () => { await queryClient.invalidateQueries(); });
    await settle();
    expect(formStatus(renderer)).toBe("conflict");
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Mine");
    expect(byId(renderer, "calendar-form-save").props.disabled).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("use-latest on conflict replaces the form with the server version", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine");
    failNext = () => new DenApiError(409, "calendar_version_conflict", "conflict", { current: { ...baseEvent("e1"), title: "Theirs", version: 2 } });
    await submit(renderer);
    await click(renderer, "calendar-form-conflict-use-latest");
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Theirs");
    expect(formStatus(renderer)).toBe("editing");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("rejects a conflict payload for a different event instead of caching or rebasing it", async () => {
  events = [baseEvent("e1")];
  const { renderer, queryClient } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine");
    failNext = () => new DenApiError(409, "calendar_version_conflict", "conflict", { current: { ...baseEvent("other"), title: "Secret", version: 2 } });
    await submit(renderer);
    expect(formStatus(renderer)).toBe("failed");
    expect(has(renderer, "calendar-form-failure-network")).toBe(true);
    const scope = createCalendarScope({ deploymentBaseUrl: "https://den.example/api", organizationId: "org-a", memberId: "member-a" })!;
    expect(queryClient.getQueryData(calendarQueryKeys.event(scope, "other"))).toBeUndefined();
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("delete requires confirmation and removes the event only after the server accepts", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await click(renderer, "calendar-form-delete");
    expect(calls).toHaveLength(0);
    await click(renderer, "calendar-form-delete-confirm-button");
    await settle();
    expect(calls[0]).toMatchObject({ op: "delete", input: { expectedVersion: 1 } });
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    expect(has(renderer, "calendar-day-event-2026-11-09-e1")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("an auth failure is reported without claiming the save happened", async () => {
  const { renderer } = await render();
  try {
    failNext = () => new DenApiError(403, "forbidden", "no");
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "X");
    await submit(renderer);
    expect(calls).toHaveLength(1);
    expect(has(renderer, "calendar-form-failure-auth")).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
});


test("date selection preserves duration and availability navigation does not change the event", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-start-date");
    await click(renderer, "calendar-form-start-date-day-2026-11-12");
    expect(has(renderer, "calendar-form-start-date-menu")).toBe(false);
    const startLabel = text(byId(renderer, "calendar-form-start-date"));
    expect(text(byId(renderer, "calendar-form-end-date"))).toBe(startLabel);
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:00");
    expect(has(renderer, "calendar-availability-selection")).toBe(true);
    await click(renderer, "calendar-availability-next");
    expect(has(renderer, "calendar-availability-selection")).toBe(false);
    expect(text(byId(renderer, "calendar-form-start-date"))).toBe(startLabel);
    await click(renderer, "calendar-availability-previous");
    expect(has(renderer, "calendar-availability-selection")).toBe(true);
    await change(renderer, "calendar-form-title", "Moved meeting");
    await submit(renderer);
    expect(calls[0]!.input.time).toMatchObject({ startInstant: "2026-11-12T04:30:00Z", endInstantExclusive: "2026-11-12T05:00:00Z" });
  } finally { await act(async () => renderer.unmount()); }
});

test("all-day end dates are inclusive in the picker and exclusive in the API", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-all-day", true);
    expect(text(byId(renderer, "calendar-form-start-date"))).toBe(text(byId(renderer, "calendar-form-end-date")));
    await click(renderer, "calendar-form-end-date");
    await click(renderer, "calendar-form-end-date-day-2026-11-11");
    await change(renderer, "calendar-form-title", "Three days");
    await submit(renderer);
    expect(calls[0]!.input.time).toEqual({ kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-12" });
  } finally { await act(async () => renderer.unmount()); }
});

test("Escape dismisses a date menu without cancelling the form, and time arrows do not submit", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-start-date");
    await act(async () => byId(renderer, "calendar-form-start-date-menu").props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
    expect(has(renderer, "calendar-form-start-date-menu")).toBe(false);
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    await act(async () => byId(renderer, "calendar-form-start-time").props.onKeyDown({ key: "ArrowDown", preventDefault() {}, stopPropagation() {} }));
    expect(byId(renderer, "calendar-form-start-time").props.value).toBe("13:00");
    expect(byId(renderer, "calendar-form-end-time").props.value).toBe("13:30");
    await act(async () => byId(renderer, "calendar-form-start-time").props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation() {} }));
    expect(has(renderer, "calendar-form-start-time-menu")).toBe(false);
    expect(calls).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});

test("multiple reminders can be changed and removed independently, including removing every row", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    expect(has(renderer, "calendar-form-reminder-add")).toBe(true);
    await click(renderer, "calendar-form-reminder-add");
    await click(renderer, "calendar-form-reminder-add");
    expect(text(byId(renderer, "calendar-form-reminder-row-0"))).toContain(t("calendar.reminder_minutes_before", { count: 5 }));
    expect(text(byId(renderer, "calendar-form-reminder-row-1"))).toContain(t("calendar.reminder_minutes_before", { count: 15 }));
    expect(text(byId(renderer, "calendar-form-reminder-row-2"))).toContain(t("calendar.reminder_minutes_before", { count: 30 }));
    await click(renderer, "calendar-form-reminder-trigger-1");
    expect(has(renderer, "calendar-form-reminder-option-5-1")).toBe(false);
    await click(renderer, "calendar-form-reminder-option-60-1");
    expect(has(renderer, "calendar-form-reminder-menu-1")).toBe(false);
    expect(text(byId(renderer, "calendar-form-reminder-row-1"))).toContain(t("calendar.reminder_hours_before", { count: 1 }));
    expect(text(byId(renderer, "calendar-form-reminder-row-0"))).toContain(t("calendar.reminder_minutes_before", { count: 5 }));
    await click(renderer, "calendar-form-reminder-remove");
    expect(has(renderer, "calendar-form-reminder-row-0")).toBe(false);
    expect(text(byId(renderer, "calendar-form-reminder-row-1"))).toContain(t("calendar.reminder_hours_before", { count: 1 }));
    await click(renderer, "calendar-form-reminder-trigger-2");
    await click(renderer, "calendar-form-reminder-option-120-2");
    expect(text(byId(renderer, "calendar-form-reminder-row-2"))).toContain(t("calendar.reminder_hours_before", { count: 2 }));
    await click(renderer, "calendar-form-reminder-remove-1");
    await click(renderer, "calendar-form-reminder-remove-2");
    expect(has(renderer, "calendar-form-reminder-row-1")).toBe(false);
    expect(has(renderer, "calendar-form-reminder-row-2")).toBe(false);
    await click(renderer, "calendar-form-reminder-add");
    expect(text(byId(renderer, "calendar-form-reminder-row-3"))).toContain(t("calendar.reminder_minutes_before", { count: 5 }));
    expect(calls).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});

test("reminders survive reopening; failed edits preserve them and reminder-only save can clear them", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Personal reminders");
    await click(renderer, "calendar-form-reminder-trigger");
    await click(renderer, "calendar-form-reminder-option-0");
    await click(renderer, "calendar-form-reminder-add");
    await submit(renderer);
    const eventId = events[0]!.id;
    expect(readCalendarReminderMinutes(calendarScope, eventId)).toEqual([0, 5]);

    const edit = async () => {
      await click(renderer, `calendar-day-event-2026-11-09-${eventId}`);
      await click(renderer, "calendar-event-detail-edit");
    };
    await edit();
    expect(text(byId(renderer, "calendar-form-reminder-trigger"))).toBe(t("calendar.reminder_at_start"));
    await click(renderer, "calendar-form-reminder-remove");
    await click(renderer, "calendar-form-reminder-remove-1");
    await change(renderer, "calendar-form-title", "Rejected title");
    failNext = () => new DenApiError(403, "forbidden", "update rejected");
    await submit(renderer);
    expect(formStatus(renderer)).toBe("failed");
    expect(readCalendarReminderMinutes(calendarScope, eventId)).toEqual([0, 5]);

    await change(renderer, "calendar-form-title", "Personal reminders");
    const writes = calls.length;
    await submit(renderer);
    expect(calls).toHaveLength(writes);
    expect(readCalendarReminderMinutes(calendarScope, eventId)).toEqual([]);
    await edit();
    expect(has(renderer, "calendar-form-reminder-trigger")).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});

test("occurrence details share series reminders only within the same scope", async () => {
  const seriesId = "series:计划/1";
  writeCalendarReminderMinutes(calendarScope, seriesId, [60, 0, 60]);
  const detail = (index: number, scope = calendarScope) => <CalendarEventDetail
    scope={scope} recurringOccurrence event={baseEvent(`scheduling:${encodeURIComponent(seriesId)}:${index}`)}
    calendar={calendars[0]} locale="en" onClose={() => {}} />;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(detail(1)); });
  try {
    const labels = () => byId(renderer, "calendar-event-detail-reminder").findAllByType("li").map(text);
    expect(labels()).toEqual([t("calendar.reminder_hours_before", { count: 1 }), t("calendar.reminder_at_start")]);
    await act(async () => renderer.update(detail(2)));
    expect(labels()).toHaveLength(2);
    for (const field of ["memberId", "organizationId", "deployment"] as const) {
      await act(async () => renderer.update(detail(1, { ...calendarScope, [field]: "other" })));
      expect(labels()).toEqual([t("calendar.reminder_minutes_before", { count: 5 })]);
    }
    expect(readCalendarReminderMinutes(calendarScope, `${seriesId}-other`)).toEqual([5]);
    writeCalendarReminderMinutes(calendarScope, seriesId, []);
    await act(async () => renderer.update(detail(1)));
    expect(has(renderer, "calendar-event-detail-reminder")).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});

test("preference change notification contains the persisted unique minutes and original event id", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  const target = new EventTarget();
  const listener = mock((event: Event) => {
    expect((event as CustomEvent).detail).toEqual({ scope: calendarScope, eventId: "series", minutes: [15] });
    expect(readCalendarReminderMinutes(calendarScope, "series")).toEqual([15]);
  });
  target.addEventListener(CALENDAR_REMINDER_PREFERENCES_CHANGED, listener);
  Object.defineProperty(globalThis, "window", { configurable: true, value: target });
  try {
    writeCalendarReminderMinutes(calendarScope, "series", [15, 15]);
    expect(listener).toHaveBeenCalledTimes(1);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

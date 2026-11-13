import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenCalendar, type DenCalendarEvent } from "../src/app/lib/den";
import { calendarQueryKeys } from "../src/react-app/domains/calendar/calendar-query-keys";
import { createCalendarScope } from "../src/react-app/domains/calendar/calendar-scope";

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
const client = {
  listCalendars: async () => calendars,
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => ({ calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" }),
  listCalendarSchedulingEvents: async () => ({ items: events.filter((event) => "attendees" in event).map((event) => ({ event, occurrenceIndex: 1, time: event.time })) }),
  getCalendarSchedulingAvailability: async (_org: string, input: { memberIds: string[] }) => ({ members: input.memberIds.map((memberId) => ({ memberId, busy: [] })) }),
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
    const { idempotencyKey: _key, ...rest } = input;
    const created = { ...baseEvent(`new-${calls.length}`), ...rest, description: (rest.description as string) ?? "", status: "active" } as DenCalendarEvent;
    events = [...events, created];
    return { event: created, replayed: false };
  },
  updateCalendarSchedulingEvent: async (_org: string, eventId: string, input: Record<string, unknown>) => {
    calls.push({ op: "scheduling-update", input: { eventId, ...input } });
    const failure = failNext?.("update"); if (failure) throw failure;
    const current = events.find((event) => event.id === eventId)!;
    const { idempotencyKey: _key, expectedVersion: _v, attendees, ...patch } = input;
    const updated = { ...current, ...patch, ...(attendees ? { attendees } : {}), status: "active", version: current.version + 1 } as DenCalendarEvent;
    events = events.map((event) => event.id === eventId ? updated : event);
    return { event: updated, replayed: false };
  },
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
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", activeOrganization: { id: "org-a", orgMemberId: "member-a" }, client }),
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => ({ loading: false, config: { calendarEnabled: true, calendarWriteEnabled: true } }),
}));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");
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
  organizationMembers = [];
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
  return { renderer, queryClient };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.find((node) => node.props["data-testid"] === id);
const has = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const click = async (renderer: TestRenderer.ReactTestRenderer, id: string) => { await act(async () => { byId(renderer, id).props.onClick(); }); await settle(); };
const change = async (renderer: TestRenderer.ReactTestRenderer, id: string, value: string | boolean) => {
  await act(async () => { byId(renderer, id).props.onChange({ target: typeof value === "boolean" ? { checked: value } : { value } }); });
};
const submit = async (renderer: TestRenderer.ReactTestRenderer) => {
  await act(async () => { byId(renderer, "calendar-event-form").props.onSubmit({ preventDefault: () => undefined }); });
  await settle();
};
const formStatus = (renderer: TestRenderer.ReactTestRenderer) => byId(renderer, "calendar-event-form").props["data-status"];

test("creating an all-day event shows it only after the authoritative response", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    expect(byId(renderer, "calendar-event-dialog").props["aria-label"]).toBe(t("calendar.create_event"));
    expect(String(byId(renderer, "calendar-event-dialog").props.className)).toContain("sm:max-w-[1120px]");
    expect(String(byId(renderer, "calendar-event-dialog").props.className)).toContain("bg-dls-sidebar");
    expect(String(byId(renderer, "calendar-form-time-grid").props.className)).toContain("grid-cols-1");
    expect(String(byId(renderer, "calendar-form-time-grid").props.className)).toContain("sm:grid-cols-2");
    expect(text(byId(renderer, "calendar-form-attendees-trigger"))).toContain("member-a");
    await change(renderer, "calendar-form-title", "Planning");
    await change(renderer, "calendar-form-calendar", "cal-2");
    await submit(renderer);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toMatchObject({ calendarId: "cal-2", title: "Planning", description: "", time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" } });
    expect(calls[0]!.input).toMatchObject({ attendees: [{ memberId: "member-a" }], recurrence: null });
    expect(typeof calls[0]!.input.idempotencyKey).toBe("string");
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
    expect(has(renderer, "calendar-event-panel")).toBe(true);
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Planning");
    expect(text(byId(renderer, "calendar-event-detail-calendar"))).toBe("Side project");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("the creator is selected and cannot be removed from a personal event", async () => {
  organizationMembers = [{ id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada", account: "ada", email: "ada@example.com", avatar: null } }];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await click(renderer, "calendar-form-attendees-trigger");
    const creator = byId(renderer, "calendar-attendee-member-a");
    expect(creator.props.disabled).toBe(true);
    expect(creator.props["aria-disabled"]).toBe(true);
    await act(async () => { creator.props.onClick?.(); });
    expect(text(byId(renderer, "calendar-form-attendees-trigger"))).toContain("Ada");
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
    await change(renderer, "calendar-form-end-date", "2026-11-09");
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
    expect(has(renderer, "calendar-event-detail")).toBe(true);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("timed inputs use 30-minute options and 09:00-09:30 sends a timed union", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Call");
    await change(renderer, "calendar-form-all-day", false);
    expect(text(byId(renderer, "calendar-form-zone"))).toContain("Asia/Shanghai");
    expect(byId(renderer, "calendar-form-start-time").props.step).toBe(1800);
    expect(byId(renderer, "calendar-form-end-time").props.step).toBe(1800);
    expect(byId(renderer, "calendar-time-options").findAllByType("option")).toHaveLength(48);
    await change(renderer, "calendar-form-start-time", "09:00");
    await change(renderer, "calendar-form-end-time", "09:30");
    await submit(renderer);
    expect(calls[0]!.input.time).toEqual({ kind: "timed", startInstant: "2026-11-09T01:00:00Z", endInstantExclusive: "2026-11-09T01:30:00Z", timeZone: "Asia/Shanghai" });
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("09:17 is rejected without sending a request", async () => {
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-create-event");
    await change(renderer, "calendar-form-title", "Invalid time");
    await change(renderer, "calendar-form-all-day", false);
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
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Offline-ish");
  } finally { await act(async () => { renderer.unmount(); }); }
}, 10_000);

test("editing sends only changed fields with the loaded version", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    expect(has(renderer, "calendar-event-dialog")).toBe(false);
    expect(has(renderer, "calendar-event-panel")).toBe(true);
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

import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenCalendar, type DenCalendarEvent } from "../src/app/lib/den";

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
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, showCloseButton: _showCloseButton, finalFocus: _finalFocus, ...props }: React.ComponentProps<"section"> & { showCloseButton?: boolean; finalFocus?: unknown }) => <section {...props}>{children}</section>,
  DialogDescription: (props: React.ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogHeader: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogTitle: (props: React.ComponentProps<"h2">) => <h2 {...props} />,
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
let version = 1;
const client = {
  listCalendars: async () => calendars,
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => ({ calendars, events, coverage: { ...range, calendarIds: [] }, cursor: "c1" }),
  listCalendarSchedulingEvents: async () => ({ items: [] }),
  createCalendar: async () => { throw new Error("unexpected calendar write"); },
  updateCalendar: async () => { throw new Error("unexpected calendar write"); },
  deleteCalendar: async () => { throw new Error("unexpected calendar write"); },
  createCalendarEvent: async (_org: string, input: Record<string, unknown>) => {
    calls.push({ op: "create", input });
    const failure = failNext?.("create"); if (failure) throw failure;
    const { idempotencyKey: _key, ...rest } = input;
    const created = { ...baseEvent(`new-${calls.length}`), ...rest, description: (rest.description as string) ?? "" } as DenCalendarEvent;
    events = [...events, created];
    return { event: created };
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

// Minimal focus model for react-test-renderer: refs are fake nodes that record focus.
let activeNode: { id: string } | null = null;
const fakeDocument = {
  get activeElement() { return activeNode; },
  body: { id: "body" },
  querySelector: (selector: string) => selector.includes("data-calendar-selected-day") ? selectedDayNode : null,
};
let selectedDayNode: FakeNode | null = null;
class FakeNode {
  constructor(readonly id: string) {}
  isConnected = true;
  focus() { activeNode = this; }
}
const globals = globalThis as unknown as { HTMLElement?: unknown; document?: unknown };
const previousGlobals = { HTMLElement: globals.HTMLElement, document: globals.document };
globals.HTMLElement = FakeNode;
globals.document = fakeDocument;
afterAll(() => {
  globals.HTMLElement = previousGlobals.HTMLElement;
  globals.document = previousGlobals.document;
});
const createNodeMock = (element: { props: Record<string, unknown> }) => {
  const id = String(element.props["data-testid"] ?? element.props.id ?? "node");
  const node = new FakeNode(id);
  if (element.props["data-calendar-selected-day"] === "true") selectedDayNode = node;
  return node;
};

function baseEvent(id: string): DenCalendarEvent {
  return {
    id, organizationId: "org-a", ownerMemberId: "member-a", calendarId: "cal-1", title: `Title ${id}`, description: "",
    time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" },
    version: version, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
}

beforeEach(() => {
  activeNode = null; selectedDayNode = null;
  values.clear(); calls.length = 0; events = []; failNext = null; version = 1;
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
  await act(async () => { renderer = TestRenderer.create(tree(), { createNodeMock: createNodeMock as never }); });
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

const focusedId = () => (activeNode as FakeNode | null)?.id ?? null;
const pressKey = async (renderer: TestRenderer.ReactTestRenderer, id: string, key: string) => {
  await act(async () => { byId(renderer, id).props.onKeyDown({ key, preventDefault: () => undefined, stopPropagation: () => undefined }); });
  await settle();
};
const focusNode = (id: string) => { activeNode = new FakeNode(id); };
const interactive = (renderer: TestRenderer.ReactTestRenderer) => renderer.root.findAll((node) => node.type === "button" || node.type === "input" || node.type === "select" || node.type === "textarea");
const accessibleName = (node: TestRenderer.ReactTestInstance): string => {
  if (typeof node.props["aria-label"] === "string") return node.props["aria-label"];
  const own = text(node).trim();
  if (own) return own;
  // Inputs inside a <label> take their name from the label text.
  let parent = node.parent;
  while (parent) {
    if (parent.type === "label") return text(parent).trim();
    parent = parent.parent;
  }
  return "";
};

test("every core control has an accessible name and uses visible focus styles", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    const controls = interactive(renderer);
    expect(controls.length).toBeGreaterThan(20);
    const unnamed = controls.filter((node) => accessibleName(node) === "").map((node) => node.props["data-testid"]);
    expect(unnamed).toEqual([]);
    for (const id of ["calendar-day-button-2026-11-09", "calendar-day-event-2026-11-09-e1", "calendar-filter-toggle", "calendar-view-day"]) {
      expect(String(byId(renderer, id).props.className)).toContain("focus-visible:ring-2");
    }
    expect(byId(renderer, "calendar-sidebar").props["aria-label"]).toBe(t("calendar.sidebar"));
    expect(has(renderer, "calendar-day-panel")).toBe(false);
    expect(byId(renderer, "calendar-view-switcher").props["aria-label"]).toBe(t("calendar.view_switcher"));
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("only the selected day is in the Tab order, and its event chips follow it", async () => {
  events = [baseEvent("e1"), { ...baseEvent("e2"), time: { kind: "allDay", startDate: "2026-11-12", endDateExclusive: "2026-11-13" } }];
  const { renderer } = await render();
  try {
    const dayButtons = renderer.root.findAll((node) => node.type === "button" && /^calendar-day-button-/.test(String(node.props["data-testid"] ?? "")));
    expect(dayButtons.filter((node) => node.props.tabIndex === 0).map((node) => node.props["data-testid"])).toEqual(["calendar-day-button-2026-11-09"]);
    expect(byId(renderer, "calendar-day-event-2026-11-09-e1").props.tabIndex).toBe(0);
    expect(byId(renderer, "calendar-day-event-2026-11-12-e2").props.tabIndex).toBe(-1);
    await act(async () => { byId(renderer, "calendar-month-grid").findByProps({ role: "grid" }).props.onKeyDown({ key: "ArrowRight", preventDefault: () => undefined }); });
    await act(async () => { byId(renderer, "calendar-month-grid").findByProps({ role: "grid" }).props.onKeyDown({ key: "ArrowRight", preventDefault: () => undefined }); });
    await act(async () => { byId(renderer, "calendar-month-grid").findByProps({ role: "grid" }).props.onKeyDown({ key: "ArrowRight", preventDefault: () => undefined }); });
    expect(focusedId()).toBe("calendar-day-button-2026-11-12");
    expect(byId(renderer, "calendar-day-event-2026-11-12-e2").props.tabIndex).toBe(0);
    expect(byId(renderer, "calendar-day-event-2026-11-09-e1").props.tabIndex).toBe(-1);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("opening the editor focuses its title; cancel and Escape return focus to the opener", async () => {
  const { renderer } = await render();
  try {
    focusNode("calendar-create-event");
    await click(renderer, "calendar-create-event");
    expect(has(renderer, "calendar-event-dialog")).toBe(true);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    expect(byId(renderer, "calendar-event-dialog").props["aria-label"]).toBe(t("calendar.create_event"));
    expect(focusedId()).toBe("calendar-form-title");
    await click(renderer, "calendar-form-cancel");
    expect(focusedId()).toBe("calendar-create-event");

    focusNode("calendar-create-event");
    await click(renderer, "calendar-create-event");
    await pressKey(renderer, "calendar-event-form", "Escape");
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(focusedId()).toBe("calendar-create-event");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("event detail takes focus, Escape closes it, and focus returns to the chip that opened it", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    focusNode("calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    expect(focusedId()).toBe("calendar-event-detail");
    await pressKey(renderer, "calendar-event-detail", "Escape");
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    expect(focusedId()).toBe("calendar-day-event-2026-11-09-e1");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("after deleting, focus falls back to the selected day when the opener no longer exists", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    const opener = new FakeNode("calendar-day-event-2026-11-09-e1");
    activeNode = opener;
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await click(renderer, "calendar-form-delete");
    opener.isConnected = false; // the agenda row disappears with the event
    await click(renderer, "calendar-form-delete-confirm-button");
    await settle();
    expect(has(renderer, "calendar-event-form")).toBe(false);
    expect(focusedId()).toBe("calendar-day-button-2026-11-09");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("Escape in the delete confirmation backs out of it without closing the form", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await click(renderer, "calendar-day-event-2026-11-09-e1");
    await click(renderer, "calendar-event-detail-edit");
    await click(renderer, "calendar-form-delete");
    await pressKey(renderer, "calendar-event-form", "Escape");
    expect(has(renderer, "calendar-form-delete-confirm")).toBe(false);
    expect(has(renderer, "calendar-event-form")).toBe(true);
    expect(calls).toHaveLength(0);
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("narrow layout: filters collapse behind an expandable toggle; core regions keep their order", async () => {
  const { renderer } = await render();
  try {
    const toggle = byId(renderer, "calendar-filter-toggle");
    expect(toggle.props["aria-expanded"]).toBe(false);
    expect(toggle.props["aria-controls"]).toBe("calendar-filter-region");
    expect(String(byId(renderer, "calendar-filter-region").props.className)).toMatch(/(^| )hidden( |$)/);
    expect(String(byId(renderer, "calendar-filter-region").props.className)).toContain("@5xl/calendar:block");
    await click(renderer, "calendar-filter-toggle");
    expect(byId(renderer, "calendar-filter-toggle").props["aria-expanded"]).toBe(true);
    expect(String(byId(renderer, "calendar-filter-region").props.className)).toMatch(/(^| )block( |$)/);
    // The page scrolls vertically only; the month grid comes first and stays at least 7 columns wide in its own box.
    expect(String(byId(renderer, "calendar-layout").props.className)).toContain("overflow-y-auto");
    expect(String(byId(renderer, "calendar-layout").props.className)).not.toContain("overflow-x");
    const order = (id: string) => String(byId(renderer, id).props.className).match(/(?:^| )order-(\d)/)?.[1];
    expect(order("calendar-sidebar")).toBe("2");
    expect(has(renderer, "calendar-day-panel")).toBe(false);
    expect(has(renderer, "calendar-event-panel")).toBe(false);
    expect(String(byId(renderer, "calendar-mini-month-slot").props.className)).toContain("hidden @5xl/calendar:block");
  } finally { await act(async () => { renderer.unmount(); }); }
});

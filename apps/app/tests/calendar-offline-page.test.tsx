import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { DenApiError, type DenCalendar, type DenCalendarEvent } from "../src/app/lib/den";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
// In a full-suite run console.error may already be a shared spy; guard against forwarding into ourselves.
let forwardingConsoleError = false;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  if (forwardingConsoleError) return;
  forwardingConsoleError = true;
  try { originalConsoleError(message, ...args); } finally { forwardingConsoleError = false; }
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
  getCalendarBootstrap: async (_org: string, range: { startDate: string; endDateExclusive: string }) => { bootstrapCalls += 1; return { calendars, events, coverage: { ...range, calendarIds: calendars.map((c) => c.id) }, cursor: "c1" }; },
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
const { CalendarIndexedDbAdapter } = await import("../src/react-app/domains/calendar/calendar-cache");
const { t } = await import("../src/i18n");

function baseEvent(id: string): DenCalendarEvent {
  return {
    id, organizationId: "org-a", ownerMemberId: "member-a", calendarId: "cal-1", title: `Title ${id}`, description: "",
    time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" },
    version: version, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  };
}

let isOnline = true;
const onlineListeners = new Set<() => void>();
let cache: InstanceType<typeof CalendarIndexedDbAdapter>;
const runtime = () => ({
  online: { isOnline: () => isOnline, subscribe: (listener: () => void) => { onlineListeners.add(listener); return () => { onlineListeners.delete(listener); }; } },
  cache,
  now: () => Temporal.Instant.from("2026-11-09T04:00:00Z"),
});
let currentRuntime: ReturnType<typeof runtime>;
const setOnline = async (value: boolean) => {
  isOnline = value;
  await act(async () => { for (const listener of onlineListeners) listener(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
};
let bootstrapCalls = 0;

beforeEach(() => {
  values.clear(); calls.length = 0; events = []; failNext = null; version = 1;
  isOnline = true; onlineListeners.clear(); bootstrapCalls = 0;
  cache = new CalendarIndexedDbAdapter({ indexedDB: new IDBFactory(), IDBKeyRange });
  currentRuntime = runtime();
  calendars = [calendar("cal-1", "Personal"), calendar("cal-2", "Side project")];
});

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const noop = () => undefined;
  let renderer!: TestRenderer.ReactTestRenderer;
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/calendar"]}>
        <CalendarPage workspaceId="" sessionPath="/session" clock={clock} offlineRuntime={currentRuntime} onOpenAccount={noop} onOpenApps={noop} onOpenChat={noop} onOpenReviews={noop} onOpenSettings={noop} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => { renderer = TestRenderer.create(tree()); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
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

const wait = (ms = 30) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("offline with a cached month shows saved events read-only with a stale-data banner", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await wait(); // baseline persisted to IndexedDB from the online bootstrap
    await setOnline(false);
    expect(byId(renderer, "calendar-offline-banner").props["data-offline-state"]).toBe("offline-covered");
    expect(has(renderer, "calendar-day-event-2026-11-09-e1")).toBe(true);
    await click(renderer, "calendar-agenda-item-e1");
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Title e1");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("offline in an uncached month says data is unavailable instead of showing an empty month as fact", async () => {
  const { renderer } = await render();
  try {
    await wait();
    await setOnline(false);
    await click(renderer, "calendar-next-month");
    await wait();
    expect(byId(renderer, "calendar-offline-banner").props["data-offline-state"]).toBe("offline-uncovered");
    expect(text(byId(renderer, "calendar-offline-banner"))).toContain(t("calendar.offline_uncovered"));
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("offline editing never sends a write, disables save and delete, and keeps an unsynced draft", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await wait();
    await setOnline(false);
    await click(renderer, "calendar-agenda-item-e1");
    await click(renderer, "calendar-event-detail-edit");
    expect(has(renderer, "calendar-form-offline")).toBe(true);
    expect(byId(renderer, "calendar-form-save").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-form-delete").props.disabled).toBe(true);
    await change(renderer, "calendar-form-title", "Offline edit");
    await submit(renderer);
    expect(calls).toHaveLength(0);
    await click(renderer, "calendar-form-save-draft");
    await wait();
    expect(calls).toHaveLength(0);
    expect(has(renderer, "calendar-form-draft-saved")).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
    const drafts = await cache.listDrafts({ deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" }, "event");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ operation: "edit", unsynced: true, baseEntity: { id: "e1", version: 1 } });
    expect(text(byId(renderer, `calendar-draft-badge-${drafts[0]!.id}`))).toBe(t("calendar.draft_unsynced"));
    // The saved event itself is unchanged: drafts never enter authoritative results.
    expect(text(byId(renderer, "calendar-agenda-item-e1"))).toContain("Title e1");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("reconnecting refreshes data but never auto-submits drafts; an explicit submit clears the draft only after success", async () => {
  const { renderer } = await render();
  try {
    await wait();
    await setOnline(false);
    await click(renderer, "calendar-agenda-create");
    await change(renderer, "calendar-form-title", "Planned offline");
    await click(renderer, "calendar-form-save-draft");
    await wait();
    const scope = { deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" };
    const [draft] = await cache.listDrafts(scope, "event");
    expect(draft).toBeDefined();
    const before = bootstrapCalls;
    await setOnline(true);
    await wait(60);
    expect(bootstrapCalls).toBeGreaterThan(before);
    expect(calls).toHaveLength(0);
    expect(await cache.listDrafts(scope, "event")).toHaveLength(1);
    await click(renderer, `calendar-draft-restore-${draft!.id}`);
    expect(has(renderer, "calendar-form-restored-draft")).toBe(true);
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Planned offline");
    await submit(renderer);
    await wait();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: "create", input: { title: "Planned offline" } });
    expect(await cache.listDrafts(scope, "event")).toHaveLength(0);
    expect(text(byId(renderer, "calendar-event-detail-title"))).toBe("Planned offline");
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a draft whose base event changed in the cloud requires explicit resolution before saving", async () => {
  events = [baseEvent("e1")];
  const { renderer } = await render();
  try {
    await wait();
    await setOnline(false);
    await click(renderer, "calendar-agenda-item-e1");
    await click(renderer, "calendar-event-detail-edit");
    await change(renderer, "calendar-form-title", "Mine offline");
    await click(renderer, "calendar-form-save-draft");
    await wait();
    await click(renderer, "calendar-form-cancel");
    events = [{ ...baseEvent("e1"), title: "Theirs", version: 2 }];
    await setOnline(true);
    await wait(60);
    const [draft] = await cache.listDrafts({ deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-a" }, "event");
    await click(renderer, `calendar-draft-restore-${draft!.id}`);
    expect(byId(renderer, "calendar-event-form").props["data-status"]).toBe("conflict");
    expect(byId(renderer, "calendar-form-title").props.value).toBe("Mine offline");
    expect(byId(renderer, "calendar-form-save").props.disabled).toBe(true);
    await click(renderer, "calendar-form-conflict-keep-mine");
    await submit(renderer);
    await wait();
    expect(calls[0]).toMatchObject({ op: "update", input: { title: "Mine offline", expectedVersion: 2 } });
  } finally { await act(async () => { renderer.unmount(); }); }
});

test("a network failure while online can be kept as a draft and never shows saved", async () => {
  const { renderer } = await render();
  try {
    failNext = () => new DenApiError(503, "unavailable", "down");
    await click(renderer, "calendar-agenda-create");
    await change(renderer, "calendar-form-title", "Flaky");
    await submit(renderer);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_300)); });
    expect(has(renderer, "calendar-form-failure-network")).toBe(true);
    await click(renderer, "calendar-form-save-draft");
    await wait();
    expect(has(renderer, "calendar-form-draft-saved")).toBe(true);
    expect(has(renderer, "calendar-event-detail")).toBe(false);
  } finally { await act(async () => { renderer.unmount(); }); }
}, 10_000);

test("drafts are partitioned per member: another member's draft is neither shown nor removed", async () => {
  const other = { deployment: "https://den.example/api", organizationId: "org-a", memberId: "member-b" };
  await cache.putDraft(other, { schemaVersion: 1, id: "draft-b", entityType: "event", operation: "create", baseEntity: null, unsynced: true, values: { form: { title: "B private" } } });
  const { renderer } = await render();
  try {
    await wait();
    expect(has(renderer, "calendar-drafts")).toBe(false);
    expect(renderer.root.findAll((node) => typeof node.children?.[0] === "string" && node.children[0] === "B private")).toHaveLength(0);
    expect(await cache.listDrafts(other, "event")).toHaveLength(1);
  } finally { await act(async () => { renderer.unmount(); }); }
});

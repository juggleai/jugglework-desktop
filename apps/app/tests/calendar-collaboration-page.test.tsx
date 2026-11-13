import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Temporal } from "@js-temporal/polyfill";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenCalendar, type DenCalendarCollaborationResource, type DenCalendarEvent, type DenCalendarMembership, type DenCalendarCollaborationRole } from "../src/app/lib/den";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => consoleError.mockRestore());

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear(), key: () => null, get length() { return values.size; } },
});

mock.module("../src/i18n", () => ({ t: (key: string) => key, currentLocale: () => "en" }));
mock.module("../src/react-app/shell/app-navigation-rail", () => ({ AppNavigationRail: () => <nav /> }));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: React.ComponentProps<"div">) => <div {...props}>{children}</div>,
  DialogDescription: (props: React.ComponentProps<"p">) => <p {...props} />,
  DialogFooter: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogHeader: (props: React.ComponentProps<"div">) => <div {...props} />,
  DialogTitle: (props: React.ComponentProps<"h2">) => <h2 {...props} />,
}));

const resource = (id: string, kind: "personal" | "team", role: DenCalendarCollaborationResource["role"]): DenCalendarCollaborationResource => ({
  id, organizationId: "org-a", ownerMemberId: "member-a", kind, name: id, color: "#2563eb", role,
  capabilities: {
    canViewFreeBusy: true,
    canViewDetails: role !== "free-busy",
    canEditEvents: role === "editor" || role === "manager",
    canManage: role === "manager",
  },
  version: 1, authorizationVersion: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});
const resources = [
  resource("personal", "personal", "manager"),
  resource("managed-team", "team", "manager"),
  resource("editable-team", "team", "editor"),
  resource("view-team", "team", "viewer"),
  resource("busy-team", "team", "free-busy"),
];
const event = (calendarId: string): DenCalendarEvent => ({
  id: `event-${calendarId}`, organizationId: "org-a", ownerMemberId: "member-a", calendarId, title: calendarId, description: "",
  time: { kind: "allDay", startDate: "2026-11-09", endDateExclusive: "2026-11-10" },
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});
const defaultPersonalCalendar: DenCalendar = {
  id: "personal", organizationId: "org-a", ownerMemberId: "member-a", name: "Personal", color: "#2563eb", isDefault: true,
  version: 1, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
};

let collaborationEnabled = true;
let calendarWriteEnabled = true;
const snapshotCalls: string[] = [];
const putMembershipCalls: Array<{ memberId: string; role: DenCalendarCollaborationRole; expectedAuthorizationVersion: number }> = [];
const revokeMembershipCalls: Array<{ memberId: string; expectedAuthorizationVersion: number }> = [];
let membershipAuthorizationVersion = 1;
let membershipItems: DenCalendarMembership[] = [];
let directoryOffsets: number[] = [];
let membershipMutationGate: Promise<void> | null = null;
const client = {
  listCalendars: async () => [],
  listCalendarCollaboration: async () => ({ items: resources, authorizationGeneration: 1, reset: { mode: "replace" as const, namespace: "calendar-collaboration" as const } }),
  getCalendarBootstrap: async (_organizationId: string, range: { startDate: string; endDateExclusive: string }) => ({ calendars: [defaultPersonalCalendar], events: [event("personal")], coverage: { ...range, calendarIds: ["personal"] }, cursor: "cursor" }),
  getTeamCalendarSnapshot: async (_organizationId: string, calendarId: string, range: { startDate: string; endDateExclusive: string }) => {
    snapshotCalls.push(calendarId);
    const calendar = resources.find((item) => item.id === calendarId)!;
    return { calendar, events: [event(calendarId)], coverage: { ...range, calendarIds: [calendarId] }, authorizationVersion: 1, reset: { mode: "replace" as const, namespace: `calendar:${calendarId}` } };
  },
  createCalendar: async () => { throw new Error("unexpected create"); },
  updateCalendar: async () => { throw new Error("unexpected update"); },
  deleteCalendar: async () => { throw new Error("unexpected delete"); },
  createCalendarEvent: async () => { throw new Error("unexpected create"); },
  updateCalendarEvent: async () => { throw new Error("unexpected update"); },
  deleteCalendarEvent: async () => { throw new Error("unexpected delete"); },
  createTeamCalendar: async () => { throw new Error("unexpected create"); },
  createTeamCalendarEvent: async () => { throw new Error("unexpected create"); },
  updateTeamCalendarEvent: async () => { throw new Error("unexpected update"); },
  deleteTeamCalendarEvent: async () => { throw new Error("unexpected delete"); },
  listOrganizationMembers: async (_organizationId: string, _options: { limit?: number; offset?: number } = {}) => {
    const offset = _options.offset ?? 0;
    directoryOffsets.push(offset);
    const all = [
      { id: "member-a", userId: "user-a", role: "member", user: { id: "user-a", name: "Ada Manager", account: "ada", email: "ada@example.com", avatar: null } },
      { id: "member-b", userId: "user-b", role: "member", user: { id: "user-b", name: "Ben Editor", account: "ben", email: "ben@example.com", avatar: null } },
      { id: "member-c", userId: "user-c", role: "member", user: { id: "user-c", name: "Cora Viewer", account: "cora", email: "cora@example.com", avatar: null } },
      { id: "member-d", userId: "user-d", role: "member", user: { id: "user-d", name: "Dan Busy", account: "dan", email: "dan@example.com", avatar: null } },
    ];
    const members = offset === 0 ? all.slice(0, 2) : all.slice(2);
    return { members, total: all.length, limit: 200, offset };
  },
  listTeamCalendarMemberships: async () => ({ items: membershipItems.map((item) => ({ ...item })), authorizationVersion: membershipAuthorizationVersion }),
  putTeamCalendarMembership: async (_organizationId: string, _calendarId: string, memberId: string, input: { role: DenCalendarCollaborationRole; expectedAuthorizationVersion: number }) => {
    putMembershipCalls.push({ memberId, ...input });
    if (membershipMutationGate) await membershipMutationGate;
    const existing = membershipItems.find((item) => item.memberId === memberId);
    const membership = { memberId, role: input.role, createdByMemberId: existing?.createdByMemberId ?? "member-a", createdAt: existing?.createdAt ?? "2026-11-12T01:00:00Z", updatedAt: "2026-11-12T01:01:00Z" };
    membershipItems = existing ? membershipItems.map((item) => item.memberId === memberId ? membership : item) : [...membershipItems, membership];
    membershipAuthorizationVersion += 1;
    return { membership, authorizationVersion: membershipAuthorizationVersion };
  },
  revokeTeamCalendarMembership: async (_organizationId: string, _calendarId: string, memberId: string, input: { expectedAuthorizationVersion: number }) => {
    revokeMembershipCalls.push({ memberId, ...input });
    if (memberId === "member-a") throw new DenApiError(409, "calendar_last_manager", "A team calendar must retain at least one manager.");
    membershipItems = membershipItems.filter((item) => item.memberId !== memberId);
    membershipAuthorizationVersion += 1;
    return { authorizationVersion: membershipAuthorizationVersion };
  },
};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => ({ isSignedIn: true, baseUrl: "https://den.example/api", user: { id: "user-a", name: "Ada Manager", account: "ada", email: "ada@example.com" }, activeOrganization: { id: "org-a", orgMemberId: "member-a" }, client }),
}));
mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => ({ loading: false, config: { calendarEnabled: true, calendarWriteEnabled, calendarCollaborationEnabled: collaborationEnabled } }),
}));

const { CalendarPage } = await import("../src/react-app/domains/calendar/calendar-page");
const clock = { now: () => Temporal.Instant.from("2026-11-09T04:00:00Z"), timeZone: () => "Asia/Shanghai" };
const noop = () => undefined;

beforeEach(() => {
  values.clear(); snapshotCalls.length = 0; putMembershipCalls.length = 0; revokeMembershipCalls.length = 0; directoryOffsets = []; collaborationEnabled = true; calendarWriteEnabled = true;
  membershipAuthorizationVersion = 1; membershipMutationGate = null;
  membershipItems = [
    { memberId: "member-a", role: "manager", createdByMemberId: "member-a", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
    { memberId: "member-b", role: "editor", createdByMemberId: "member-a", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" },
  ];
});

async function render() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/calendar"]}>
        <CalendarPage workspaceId="" sessionPath="/session" clock={clock} onOpenAccount={noop} onOpenApps={noop} onOpenChat={noop} onOpenReviews={noop} onOpenSettings={noop} />
      </MemoryRouter></QueryClientProvider>,
    );
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return renderer;
}
const byId = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.find((node) => node.props["data-testid"] === id);
const has = (renderer: TestRenderer.ReactTestRenderer, id: string) => renderer.root.findAll((node) => node.props["data-testid"] === id).length > 0;
const text = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const click = async (renderer: TestRenderer.ReactTestRenderer, id: string) => {
  await act(async () => { byId(renderer, id).props.onClick(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};
const change = async (renderer: TestRenderer.ReactTestRenderer, id: string, value: string) => {
  await act(async () => { byId(renderer, id).props.onChange({ target: { value } }); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

test("groups real role projections and snapshots only visible detail-capable teams", async () => {
  const renderer = await render();
  try {
    const managed = byId(renderer, "calendar-filter-group-managed");
    const subscribed = byId(renderer, "calendar-filter-group-subscribed");
    expect(managed.findAll((node) => node.props["data-testid"] === "calendar-filter-personal")).toHaveLength(1);
    expect(text(managed.find((node) => node.props["data-testid"] === "calendar-filter-personal").parent!)).toContain("Ada Manager");
    expect(managed.findAll((node) => node.props["data-testid"] === "calendar-filter-managed-team")).toHaveLength(1);
    for (const id of ["editable-team", "view-team", "busy-team"]) expect(subscribed.findAll((node) => node.props["data-testid"] === `calendar-filter-${id}`)).toHaveLength(1);
    expect(snapshotCalls.sort()).toEqual(["editable-team", "managed-team", "view-team"]);
    expect(snapshotCalls).not.toContain("busy-team");
    await click(renderer, "calendar-view-week");
    expect(has(renderer, "calendar-all-day-event-event-view-team")).toBe(true);
    await click(renderer, "calendar-all-day-event-event-view-team");
    expect(has(renderer, "calendar-event-detail-edit")).toBe(false);
    await click(renderer, "calendar-event-detail-close");
    await click(renderer, "calendar-all-day-event-event-editable-team");
    expect(has(renderer, "calendar-event-detail-edit")).toBe(true);
  } finally { await act(async () => renderer.unmount()); }
});

test("hides the team creation choice when the collaboration flag is off", async () => {
  collaborationEnabled = false;
  const renderer = await render();
  try {
    await click(renderer, "calendar-add-calendar");
    expect(has(renderer, "calendar-create-personal")).toBe(true);
    expect(has(renderer, "calendar-create-team")).toBe(false);
    expect(snapshotCalls).toEqual([]);
  } finally { await act(async () => renderer.unmount()); }
});

test("only managers see the independent accessible member-management entry", async () => {
  const renderer = await render();
  try {
    const button = byId(renderer, "calendar-manage-members-managed-team");
    expect(button.props.type).toBe("button");
    expect(button.props["aria-label"]).toBe("calendar.manage_members_label");
    expect(button.props["aria-haspopup"]).toBe("dialog");
    expect(has(renderer, "calendar-manage-members-editable-team")).toBe(false);
    expect(byId(renderer, "calendar-filter-managed-team").props.checked).toBe(true);
    await click(renderer, "calendar-manage-members-managed-team");
    expect(byId(renderer, "calendar-filter-managed-team").props.checked).toBe(true);
    expect(byId(renderer, "calendar-members-dialog").props["aria-label"]).toBe("calendar.manage_members_label");
  } finally { await act(async () => renderer.unmount()); }
});

test("hides member-management writes when global calendar writes are disabled", async () => {
  calendarWriteEnabled = false;
  const renderer = await render();
  try {
    expect(has(renderer, "calendar-manage-members-managed-team")).toBe(false);
    expect(has(renderer, "calendar-members-dialog")).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});

test("loads the full organization directory and adds, changes, and revokes members without free text", async () => {
  const renderer = await render();
  try {
    await click(renderer, "calendar-manage-members-managed-team");
    expect(directoryOffsets).toEqual([0, 2]);
    const memberSelect = byId(renderer, "calendar-add-member-select");
    expect(memberSelect.findAllByType("option").map((option) => option.props.value)).toEqual(["member-c", "member-d"]);
    const dialog = byId(renderer, "calendar-members-dialog");
    expect(dialog.findAll((node) => node.type === "input" && ["text", "email"].includes(node.props.type))).toHaveLength(0);

    await click(renderer, "calendar-add-member-submit");
    expect(putMembershipCalls[0]).toEqual({ memberId: "member-c", role: "viewer", expectedAuthorizationVersion: 1 });
    expect(byId(renderer, "calendar-member-role-member-c").props.value).toBe("viewer");

    await change(renderer, "calendar-member-role-member-c", "editor");
    expect(putMembershipCalls[1]).toEqual({ memberId: "member-c", role: "editor", expectedAuthorizationVersion: 2 });
    expect(byId(renderer, "calendar-member-role-member-c").props.value).toBe("editor");

    await click(renderer, "calendar-remove-member-member-c");
    expect(revokeMembershipCalls[0]).toEqual({ memberId: "member-c", expectedAuthorizationVersion: 3 });
    expect(has(renderer, "calendar-member-role-member-c")).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});

test("keeps the final manager unchanged and shows the explicit server error", async () => {
  const renderer = await render();
  try {
    await click(renderer, "calendar-manage-members-managed-team");
    await click(renderer, "calendar-remove-member-member-a");
    expect(revokeMembershipCalls).toEqual([{ memberId: "member-a", expectedAuthorizationVersion: 1 }]);
    expect(byId(renderer, "calendar-member-role-member-a").props.value).toBe("manager");
    expect(byId(renderer, "calendar-members-error").children).toEqual(["calendar.members_last_manager_error"]);
  } finally { await act(async () => renderer.unmount()); }
});

test("disables every membership operation while a change is pending", async () => {
  const renderer = await render();
  let release!: () => void;
  membershipMutationGate = new Promise<void>((resolve) => { release = resolve; });
  try {
    await click(renderer, "calendar-manage-members-managed-team");
    await act(async () => { byId(renderer, "calendar-add-member-submit").props.onClick(); });
    expect(byId(renderer, "calendar-add-member-select").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-add-member-role").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-member-role-member-a").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-remove-member-member-b").props.disabled).toBe(true);
    expect(byId(renderer, "calendar-members-close").props.disabled).toBe(true);
    release();
    await act(async () => { await membershipMutationGate; await new Promise((resolve) => setTimeout(resolve, 0)); });
  } finally { await act(async () => renderer.unmount()); }
});

test("restores focus to the member-management button when the dialog closes", async () => {
  const originalDocument = globalThis.document;
  let focused = 0;
  const opener = { isConnected: true, focus: () => { focused += 1; } };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: opener, body: {}, querySelector: () => null } });
  const renderer = await render();
  try {
    await click(renderer, "calendar-manage-members-managed-team");
    await click(renderer, "calendar-members-close");
    await act(async () => { await new Promise((resolve) => queueMicrotask(resolve)); });
    expect(focused).toBe(1);
  } finally {
    Object.defineProperty(globalThis, "document", { configurable: true, value: originalDocument });
    await act(async () => renderer.unmount());
  }
});

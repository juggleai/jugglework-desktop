import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenClient, type DenProductTask, type DenProductTaskActivityItem, type DenProductTaskList, type DenProductTaskListResult, type DenProductTaskResult } from "../src/app/lib/den";
import { Button } from "../src/components/ui/button";
import { taskSectionStorageKey } from "../src/react-app/domains/tasks/task-page-state";
import { taskWorkbenchStorageKey } from "../src/react-app/domains/tasks/task-view-state";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => { consoleError.mockRestore(); });

const localValues = new Map<string, string>();
const sessionValues = new Map<string, string>();
const memoryStorage = (values: Map<string, string>) => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); }, clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size; } });
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage(localValues) });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage(sessionValues) });

const toastErrors: unknown[] = [];
const toastWarnings: unknown[] = [];
const uploadBusinessFile = mock<typeof import("../src/app/lib/business-file-upload").uploadBusinessFile>(async ({ file }) => ({ name: file.name, url: "https://files.test/map.png" }));
mock.module("../src/app/lib/business-file-upload", () => ({ uploadBusinessFile }));
mock.module("../src/components/ui/sonner", () => ({
  toast: {
    error: (message: unknown) => { toastErrors.push(message); },
    warning: (message: unknown) => { toastWarnings.push(message); },
  },
}));

mock.module("../src/react-app/shell/app-navigation-rail", () => ({
  APP_NAVIGATION_RAIL_WIDTH: 48,
  AppNavigationRail: () => <nav data-testid="mock-app-rail" />,
}));
mock.module("../src/react-app/shell/workspace-shell-layout", () => ({
  APP_INSET_SIDEBAR_OFFSET: 4,
  appInsetSidebarCssWidth: () => "240px",
  useWorkspaceShellLayout: () => ({
    leftSidebarResizing: false,
    leftSidebarWidth: 240,
    startLeftSidebarResize: () => undefined,
  }),
}));
let cloudSession: Record<string, unknown> = {};
mock.module("../src/react-app/domains/settings/cloud/cloud-session-provider", () => ({
  useCloudSession: () => cloudSession,
}));
const PrimitiveContainer = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: PrimitiveContainer,
  DropdownMenuContent: PrimitiveContainer,
  DropdownMenuGroup: PrimitiveContainer,
  DropdownMenuLabel: PrimitiveContainer,
  DropdownMenuRadioGroup: PrimitiveContainer,
  DropdownMenuSeparator: PrimitiveContainer,
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
  DropdownMenuCheckboxItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
  DropdownMenuRadioItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
mock.module("../src/components/ui/popover", () => ({
  Popover: PrimitiveContainer,
  PopoverContent: PrimitiveContainer,
  PopoverTrigger: ({ children, render }: React.PropsWithChildren<{ render?: React.ReactElement }>) => render ? React.cloneElement(render, {}, children) : <>{children}</>,
}));
mock.module("../src/components/ui/dialog", () => ({
  Dialog: PrimitiveContainer,
  DialogContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div role="dialog" {...props}>{children}</div>,
  DialogDescription: PrimitiveContainer,
  DialogFooter: PrimitiveContainer,
  DialogHeader: PrimitiveContainer,
  DialogTitle: PrimitiveContainer,
}));
mock.module("../src/components/ui/checkbox", () => ({
  Checkbox: (props: Record<string, unknown>) => <button type="button" {...props} />,
}));
mock.module("../src/components/ui/tabs", () => ({
  Tabs: PrimitiveContainer,
  TabsList: PrimitiveContainer,
  TabsTrigger: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button role="tab" {...props}>{children}</button>,
}));

const { TaskPage, TaskShellContent } = await import("../src/react-app/domains/tasks/task-page");
const { TaskCommentEditor, TaskDescriptionEditor } = await import("../src/react-app/domains/tasks/task-description-editor");
const { TaskDateTimeCell } = await import("../src/react-app/domains/tasks/task-date-time-cell");
const { useUiStateStore } = await import("../src/react-app/shell/ui-state-store");
const queryClients = new Set<QueryClient>();

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  queryClients.add(queryClient);
  return queryClient;
}

afterEach(() => {
  for (const queryClient of queryClients) queryClient.clear();
  queryClients.clear();
  useUiStateStore.setState({ sidebarOpen: true });
  toastErrors.length = 0;
  toastWarnings.length = 0;
  localValues.clear();
  sessionValues.clear();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const task = (version: number, title = "Server title", description = "Server description", id = "task_one"): DenProductTask => ({
  id,
  displayNumber: 100001,
  creatorMemberId: "member_one",
  listId: null,
  title,
  description,
  priority: "none",
  visibility: "private",
  completionPolicy: "any_assignee",
  status: "todo",
  version,
  startAt: null,
  dueAt: null,
  completedAt: null,
  completedByMemberId: null,
  canceledAt: null,
  canceledByMemberId: null,
  deletedAt: null,
  restoreUntil: null,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T01:00:00Z",
});

const result = (value: DenProductTask): DenProductTaskResult => ({
  task: value,
  members: [],
  permissions: { canView: true, canEditContent: true, canEditTime: true, canManageMembers: true, canManageVisibility: true, canComplete: true, canReopen: false, canCancel: true, canComment: true, canDelete: true, canRestore: false },
  tombstone: false,
  replayed: false,
});

function connectedClient(overrides: Partial<DenClient> = {}): DenClient {
  return {
    listProductTasks: async () => ({ items: [], membersByTaskId: {}, nextCursor: "" }),
    listProductTaskLists: async () => ({ items: [], nextCursor: "" }),
    listOrganizationMembers: async () => ({ members: [], total: 0, limit: 200, offset: 0 }),
    listCollaborationGroups: async () => ({ groups: [], total: 0 }),
    listCollaborationGroupMembers: async () => ({ members: [], total: 0, limit: 100, offset: 0 }),
    getProductTask: async () => result(task(1)),
    getProductTaskActivity: async () => ({ comments: [], events: [] }),
    listProductTaskActivity: async () => ({ items: [], nextCursor: "", hasMore: false, unreadCount: 0, latestSequence: 0 }),
    markProductTaskActivityRead: async () => undefined,
    markAllProductTaskActivityRead: async () => undefined,
    listProductTaskReminders: async () => [],
    ...overrides,
  } as DenClient;
}

function setCloudSession(client: DenClient, organizationId = "org_one") {
  cloudSession = {
    isSignedIn: true,
    baseUrl: "https://work.example",
    user: { id: "user_one", name: "Self" },
    activeOrganization: { id: organizationId, orgMemberId: "member_self" },
    client,
  };
}

function taskPage(queryClient: QueryClient, routeTaskId?: string) {
  return <QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[routeTaskId ? `/tasks/${routeTaskId}` : "/tasks"]}><TaskPage
    routeTaskId={routeTaskId}
    workspaceId="workspace-1"
    sessionPath="/workspace/workspace-1/session/session-1"
    onOpenAccount={() => undefined}
    onOpenApps={() => undefined}
    onOpenChat={() => undefined}
    onOpenReviews={() => undefined}
    onOpenSettings={() => undefined}
  /></MemoryRouter></QueryClientProvider>;
}

function connectedPage(client: DenClient, routeTaskId?: string) {
  setCloudSession(client);
  return taskPage(createQueryClient(), routeTaskId);
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function openDetailDescription(root: TestRenderer.ReactTestInstance) {
  await act(async () => { root.findByProps({ "data-testid": "task-detail-description-preview" }).props.onClick(); });
  return root.find((node) => node.type === TaskDescriptionEditor && node.props.testId === "task-detail-description-editor");
}

function leaveDescription(editor: TestRenderer.ReactTestInstance) {
  editor.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
}

test("renders an Agent-independent empty task center shell", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/tasks"]}>
        <TaskPage
          workspaceId="workspace-1"
          sessionPath="/workspace/workspace-1/session/session-1"
          onOpenAccount={() => undefined}
          onOpenApps={() => undefined}
          onOpenChat={() => undefined}
          onOpenReviews={() => undefined}
          onOpenSettings={() => undefined}
          state={{ kind: "empty" }}
        />
      </MemoryRouter>,
    );
  });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "tasks-sidebar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-main" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-app-secondary-sidebar-resize-handle": true })).toBeDefined();
    expect(renderer!.root.findAllByProps({ children: "No tasks yet" })).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("keeps Tasks top controls search-free and collapses the sidebar into a zero-width frame", async () => {
  let searches = 0;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <MemoryRouter initialEntries={["/tasks"]}>
        <TaskPage
          workspaceId="workspace-1"
          sessionPath="/workspace/workspace-1/session/session-1"
          onOpenAccount={() => undefined}
          onOpenApps={() => undefined}
          onOpenChat={() => undefined}
          onOpenReviews={() => undefined}
          onOpenSettings={() => undefined}
          onOpenTaskSearch={() => { searches += 1; }}
          state={{ kind: "empty" }}
        />
      </MemoryRouter>,
    );
  });
  try {
    expect(renderer!.root.findAllByProps({ "data-app-secondary-sidebar-search": true })).toHaveLength(0);
    expect(searches).toBe(0);

    await act(async () => { renderer!.root.findByProps({ "data-app-secondary-sidebar-toggle": true }).props.onClick(); });
    expect(useUiStateStore.getState().sidebarOpen).toBe(false);
    expect(renderer!.root.findAllByProps({ "data-testid": "tasks-sidebar" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-app-secondary-sidebar-resize-handle": true })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-app-secondary-sidebar-frame": true }).props.className).toContain("w-0");
    expect(renderer!.root.findByProps({ "data-testid": "tasks-main" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-app-secondary-sidebar-search": true })).toHaveLength(0);

    await act(async () => { renderer!.root.findByProps({ "data-app-secondary-sidebar-toggle": true }).props.onClick(); });
    expect(useUiStateStore.getState().sidebarOpen).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-sidebar" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-app-secondary-sidebar-search": true })).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("Today and Activity keep their page headers free of filters and create actions", async () => {
  const client = connectedClient();
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  const expectCleanHeader = () => {
    expect(renderer!.root.findAllByProps({ "aria-label": "Filter by priority" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Sort" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-create-menu" })).toHaveLength(0);
    expect(renderer!.root.findAllByType("button").filter((node) => React.Children.toArray(node.props.children).includes("Create task"))).toHaveLength(0);
  };
  try {
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Today");
    expectCleanHeader();
    const activity = renderer!.root.findByProps({ "data-testid": "tasks-sidebar-section-activity" });
    await act(async () => { activity.props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Activity");
    expectCleanHeader();
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Activity shows authoritative unread state, marks events read, and opens task detail", async () => {
  const item: DenProductTaskActivityItem = {
    event: { id: "event_one", sequence: 14, eventType: "comment.mentioned", payloadVersion: 1, taskId: "task_activity", taskVersion: 2, listId: "list_one", actorMemberId: "member_two", affectedMemberId: "member_self", occurredAt: new Date().toISOString(), payload: { excerpt: "Please review" } },
    readAt: null,
    attentionLevel: "attention",
    task: { id: "task_activity", displayNumber: 100014, title: "Review launch", accessible: true, deleted: false },
    list: { id: "list_one", name: "Launch", marker: "L" },
    actor: { memberId: "member_two", name: "Alice", avatar: null },
  };
  const activityOptions: Array<Record<string, unknown>> = [];
  const readEvents: string[] = [];
  const readSequences: number[] = [];
  const detailTaskIds: string[] = [];
  const client = connectedClient({
    listProductTaskActivity: async (_orgId, options) => {
      activityOptions.push(options ?? {});
      return { items: [item], nextCursor: "", hasMore: false, unreadCount: 1, latestSequence: 14 };
    },
    markProductTaskActivityRead: async (_orgId, eventId) => { readEvents.push(eventId); },
    markAllProductTaskActivityRead: async (_orgId, sequence) => { readSequences.push(sequence); },
    getProductTask: async (_orgId, taskId) => { detailTaskIds.push(taskId); return result(task(2, "Review launch", "", taskId)); },
    listProductTaskLists: async () => ({ items: [{ id: "list_one", creatorMemberId: "member_self", name: "Launch", description: "", marker: "L", visibility: "members", version: 1, archivedAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], nextCursor: "" }),
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-activity-sidebar-badge" }).props.children).toBe(1);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-section-activity" }).props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "task-activity-row-event_one" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-activity-list-event_one" }).props.children).toBe("Launch");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-activity-filter-unread" }).props.onClick(); });
    await settle();
    expect(activityOptions.some((options) => options.unreadOnly === true)).toBe(true);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-activity-read-all" }).props.onClick(); });
    await settle();
    expect(readSequences).toEqual([14]);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-activity-open-event_one" }).props.onClick(); });
    await settle();
    expect(readEvents).toEqual(["event_one"]);
    expect(detailTaskIds).toContain("task_activity");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Activity exposes aggregate endpoint failures instead of a fabricated empty state", async () => {
  const client = connectedClient({ listProductTaskActivity: async () => { throw new DenApiError(404, "not_found", "Aggregate activity is not available."); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-section-activity" }).props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-testid": "task-activity-empty" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Aggregate activity is not available.")).toHaveLength(1);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Today renders an action summary and mutually exclusive overdue, due-today, and starts-today groups", async () => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  const overdue = { ...task(1, "Overdue launch", "", "today_overdue"), listId: "legacy_hidden", listIds: ["list_today", "unresolved_list_id", "second"], dueAt: yesterdayNoon.toISOString(), priority: "high" as const };
  const dueToday = { ...task(1, "Review today", "", "today_due"), creatorMemberId: "member_self", listId: "list_today", dueAt: today.toISOString() };
  const startsToday = { ...task(1, "Start research", "", "today_start"), listId: "list_today", startAt: today.toISOString() };
  const list: DenProductTaskList = { id: "list_today", creatorMemberId: "member_self", name: "Launch plan", description: "", marker: "L", visibility: "members", version: 1, archivedAt: null, createdAt: today.toISOString(), updatedAt: today.toISOString() };
  const membersByTaskId = {
    [overdue.id]: [{ memberId: "member_self", role: "assignee" as const }],
    [dueToday.id]: [],
    [startsToday.id]: [{ memberId: "member_self", role: "follower" as const }],
  };
  const client = connectedClient({
    listProductTasks: async () => ({ items: [startsToday, dueToday, overdue], membersByTaskId, nextCursor: "" }),
    listProductTaskLists: async () => ({ items: [list, { ...list, id: "second", name: "Planning" }], nextCursor: "" }),
    listOrganizationMembers: async () => ({ members: [{ id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } }], total: 1, limit: 200, offset: 0 }),
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    expect(renderer!.root.findByProps({ "data-testid": "today-task-view" })).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.children === "3 pending")).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.props.children === "1 overdue")).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": "today-group-overdue" }).findByProps({ "data-testid": `today-task-row-${overdue.id}` })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "today-group-due_today" }).findByProps({ "data-testid": `today-task-row-${dueToday.id}` })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "today-group-starts_today" }).findByProps({ "data-testid": `today-task-row-${startsToday.id}` })).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.children === "Assigned to me")).not.toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Created by me")).not.toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Following")).not.toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": `today-task-row-${overdue.id}` }).findByProps({ children: "Launch plan, Planning" })).toBeDefined();
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Today completion loads authoritative permissions before transitioning the task", async () => {
  const now = new Date();
  const listed = { ...task(1, "Finish today", "", "finish_today"), dueAt: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString() };
  const authoritative = result({ ...listed, version: 5 });
  authoritative.members = [{ memberId: "member_self", role: "assignee" }];
  const transitions: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: authoritative.members }, nextCursor: "" }),
    getProductTask: async () => authoritative,
    transitionProductTask: async (_orgId, taskId, operation, input) => { transitions.push({ taskId, operation, ...input }); return result({ ...authoritative.task, status: "completed", version: 6 }); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Complete task" }).props.onClick(); });
    await settle();
    expect(transitions).toEqual([{ taskId: listed.id, operation: "complete", expectedVersion: 5, idempotencyKey: expect.any(String) }]);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("selecting Assigned by me queries explicit assignee exclusion and assigner inclusion filters", async () => {
  const options: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async (_orgId, input) => {
      options.push(input ?? {});
      return { items: [], membersByTaskId: {}, nextCursor: "" };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assignedByMe = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned by me"))!;
    await act(async () => { assignedByMe.props.onClick(); });
    await settle();
    expect(options.some((input) => input.view === "all"
      && JSON.stringify(input.assigneeMemberId) === JSON.stringify(["member_self"])
      && input.assigneeMemberOperator === "not_contains"
      && JSON.stringify(input.assignerMemberId) === JSON.stringify(["member_self"])
      && input.assignerMemberOperator === "contains")).toBe(true);
    expect(renderer!.root.findAll((node) => node.props.children === "Assigned by me")).not.toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-filter-condition-assignee" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-filter-condition-assigner" })).toBeDefined();
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("six task collection pages share the workbench and apply their visible default filters", async () => {
  const options: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async (_orgId, input) => {
      options.push(input ?? {});
      return { items: [], membersByTaskId: {}, nextCursor: "" };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  const cases = [
    { label: "Assigned to me", fields: ["assignee"], query: (input: Record<string, unknown>) => input.view === "all" && input.assigneeMemberOperator === "contains" },
    { label: "Following", fields: ["follower", "creator", "assignee"], query: (input: Record<string, unknown>) => input.view === "all" && input.followerMemberOperator === "contains" && input.creatorMemberOperator === "not_contains" && input.assigneeMemberOperator === "not_contains" },
    { label: "All tasks", fields: [], query: (input: Record<string, unknown>) => input.view === "all" && JSON.stringify(input.status) === JSON.stringify(["todo", "completed", "canceled"]) },
    { label: "Created by me", fields: ["creator"], query: (input: Record<string, unknown>) => input.view === "all" && input.creatorMemberOperator === "contains" },
    { label: "Assigned by me", fields: ["assignee", "assigner"], query: (input: Record<string, unknown>) => input.view === "all" && input.assigneeMemberOperator === "not_contains" && input.assignerMemberOperator === "contains" },
    { label: "Completed", fields: [], query: (input: Record<string, unknown>) => input.view === "all" && JSON.stringify(input.status) === JSON.stringify(["completed"]) },
  ];
  try {
    for (const item of cases) {
      const before = options.length;
      const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
      const button = sidebar.findAllByType("button").find((candidate) => Array.isArray(candidate.props.children) && candidate.props.children.includes(item.label))!;
      await act(async () => { button.props.onClick(); });
      await settle();
      expect(renderer!.root.findByProps({ "data-testid": "task-workbench-toolbar" })).toBeDefined();
      expect(renderer!.root.findAllByProps({ role: "tab" })).toHaveLength(2);
      expect(options.slice(before).some(item.query)).toBe(true);
      for (const field of item.fields) expect(renderer!.root.findByProps({ "data-testid": `task-filter-condition-${field}` })).toBeDefined();
      expect(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-filter-condition-"))).toHaveLength(item.fields.length);
      if (item.label === "Completed") expect(renderer!.root.findByProps({ "data-testid": "task-status-menu" }).props["data-disabled"]).toBeUndefined();
    }
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("selecting a sidebar task list constrains the shared workbench query", async () => {
  const options: Array<Record<string, unknown>> = [];
  const list: DenProductTaskList = { id: "list_sidebar", creatorMemberId: "member_self", name: "Sidebar list", description: "", marker: "S", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const client = connectedClient({
    listProductTasks: async (_orgId, input) => { options.push(input ?? {}); return { items: [], membersByTaskId: {}, nextCursor: "" }; },
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const before = options.length;
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const listButton = sidebar.findByProps({ "data-testid": "tasks-sidebar-list-list_sidebar" });
    expect(listButton.findAll((node) => node.type === "span" && node.props.children === "Sidebar list")).toHaveLength(1);
    expect(listButton.findAll((node) => node.props.children === "S")).toHaveLength(0);
    await act(async () => { listButton.props.onClick(); });
    await settle();
    expect(options.slice(before).some((input) => input.view === "all" && JSON.stringify(input.listId) === JSON.stringify(["list_sidebar"]))).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-workbench-toolbar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Sidebar list");
    expect(renderer!.root.findByProps({ "data-testid": "task-group-row-custom-default" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-custom-group-create-trigger" })).toBeDefined();
    const updatedSidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const selectedListButton = updatedSidebar.findByProps({ "data-testid": "tasks-sidebar-list-list_sidebar" });
    const allTasksButton = updatedSidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("All tasks"))!;
    expect(selectedListButton.props["aria-current"]).toBe("page");
    expect(selectedListButton.props.className).toContain("bg-blue-3");
    expect(selectedListButton.props.className).toContain("text-blue-11");
    expect(allTasksButton.props["aria-current"]).toBeUndefined();
    expect(allTasksButton.props.className).not.toContain("bg-blue-3");
  } finally { await act(async () => renderer!.unmount()); }
});

test("task-list detail failure keeps header operations available instead of showing a permanent loader", async () => {
  const list: DenProductTaskList = { id: "list_failed_detail", creatorMemberId: "member_self", name: "Available list", description: "", marker: "A", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => { throw new DenApiError(500, "invalid_task_list_payload", "Task list response was invalid."); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_failed_detail" }).props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Available list");
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-collaboration-loading" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-create-menu" })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("task-list header shares with people and expands group members into collaborators", async () => {
  const list: DenProductTaskList = { id: "list_shared", creatorMemberId: "member_self", name: "Launch list", description: "", marker: "L", visibility: "private", version: 3, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const self = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: "https://example.com/self.png" } };
  const teammate = { id: "member_two", userId: "user_two", role: "member", user: { id: "user_two", name: "Teammate", account: null, email: null, avatar: null } };
  const groupMate = { id: "member_three", userId: "user_three", role: "member", user: { id: "user_three", name: "Group mate", account: null, email: null, avatar: null } };
  const existingAdmin = { id: "member_four", userId: "user_four", role: "member", user: { id: "user_four", name: "Existing admin", account: null, email: null, avatar: null } };
  const updates: Array<{ listId: string; patch: Record<string, unknown> }> = [];
  const groupMemberReads: string[] = [];
  const detail = { list, members: [{ memberId: "member_self", role: "administrator" as const }, { memberId: "member_four", role: "administrator" as const }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: false, canDelete: false, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => detail,
    listOrganizationMembers: async () => ({ members: [self, teammate, groupMate, existingAdmin], total: 4, limit: 200, offset: 0 }),
    listCollaborationGroups: async () => ({ groups: [{ id: "group_one", name: "Launch group", avatar: null, groupType: 0, organizationId: "org_one" }], total: 1 }),
    listCollaborationGroupMembers: async (_orgId, groupId) => { groupMemberReads.push(groupId); return { members: [{ id: "relation_three", groupId: "group_one", userId: "user_three", name: "Group mate", account: null, avatar: null }], total: 1, limit: 100, offset: 0 }; },
    updateProductTaskList: async (_orgId, listId, patch) => {
      updates.push({ listId, patch });
      return { ...detail, list: { ...list, visibility: "members", version: 4 }, members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_four", role: "administrator" }, { memberId: "member_two", role: "member" }, { memberId: "member_three", role: "member" }] };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_shared" }).props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "task-list-collaboration-summary" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-testid": "task-create-menu" })).toHaveLength(0);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-share-trigger" }).props.onClick(); });
    await settle();
    const dialog = renderer!.root.findByProps({ "data-testid": "task-list-share-dialog" });
    const footer = dialog.findByProps({ "data-testid": "task-list-share-footer" });
    expect(footer.props.className).toContain("mx-0");
    expect(footer.props.className).toContain("mb-0");
    expect(footer.props.className).toContain("rounded-b-2xl");
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-results" })).toHaveLength(0);
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-member-member_two" })).toHaveLength(0);
    const search = dialog.findByProps({ "aria-label": "Search people and groups" });
    await act(async () => { search.props.onChange({ currentTarget: { value: "Team" } }); });
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-results" })).toHaveLength(0);
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-share-search" }).props.onClick(); });
    expect(dialog.findByProps({ "data-testid": "task-list-share-member-member_two" })).toBeDefined();
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-share-member-member_two" }).props.onClick(); });
    expect(dialog.findByProps({ "data-testid": "task-list-share-chip-member-member_two" })).toBeDefined();
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-results" })).toHaveLength(0);
    await act(async () => { dialog.findByProps({ "aria-label": "Remove Teammate" }).props.onClick(); });
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-chip-member-member_two" })).toHaveLength(0);
    expect(dialog.findByProps({ "data-testid": "task-list-share-confirm" }).props.disabled).toBe(true);
    await act(async () => { search.props.onChange({ currentTarget: { value: "Team" } }); });
    await act(async () => { search.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }); });
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-share-member-member_two" }).props.onClick(); });
    await act(async () => { search.props.onChange({ currentTarget: { value: "Launch" } }); });
    await act(async () => { search.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }); });
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-share-group-group_one" }).props.onClick(); });
    expect(dialog.findByProps({ "data-testid": "task-list-share-chip-group-group_one" })).toBeDefined();
    expect(groupMemberReads).toHaveLength(0);
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-share-confirm" }).props.onClick(); });
    await settle();
    expect(groupMemberReads).toEqual(["group_one"]);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.listId).toBe("list_shared");
    expect(updates[0]?.patch).toMatchObject({ expectedVersion: 3, visibility: "members", members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_four", role: "administrator" }, { memberId: "member_two", role: "member" }, { memberId: "member_three", role: "member" }], idempotencyKey: expect.any(String) });
    expect(updates[0]?.patch).not.toHaveProperty("enableTaskAccess");
    expect(updates[0]?.patch).not.toHaveProperty("confirmedAccessDigest");
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-share-dialog" })).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task-list sharing is read-only without member-management permission", async () => {
  const list: DenProductTaskList = { id: "list_read_only", creatorMemberId: "member_owner", name: "Read only list", description: "", marker: "R", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const owner = { id: "member_owner", userId: "user_owner", role: "member", user: { id: "user_owner", name: "Owner", account: null, email: null, avatar: null } };
  const viewer = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Viewer", account: null, email: null, avatar: null } };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => ({ list, members: [{ memberId: "member_owner", role: "administrator" }, { memberId: "member_self", role: "member" }], permissions: { canView: true, canEdit: false, canManageMembers: false, canTransferOwnership: false, canDelete: false, canAddTasks: false, canArchive: false, canRestore: false }, replayed: false }),
    listOrganizationMembers: async () => ({ members: [owner, viewer], total: 2, limit: 200, offset: 0 }),
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_read_only" }).props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-share-trigger" }).props.onClick(); });
    const dialog = renderer!.root.findByProps({ "data-testid": "task-list-share-dialog" });
    expect(dialog.findAllByProps({ "aria-label": "Search people and groups" })).toHaveLength(0);
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-search" })).toHaveLength(0);
    expect(dialog.findAllByProps({ "data-testid": "task-list-share-confirm" })).toHaveLength(0);
    expect(dialog.findAllByProps({ children: "You can view collaborators, but you do not have permission to change them." }).length).toBeGreaterThan(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task-list collaborator avatars open management and save role and removal changes", async () => {
  const list: DenProductTaskList = { id: "list_manage", creatorMemberId: "member_self", name: "Manage list", description: "", marker: "M", visibility: "members", version: 5, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const directory = Array.from({ length: 7 }, (_, index) => ({ id: index === 0 ? "member_self" : `member_${index + 1}`, userId: `user_${index + 1}`, role: "member", user: { id: `user_${index + 1}`, name: index === 0 ? "Owner" : `Collaborator ${index + 1}`, account: null, email: null, avatar: null } }));
  const detail = {
    list,
    members: [{ memberId: "member_self", role: "administrator" as const }, ...directory.slice(1).map((member) => ({ memberId: member.id, role: "member" as const }))],
    permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: false, canDelete: false, canAddTasks: true, canArchive: true, canRestore: false },
    replayed: false,
  };
  const updates: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => detail,
    listOrganizationMembers: async () => ({ members: directory, total: directory.length, limit: 200, offset: 0 }),
    updateProductTaskList: async (_orgId, _listId, patch) => {
      updates.push(patch);
      return { ...detail, list: { ...list, version: 6 }, members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_2", role: "administrator" }, ...directory.slice(3).map((member) => ({ memberId: member.id, role: "member" as const }))] };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_manage" }).props.onClick(); });
    await settle();
    const summary = renderer!.root.findByProps({ "data-testid": "task-list-collaboration-summary" });
    const avatarTrigger = summary.findByProps({ "data-testid": "task-list-collaborators-trigger" });
    expect(avatarTrigger.props.children[0]).toHaveLength(5);
    expect(summary.findByProps({ "data-testid": "task-list-collaborator-overflow" }).props.children).toEqual(["+", 2]);
    await act(async () => { avatarTrigger.props.onClick(); });
    let manage = renderer!.root.findByProps({ "data-testid": "task-list-collaborators-dialog" });
    expect(manage.findByProps({ "data-testid": "task-list-collaborator-member_self" })).toBeDefined();
    expect(manage.findAllByProps({ "data-testid": "task-list-collaborator-role-member_self" })).toHaveLength(0);

    await act(async () => { manage.findByProps({ "data-testid": "task-list-add-collaborator" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-list-share-dialog" })).toBeDefined();
    const addDialog = renderer!.root.findByProps({ "data-testid": "task-list-share-dialog" });
    await act(async () => { addDialog.findAllByType("button").find((button) => button.props.children === "Cancel")!.props.onClick(); });
    manage = renderer!.root.findByProps({ "data-testid": "task-list-collaborators-dialog" });

    const memberTwoRow = manage.findByProps({ "data-testid": "task-list-collaborator-member_2" });
    await act(async () => { memberTwoRow.findAllByType("button")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaborator-edit-member_2" }).props.onClick(); });
    const memberThreeRow = manage.findByProps({ "data-testid": "task-list-collaborator-member_3" });
    await act(async () => { memberThreeRow.findAllByType("button")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaborator-remove-member_3" }).props.onClick(); });
    expect(manage.findAllByProps({ "data-testid": "task-list-collaborator-member_3" })).toHaveLength(0);
    await act(async () => { manage.findByProps({ "data-testid": "task-list-collaborators-done" }).props.onClick(); });
    await settle();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ expectedVersion: 5, visibility: "members", members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_2", role: "administrator" }, { memberId: "member_4", role: "member" }, { memberId: "member_5", role: "member" }, { memberId: "member_6", role: "member" }, { memberId: "member_7", role: "member" }] });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-collaborators-dialog" })).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test.each([
  ["legacy member", undefined, "member", false],
  ["historical member", false, "member", false],
  ["enabled administrator", true, "administrator", false],
  ["enabled member", true, "member", true],
  ["enabled member with no current tasks", true, "member", true],
] as const)("task-list owner can transfer ownership to an existing collaborator: %s", async (mode, grantsTaskAccess, previousRole, needsConfirmation) => {
  const list: DenProductTaskList = { id: "list_transfer", creatorMemberId: "member_self", name: "Transfer list", description: "", marker: "T", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...(grantsTaskAccess === undefined ? {} : { grantsTaskAccess }) };
  const self = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Owner", account: null, email: null, avatar: null } };
  const teammate = { id: "member_two", userId: "user_two", role: "member", user: { id: "user_two", name: "Teammate", account: null, email: null, avatar: null } };
  let detail: DenProductTaskListResult = { list, members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_two", role: previousRole }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  const transfers: Array<Record<string, unknown>> = [];
  const previewReads: string[][] = [];
  const prompts: string[] = [];
  const preview = mode === "enabled member with no current tasks" ? { taskCount: 0, digest: "" } : { taskCount: 8, digest: "transfer-digest" };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [detail.list], nextCursor: "" }),
    getProductTaskList: async () => detail,
    getProductTaskListAccessPreview: async (...args) => { previewReads.push(args); return preview; },
    listOrganizationMembers: async () => ({ members: [self, teammate], total: 2, limit: 200, offset: 0 }),
    transferProductTaskListOwnership: async (_orgId, listId, patch) => {
      transfers.push({ listId, ...patch });
      detail = { ...detail, list: { ...list, creatorMemberId: "member_two", version: 3 }, members: [{ memberId: "member_self", role: "administrator" }, { memberId: "member_two", role: "administrator" }], permissions: { ...detail.permissions, canTransferOwnership: false, canDelete: false } };
      return detail;
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  const originalConfirm = globalThis.confirm;
  let accept = false;
  globalThis.confirm = (message) => { prompts.push(message ?? ""); return accept; };
  const click = (id: string) => act(async () => { renderer.root.findByProps({ "data-testid": id }).props.onClick(); });
  try {
    await settle();
    await click("tasks-sidebar-list-list_transfer");
    await settle();
    await click("task-list-collaborators-trigger");
    if (grantsTaskAccess && previousRole === "member") {
      // An unsaved role edit must not bypass the transfer confirmation.
      await click("task-list-collaborator-edit-member_two");
    }
    if (needsConfirmation) {
      await click("task-list-collaborator-owner-member_two");
      await settle();
      expect(previewReads).toEqual([["org_one", list.id]]);
      expect(prompts[0]).toContain(`Tasks currently in this list: ${preview.taskCount}`);
      expect(prompts[0]).toContain("Transfer ownership of “Transfer list” to Teammate");
      expect(prompts[0]).toContain("edit existing tasks and tasks added later");
      expect(transfers).toHaveLength(0);
    }
    accept = true;
    await click("task-list-collaborator-owner-member_two");
    await settle();
    expect(previewReads).toHaveLength(needsConfirmation ? 2 : 0);
    expect(prompts).toHaveLength(needsConfirmation ? 2 : 0);
    expect(transfers).toEqual([{ listId: "list_transfer", expectedVersion: 2, idempotencyKey: expect.any(String), newOwnerMemberId: "member_two", ...(needsConfirmation && preview.digest ? { confirmedAccessDigest: preview.digest } : {}) }]);
    const manage = renderer!.root.findByProps({ "data-testid": "task-list-collaborators-dialog" });
    expect(manage.findByProps({ "data-testid": "task-list-collaborator-member_two" }).findAllByProps({ children: "Owner" }).length).toBeGreaterThan(0);
    expect(manage.findAllByProps({ "data-testid": "task-list-collaborator-owner-member_self" })).toHaveLength(0);
    expect(manage.findByProps({ "data-testid": "task-list-collaborator-member_self" }).findAllByProps({ children: "Can edit" }).length).toBeGreaterThan(0);
  } finally { globalThis.confirm = originalConfirm; await act(async () => { renderer!.unmount(); }); }
});

test("task-list administrator who is not owner cannot see ownership transfer", async () => {
  const list: DenProductTaskList = { id: "list_admin", creatorMemberId: "member_owner", name: "Admin list", description: "", marker: "A", visibility: "members", version: 2, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const directory = [
    { id: "member_owner", userId: "user_owner", role: "member", user: { id: "user_owner", name: "Owner", account: null, email: null, avatar: null } },
    { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Administrator", account: null, email: null, avatar: null } },
    { id: "member_two", userId: "user_two", role: "member", user: { id: "user_two", name: "Teammate", account: null, email: null, avatar: null } },
  ];
  const detail = { list, members: [{ memberId: "member_owner", role: "administrator" as const }, { memberId: "member_self", role: "administrator" as const }, { memberId: "member_two", role: "member" as const }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: false, canDelete: false, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  const client = connectedClient({ listProductTaskLists: async () => ({ items: [list], nextCursor: "" }), getProductTaskList: async () => detail, listOrganizationMembers: async () => ({ members: directory, total: 3, limit: 200, offset: 0 }) });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_admin" }).props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaboration-summary" }).findAllByType("button")[2]!.props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-delete-action" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-list-rename-action" })).toBeDefined();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaborators-trigger" }).props.onClick(); });
    const teammateRow = renderer!.root.findByProps({ "data-testid": "task-list-collaborator-member_two" });
    await act(async () => { teammateRow.findAllByType("button")[0]!.props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-collaborator-owner-member_two" })).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task-list owner renames the selected list from the header menu", async () => {
  let list: DenProductTaskList = { id: "list_rename", creatorMemberId: "member_self", name: "Old list", description: "", marker: "O", visibility: "private", version: 3, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const detail = { list, members: [{ memberId: "member_self", role: "administrator" as const }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  const updates: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => detail,
    updateProductTaskList: async (_orgId, _listId, patch) => { updates.push(patch); list = { ...list, name: "Renamed list", version: 4 }; return { ...detail, list }; },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_rename" }).props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaboration-summary" }).findAllByType("button")[2]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-rename-action" }).props.onClick(); });
    const dialog = renderer!.root.findByProps({ "data-testid": "task-list-rename-dialog" });
    await act(async () => { dialog.findByProps({ "aria-label": "Task list name" }).props.onChange({ target: { value: "  Renamed list  " } }); });
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-rename-confirm" }).props.onClick(); });
    await settle();
    expect(updates).toEqual([{ expectedVersion: 3, idempotencyKey: expect.any(String), name: "Renamed list" }]);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Renamed list");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task-list owner can delete the list and opt into deleting unassigned tasks", async () => {
  const list: DenProductTaskList = { id: "list_delete", creatorMemberId: "member_self", name: "Delete list", description: "", marker: "D", visibility: "private", version: 5, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const detail = { list, members: [{ memberId: "member_self", role: "administrator" as const }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false };
  const deletes: Array<Record<string, unknown>> = [];
  let lists = [list];
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: lists, nextCursor: "" }),
    getProductTaskList: async () => detail,
    deleteProductTaskList: async (_orgId, listId, patch) => { deletes.push({ listId, ...patch }); lists = []; return { listId, replayed: false }; },
  });
  localStorage.setItem('jugglework:tasks:workbench:["https://work.example","user_one","org_one"]:all', JSON.stringify({ listIds: ["list_delete", "list_other"] }));
  localStorage.setItem('jugglework:tasks:workbench:["https://work.example","user_one","org_one"]:list:list_delete', JSON.stringify({ group: "custom" }));
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_delete" }).props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-collaboration-summary" }).findAllByType("button")[2]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-delete-action" }).props.onClick(); });
    const dialog = renderer!.root.findByProps({ "data-testid": "task-list-delete-dialog" });
    const checkbox = dialog.findByProps({ "data-testid": "task-list-delete-unassigned" });
    expect(checkbox.props.checked).toBe(false);
    await act(async () => { checkbox.props.onCheckedChange(true); });
    await act(async () => { dialog.findByProps({ "data-testid": "task-list-delete-confirm" }).props.onClick(); });
    await settle();
    expect(deletes).toEqual([{ listId: "list_delete", expectedVersion: 5, idempotencyKey: expect.any(String), deleteUnassignedTasks: true }]);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("All tasks");
    expect(renderer!.root.findAllByProps({ "data-testid": "tasks-sidebar-list-list_delete" })).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem('jugglework:tasks:workbench:["https://work.example","user_one","org_one"]:all')!).listIds).toEqual(["list_other"]);
    expect(localStorage.getItem('jugglework:tasks:workbench:["https://work.example","user_one","org_one"]:list:list_delete')).toBeNull();
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("creates a private task list inline from the sidebar and opens it", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const createdList: DenProductTaskList = { id: "list_inline_sidebar", creatorMemberId: "member_self", name: "Launch plan", description: "", marker: "L", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const client = connectedClient({
    createProductTaskList: async (_orgId, input) => { creates.push(input); return { list: createdList, members: [], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false }; },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    await act(async () => { sidebar.findByProps({ "aria-label": "Create task list" }).props.onClick(); });
    const input = renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" });
    expect(input.props.autoFocus).toBe(true);
    expect(input.props.value).toBe("Task list 1");
    let selections = 0;
    input.props.onFocus({ currentTarget: { select: () => { selections += 1; } } });
    expect(selections).toBe(1);
    await act(async () => { input.props.onChange({ currentTarget: { value: "  Launch plan  " } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create" }).props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ name: "Launch plan", description: "", marker: "L", visibility: "private", idempotencyKey: expect.any(String) });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-sidebar-list-create-input" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Launch plan");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("cancels an inline sidebar task-list draft with Escape", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const client = connectedClient({ createProductTaskList: async (_orgId, input) => { creates.push(input); throw new Error("unexpected create"); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Create task list" }).props.onClick(); });
    const input = renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" });
    await act(async () => { input.props.onChange({ currentTarget: { value: "Discard me" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onKeyDown({ key: "Escape", preventDefault: () => undefined }); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-sidebar-list-create-input" })).toHaveLength(0);
    expect(creates).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("keeps a failed inline sidebar task-list name for retry", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const client = connectedClient({ createProductTaskList: async (_orgId, input) => { creates.push(input); throw new Error("Inline list failed"); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Create task list" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onChange({ currentTarget: { value: "Retry list" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create" }).props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.value).toBe("Retry list");
    expect(toastErrors).toContain("Inline list failed");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("dismisses a blank inline sidebar task-list draft on blur without creating", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const client = connectedClient({ createProductTaskList: async (_orgId, input) => { creates.push(input); throw new Error("unexpected create"); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Create task list" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onChange({ currentTarget: { value: "   " } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onBlur({ currentTarget: { value: "   " } }); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-sidebar-list-create-input" })).toHaveLength(0);
    expect(creates).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("assigned workbench repopulates its editable default while preserving non-person settings", async () => {
  const scope = { baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" };
  sessionValues.set(taskSectionStorageKey(scope), "assigned");
  localValues.set(taskWorkbenchStorageKey(scope), JSON.stringify({
    status: "incomplete",
    assigneeMemberIds: ["assignee_one", "assignee_two"],
    assigneeMemberOperator: "not_contains",
    assignerMemberIds: ["assigner_one"],
    assignerMemberOperator: "contains",
    creatorMemberIds: ["creator_one"],
    creatorMemberOperator: "not_empty",
    followerMemberIds: ["follower_one"],
    followerMemberOperator: "contains",
    priorities: ["high", "low"],
    listIds: ["list_one", "list_two"],
    overdue: true,
  }));
  const options: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async (_orgId, input) => {
      options.push(input ?? {});
      return { items: [], membersByTaskId: {}, nextCursor: "" };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    expect(options.some((input) => input.view === "all"
      && JSON.stringify(input.assigneeMemberId) === JSON.stringify(["member_self"])
      && input.assigneeMemberOperator === "contains"
      && input.assignerMemberId === undefined
      && input.creatorMemberId === undefined
      && input.followerMemberId === undefined
      && JSON.stringify(input.priority) === JSON.stringify(["high", "low"])
      && JSON.stringify(input.listId) === JSON.stringify(["list_one", "list_two"])
      && input.overdue === undefined)).toBe(true);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("Assigned to me shows only List and Board tabs and the two creation options", async () => {
  const client = connectedClient();
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    const tabs = renderer!.root.findAllByProps({ role: "tab" });
    expect(tabs).toHaveLength(2);
    expect(tabs.map((node) => React.Children.toArray(node.props.children).filter((child) => typeof child === "string").join(""))).toEqual(["List", "Board"]);
    const createMenu = renderer!.root.findByProps({ "data-testid": "task-create-menu" });
    expect(createMenu.findAllByType("button").map((node) => node.props.children)).toEqual(["New task", "New task list"]);

    await act(async () => { createMenu.findAllByType("button")[0]!.props.onClick(); });
    const fullCreateDialog = renderer!.root.findByProps({ role: "dialog" });
    expect(fullCreateDialog.props["aria-label"]).toBe("Create task");
    expect(fullCreateDialog.props.className).toContain("max-w-[680px]");
    expect(fullCreateDialog.props.className).toContain("h-[min(460px");
    expect(renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" })).toBeDefined();
    const descriptionEditor = fullCreateDialog.findByType(TaskDescriptionEditor);
    expect(descriptionEditor.props.value).toBe("");
    expect(descriptionEditor.findByProps({ "data-testid": "task-create-description-editor" })).toBeDefined();
    expect(descriptionEditor.findByProps({ "data-testid": "task-description-attachment" }).props.disabled).toBe(false);
    expect(renderer!.root.findByProps({ "data-testid": "task-create-followers-trigger" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-create-footer" }).props.className).toContain("sm:justify-between");
    expect(fullCreateDialog.findAllByType("button").find((button) => button.props.type === "submit")?.props.children).toBe("Create");
    expect(renderer!.root.findByProps({ "data-testid": "task-create-followers-trigger" }).findAll((node) => node.type?.displayName === "ChevronDown")).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Today")).not.toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Tomorrow")).not.toHaveLength(0);
    expect(renderer!.root.findByProps({ "aria-label": "Due time" })).toBeDefined();
    expect(renderer!.root.findByProps({ "aria-label": "Task list" })).toBeDefined();
    const createDialogRoot = renderer!.root.find((node) => node.props.open === true && typeof node.props.onOpenChange === "function");
    await act(async () => { createDialogRoot.props.onOpenChange(false); });
    await act(async () => { useUiStateStore.getState().setSidebarOpen(false); });
    await act(async () => { renderer!.update(connectedPage(client)); });
    expect(renderer!.root.findAllByProps({ "data-testid": "tasks-sidebar" })).toHaveLength(0);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[1]!.props.onClick(); });
    expect(useUiStateStore.getState().sidebarOpen).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-sidebar" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.value).toBe("Task list 1");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("task file consumers bind uploads to the current org/task, and creation waits for the uploaded Markdown", async () => {
  const receipt = deferred<{ url: string; name: string }>();
  const create = mock(async () => result(task(1)));
  const client = connectedClient({ createProductTask: create });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const root = renderer.root;
    const file = new File(["data"], "map.png", { type: "image/png" });
    const signal = new AbortController().signal;
    const detail = root.findByType(TaskDescriptionEditor);
    const comment = root.findByType(TaskCommentEditor);
    await detail.props.upload(file, "task_attachment", signal);
    expect(uploadBusinessFile).toHaveBeenLastCalledWith({ client, organizationId: "org_one", taskId: "task_one", purpose: "task_attachment", file, signal });
    await comment.props.upload(file, "task_image", signal);
    expect(uploadBusinessFile).toHaveBeenLastCalledWith({ client, organizationId: "org_one", taskId: "task_one", purpose: "task_image", file, signal });
    await act(async () => root.findByProps({ "data-testid": "task-detail-backdrop" }).props.onClick());
    const sidebar = root.findByProps({ "data-testid": "tasks-sidebar" });
    await act(async () => sidebar.findAllByType("button").find(button => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!.props.onClick());
    await settle();
    await act(async () => root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0].props.onClick());
    const dialog = root.findByProps({ "data-testid": "task-create-dialog" });
    await act(async () => dialog.findByProps({ autoFocus: true, placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Draft" } }));
    await act(async () => dialog.findByProps({ "data-testid": "task-description-attachment" }).props.onClick());
    uploadBusinessFile.mockReturnValueOnce(receipt.promise);
    await act(async () => dialog.findByProps({ type: "file" }).props.onChange({ currentTarget: { files: [file] } }));
    expect(uploadBusinessFile).toHaveBeenLastCalledWith({ client, organizationId: "org_one", taskId: undefined, purpose: "task_attachment", file, signal: expect.any(AbortSignal) });
    expect(dialog.findByType("form").findByProps({ type: "submit" }).props.disabled).toBe(true);
    await act(async () => dialog.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(create).not.toHaveBeenCalled();
    await act(async () => receipt.resolve({ url: "https://files.test/map.png", name: file.name }));
    await act(async () => dialog.findByType("form").props.onSubmit({ preventDefault() {} }));
    expect(create).toHaveBeenCalledWith("org_one", expect.objectContaining({ title: "Draft", description: '[map.png](https://files.test/map.png "task-file:4")' }));
  } finally { await act(async () => renderer.unmount()); }
});

test("toolbar new task list uses the sidebar inline private mutation and exposes failures", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    createProductTaskList: async (_orgId, input) => {
      creates.push(input);
      throw new Error("List create failed");
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[1]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onChange({ currentTarget: { value: "Launch list" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create" }).props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({ name: "Launch list", description: "", marker: "L", visibility: "private" });
    expect(toastErrors).toContain("List create failed");
    expect(renderer!.root.findAll((node) => node.props.children === "List create failed")).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.value).toBe("Launch list");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("Assigned toolbar inline creation submits a title-only private task with no default assignee", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const self = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } };
  const client = connectedClient({
    listOrganizationMembers: async () => ({ members: [self], total: 1, limit: 200, offset: 0 }),
    createProductTask: async (_orgId, input) => { creates.push(input); return result(task(1, input.title, "", "inline_task")); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    const row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-top" });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "Inline task" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-row-top" }).findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({ title: "Inline task", priority: "none", visibility: "private", members: [] });
    expect(creates[0]?.idempotencyKey).toEqual(expect.any(String));
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test.each([
  ["legacy", "members", undefined, "members"],
  ["historical", "organization", false, "organization"],
  ["enabled members", "members", true, "private"],
  ["enabled organization", "organization", true, "private"],
] as const)("selected %s list quick creation retains the list and uses the correct direct visibility", async (_mode, visibility, grantsTaskAccess, expectedVisibility) => {
  const list: DenProductTaskList = { id: "list_quick_create", creatorMemberId: "member_self", name: "Current list", description: "", marker: "C", visibility, version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...(grantsTaskAccess === undefined ? {} : { grantsTaskAccess }) };
  const creates: Array<Record<string, unknown>> = [];
  let created: DenProductTask | null = null;
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    getProductTaskList: async () => ({ list, members: [{ memberId: "member_self", role: "administrator" }], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: true, canDelete: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false }),
    listProductTasks: async (_orgId, input) => ({ items: input?.listId?.includes(list.id) && created ? [created] : [], membersByTaskId: created ? { [created.id]: [] } : {}, nextCursor: "" }),
    createProductTask: async (_orgId, input) => {
      creates.push(input);
      created = { ...task(1, input.title, "", "list_inline_task"), listId: input.listId ?? null, visibility: input.visibility ?? "private" };
      return result(created);
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "tasks-sidebar-list-list_quick_create" }).props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    const row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-custom-default" });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "List task" } }); });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({ title: "List task", listId: "list_quick_create", visibility: expectedVisibility, priority: "none", members: [] });
    expect(renderer!.root.findByProps({ "data-testid": "task-title-cell-list_inline_task" })).toBeDefined();
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Assigned status changes keep the workbench mounted while the replacement query is pending", async () => {
  const listed = task(1, "Previous task", "", "previous_task");
  const pending = deferred<Awaited<ReturnType<DenClient["listProductTasks"]>>>();
  let requests = 0;
  const client = connectedClient({
    listProductTasks: async () => {
      requests += 1;
      return requests < 3 ? { items: [listed], membersByTaskId: { [listed.id]: [] }, nextCursor: "" } : pending.promise;
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    const statusMenu = renderer!.root.findByProps({ "data-testid": "task-status-menu" });
    const statusGroup = statusMenu.find((node) => node.props.value === "incomplete" && typeof node.props.onValueChange === "function");
    await act(async () => { statusGroup.props.onValueChange("completed"); });
    expect(renderer!.root.findByProps({ "data-testid": "task-workbench-toolbar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "assigned-task-table" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-title-cell-previous_task" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-filter-refreshing" })).toBeDefined();
    await act(async () => { pending.resolve({ items: [], membersByTaskId: {}, nextCursor: "" }); });
    await settle();
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("pending task-list creation cannot close or alert in a new organization scope", async () => {
  const pending = deferred<Awaited<ReturnType<DenClient["createProductTaskList"]>>>();
  const client = connectedClient({ createProductTaskList: async () => pending.promise });
  const queryClient = createQueryClient();
  setCloudSession(client, "org_one");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(queryClient)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[1]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create-input" }).props.onChange({ currentTarget: { value: "Old list" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-sidebar-list-create" }).props.onSubmit({ preventDefault: () => undefined }); });

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient)); });
    await settle();
    await act(async () => { pending.reject(new Error("Old list failure")); });
    await settle();
    expect(renderer!.root.findAllByProps({ "data-testid": "task-sidebar-list-create-input" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Old list failure")).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("renders loading and retryable error states", async () => {
  let retried = 0;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<TaskShellContent state={{ kind: "loading" }} />);
  });
  expect(renderer!.root.findByProps({ role: "status" })).toBeDefined();
  await act(async () => {
    renderer!.update(<TaskShellContent state={{ kind: "error", onRetry: () => { retried += 1; } }} />);
  });
  expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
  await act(async () => { renderer!.root.findByType("button").props.onClick(); });
  expect(retried).toBe(1);
  await act(async () => { renderer!.unmount(); });
});

test("shows full-create mutation failures without an unhandled rejection", async () => {
  const client = connectedClient({ createProductTask: async () => { throw new Error("Create failed"); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const allTasks = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" }).findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("All tasks"))!;
    await act(async () => { allTasks.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    const input = renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" });
    await act(async () => { input.props.onChange({ target: { value: "New task" } }); });
    const form = renderer!.root.findByProps({ role: "dialog" }).findByType("form");
    await act(async () => { form.props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(toastErrors).toContain("Create failed");
    expect(renderer!.root.findAll((node) => node.props.children === "Create failed")).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test.each([
  ["legacy members", "members", undefined, "member_other", "member_self", "members"],
  ["legacy private", "private", undefined, "member_other", "member_self", "members"],
  ["legacy private", "private", undefined, "member_self", "member_other", "members"],
  ["legacy private", "private", undefined, "member_self", "member_self", "private"],
  ["legacy organization", "organization", undefined, "member_other", "member_self", "organization"],
  ["historical organization", "organization", false, "member_other", "member_self", "organization"],
  ["enabled members", "members", true, "member_self", "member_self", "private"],
  ["enabled organization", "organization", true, null, null, "private"],
  ["enabled organization", "organization", true, "member_other", null, "members"],
  ["enabled organization", "organization", true, null, "member_other", "members"],
] as const)("full task creation: %s list, assignee and follower determine direct visibility (%s, %s, %s, %s → %s)", async (_mode, listVisibility, grantsTaskAccess, assignee, follower, expectedVisibility) => {
  const creates: Array<Record<string, unknown>> = [];
  const members = [
    { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } },
    { id: "member_other", userId: "user_two", role: "member", user: { id: "user_two", name: "Other", account: null, email: null, avatar: null } },
  ];
  const list: DenProductTaskList = { id: "list_one", creatorMemberId: "member_self", name: "Launch", description: "", marker: "L", visibility: listVisibility, version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...(grantsTaskAccess === undefined ? {} : { grantsTaskAccess }) };
  const client = connectedClient({
    listOrganizationMembers: async () => ({ members, total: 2, limit: 200, offset: 0 }),
    listProductTaskLists: async () => ({ items: [list], nextCursor: "" }),
    createProductTask: async (_orgId, input) => { creates.push(input); return result(task(1, input.title, input.description, "created_task")); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    expect(dialog.findByProps({ "data-testid": "task-create-assignees-trigger" }).findAllByType("span").some((node) => node.props.children === "Add assignee")).toBe(true);
    await act(async () => {
      dialog.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Full task" } });
    });
    await act(async () => { dialog.findByType(TaskDescriptionEditor).props.onChange("Everything"); });
    await act(async () => { renderer!.root.findAll((node) => node.props.children === "Today")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-option-create-dialog-draft-list_one" }).props.onClick(); });
    const assignees = assignee === "member_other" ? ["member_self", assignee] : assignee ? [assignee] : [];
    for (const id of assignees) await act(async () => { renderer!.root.findByProps({ "data-testid": `task-create-assignees-option-${id}` }).props.onClick(); });
    if (follower) await act(async () => { renderer!.root.findByProps({ "data-testid": `task-create-followers-option-${follower}` }).props.onClick(); });
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({
      title: "Full task",
      description: "Everything",
      priority: "none",
      visibility: expectedVisibility,
      listId: "list_one",
      members: [...assignees.map((memberId) => ({ memberId, role: "assignee" })), ...(follower ? [{ memberId: follower, role: "follower" }] : [])],
    });
    expect(typeof creates[0]?.dueAt).toBe("string");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("full task creation keeps the selected start and due dates independent", async () => {
  const creates: Array<Parameters<DenClient["createProductTask"]>[1]> = [];
  const client = connectedClient({
    createProductTask: async (_orgId, input) => { creates.push(input); return result(task(1, input.title)); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const allTasks = sidebar.findAllByType("button").find((button) => React.Children.toArray(button.props.children).includes("All tasks"))!;
    await act(async () => { allTasks.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await act(async () => { dialog.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Scheduled task" } }); });
    const cell = dialog.findByType(TaskDateTimeCell);
    const dueAt = "2026-11-20T18:00:00.000Z";
    const startAt = "2026-11-18T09:00:00.000Z";
    await act(async () => { await cell.props.onChange(cell.props.task, "dueAt", dueAt); });
    await act(async () => { await cell.props.onChange(cell.props.task, "startAt", startAt); });
    expect(cell.props.task).toMatchObject({ startAt, dueAt });
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ startAt, dueAt });
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("full task creation can set one priority and assign a custom group", async () => {
  const created = task(1, "Grouped task", "", "grouped_task");
  const priorities: Array<DenProductTask["priority"] | undefined> = [];
  const client = connectedClient({ createProductTask: async (_orgId, input) => { priorities.push(input.priority); return result(created); } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Grouped task" } }); });
    const priority = renderer!.root.findByProps({ "data-testid": "task-create-priority" });
    expect(priority.props.value).toBe("none");
    expect(priority.findAllByType("option").filter((option) => !option.props.disabled).map((option) => option.props.value)).toEqual(["low", "medium", "high"]);
    await act(async () => { priority.props.onChange({ currentTarget: { value: "medium" } }); });
    await act(async () => { renderer!.root.findByProps({ placeholder: "Search or create a group" }).props.onChange({ target: { value: "Planning" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-group-create" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ role: "dialog" }).findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(priorities).toEqual(["medium"]);
    const settings = JSON.parse(localValues.get(taskWorkbenchStorageKey({ baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" }, "assigned")) ?? "{}") as { customGroups?: Array<{ id: string; name: string }>; customGroupAssignments?: Record<string, string> };
    expect(settings.customGroups?.[0]?.name).toBe("Planning");
    expect(settings.customGroupAssignments?.grouped_task).toBe(settings.customGroups?.[0]?.id);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("task priority saves from the workbench and detail only with current edit permission", async () => {
  const scope = { baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" };
  sessionValues.set(taskSectionStorageKey(scope), "all");
  localValues.set(taskWorkbenchStorageKey(scope, "all"), JSON.stringify({ fields: ["priority"] }));
  let current = task(4, "Prioritize this task", "", "priority_task");
  let allowed = true;
  const activityRefreshes: DenProductTask["priority"][] = [];
  const updates: Array<{ priority: DenProductTask["priority"] | undefined; expectedVersion: number }> = [];
  const detail = () => { const value = result(current); value.permissions.canEditContent = allowed; return value; };
  const client = connectedClient({
    listProductTasks: async () => ({ items: [current], nextCursor: "" }),
    listProductTaskActivity: async () => {
      activityRefreshes.push(current.priority);
      return { items: [], nextCursor: "", hasMore: false, unreadCount: 0, latestSequence: 0 };
    },
    getProductTask: async () => detail(),
    updateProductTask: async (_orgId, _taskId, input) => {
      updates.push({ priority: input.priority, expectedVersion: input.expectedVersion });
      current = { ...current, priority: input.priority ?? current.priority, version: current.version + 1 };
      return detail();
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const listPriority = () => renderer!.root.findByProps({ "data-testid": "task-priority-trigger-priority_task" });
    await act(async () => { listPriority().props.onChange({ currentTarget: { value: "low" } }); });
    await settle();
    expect(listPriority().props.value).toBe("low");
    expect(activityRefreshes).toEqual(["none", "low"]);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-title-cell-priority_task" }).findByProps({ children: "Prioritize this task" }).props.onClick(); });
    await settle();
    const detailPriority = () => renderer!.root.findByProps({ "data-testid": "task-detail-priority" });
    await act(async () => { detailPriority().props.onChange({ currentTarget: { value: "high" } }); });
    await settle();
    expect(detailPriority().props.value).toBe("high");
    expect(listPriority().props.value).toBe("high");
    allowed = false;
    await act(async () => { listPriority().props.onChange({ currentTarget: { value: "medium" } }); });
    await settle();
    expect(detailPriority().props.disabled).toBe(true);
    expect(listPriority().props.value).toBe("high");
    expect(updates).toEqual([{ priority: "low", expectedVersion: 4 }, { priority: "high", expectedVersion: 5 }]);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("workbench transitions fetch authoritative detail before permission and confirmation checks", async () => {
  const listed = task(1, "Shared task", "", "shared_task");
  const authoritative = result({ ...listed, version: 4 });
  authoritative.members = [{ memberId: "member_one", role: "assignee" }, { memberId: "member_two", role: "assignee" }];
  const gets: string[] = [];
  const transitions: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], nextCursor: "" }),
    getProductTask: async (_orgId, taskId) => { gets.push(taskId); return authoritative; },
    transitionProductTask: async (_orgId, _taskId, _operation, input) => { transitions.push(input); return authoritative; },
  });
  const originalConfirm = globalThis.confirm;
  let confirmations = 0;
  globalThis.confirm = () => { confirmations += 1; return false; };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Complete task" }).props.onClick(); });
    await settle();
    expect(gets).toEqual(["shared_task"]);
    expect(confirmations).toBe(1);
    expect(transitions).toHaveLength(0);
  } finally {
    globalThis.confirm = originalConfirm;
    await act(async () => { renderer!.unmount(); });
  }
});

test("workbench transitions stop when authoritative detail denies permission", async () => {
  const listed = task(1, "Protected task", "", "protected_task");
  const authoritative = result(listed);
  authoritative.permissions.canComplete = false;
  let transitions = 0;
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: [{ memberId: "member_one", role: "assignee" }] }, nextCursor: "" }),
    getProductTask: async () => authoritative,
    transitionProductTask: async () => { transitions += 1; return authoritative; },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Complete task" }).props.onClick(); });
    await settle();
    expect(transitions).toBe(0);
    expect(toastErrors).toContain("You do not have permission to perform this task action.");
    expect(renderer!.root.findAll((node) => node.props.children === "You do not have permission to perform this task action.")).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("workbench completion does not proceed when authoritative detail loading fails", async () => {
  const listed = task(1, "Unknown members", "", "unknown_members");
  let transitions = 0;
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: [] }, nextCursor: "" }),
    getProductTask: async () => { throw new Error("Detail unavailable"); },
    transitionProductTask: async () => { transitions += 1; return result(listed); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Complete task" }).props.onClick(); });
    await settle();
    expect(transitions).toBe(0);
    expect(toastErrors).toContain("Detail unavailable");
    expect(renderer!.root.findAll((node) => node.props.children === "Detail unavailable")).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("workbench completion sends only lifecycle contract fields and refreshes the list", async () => {
  const listed = task(1, "Complete me", "", "complete_me");
  const authoritative = result(listed);
  authoritative.members = [{ memberId: "member_one", role: "assignee" }];
  const transitionInputs: Array<Record<string, unknown>> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: authoritative.members }, nextCursor: "" }),
    getProductTask: async () => authoritative,
    transitionProductTask: async (_orgId, _taskId, operation, input) => {
      transitionInputs.push({ operation, ...input });
      return result({ ...listed, status: "completed", version: 2, completedAt: "2026-11-05T00:00:00Z", completedByMemberId: "member_one" });
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Complete task" }).props.onClick(); });
    await settle();
    expect(transitionInputs).toHaveLength(1);
    expect(transitionInputs[0]).toEqual({ operation: "complete", expectedVersion: 1, idempotencyKey: expect.any(String) });
    expect(transitionInputs[0]).not.toHaveProperty("taskId");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("workbench completion rule loads the latest task and sends a CAS update", async () => {
  const listed = task(1, "Rule task", "", "rule_task");
  const authoritative = result({ ...listed, version: 7 });
  authoritative.members = [{ memberId: "member_one", role: "assignee" }];
  const gets: string[] = [];
  const updates: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: authoritative.members }, nextCursor: "" }),
    listOrganizationMembers: async () => ({ members: [{ id: "member_one", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } }], total: 1, limit: 200, offset: 0 }),
    getProductTask: async (_orgId, taskId) => { gets.push(taskId); return authoritative; },
    updateProductTask: async (_orgId, _taskId, patch) => { updates.push(patch); return result({ ...authoritative.task, completionPolicy: patch.completionPolicy ?? authoritative.task.completionPolicy, version: 8 }); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-completion-policy-rule_task-all_assignees" }).props.onClick(); });
    await settle();
    expect(gets).toEqual(["rule_task"]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ expectedVersion: 7, idempotencyKey: expect.any(String), completionPolicy: "all_assignees" });
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("workbench time update loads the latest task permission and sends a CAS patch", async () => {
  const listed = task(1, "Time task", "", "time_task");
  const authoritative = result({ ...listed, version: 9 });
  const updates: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: [] }, nextCursor: "" }),
    getProductTask: async () => authoritative,
    updateProductTask: async (_orgId, _taskId, patch) => { updates.push(patch); return result({ ...authoritative.task, ...patch, version: 10 }); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    const day = renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-time-day-time_task-startAt-") && node.props.disabled === false)[0]!;
    await act(async () => { day.props.onClick(); });
    await settle();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ expectedVersion: 9, idempotencyKey: expect.any(String), startAt: expect.any(String) });
  } finally { await act(async () => renderer!.unmount()); }
});

const destination: DenProductTaskList = { id: "list_destination", creatorMemberId: "member_self", name: "Personal filing", description: "", marker: "P", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
const destinationResult = () => ({ list: destination, members: [], permissions: { canView: true, canEdit: true, canManageMembers: true, canTransferOwnership: false, canDelete: false, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false });

test.each(["new share", "new promotion", "new demotion", "historical share", "historical admin share", "standalone enable", "standalone without digest"] as const)("%s follows the task-access confirmation rules", async (mode) => {
  const active = mode.startsWith("new");
  const promote = mode === "new promotion";
  const demote = mode === "new demotion";
  const nonOwner = mode === "historical admin share";
  const standalone = mode.startsWith("standalone");
  const requiresConfirmation = !demote && !nonOwner;
  const preview = { taskCount: standalone ? 0 : 3, digest: mode === "standalone without digest" ? "" : "access-digest" };
  const target: DenProductTaskList = { ...destination, creatorMemberId: nonOwner ? "member_owner" : "member_self", grantsTaskAccess: active, version: 7, visibility: promote || demote || nonOwner ? "members" : "private" };
  let listDetail: DenProductTaskListResult = { ...destinationResult(), list: target, members: [{ memberId: "member_self", role: "administrator" }] };
  if (nonOwner) listDetail.members.unshift({ memberId: target.creatorMemberId, role: "administrator" });
  if (promote || demote) listDetail.members.push({ memberId: "member_two", role: demote ? "administrator" : "member" });
  const teammate = { id: "member_two", userId: "user_two", role: "member", user: { id: "user_two", name: "Teammate", account: null, email: null, avatar: null } };
  const patches: Parameters<DenClient["updateProductTaskList"]>[2][] = [];
  const previewReads: string[][] = [];
  const prompts: string[] = [];
  const originalConfirm = globalThis.confirm;
  let accept = false;
  globalThis.confirm = (message) => { prompts.push(message ?? ""); return accept; };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [listDetail.list], nextCursor: "" }),
    getProductTaskList: async () => listDetail,
    getProductTaskListAccessPreview: async (...args) => { previewReads.push(args); return preview; },
    listOrganizationMembers: async () => ({ members: [teammate], total: 1, limit: 200, offset: 0 }),
    updateProductTaskList: async (_org, _id, patch) => {
      patches.push(patch);
      listDetail = { ...listDetail, list: { ...target, grantsTaskAccess: active || patch.enableTaskAccess === true, version: 8 }, members: patch.members ?? listDetail.members };
      return listDetail;
    },
  });
  const queryClient = createQueryClient();
  setCloudSession(client);
  const taskCachePrefix = ["product-tasks", "https://work.example", "user_one", "org_one"];
  const inactiveTask = [...taskCachePrefix, "details", "inactive-task"];
  const inactiveList = [...taskCachePrefix, "lists", { view: "completed" }];
  queryClient.setQueryData(inactiveTask, result(task(1)));
  queryClient.setQueryData(inactiveList, { pages: [], pageParams: [] });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(queryClient)); });
  const click = (id: string) => act(async () => { renderer.root.findByProps({ "data-testid": id }).props.onClick(); });
  try {
    await settle();
    await click(`tasks-sidebar-list-${target.id}`);
    await settle();
    let saveButton = "task-list-enable-task-access";
    if (promote || demote) {
      await click("task-list-collaborators-trigger");
      await click(demote ? "task-list-collaborator-read-member_two" : "task-list-collaborator-edit-member_two");
      saveButton = "task-list-collaborators-done";
    } else if (!standalone) {
      await click("task-list-share-trigger");
      const search = renderer!.root.findByProps({ "aria-label": "Search people and groups" });
      await act(async () => { search.props.onChange({ currentTarget: { value: "Teammate" } }); });
      await click("task-list-share-search");
      await click("task-list-share-member-member_two");
      saveButton = "task-list-share-confirm";
    }

    if (nonOwner) expect(renderer!.root.findAllByProps({ "data-testid": "task-list-enable-task-access" })).toHaveLength(0);
    if (requiresConfirmation) {
      await click(saveButton);
      await settle();
      expect(previewReads).toEqual([["org_one", target.id]]);
      expect(prompts[0]).toContain(`Tasks currently in this list: ${preview.taskCount}`);
      expect(prompts[0]).toContain(target.name);
      expect(patches).toHaveLength(0);
      expect(queryClient.getQueryState(inactiveTask)?.isInvalidated).toBe(false);
    }

    accept = true;
    await click(saveButton);
    await settle();
    expect(previewReads).toHaveLength(requiresConfirmation ? 2 : 0);
    expect(patches).toHaveLength(1);
    expect(patches[0]?.expectedVersion).toBe(7);
    if (requiresConfirmation && preview.digest) expect(patches[0]?.confirmedAccessDigest).toBe(preview.digest);
    else expect(patches[0]).not.toHaveProperty("confirmedAccessDigest");
    if (active || nonOwner) expect(patches[0]).not.toHaveProperty("enableTaskAccess");
    else expect(patches[0]?.enableTaskAccess).toBe(true);
    if (standalone) expect(patches[0]).not.toHaveProperty("members");
    else expect(patches[0]?.members).toContainEqual({ memberId: teammate.id, role: promote ? "administrator" : "member" });
    expect(queryClient.getQueryState(inactiveTask)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(inactiveList)?.isInvalidated).toBe(true);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-list-enable-task-access" })).toHaveLength(0);
  } finally { globalThis.confirm = originalConfirm; await act(async () => renderer!.unmount()); }
});

test.each(["shared", "public", "owner-only", "historical", "old server"] as const)("filing into a %s list only confirms changes that grant task access", async (mode) => {
  const filing = task(1);
  const requiresConfirmation = mode === "shared" || mode === "public";
  const list: DenProductTaskList = { ...destination, version: 24, visibility: mode === "public" ? "organization" : mode === "owner-only" ? "private" : "members", ...(mode === "old server" ? {} : { grantsTaskAccess: mode !== "historical" }) };
  const details: DenProductTaskListResult = { ...destinationResult(), list, members: [{ memberId: list.creatorMemberId, role: "administrator" }, ...(["public", "owner-only"].includes(mode) ? [] : [{ memberId: "member_two", role: "member" as const }])] };
  let current = filing;
  const writes: Parameters<DenClient["setProductTaskListMembership"]>[] = [];
  const originalConfirm = globalThis.confirm;
  const prompts: string[] = [];
  let accept = false;
  globalThis.confirm = (message) => { prompts.push(message ?? ""); return accept; };
  const client = connectedClient({
    listProductTaskLists: async () => ({ items: [{ ...list, version: 2 }], nextCursor: "" }),
    getProductTaskList: async () => details,
    getProductTask: async () => result(current),
    setProductTaskListMembership: async (...args) => {
      writes.push(args);
      const [, taskId, listId, added] = args;
      current = { ...current, listId: added ? listId : null };
      return { taskId, listId, added };
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, filing.id)); });
  try {
    await settle();
    const option = () => renderer!.root.findByProps({ "data-testid": `task-list-option-${filing.id}-${list.id}` });
    const toggle = () => act(async () => { option().props.onClick(); });
    await toggle();
    await settle();
    if (requiresConfirmation) {
      expect(option().props["aria-pressed"]).toBe(false);
      expect(writes).toHaveLength(0);
      expect(prompts[0]).toContain(mode === "public" ? "Everyone in the organization" : "People with access to the list");
      accept = true;
      await toggle();
      await settle();
    }
    expect(option().props["aria-pressed"]).toBe(true);
    const addArgs = ["org_one", filing.id, list.id, true];
    expect(writes).toEqual([requiresConfirmation ? [...addArgs, 24] : addArgs]);
    await toggle();
    await settle();
    expect(option().props["aria-pressed"]).toBe(false);
    expect(writes[1]).toEqual(["org_one", filing.id, list.id, false]);
    expect(prompts).toHaveLength(requiresConfirmation ? 2 : 0);
  } finally { globalThis.confirm = originalConfirm; await act(async () => renderer!.unmount()); }
});

for (const surface of ["table", "detail"] as const) {
  test(`${surface}: non-creator files a visible task, reloads, and removes just one membership`, async () => {
    const original = { ...destination, id: "list_orig", name: "Original" };
    let listed = { ...task(1), visibility: "members" as const, listIds: [original.id], listId: "legacy_hidden" };
    let directory = [original];
    const writes: Array<[string, string, string, boolean]> = [];
    const client = connectedClient({
      listProductTasks: async () => ({ items: [listed], nextCursor: "" }),
      getProductTask: async () => { const detail = result(listed); detail.permissions.canManageMembers = detail.permissions.canManageVisibility = false; return detail; },
      listProductTaskLists: async () => ({ items: directory, nextCursor: "" }),
      createProductTaskList: async () => { directory = [original, destination]; return destinationResult(); },
      getProductTaskList: async () => destinationResult(),
      setProductTaskListMembership: async (org, taskId, listId, added) => {
        writes.push([org, taskId, listId, added]);
        listed = { ...listed, listIds: added ? [...listed.listIds, listId] : listed.listIds.filter((id) => id !== listId) };
        return { taskId, listId, added };
      },
    });
    let renderer: TestRenderer.ReactTestRenderer;
    const mount = async () => {
      await act(async () => { renderer = TestRenderer.create(connectedPage(client, surface === "detail" ? listed.id : undefined)); });
      await settle();
      if (surface === "table") {
        await act(async () => { renderer.root.findByProps({ "data-testid": "tasks-sidebar" }).findAllByType("button").find((b) => Array.isArray(b.props.children) && b.props.children.includes("All tasks"))!.props.onClick(); });
        await settle();
      }
    };
    const option = (id: string) => renderer.root.findByProps({ "data-testid": `task-list-option-${listed.id}-${id}` });
    await mount();
    try {
      expect(option(original.id).props["aria-pressed"]).toBe(true);
      expect(renderer!.root.findAllByProps({ "data-testid": `task-list-option-${listed.id}-none` })).toHaveLength(0);
      await act(async () => { renderer.root.findByProps({ "data-testid": `task-list-search-${listed.id}` }).props.onChange({ currentTarget: { value: destination.name } }); });
      await act(async () => { renderer.root.findByProps({ "data-testid": `task-list-create-${listed.id}` }).props.onClick(); });
      await settle();
      expect(option(original.id).props["aria-pressed"]).toBe(true);
      expect(option(destination.id).props["aria-pressed"]).toBe(true);
      await act(async () => renderer.unmount());
      await mount(); // New query client; checked state must come from the server projection.
      expect(option(destination.id).props["aria-pressed"]).toBe(true);
      await act(async () => { option(destination.id).props.onClick(); });
      await settle();
      expect(option(original.id).props["aria-pressed"]).toBe(true);
      expect(option(destination.id).props["aria-pressed"]).toBe(false);
      expect(writes).toEqual([["org_one", listed.id, destination.id, true], ["org_one", listed.id, destination.id, false]]);
    } finally { await act(async () => renderer.unmount()); }
  });
}

for (const boundary of ["read-only", "archived", "org", "user", "deployment", "unmount", "server-denied"] as const) {
  test(`list membership respects ${boundary} boundary`, async () => {
    const listed = task(1);
    const pending = deferred<ReturnType<typeof destinationResult>>();
    let writes = 0;
    const client = connectedClient({
      listProductTaskLists: async () => ({ items: [destination], nextCursor: "" }),
      getProductTask: async () => result(listed),
      getProductTaskList: async () => pending.promise,
      setProductTaskListMembership: async () => { writes++; throw new DenApiError(403, "forbidden", "Membership denied"); },
    });
    const queryClient = createQueryClient();
    setCloudSession(client);
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(taskPage(queryClient, listed.id)); });
    await settle();
    try {
      const option = () => renderer.root.findByProps({ "data-testid": `task-list-option-${listed.id}-${destination.id}` });
      await act(async () => { option().props.onClick(); });
      if (boundary === "org") setCloudSession(client, "org_two");
      if (boundary === "user") cloudSession.user = { id: "user_two", name: "Other" };
      if (boundary === "deployment") cloudSession.baseUrl = "https://other.example";
      if (boundary === "unmount") await act(async () => renderer.unmount());
      else await act(async () => renderer.update(taskPage(queryClient, listed.id)));
      const readable = destinationResult(); // The list remains visible even when not writable.
      readable.permissions.canAddTasks = boundary !== "read-only";
      if (boundary === "archived") readable.list = { ...destination, archivedAt: destination.createdAt };
      await act(async () => { pending.resolve(readable); });
      await settle();
      expect(writes).toBe(boundary === "server-denied" ? 1 : 0);
      if (["read-only", "archived", "server-denied"].includes(boundary)) {
        expect(option().props["aria-pressed"]).toBe(false);
        expect(toastErrors).toHaveLength(1);
      } else expect(toastErrors).toHaveLength(0);
    } finally { if (boundary !== "unmount") await act(async () => renderer.unmount()); }
  });
}

test.each(["legacy workbench", "new workbench", "new detail"] as const)("%s shares a private task in the same latest-version assignment patch", async (mode) => {
  const listed = task(1, "Private task", "", "private_task");
  const legacy = mode === "legacy workbench";
  const inDetail = mode === "new detail";
  const authoritative = result({ ...listed, version: 9, ...(legacy ? {} : { listId: "listed", listIds: ["listed"] }) });
  authoritative.members = [{ memberId: "member_one", role: "assignee" }, { memberId: "member_one", role: "follower" }, { memberId: "member_one", role: "viewer" }];
  if (!legacy) Object.assign(authoritative.permissions, { canAssign: true, canManageMembers: false, canManageVisibility: false, canEditContent: false, canEditTime: false });
  const updates: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  const directory = [
    { id: "member_one", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } },
    { id: "member_two", userId: "user_two", role: "member", user: { id: "user_two", name: "Other", account: null, email: null, avatar: null } },
  ];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: authoritative.members }, nextCursor: "" }),
    listOrganizationMembers: async () => ({ members: directory, total: directory.length, limit: 200, offset: 0 }),
    getProductTask: async () => authoritative,
    updateProductTask: async (_orgId, _taskId, patch) => { updates.push(patch); return result({ ...authoritative.task, visibility: "members", version: 10 }); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, inDetail ? listed.id : undefined)); });
  await settle();
  try {
    if (!inDetail) {
      const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
      const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
      await act(async () => { assigned.props.onClick(); });
      await settle();
    }
    const editor = inDetail ? renderer!.root.findByProps({ "data-testid": "task-detail-panel" }) : renderer!.root;
    await act(async () => { editor.findByProps({ "data-testid": "task-assignee-option-private_task-member_two" }).props.onClick(); });
    await settle();
    expect(updates).toEqual([{
      expectedVersion: 9,
      idempotencyKey: expect.any(String),
      visibility: "members",
      members: [{ memberId: "member_one", role: "follower" }, { memberId: "member_one", role: "viewer" }, { memberId: "member_one", role: "assignee" }, { memberId: "member_two", role: "assignee" }],
    }]);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test.each(["explicit denial", "legacy private in list"] as const)("assignee editing respects %s", async (mode) => {
  const authoritative = result({ ...task(1), listId: "listed" });
  if (mode === "explicit denial") authoritative.permissions.canAssign = false;
  const updates: unknown[] = [];
  const client = connectedClient({
    getProductTask: async () => authoritative,
    updateProductTask: async (_orgId, _taskId, patch) => { updates.push(patch); return authoritative; },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, authoritative.task.id)); });
  await settle();
  try {
    const panel = renderer!.root.findByProps({ "data-testid": "task-detail-panel" });
    if (mode === "explicit denial") {
      expect(panel.findAllByProps({ "data-testid": "task-assignee-trigger-task_one" })).toHaveLength(0);
    } else {
      await act(async () => { panel.findByProps({ "data-testid": "task-assignee-option-task_one-member_self" }).props.onClick(); });
      await settle();
      expect(toastErrors).toHaveLength(1);
    }
    expect(updates).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task detail shows the saved due date without a picker when time editing is denied", async () => {
  const authoritative = result({ ...task(1), dueAt: new Date(2026, 10, 18).toISOString() });
  authoritative.permissions.canEditTime = false;
  const client = connectedClient({ getProductTask: async () => authoritative });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, authoritative.task.id)); });
  await settle();
  try {
    const panel = renderer!.root.findByProps({ "data-testid": "task-detail-panel" });
    const trigger = panel.findByProps({ "data-testid": "task-time-trigger-task_one-dueAt" });
    expect(trigger.props.disabled).toBe(true);
    expect(trigger.findByType("span").props.children).toBe(new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(new Date(authoritative.task.dueAt!)));
    expect(panel.findAllByProps({ "data-testid": "task-time-picker-task_one-dueAt" })).toHaveLength(0);
    expect(panel.findAllByType("input").find((node) => node.props.value === authoritative.task.title)?.props.readOnly).toBe(false);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("late current-member resolution keeps Assigned creation unassigned until the user chooses", async () => {
  const memberPage = deferred<Awaited<ReturnType<DenClient["listOrganizationMembers"]>>>();
  const creates: Array<Record<string, unknown>> = [];
  const self = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } };
  const other = { id: "member_other", userId: "user_two", role: "member", user: { id: "user_two", name: "Other", account: null, email: null, avatar: null } };
  const client = connectedClient({
    listOrganizationMembers: async () => memberPage.promise,
    createProductTask: async (_orgId, input) => { creates.push(input); return result(task(1, input.title, "", "created")); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await act(async () => { dialog.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Late identity" } }); });
    expect(dialog.findAllByType("button").find((button) => button.props.type === "submit")!.props.disabled).toBe(false);
    await act(async () => { memberPage.resolve({ members: [self, other], total: 2, limit: 200, offset: 0 }); });
    await settle();
    const resolvedDialog = renderer!.root.findByProps({ role: "dialog" });
    expect(resolvedDialog.findByProps({ "data-testid": "task-create-assignees-trigger" }).findAllByType("span").some((node) => node.props.children === "Add assignee")).toBe(true);
    await act(async () => { resolvedDialog.findByProps({ "data-testid": "task-create-assignees-option-member_other" }).props.onClick(); });
    expect(resolvedDialog.findByProps({ "data-testid": "task-create-assignees-trigger" }).findAll((node) => node.props.children === "1 selected")).toHaveLength(1);
    await act(async () => { resolvedDialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]?.members).toEqual([{ memberId: "member_other", role: "assignee" }]);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("organization member failures keep tasks visible and expose retry in workbench and create dialog", async () => {
  const listed = task(1, "Visible task");
  let memberRequests = 0;
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: [] }, nextCursor: "" }),
    listOrganizationMembers: async () => { memberRequests += 1; throw new DenApiError(500, "members_failed", "Directory failed"); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    expect(renderer!.root.findAll((node) => node.props.children === "Visible task").length).toBeGreaterThan(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Organization members are temporarily unavailable. Tasks are still shown.")).toHaveLength(1);
    const beforeRetry = memberRequests;
    await act(async () => { renderer!.root.findAllByType("button").find((button) => button.props.children === "Retry")!.props.onClick(); });
    await settle();
    expect(memberRequests).toBeGreaterThan(beforeRetry);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    expect(renderer!.root.findByProps({ role: "dialog" }).findAll((node) => node.props.children === "Organization members are temporarily unavailable. Tasks are still shown.")).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.props.children === "No organization members are available.")).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Personal workspace identified by its legacy ID uses the current-member fallback", async () => {
  let memberRequests = 0;
  const client = connectedClient({
    listOrganizationMembers: async () => {
      memberRequests += 1;
      throw new DenApiError(403, "feature_unavailable_for_scope", "Unavailable in Personal Workspace");
    },
  });
  setCloudSession(client);
  cloudSession.activeOrganization = {
    id: "personal_legacy",
    name: "Personal",
    slug: "personal_legacy",
    role: "owner",
  };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(createQueryClient())); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    expect(memberRequests).toBe(1);
    expect(renderer!.root.findAll((node) => node.props.children === "Organization members are temporarily unavailable. Tasks are still shown.")).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("Personal workspace member directory populates the fixed assigned-to-me filter", async () => {
  const personalMember = { id: "member_personal", userId: "user_one", role: "owner", user: { id: "user_one", name: "Personal User", account: null, email: null, avatar: null } };
  const client = connectedClient({
    listOrganizationMembers: async () => ({ members: [personalMember], total: 1, limit: 200, offset: 0 }),
  });
  setCloudSession(client);
  cloudSession.activeOrganization = { id: "personal_one", name: "Personal", slug: "personal_one", kind: "personal", role: "owner" };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(createQueryClient())); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "task-filter-condition-assignee" })).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.children === "Personal User").length).toBeGreaterThan(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task detail opens the description from its preview and saves and collapses on blur", async () => {
  const updates: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  let saved = task(1);
  const client = connectedClient({
    getProductTask: async () => result(saved),
    updateProductTask: async (_orgId, _taskId, patch) => {
      updates.push(patch);
      saved = task(2, patch.title, patch.description);
      return result(saved);
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const root = renderer!.root;
    const editorFrame = { "data-testid": "task-detail-description-editor" };
    expect(root.findAllByProps(editorFrame)).toHaveLength(0);
    const editor = await openDetailDescription(root);
    expect(root.findByProps(editorFrame)).toBeDefined();
    expect(editor.props.value).toBe("Server description");
    await act(async () => { editor.props.onChange("Updated description"); });
    expect(updates).toHaveLength(0);
    await act(async () => { leaveDescription(editor); });
    await settle();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ expectedVersion: 1, description: "Updated description" });
    expect(root.findAllByProps(editorFrame)).toHaveLength(0);
    expect((await openDetailDescription(root)).props.value).toBe("Updated description");
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("task detail keeps the description in preview without content edit permission", async () => {
  const detail = result(task(1));
  detail.permissions.canEditContent = false;
  const client = connectedClient({ getProductTask: async () => detail });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const root = renderer!.root;
    const preview = root.findByProps({ "data-testid": "task-detail-description-preview" });
    if (!preview.props.disabled) await act(async () => { preview.props.onClick?.(); });
    expect(root.findByProps({ "data-testid": "task-detail-description-preview" })).toBeDefined();
    expect(root.findAllByProps({ "data-testid": "task-detail-description-editor" })).toHaveLength(0);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("loads the latest task and retries a preserved conflict draft", async () => {
  let getCount = 0;
  const updates: Array<{ taskId: string; patch: Parameters<DenClient["updateProductTask"]>[2] }> = [];
  const client = connectedClient({
    getProductTask: async () => result(task(++getCount)),
    updateProductTask: async (_orgId, taskId, patch) => {
      updates.push({ taskId, patch });
      if (updates.length <= 2) throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: updates.length + 1 });
      return result(task(4, patch.title, patch.description));
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const titleInput = renderer!.root.findByProps({ value: "Server title" });
    const descriptionInput = await openDetailDescription(renderer!.root);
    await act(async () => {
      titleInput.props.onChange({ target: { value: "My draft title" } });
      descriptionInput.props.onChange("My draft description");
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { leaveDescription(descriptionInput); });
    await settle();
    expect(updates[0]?.patch).toMatchObject({ expectedVersion: 1, title: "My draft title", description: "My draft description" });

    await act(async () => { button("Load latest").props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ value: "My draft title" })).toBeDefined();
    expect((await openDetailDescription(renderer!.root)).props.value).toBe("My draft description");

    await act(async () => { button("Retry").props.onClick(); });
    await settle();
    expect(updates[1]?.patch).toMatchObject({ expectedVersion: 2, title: "My draft title", description: "My draft description" });
    expect(updates[1]?.patch.idempotencyKey).not.toBe(updates[0]?.patch.idempotencyKey);

    await act(async () => { button("Load latest").props.onClick(); });
    await settle();
    await act(async () => { button("Retry").props.onClick(); });
    await settle();
    expect(updates[2]?.patch).toMatchObject({ expectedVersion: 3, title: "My draft title", description: "My draft description" });
    expect(new Set(updates.map(({ patch }) => patch.idempotencyKey)).size).toBe(3);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("loading a conflict with revoked content permission keeps the draft but blocks another save", async () => {
  let getCount = 0;
  const updates: unknown[] = [];
  const latest = result(task(2, "Latest title"));
  latest.permissions.canEditContent = false;
  const client = connectedClient({
    getProductTask: async () => ++getCount === 1 ? result(task(1)) : latest,
    updateProductTask: async (_orgId, _taskId, patch) => {
      updates.push(patch);
      throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: 2 });
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const input = () => renderer!.root.findByProps({ value: "My draft title" });
    const submitDraft = () => input().props.onBlur();
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "My draft title" } }); });
    await act(async () => { submitDraft(); });
    await settle();
    await act(async () => { button("Load latest").props.onClick(); });
    await settle();
    expect(input().props.value).toBe("My draft title");
    expect(input().props.readOnly).toBe(true);
    expect(button("Retry").props.disabled).toBe(true);
    const retryAction = renderer!.root.findAllByType(Button).find((node) => node.props.children === "Retry")!;
    await act(async () => { retryAction.props.onClick(); submitDraft(); });
    await settle();
    expect(updates).toHaveLength(1);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("dismissing conflict feedback preserves the draft for another save", async () => {
  const updates: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  const client = connectedClient({
    updateProductTask: async (_orgId, _taskId, patch) => {
      updates.push(patch);
      if (updates.length === 1) throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: 2 });
      return result(task(2, patch.title, patch.description));
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const editor = await openDetailDescription(renderer!.root);
    await act(async () => {
      renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "Preserved title" } });
      editor.props.onChange("Preserved description");
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { leaveDescription(editor); });
    await settle();
    await act(async () => { button("Dismiss").props.onClick(); });
    expect(renderer!.root.findByProps({ value: "Preserved title" })).toBeDefined();
    const reopenedEditor = await openDetailDescription(renderer!.root);
    expect(reopenedEditor.props.value).toBe("Preserved description");
    await act(async () => { leaveDescription(reopenedEditor); });
    await settle();
    expect(updates[1]).toMatchObject({ title: "Preserved title", description: "Preserved description" });
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("switching tasks hides recovery while retaining the conflicted task draft", async () => {
  const first = task(1, "Task one", "One", "task_one");
  const second = task(5, "Task two", "Two", "task_two");
  const requested: string[] = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [first, second], membersByTaskId: { [first.id]: [], [second.id]: [] }, nextCursor: "" }),
    getProductTask: async (_orgId, taskId) => { requested.push(taskId); return result(taskId === "task_one" ? first : second); },
    updateProductTask: async () => { throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: 2 }); },
  });
  sessionValues.set(taskSectionStorageKey({ baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" }), "all");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ value: "Task one" }).props.onChange({ target: { value: "Task one draft" } }); });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Task one draft" }).props.onBlur(); });
    await settle();
    const taskButton = (title: string) => renderer!.root.findAllByType("button").find((node) => node.findAll((child) => child.props.children === title).length > 0)!;
    await act(async () => { taskButton("Task two").props.onClick(); });
    await settle();
    expect(renderer!.root.findAllByProps({ children: "Load latest" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ value: "Task two" })).toBeDefined();

    await act(async () => { taskButton("Task one").props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ value: "Task one draft" })).toBeDefined();
    expect(requested.filter((id) => id === "task_two")).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("pending full create cannot navigate or leak after organization switch", async () => {
  const pending = deferred<DenProductTaskResult>();
  const client = connectedClient({ createProductTask: async () => pending.promise });
  const queryClient = createQueryClient();
  setCloudSession(client, "org_one");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(queryClient)); });
  await settle();
  try {
    const allTasks = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" }).findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("All tasks"))!;
    await act(async () => { allTasks.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Old organization draft" } }); });
    await act(async () => { renderer!.root.findByProps({ role: "dialog" }).findByType("form").props.onSubmit({ preventDefault: () => undefined }); });

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient)); });
    await settle();
    await act(async () => { pending.resolve(result(task(1, "Created elsewhere", "", "created_old_org"))); });
    await settle();

    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Task details" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Created elsewhere")).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("late update conflict cannot restore draft or feedback after organization switch", async () => {
  const pending = deferred<DenProductTaskResult>();
  const client = connectedClient({ updateProductTask: async () => pending.promise });
  const queryClient = createQueryClient();
  setCloudSession(client, "org_one");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(queryClient, "task_one")); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "Old organization edit" } }); });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Old organization edit" }).props.onBlur(); });

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient, "task_one")); });
    await settle();
    await act(async () => { pending.reject(new DenApiError(409, "task_version_conflict", "Old organization conflict", { currentVersion: 2 })); });
    await settle();

    expect(renderer!.root.findAllByProps({ children: "Load latest" })).toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Old organization conflict")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ value: "Old organization edit" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ value: "Server title" })).toBeDefined();
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("an older save completion cannot clear a newer same-task conflict draft", async () => {
  const first = deferred<DenProductTaskResult>();
  const second = deferred<DenProductTaskResult>();
  const requests: Array<Parameters<DenClient["updateProductTask"]>[2]> = [];
  const client = connectedClient({
    updateProductTask: async (_orgId, _taskId, patch) => {
      const pending = requests.length === 0 ? first : second;
      requests.push(patch);
      return pending.promise;
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const title = () => renderer!.root.findAll((node) => node.props.value === "Server title" || node.props.value === "First draft" || node.props.value === "Newer draft").find((node) => typeof node.props.onBlur === "function")!;
    await act(async () => { title().props.onChange({ target: { value: "First draft" }, currentTarget: { value: "First draft" } }); });
    await act(async () => { title().props.onBlur(); });
    await act(async () => { title().props.onChange({ target: { value: "Newer draft" }, currentTarget: { value: "Newer draft" } }); });
    await act(async () => { title().props.onBlur(); });
    expect(requests).toHaveLength(2);
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Save")).toHaveLength(0);

    await act(async () => { second.reject(new DenApiError(409, "task_version_conflict", "Newer conflict", { currentVersion: 3 })); });
    await settle();
    expect(renderer!.root.findByProps({ value: "Newer draft" })).toBeDefined();
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Load latest")).toHaveLength(1);

    await act(async () => { first.resolve(result(task(2, "First draft", "Server description"))); });
    await settle();
    expect(renderer!.root.findByProps({ value: "Newer draft" })).toBeDefined();
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Load latest")).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("dismissed conflict suppresses a stale load-latest failure", async () => {
  const latest = deferred<DenProductTaskResult>();
  let getCount = 0;
  const client = connectedClient({
    getProductTask: async () => ++getCount === 1 ? result(task(1)) : latest.promise,
    updateProductTask: async () => { throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: 2 }); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "Preserved draft" } }); });
    await act(async () => { renderer!.root.findByProps({ value: "Preserved draft" }).props.onBlur(); });
    await settle();
    await act(async () => { button("Load latest").props.onClick(); });
    await act(async () => { button("Dismiss").props.onClick(); });
    await act(async () => { latest.reject(new Error("Stale load failure")); });
    await settle();

    expect(renderer!.root.findAll((node) => node.props.children === "Stale load failure")).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ children: "Load latest" })).toHaveLength(0);
    expect(renderer!.root.findByProps({ value: "Preserved draft" })).toBeDefined();
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("switching tasks suppresses a stale load-latest failure", async () => {
  const firstTask = task(1, "Task one", "One", "task_one");
  const secondTask = task(1, "Task two", "Two", "task_two");
  const latest = deferred<DenProductTaskResult>();
  let taskOneGets = 0;
  const client = connectedClient({
    listProductTasks: async () => ({ items: [firstTask, secondTask], membersByTaskId: { [firstTask.id]: [], [secondTask.id]: [] }, nextCursor: "" }),
    getProductTask: async (_orgId, taskId) => {
      if (taskId === "task_two") return result(secondTask);
      return ++taskOneGets === 1 ? result(firstTask) : latest.promise;
    },
    updateProductTask: async () => { throw new DenApiError(409, "task_version_conflict", "Changed elsewhere", { currentVersion: 2 }); },
  });
  sessionValues.set(taskSectionStorageKey({ baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" }), "all");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Task one" }).props.onChange({ target: { value: "Task one draft" } }); });
    await act(async () => { renderer!.root.findByProps({ value: "Task one draft" }).props.onBlur(); });
    await settle();
    await act(async () => { button("Load latest").props.onClick(); });

    const taskButton = (title: string) => renderer!.root.findAllByType("button").find((node) => node.findAll((child) => child.props.children === title).length > 0)!;
    await act(async () => { taskButton("Task two").props.onClick(); });
    await settle();
    await act(async () => { latest.reject(new Error("Stale switched load failure")); });
    await settle();

    expect(renderer!.root.findByProps({ value: "Task two" })).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.children === "Stale switched load failure")).toHaveLength(0);
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Load latest")).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("a pending comment from another task cannot clear the current task input", async () => {
  const firstTask = task(1, "Task one", "One", "task_one");
  const secondTask = task(1, "Task two", "Two", "task_two");
  const pendingComment = deferred<void>();
  const comments: Array<{ taskId: string; body: string }> = [];
  const client = connectedClient({
    listProductTasks: async () => ({ items: [firstTask, secondTask], membersByTaskId: { [firstTask.id]: [], [secondTask.id]: [] }, nextCursor: "" }),
    getProductTask: async (_orgId, taskId) => result(taskId === "task_one" ? firstTask : secondTask),
    addProductTaskComment: async (_orgId, taskId, input) => {
      comments.push({ taskId, body: input.body });
      if (taskId === "task_one") await pendingComment.promise;
    },
  });
  sessionValues.set(taskSectionStorageKey({ baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" }), "all");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const commentEditor = () => renderer!.root.findByType(TaskCommentEditor);
    await act(async () => { commentEditor().props.onChange("Task A comment"); });
    await act(async () => { commentEditor().props.onSend(); });
    expect(commentEditor().props.pending).toBe(true);

    const taskButton = (title: string) => renderer!.root.findAllByType("button").find((node) => node.findAll((child) => child.props.children === title).length > 0)!;
    await act(async () => { taskButton("Task two").props.onClick(); });
    await settle();
    expect(commentEditor().props.value).toBe("");
    expect(commentEditor().props.pending).toBe(false);
    await act(async () => { commentEditor().props.onChange("Task B input"); });

    await act(async () => { pendingComment.resolve(); });
    await settle();
    expect(commentEditor().props.value).toBe("Task B input");
    expect(comments).toEqual([{ taskId: "task_one", body: "Task A comment" }]);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("task detail follows, manages followers, and submits formatted comments", async () => {
  const self = { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } };
  const other = { id: "member_other", userId: "user_two", role: "member", user: { id: "user_two", name: "Other", account: null, email: null, avatar: null } };
  const updates: Array<Record<string, unknown>> = [];
  const comments: string[] = [];
  const base = task(1);
  let latest = result(base);
  const client = connectedClient({
    listOrganizationMembers: async () => ({ members: [self, other], total: 2, limit: 200, offset: 0 }),
    getProductTask: async () => latest,
    updateProductTask: async (_orgId, _taskId, patch) => {
      updates.push(patch);
      latest = { ...latest, task: { ...latest.task, version: latest.task.version + 1, visibility: patch.visibility ?? latest.task.visibility }, members: patch.members ?? latest.members };
      return latest;
    },
    addProductTaskComment: async (_orgId, _taskId, input) => { comments.push(input.body); },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-follow" }).props.onClick(); });
    await settle();
    expect(updates[0]).toMatchObject({ visibility: "members", members: [{ memberId: "member_self", role: "follower" }] });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-followers-option-member_other" }).props.onClick(); });
    await settle();
    expect(updates[1]).toMatchObject({ members: [{ memberId: "member_self", role: "follower" }, { memberId: "member_other", role: "follower" }] });
    const panel = renderer!.root.findByProps({ "data-testid": "task-detail-panel" });
    const fields = panel.find((node) => node.type === "section" && node.findAllByProps({ "data-testid": "task-detail-description-preview" }).length > 0);
    expect(panel.props.className).toContain("z-50");
    expect(panel.props.className).toContain("bg-background");
    expect(fields.findAllByProps({ role: "tooltip" }).map((node) => node.props.children)).toEqual(["Assignees", "Due time", "Task list", "Description"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-detail-backdrop" }).props.className).toContain("z-40");
    const commentEditor = panel.findByType(TaskCommentEditor);
    expect(commentEditor.props.members).toEqual([self, other]);
    await act(async () => { commentEditor.props.onChange("Review **these changes**"); });
    await act(async () => { commentEditor.props.onSend(); });
    await settle();
    expect(comments).toEqual(["Review **these changes**"]);
    expect(commentEditor.props.value).toBe("");
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-backdrop" }).props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-detail-panel" })).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("posted attachments are downloadable only under their own comment and inline images stay in the body", async () => {
  const entry = (id: string, body: string) => ({ id, body, authorMemberId: "member_self", createdAt: "2026-11-01", updatedAt: "2026-11-01" });
  const client = connectedClient({ getProductTaskActivity: async () => ({ events: [], comments: [
    entry("first", 'Review **this** ![diagram](https://files.test/img.png "task-file")\n[spec.pdf](https://files.test/spec.pdf "task-file")'),
    entry("second", '[only.pdf](https://files.test/only.pdf "task-file:7")'),
  ] }) });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const [first, second] = renderer!.root.findAllByProps({ "data-testid": "comment-attachments" });
    expect(first.findAllByType("button")).toHaveLength(1);
    expect(first.findByType("button").props["aria-label"]).toBe("Download file: spec.pdf");
    expect(first.findByProps({ children: "Size unavailable" })).toBeTruthy();
    const body = renderer!.root.find(node => node.type === "div" && node.props.className === "mt-1 text-sm text-dls-text" && node.findAllByType("strong").length === 1);
    expect(body.findByProps({ "data-testid": "comment-attachments" })).toBe(first);
    expect(body.findByType("img").props.src).toBe("https://files.test/img.png");
    expect(body.findByType("strong").children).toEqual(["this"]);
    expect(second.findByType("button").props["aria-label"]).toBe("Download file: only.pdf");
    expect(second.findByProps({ children: "7 B" })).toBeTruthy();
  } finally { await act(async () => renderer!.unmount()); }
});

test("a failed comment keeps its draft for retry and clears it after success", async () => {
  const attempts: string[] = [];
  const client = connectedClient({
    addProductTaskComment: async (_orgId, _taskId, input) => {
      attempts.push(input.body);
      if (attempts.length === 1) throw new Error("Comment not saved");
    },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const editor = renderer!.root.findByType(TaskCommentEditor);
    const draft = 'Please **review**\n[spec.pdf](https://files.test/spec.pdf "task-file:100")';
    await act(async () => { editor.props.onChange(draft); });
    await act(async () => { editor.props.onSend(); });
    await settle();
    expect(attempts).toEqual([draft]);
    expect(editor.props.value).toBe(draft);
    expect(editor.findByProps({ title: "spec.pdf" }).children).toEqual(["spec.pdf"]);
    expect(editor.props.pending).toBe(false);

    await act(async () => { editor.props.onSend(); });
    await settle();
    expect(attempts).toEqual([draft, draft]);
    expect(editor.props.value).toBe("");
    expect(editor.findAllByProps({ title: "spec.pdf" })).toHaveLength(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("same task ID remounts detail and mutations across organization changes", async () => {
  const pendingOrgAComment = deferred<void>();
  const updates: Array<{ organizationId: string; title: string | undefined; description: string | undefined }> = [];
  const comments: Array<{ organizationId: string; body: string }> = [];
  const client = connectedClient({
    getProductTask: async (organizationId) => result(organizationId === "org_one"
      ? task(1, "Org A title", "Org A description")
      : task(7, "Org B title", "Org B description")),
    updateProductTask: async (organizationId, _taskId, patch) => {
      updates.push({ organizationId, title: patch.title, description: patch.description });
      return result(task(8, patch.title, patch.description));
    },
    addProductTaskComment: async (organizationId, _taskId, input) => {
      comments.push({ organizationId, body: input.body });
      if (organizationId === "org_one") await pendingOrgAComment.promise;
    },
  });
  const queryClient = createQueryClient();
  setCloudSession(client, "org_one");
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(taskPage(queryClient, "task_one")); });
  await settle();
  try {
    const commentEditor = () => renderer!.root.findByType(TaskCommentEditor);
    const commentButton = () => commentEditor().findByProps({ "data-testid": "task-comment-editor" }).find((node) => node.type === "button" && node.props.type === "submit");
    const orgAEditor = await openDetailDescription(renderer!.root);
    await act(async () => {
      renderer!.root.findByProps({ value: "Org A title" }).props.onChange({ target: { value: "Org A local title" } });
      orgAEditor.props.onChange("Org A local description");
      commentEditor().props.onChange("Org A pending comment");
    });
    await act(async () => { commentEditor().props.onSend(); });
    expect(commentButton().props.disabled).toBe(true);

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient, "task_one")); });
    await settle();

    expect(renderer!.root.findByProps({ value: "Org B title" })).toBeDefined();
    const orgBEditor = await openDetailDescription(renderer!.root);
    expect(orgBEditor.props.value).toBe("Org B description");
    expect(renderer!.root.findAllByProps({ value: "Org A local title" })).toHaveLength(0);
    expect(commentEditor().props.value).toBe("");
    expect(commentButton().props.disabled).toBe(true);
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Save")).toHaveLength(0);

    await act(async () => {
      renderer!.root.findByProps({ value: "Org B title" }).props.onChange({ target: { value: "Org B edited title" } });
      orgBEditor.props.onChange("Org B edited description");
      commentEditor().props.onChange("Org B comment");
    });
    expect(commentButton().props.disabled).toBe(false);
    await act(async () => { orgBEditor.props.onBlur(); commentEditor().props.onSend(); });
    await settle();
    expect(updates).toEqual([{ organizationId: "org_two", title: "Org B edited title", description: "Org B edited description" }]);
    expect(comments).toEqual([
      { organizationId: "org_one", body: "Org A pending comment" },
      { organizationId: "org_two", body: "Org B comment" },
    ]);

    await act(async () => { pendingOrgAComment.resolve(); });
    await settle();
    expect(renderer!.root.findAllByProps({ value: "Org A pending comment" })).toHaveLength(0);
    expect(commentEditor().props.value).toBe("");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

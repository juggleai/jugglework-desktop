import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenClient, type DenProductTask, type DenProductTaskResult } from "../src/app/lib/den";
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
    getProductTask: async () => result(task(1)),
    getProductTaskActivity: async () => ({ comments: [], events: [] }),
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

test("runs Tasks top search and collapses the sidebar into a zero-width frame", async () => {
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
    await act(async () => { renderer!.root.findByProps({ "data-app-secondary-sidebar-search": true }).props.onClick(); });
    expect(searches).toBe(1);

    await act(async () => { renderer!.root.findByProps({ "data-app-secondary-sidebar-toggle": true }).props.onClick(); });
    expect(useUiStateStore.getState().sidebarOpen).toBe(false);
    expect(renderer!.root.findAllByProps({ "data-testid": "tasks-sidebar" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ "data-app-secondary-sidebar-resize-handle": true })).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-app-secondary-sidebar-frame": true }).props.className).toContain("w-0");
    expect(renderer!.root.findByProps({ "data-testid": "tasks-main" })).toBeDefined();

    await act(async () => { renderer!.root.findByProps({ "data-app-secondary-sidebar-toggle": true }).props.onClick(); });
    expect(useUiStateStore.getState().sidebarOpen).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "tasks-sidebar" })).toBeDefined();
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
    const activity = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" }).findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Activity"))!;
    await act(async () => { activity.props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Activity");
    expectCleanHeader();
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
    const listButton = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Sidebar list"))!;
    await act(async () => { listButton.props.onClick(); });
    await settle();
    expect(options.slice(before).some((input) => input.view === "all" && JSON.stringify(input.listId) === JSON.stringify(["list_sidebar"]))).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-workbench-toolbar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "tasks-page-title" }).props.children).toBe("Sidebar list");
    expect(renderer!.root.findByProps({ "data-testid": "task-group-row-custom-default" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-custom-group-create-trigger" })).toBeDefined();
    const updatedSidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const selectedListButton = updatedSidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Sidebar list"))!;
    const allTasksButton = updatedSidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("All tasks"))!;
    expect(selectedListButton.props["aria-current"]).toBe("page");
    expect(selectedListButton.props.className).toContain("bg-blue-3");
    expect(selectedListButton.props.className).toContain("text-blue-11");
    expect(allTasksButton.props["aria-current"]).toBeUndefined();
    expect(allTasksButton.props.className).not.toContain("bg-blue-3");
  } finally { await act(async () => renderer!.unmount()); }
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
    expect(renderer!.root.findByProps({ "data-testid": "task-create-description-toolbar" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-create-description-editor" }).props.className).toContain("h-[168px]");
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
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-menu" }).findAllByType("button")[1]!.props.onClick(); });
    expect(renderer!.root.findByProps({ role: "dialog" }).props["aria-label"]).toBe("New task list");
    expect(renderer!.root.findByProps({ placeholder: "Task list name" })).toBeDefined();
    expect(renderer!.root.findByProps({ placeholder: "Description" })).toBeDefined();
    expect(renderer!.root.findByProps({ placeholder: "Marker" }).props.value).toBe("#");
    expect(renderer!.root.findAll((node) => node.props.children === "Private visibility").length).toBeGreaterThan(0);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("new task list uses the private list mutation and exposes failures", async () => {
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
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await act(async () => {
      dialog.findByProps({ placeholder: "Task list name" }).props.onChange({ target: { value: "Launch list" } });
      dialog.findByProps({ placeholder: "Description" }).props.onChange({ target: { value: "Launch tasks" } });
      dialog.findByProps({ placeholder: "Marker" }).props.onChange({ target: { value: "L" } });
    });
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({ name: "Launch list", description: "Launch tasks", marker: "L", visibility: "private" });
    expect(toastErrors).toContain("List create failed");
    expect(renderer!.root.findAll((node) => node.props.children === "List create failed")).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "dialog" })).toBeDefined();
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
    const dialog = renderer!.root.findByProps({ role: "dialog" });
    await act(async () => { dialog.findByProps({ placeholder: "Task list name" }).props.onChange({ target: { value: "Old list" } }); });
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient)); });
    await settle();
    await act(async () => { pending.reject(new Error("Old list failure")); });
    await settle();
    expect(renderer!.root.findAllByProps({ role: "dialog" })).toHaveLength(0);
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

test("full task creation submits assignees, followers, due time, list, and description", async () => {
  const creates: Array<Record<string, unknown>> = [];
  const members = [
    { id: "member_self", userId: "user_one", role: "member", user: { id: "user_one", name: "Self", account: null, email: null, avatar: null } },
    { id: "member_other", userId: "user_two", role: "member", user: { id: "user_two", name: "Other", account: null, email: null, avatar: null } },
  ];
  const list = { id: "list_one", creatorMemberId: "member_self", name: "Launch", description: "", marker: "L", visibility: "private" as const, version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
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
    expect(renderer!.root.findByProps({ "data-testid": "task-create-description-toolbar" }).findAllByType("button")).toHaveLength(11);
    await act(async () => { renderer!.root.findByProps({ placeholder: "Add a description" }).props.onChange({ target: { value: "Everything" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-description-format-bold" }).props.onClick(); });
    await act(async () => { renderer!.root.findAll((node) => node.props.children === "Today")[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-option-create-dialog-draft-list_one" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-assignees-option-member_self" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-assignees-option-member_other" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-followers-option-member_self" }).props.onClick(); });
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({
      title: "Full task",
      description: "Everything**text**",
      priority: "none",
      visibility: "members",
      listId: "list_one",
      members: [{ memberId: "member_self", role: "assignee" }, { memberId: "member_other", role: "assignee" }, { memberId: "member_self", role: "follower" }],
    });
    expect(typeof creates[0]?.dueAt).toBe("string");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("full task creation can create and assign a custom group", async () => {
  const created = task(1, "Grouped task", "", "grouped_task");
  const client = connectedClient({ createProductTask: async () => result(created) });
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
    await act(async () => { renderer!.root.findByProps({ placeholder: "Search or create a group" }).props.onChange({ target: { value: "Planning" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-create-group-create" }).props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ role: "dialog" }).findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    const settings = JSON.parse(localValues.get(taskWorkbenchStorageKey({ baseUrl: "https://work.example", userId: "user_one", organizationId: "org_one" }, "assigned")) ?? "{}") as { customGroups?: Array<{ id: string; name: string }>; customGroupAssignments?: Record<string, string> };
    expect(settings.customGroups?.[0]?.name).toBe("Planning");
    expect(settings.customGroupAssignments?.grouped_task).toBe(settings.customGroups?.[0]?.id);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
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

test("workbench creates a missing list then moves the task using the latest version", async () => {
  const listed = task(1, "List task", "", "list_task");
  const authoritative = result({ ...listed, version: 11, listId: null });
  const order: string[] = [];
  const moves: Array<Parameters<DenClient["moveProductTask"]>[2]> = [];
  const createdList: DenProductTaskList = { id: "list_created", creatorMemberId: "member_self", name: "Testing list", description: "", marker: "T", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" };
  const client = connectedClient({
    listProductTasks: async () => ({ items: [listed], membersByTaskId: { [listed.id]: [] }, nextCursor: "" }),
    getProductTask: async () => { order.push("get"); return authoritative; },
    createProductTaskList: async () => { order.push("create"); return { list: createdList, members: [], permissions: { canView: true, canEdit: true, canManageMembers: true, canAddTasks: true, canArchive: true, canRestore: false }, replayed: false }; },
    moveProductTask: async (_orgId, _taskId, input) => { order.push("move"); moves.push(input); return { taskId: listed.id, version: 12, listId: createdList.id, visibility: "private", replayed: false }; },
  });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    await act(async () => { sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!.props.onClick(); });
    await settle();
    const search = renderer!.root.findByProps({ "data-testid": "task-list-search-list_task" });
    await act(async () => { search.props.onChange({ currentTarget: { value: "Testing list" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-create-list_task" }).props.onClick(); });
    await settle();
    expect(order).toEqual(["create", "get", "move"]);
    expect(moves[0]).toMatchObject({ expectedVersion: 11, destinationListId: "list_created", idempotencyKey: expect.any(String) });
  } finally { await act(async () => renderer!.unmount()); }
});

test("workbench assignee update shares a private task in the same latest-version patch", async () => {
  const listed = task(1, "Private task", "", "private_task");
  const authoritative = result({ ...listed, version: 9 });
  authoritative.members = [{ memberId: "member_one", role: "assignee" }, { memberId: "member_follower", role: "follower" }];
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
  await act(async () => { renderer = TestRenderer.create(connectedPage(client)); });
  await settle();
  try {
    const sidebar = renderer!.root.findByProps({ "data-testid": "tasks-sidebar" });
    const assigned = sidebar.findAllByType("button").find((button) => Array.isArray(button.props.children) && button.props.children.includes("Assigned to me"))!;
    await act(async () => { assigned.props.onClick(); });
    await settle();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-assignee-option-private_task-member_two" }).props.onClick(); });
    await settle();
    expect(updates[0]).toMatchObject({
      expectedVersion: 9,
      visibility: "members",
      members: [{ memberId: "member_follower", role: "follower" }, { memberId: "member_one", role: "assignee" }, { memberId: "member_two", role: "assignee" }],
    });
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
    const descriptionInput = renderer!.root.findByProps({ value: "Server description" });
    await act(async () => {
      titleInput.props.onChange({ target: { value: "My draft title" } });
      descriptionInput.props.onChange("My draft description");
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
    await settle();
    expect(updates[0]?.patch).toMatchObject({ expectedVersion: 1, title: "My draft title", description: "My draft description" });

    await act(async () => { button("Load latest").props.onClick(); });
    await settle();
    expect(renderer!.root.findByProps({ value: "My draft title" })).toBeDefined();
    expect(renderer!.root.findByProps({ value: "My draft description" })).toBeDefined();

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
    await act(async () => {
      renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "Preserved title" } });
      renderer!.root.findByProps({ value: "Server description" }).props.onChange("Preserved description");
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
    await settle();
    await act(async () => { button("Dismiss").props.onClick(); });
    expect(renderer!.root.findByProps({ value: "Preserved title" })).toBeDefined();
    expect(renderer!.root.findByProps({ value: "Preserved description" })).toBeDefined();
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
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
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    await act(async () => { renderer!.root.findByProps({ value: "Task one" }).props.onChange({ target: { value: "Task one draft" } }); });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
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
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });

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
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
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
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Task one" }).props.onChange({ target: { value: "Task one draft" } }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); });
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
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(connectedPage(client, "task_one")); });
  await settle();
  try {
    const commentInput = () => renderer!.root.findByProps({ placeholder: "Add a comment…" });
    const commentForm = () => commentInput().parent!;
    await act(async () => { commentInput().props.onChange({ target: { value: "Task A comment" } }); });
    await act(async () => { commentForm().props.onSubmit({ preventDefault: () => undefined }); });

    const taskButton = (title: string) => renderer!.root.findAllByType("button").find((node) => node.findAll((child) => child.props.children === title).length > 0)!;
    await act(async () => { taskButton("Task two").props.onClick(); });
    await settle();
    await act(async () => { commentInput().props.onChange({ target: { value: "Task B input" } }); });

    await act(async () => { pendingComment.resolve(); });
    await settle();
    expect(commentInput().props.value).toBe("Task B input");
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
    const commentForm = renderer!.root.findByProps({ "data-testid": "task-comment-editor" });
    expect(renderer!.root.findByProps({ "data-testid": "task-detail-panel" }).props.className).toContain("z-50");
    expect(renderer!.root.findByProps({ "data-testid": "task-detail-panel" }).props.className).toContain("bg-background");
    expect(renderer!.root.findByProps({ "data-testid": "task-detail-panel" }).findAllByProps({ role: "tooltip" }).map((node) => node.props.children)).toEqual(["Assignees", "Due time", "Task list", "Description"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-detail-backdrop" }).props.className).toContain("z-40");
    await act(async () => { commentForm.findByProps({ placeholder: "Add a comment…" }).props.onChange({ target: { value: "Review " } }); });
    await act(async () => { commentForm.findByProps({ "aria-label": "Bold" }).props.onClick(); });
    await act(async () => { commentForm.findByProps({ placeholder: "Add a comment…" }).props.onKeyDown({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: false }, preventDefault: () => undefined }); });
    await settle();
    expect(comments).toEqual(["Review ****"]);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-backdrop" }).props.onClick(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-detail-panel" })).toHaveLength(0);
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
    const commentInput = () => renderer!.root.findByProps({ placeholder: "Add a comment…" });
    const commentForm = () => renderer!.root.findByProps({ "data-testid": "task-comment-editor" });
    const commentButton = () => commentForm().findAllByType("button").find((node) => node.props.type === "submit")!;
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => {
      renderer!.root.findByProps({ value: "Org A title" }).props.onChange({ target: { value: "Org A local title" } });
      renderer!.root.findByProps({ value: "Org A description" }).props.onChange("Org A local description");
      commentInput().props.onChange({ target: { value: "Org A pending comment" } });
    });
    await act(async () => { commentForm().props.onSubmit({ preventDefault: () => undefined }); });
    expect(commentButton().props.disabled).toBe(true);

    setCloudSession(client, "org_two");
    await act(async () => { renderer!.update(taskPage(queryClient, "task_one")); });
    await settle();

    expect(renderer!.root.findByProps({ value: "Org B title" })).toBeDefined();
    expect(renderer!.root.findByProps({ value: "Org B description" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ value: "Org A local title" })).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ value: "Org A local description" })).toHaveLength(0);
    expect(commentInput().props.value).toBe("");
    expect(commentButton().props.disabled).toBe(true);
    expect(renderer!.root.findAllByType("button").filter((node) => node.props.children === "Save")).toHaveLength(0);

    await act(async () => {
      renderer!.root.findByProps({ value: "Org B title" }).props.onChange({ target: { value: "Org B edited title" } });
      renderer!.root.findByProps({ value: "Org B description" }).props.onChange("Org B edited description");
      commentInput().props.onChange({ target: { value: "Org B comment" } });
    });
    expect(commentButton().props.disabled).toBe(false);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-detail-description-editor" }).props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null }); commentForm().props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(updates).toEqual([{ organizationId: "org_two", title: "Org B edited title", description: "Org B edited description" }]);
    expect(comments).toEqual([
      { organizationId: "org_one", body: "Org A pending comment" },
      { organizationId: "org_two", body: "Org B comment" },
    ]);

    await act(async () => { pendingOrgAComment.resolve(); });
    await settle();
    expect(renderer!.root.findAllByProps({ value: "Org A pending comment" })).toHaveLength(0);
    expect(commentInput().props.value).toBe("");
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

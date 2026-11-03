import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";

import { DenApiError, type DenClient, type DenProductTask, type DenProductTaskResult } from "../src/app/lib/den";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => { consoleError.mockRestore(); });

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
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const task = (version: number, title = "Server title", description = "Server description", id = "task_one"): DenProductTask => ({
  id,
  creatorMemberId: "member_one",
  listId: null,
  title,
  description,
  priority: "none",
  visibility: "private",
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
    user: { id: "user_one" },
    activeOrganization: { id: organizationId },
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

test("selecting Assigned by me queries the delegated view", async () => {
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
    expect(options.some((input) => input.view === "delegated")).toBe(true);
    expect(renderer!.root.findAll((node) => node.props.children === "Assigned by me")).not.toHaveLength(0);
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
    expect(fullCreateDialog.props.className).toContain("max-w-[900px]");
    expect(renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" })).toBeDefined();
    expect(renderer!.root.findByProps({ placeholder: "Add a description" })).toBeDefined();
    expect(renderer!.root.findAll((node) => node.props.children === "Today")).not.toHaveLength(0);
    expect(renderer!.root.findAll((node) => node.props.children === "Tomorrow")).not.toHaveLength(0);
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
    expect(renderer!.root.findAll((node) => node.props.children === "List create failed")).toHaveLength(1);
    expect(renderer!.root.findByProps({ role: "dialog" })).toBeDefined();
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
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
    await act(async () => { renderer!.root.findAllByType("button").find((node) => node.props.children?.some?.((child: unknown) => child === "Create task"))!.props.onClick(); });
    const input = renderer!.root.findByProps({ placeholder: "Enter a title and press Enter" });
    await act(async () => { input.props.onChange({ target: { value: "New task" } }); });
    const form = renderer!.root.findByProps({ role: "dialog" }).findByType("form");
    await act(async () => { form.props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(renderer!.root.findAll((node) => node.props.children === "Create failed")).toHaveLength(1);
  } finally {
    await act(async () => { renderer!.unmount(); });
  }
});

test("full task creation defaults the current assignee and submits every field", async () => {
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
    expect(dialog.findAll((node) => node.type === "button" && node.props.checked === true).length).toBeGreaterThan(0);
    await act(async () => {
      dialog.findByProps({ placeholder: "Enter a title and press Enter" }).props.onChange({ target: { value: "Full task" } });
      dialog.findByProps({ placeholder: "Add a description" }).props.onChange({ target: { value: "Everything" } });
      dialog.findByProps({ "aria-label": "Start time" }).props.onChange({ target: { value: "2026-11-04T09:30" } });
      dialog.findByProps({ "aria-label": "Due time" }).props.onChange({ target: { value: "2026-11-05T17:00" } });
      dialog.findByProps({ "aria-label": "Priority" }).props.onChange({ target: { value: "high" } });
      dialog.findByProps({ "aria-label": "Task list" }).props.onChange({ target: { value: "list_one" } });
      dialog.findAll((node) => node.type === "button" && node.props.checked === false)[0]!.props.onCheckedChange(true);
    });
    expect(dialog.findByProps({ "aria-label": "Visibility" }).props.value).toBe("members");
    await act(async () => { dialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]).toMatchObject({
      title: "Full task",
      description: "Everything",
      priority: "high",
      visibility: "members",
      listId: "list_one",
      members: [{ memberId: "member_self", role: "assignee" }, { memberId: "member_other", role: "assignee" }],
    });
    expect(typeof creates[0]?.startAt).toBe("string");
    expect(typeof creates[0]?.dueAt).toBe("string");
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
    expect(renderer!.root.findAll((node) => node.props.children === "You do not have permission to perform this task action.")).toHaveLength(1);
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
    expect(renderer!.root.findAll((node) => node.props.children === "Detail unavailable")).toHaveLength(1);
  } finally { await act(async () => { renderer!.unmount(); }); }
});

test("late current-member resolution applies the Assigned default once without overwriting user choices", async () => {
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
    expect(dialog.findAllByType("button").find((button) => button.props.type === "submit")!.props.disabled).toBe(true);
    await act(async () => { memberPage.resolve({ members: [self, other], total: 2, limit: 200, offset: 0 }); });
    await settle();
    const resolvedDialog = renderer!.root.findByProps({ role: "dialog" });
    expect(resolvedDialog.findAll((node) => node.type === "button" && node.props.checked === true)).toHaveLength(1);
    const otherCheckbox = resolvedDialog.findAll((node) => node.type === "button" && node.props.checked === false)[0]!;
    await act(async () => { otherCheckbox.props.onCheckedChange(true); });
    expect(resolvedDialog.findAll((node) => node.type === "button" && node.props.checked === true)).toHaveLength(2);
    await act(async () => { resolvedDialog.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    await settle();
    expect(creates[0]?.members).toEqual([{ memberId: "member_self", role: "assignee" }, { memberId: "member_other", role: "assignee" }]);
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
      descriptionInput.props.onChange({ target: { value: "My draft description" } });
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { button("Save").props.onClick(); });
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
      renderer!.root.findByProps({ value: "Server description" }).props.onChange({ target: { value: "Preserved description" } });
    });
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { button("Save").props.onClick(); });
    await settle();
    await act(async () => { button("Dismiss").props.onClick(); });
    expect(renderer!.root.findByProps({ value: "Preserved title" })).toBeDefined();
    expect(renderer!.root.findByProps({ value: "Preserved description" })).toBeDefined();
    await act(async () => { button("Save").props.onClick(); });
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
    await act(async () => { button("Save").props.onClick(); });
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
    await act(async () => { renderer!.root.findAllByType("button").find((node) => node.props.children?.some?.((child: unknown) => child === "Create task"))!.props.onClick(); });
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
    await act(async () => { button("Save").props.onClick(); });

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
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => { renderer!.root.findByProps({ value: "Server title" }).props.onChange({ target: { value: "First draft" } }); });
    const firstSave = button("Save").props.onClick;
    await act(async () => { renderer!.root.findByProps({ value: "First draft" }).props.onChange({ target: { value: "Newer draft" } }); });
    const secondSave = button("Save").props.onClick;

    await act(async () => { firstSave(); secondSave(); });
    expect(requests).toHaveLength(2);
    expect(button("Save").props.disabled).toBe(true);

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
    await act(async () => { button("Save").props.onClick(); });
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
    await act(async () => { button("Save").props.onClick(); });
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
    const commentForm = () => commentInput().parent!;
    const commentButton = () => commentForm().findByType("button");
    const button = (label: string) => renderer!.root.findAllByType("button").find((node) => node.props.children === label)!;
    await act(async () => {
      renderer!.root.findByProps({ value: "Org A title" }).props.onChange({ target: { value: "Org A local title" } });
      renderer!.root.findByProps({ value: "Org A description" }).props.onChange({ target: { value: "Org A local description" } });
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
    expect(button("Save").props.disabled).toBe(false);

    await act(async () => {
      renderer!.root.findByProps({ value: "Org B title" }).props.onChange({ target: { value: "Org B edited title" } });
      renderer!.root.findByProps({ value: "Org B description" }).props.onChange({ target: { value: "Org B edited description" } });
      commentInput().props.onChange({ target: { value: "Org B comment" } });
    });
    expect(commentButton().props.disabled).toBe(false);
    await act(async () => { button("Save").props.onClick(); commentForm().props.onSubmit({ preventDefault: () => undefined }); });
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

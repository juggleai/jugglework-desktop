import { afterAll, expect, mock, spyOn, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { DenOrganizationMember, DenProductTask, DenProductTaskList } from "../src/app/lib/den";

const Container = ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div>;
mock.module("../src/components/ui/dropdown-menu", () => ({
  DropdownMenu: Container,
  DropdownMenuContent: Container,
  DropdownMenuGroup: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div data-testid="dropdown-menu-group" {...props}>{children}</div>,
  DropdownMenuLabel: Container,
  DropdownMenuRadioGroup: Container,
  DropdownMenuSeparator: Container,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
  DropdownMenuCheckboxItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
  DropdownMenuRadioItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <button {...props}>{children}</button>,
}));
import { defaultTaskWorkbenchSettings } from "../src/react-app/domains/tasks/task-view-state";
import { TaskWorkbench, sortLoadedProductTasks, taskWorkbenchServerSort } from "../src/react-app/domains/tasks/task-workbench";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => consoleError.mockRestore());

const tasks: DenProductTask[] = [
  { id: "task_todo_with_full_identifier", creatorMemberId: "member_creator", listId: "list_one", title: "Prepare launch", description: "", priority: "high", visibility: "private", status: "todo", version: 2, startAt: "2026-11-03T10:00:00Z", dueAt: "2026-11-04T10:00:00Z", completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" },
  { id: "task_done", creatorMemberId: "member_creator", listId: null, title: "Review brief", description: "", priority: "none", visibility: "private", status: "completed", version: 3, startAt: "2026-11-02T10:00:00Z", dueAt: null, completedAt: "2026-11-03T10:00:00Z", completedByMemberId: "member_creator", canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-03T10:00:00Z" },
  { id: "task_canceled", creatorMemberId: "member_creator", listId: null, title: "Old draft", description: "", priority: "low", visibility: "private", status: "canceled", version: 4, startAt: null, dueAt: null, completedAt: null, completedByMemberId: null, canceledAt: "2026-11-03T11:00:00Z", canceledByMemberId: "member_creator", deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T08:00:00Z", updatedAt: "2026-11-03T11:00:00Z" },
];
const members: DenOrganizationMember[] = [
  { id: "member_creator", userId: "user_creator", role: "member", user: { id: "user_creator", name: "Casey Creator", account: "casey", email: null, avatar: null } },
  { id: "member_assignee", userId: "user_assignee", role: "member", user: { id: "user_assignee", name: "Alex Assignee", account: "alex", email: null, avatar: null } },
];
const lists: DenProductTaskList[] = [{ id: "list_one", creatorMemberId: "member_creator", name: "Launch", description: "", marker: "#", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }];
const membersByTaskId = { task_todo_with_full_identifier: [{ memberId: "member_assignee", role: "assignee" as const }], task_done: [], task_canceled: [] };

function workbench(settings = defaultTaskWorkbenchSettings, onSettingsChange = () => undefined, onTransition = () => undefined) {
  return <TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={settings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={onSettingsChange} onSelect={() => undefined} onTransition={onTransition} />;
}

test("assigned workbench renders exactly List and Board tabs plus requested joined fields", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    const tabs = renderer!.root.findAllByProps({ role: "tab" });
    expect(tabs).toHaveLength(2);
    expect(tabs.map((node) => React.Children.toArray(node.props.children).filter((child) => typeof child === "string").join(""))).toEqual(["List", "Board"]);
    expect(tabs.every((node) => node.findAll((child) => child.type === "svg").length > 0)).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" }).parent?.props.value).toBe("list");
    for (const label of ["Task title", "Assignee", "Start time", "Due time", "Creator", "Created time", "Task ID", "Task list", "Alex Assignee", "Casey Creator", "Launch"]) {
      expect(renderer!.root.findAll((node) => node.props.children === label).length).toBeGreaterThan(0);
    }
  } finally { await act(async () => renderer!.unmount()); }
});

test("both list and board render the same active underline contract", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    let indicator = renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" });
    expect(indicator.parent?.props.value).toBe("list");
    expect(indicator.props.className).toContain("-bottom-px");
    await act(async () => { renderer!.update(workbench({ ...defaultTaskWorkbenchSettings, view: "board" })); });
    indicator = renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" });
    expect(indicator.parent?.props.value).toBe("board");
    expect(indicator.props.className).toContain("-bottom-px");
    expect(renderer!.root.findByProps({ "data-testid": "task-view-tab-list" }).props.className).toContain("text-xs");
    expect(renderer!.root.findByProps({ "data-testid": "task-view-tab-board" }).props.className).toContain("text-xs");
  } finally { await act(async () => renderer!.unmount()); }
});

test("field control emits settings without the unchecked optional field", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    const fields = renderer!.root.findByProps({ "data-testid": "task-fields-menu" });
    const assignee = fields.find((node) => node.type === "button" && node.props.children === "Assignee" && typeof node.props.onCheckedChange === "function");
    await act(async () => { assignee.props.onCheckedChange(false); });
    expect(changes.at(-1)?.fields).not.toContain("assignee");
    expect(changes.at(-1)?.fields).toContain("due");
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter controls emit priority, task-list, and overdue settings with an active count", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    const filter = renderer!.root.findByProps({ "data-testid": "task-filter-menu" });
    const highPriority = filter.find((node) => node.type === "button" && node.props.children === "High priority" && typeof node.props.onCheckedChange === "function");
    await act(async () => { highPriority.props.onCheckedChange(true); });
    expect(changes.at(-1)?.priorities).toEqual(["high"]);
    await act(async () => { renderer!.update(workbench({ ...defaultTaskWorkbenchSettings, priorities: ["high"] }, (next) => changes.push(next))); });
    const updatedFilter = renderer!.root.findByProps({ "data-testid": "task-filter-menu" });
    const list = updatedFilter.find((node) => node.type === "button" && Array.isArray(node.props.children) && node.props.children.join("") === "# Launch" && typeof node.props.onCheckedChange === "function");
    await act(async () => { list.props.onCheckedChange(true); });
    expect(changes.at(-1)?.listIds).toEqual(["list_one"]);
    const overdue = updatedFilter.find((node) => node.type === "button" && node.props.children === "Overdue only" && typeof node.props.onCheckedChange === "function");
    await act(async () => { overdue.props.onCheckedChange(true); });
    expect(changes.at(-1)?.overdue).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter menu labels are mounted inside Base UI menu groups", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    const filter = renderer!.root.findByProps({ "data-testid": "task-filter-menu" });
    const groups = filter.findAllByProps({ "data-testid": "dropdown-menu-group" });
    expect(groups).toHaveLength(2);
    expect(groups[0]!.find((node) => node.props.children === "Priority")).toBeDefined();
    expect(groups[1]!.find((node) => node.props.children === "Task lists")).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("board renders status columns and accessible lifecycle actions", async () => {
  const actions: Array<[string, string]> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, view: "board", status: "all" }, () => undefined, (task, operation) => actions.push([task.id, operation]))); });
  try {
    for (const label of ["To do", "Completed", "Canceled"]) expect(renderer!.root.findByProps({ "aria-label": label })).toBeDefined();
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Complete task" })[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Cancel task" })[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Reopen task" })[0]!.props.onClick(); });
    expect(actions).toEqual([["task_todo_with_full_identifier", "complete"], ["task_todo_with_full_identifier", "cancel"], ["task_done", "reopen"]]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("List view groups rows by task list", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "list", status: "all" })); });
  try {
    expect(renderer!.root.findAll((node) => node.type === "th" && typeof node.props.children !== "string" && String(node.props.children?.[0]) === "Launch")).toHaveLength(1);
    expect(renderer!.root.findAll((node) => node.type === "th" && typeof node.props.children !== "string" && String(node.props.children?.[0]) === "No task list")).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("Start sort is loaded-client-only and orders null values last", () => {
  const settings = { ...defaultTaskWorkbenchSettings, sort: "start_at" as const, direction: "asc" as const };
  expect(taskWorkbenchServerSort(settings)).toEqual({ sort: "updated_at", direction: "desc" });
  expect(sortLoadedProductTasks(tasks, settings).map((task) => task.id)).toEqual(["task_done", "task_todo_with_full_identifier", "task_canceled"]);
});

test("List view exposes the full selectable task ID and copies the exact value", async () => {
  const writes: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    expect(renderer!.root.findByProps({ title: "task_todo_with_full_identifier" }).props.children).toBe("task_todo_with_full_identifier");
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Copy task ID" })[0]!.props.onClick(); });
    expect(writes).toEqual(["task_todo_with_full_identifier"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("completed status clears overdue and leaves the overdue control disabled", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, overdue: true }, (next) => changes.push(next))); });
  try {
    const completed = renderer!.root.find((node) => node.type === "button" && node.props.value === "completed");
    await act(async () => { completed.props.onClick?.(); completed.props.onValueChange?.("completed"); });
    if (!changes.length) {
      const group = renderer!.root.find((node) => node.props.value === "incomplete" && typeof node.props.onValueChange === "function");
      await act(async () => { group.props.onValueChange("completed"); });
    }
    expect(changes.at(-1)).toMatchObject({ status: "completed", overdue: false });
    await act(async () => { renderer!.update(workbench({ ...defaultTaskWorkbenchSettings, status: "completed", overdue: false })); });
    const overdue = renderer!.root.find((node) => node.type === "button" && node.props.children === "Overdue only");
    expect(overdue.props.disabled).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("list join failures keep tasks rendered and expose retry", async () => {
  let retries = 0;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={[]} listJoinError="failed" settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onRetryListJoin={() => { retries += 1; }} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} />); });
  try {
    expect(renderer!.root.findAll((node) => node.props.children === "Prepare launch").length).toBeGreaterThan(0);
    expect(renderer!.root.findByProps({ role: "alert" })).toBeDefined();
    await act(async () => { renderer!.root.findAllByType("button").find((node) => node.props.children === "Retry")!.props.onClick(); });
    expect(retries).toBe(1);
  } finally { await act(async () => renderer!.unmount()); }
});

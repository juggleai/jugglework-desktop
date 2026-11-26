import { afterAll, expect, mock, spyOn, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { DenOrganizationMember, DenProductTask, DenProductTaskCompletionPolicy, DenProductTaskList, DenProductTaskPage } from "../src/app/lib/den";
import { DenApiError } from "../src/app/lib/den";

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
mock.module("../src/components/ui/popover", () => ({
  Popover: Container,
  PopoverContent: Container,
  PopoverTrigger: ({ children, render }: React.PropsWithChildren<{ render?: React.ReactElement }>) => render ? React.cloneElement(render, {}, children) : <>{children}</>,
}));
mock.module("../src/components/ui/tooltip", () => ({
  Tooltip: Container,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div role="tooltip">{children}</div>,
  TooltipTrigger: ({ children, render, ...props }: React.PropsWithChildren<{ render: React.ReactElement }>) => React.cloneElement(render, props, children),
}));
import { defaultTaskWorkbenchSettings, readTaskWorkbenchSettings, taskWorkbenchStorageKey } from "../src/react-app/domains/tasks/task-view-state";
import { TaskWorkbench, sortLoadedProductTasks, taskWorkbenchServerSort } from "../src/react-app/domains/tasks/task-workbench";
import { defaultCustomTaskGroupKey, taskGroupCreateDefaults, taskTimeGroup } from "../src/react-app/domains/tasks/task-list-table";
import { TaskDateTimeCell, type TaskReminderDraft } from "../src/react-app/domains/tasks/task-date-time-cell";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const originalConsoleError = console.error;
const consoleError = spyOn(console, "error").mockImplementation((message?: unknown, ...args: unknown[]) => {
  if (message === "react-test-renderer is deprecated. See https://react.dev/warnings/react-test-renderer") return;
  originalConsoleError(message, ...args);
});
afterAll(() => consoleError.mockRestore());

const tasks: DenProductTask[] = [
  { id: "task_todo_with_full_identifier", displayNumber: 100134, creatorMemberId: "member_creator", listId: "list_one", title: "Prepare launch", description: "", priority: "high", visibility: "private", completionPolicy: "any_assignee", status: "todo", version: 2, startAt: "2026-11-03T10:00:00Z", dueAt: "2026-11-04T10:00:00Z", completedAt: null, completedByMemberId: null, canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-02T10:00:00Z" },
  { id: "task_done", displayNumber: 100133, creatorMemberId: "member_creator", listId: null, title: "Review brief", description: "", priority: "none", visibility: "private", completionPolicy: "any_assignee", status: "completed", version: 3, startAt: "2026-11-02T10:00:00Z", dueAt: null, completedAt: "2026-11-03T10:00:00Z", completedByMemberId: "member_creator", canceledAt: null, canceledByMemberId: null, deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T09:00:00Z", updatedAt: "2026-11-03T10:00:00Z" },
  { id: "task_canceled", displayNumber: null, creatorMemberId: "member_creator", listId: null, title: "Old draft", description: "", priority: "low", visibility: "private", completionPolicy: "any_assignee", status: "canceled", version: 4, startAt: null, dueAt: null, completedAt: null, completedByMemberId: null, canceledAt: "2026-11-03T11:00:00Z", canceledByMemberId: "member_creator", deletedAt: null, restoreUntil: null, createdAt: "2026-11-01T08:00:00Z", updatedAt: "2026-11-03T11:00:00Z" },
];
const members: DenOrganizationMember[] = [
  { id: "member_creator", userId: "user_creator", role: "member", user: { id: "user_creator", name: "Casey Creator", account: "casey", email: null, avatar: null } },
  { id: "member_assignee", userId: "user_assignee", role: "member", user: { id: "user_assignee", name: "Alex Assignee", account: "alex", email: null, avatar: null } },
];
const lists: DenProductTaskList[] = [{ id: "list_one", creatorMemberId: "member_creator", name: "Launch", description: "", marker: "#", visibility: "private", version: 1, archivedAt: null, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z" }];
const membersByTaskId = { task_todo_with_full_identifier: [{ memberId: "member_assignee", role: "assignee" as const, createdByMemberId: "member_creator" }, { memberId: "member_creator", role: "follower" as const }], task_done: [], task_canceled: [] };

function workbench(settings = defaultTaskWorkbenchSettings, onSettingsChange = () => undefined, onTransition = () => undefined, onQuickCreate = async () => true, onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>, onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>, onListChange?: (task: DenProductTask, listId: string) => Promise<boolean>, onListCreate?: (task: DenProductTask, name: string) => Promise<string | null>) {
  return <TaskWorkbench isTaskList={settings.group === "custom"} tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={settings} selectedTaskId={null} canLoadMore={false} loadingMore={false} quickCreateMemberId="member_assignee" onLoadMore={() => undefined} onSettingsChange={onSettingsChange} onSelect={() => undefined} onTransition={onTransition} onQuickCreate={onQuickCreate} onAssigneesChange={onAssigneesChange} onCompletionPolicyChange={onCompletionPolicyChange} onListChange={onListChange} onListCreate={onListCreate} />;
}

function refreshingWorkbench() {
  return <TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} refreshing onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />;
}

test("assigned workbench renders exactly List and Board tabs plus requested joined fields", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    const tabs = renderer!.root.findAllByProps({ role: "tab" });
    expect(tabs).toHaveLength(2);
    expect(tabs.map((node) => React.Children.toArray(node.props.children).filter((child) => typeof child === "string").join(""))).toEqual(["List", "Board"]);
    expect(tabs.every((node) => node.findAll((child) => child.type === "svg").length > 0)).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" }).parent?.props["data-testid"]).toBe("task-view-tab-list");
    for (const label of ["Assignee", "Start time", "Due time", "Creator", "Created time", "Task ID", "Priority", "Task list", "Casey Creator", "Launch"]) {
      expect(renderer!.root.findAll((node) => node.props.children === label).length).toBeGreaterThan(0);
    }
    expect(renderer!.root.findByProps({ role: "img", "aria-label": "Alex Assignee" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-priority-high" }).children).toContain("High priority");
    const headers = renderer!.root.findByType("thead").findAllByType("th");
    const headerText = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : headerText(child)).join("");
    expect(headers.slice(0, 4).map(headerText)).toEqual(["Task title", "Assignee", "Start time", "Due time"]);
    expect(headers.slice(-2).map(headerText)).toEqual(["Priority", "Task list"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("list title icons and labels keep a fixed gap as the table grows", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-title-header" }).props.className).toContain("gap-2");
    expect(renderer!.root.findByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" }).props.className).toContain("gap-2");
    expect(renderer!.root.findByProps({ "data-testid": "assigned-task-table" }).findByType("table").props.className).toContain("after:left-[38px]");
    expect(renderer!.root.findByProps({ "data-testid": "assigned-task-table" }).findByType("table").props.className).toContain("after:right-6");
  } finally { await act(async () => renderer!.unmount()); }
});

const hierarchyParent: DenProductTask = {
  ...tasks[0], id: "tree-parent", title: "Plan launch", subtaskCount: 3, completedSubtaskCount: 1, commentCount: 4,
  description: '[brief.pdf](https://files.test/brief.pdf "task-file")\n[notes.txt](https://files.test/notes.txt "task-file:123")\n![diagram](https://files.test/diagram.png "task-file")\n`[example](https://files.test/example "task-file")`\n[ordinary link](https://files.test/page)',
};
const hierarchyChild: DenProductTask = {
  ...tasks[1], id: "tree-child", title: "Review plan", parentTask: { id: hierarchyParent.id, title: hierarchyParent.title }, subtaskCount: 1, commentCount: 0,
};
const hierarchyGrandchild: DenProductTask = {
  ...tasks[2], id: "tree-grandchild", title: "Check budget", parentTask: { id: hierarchyChild.id, title: hierarchyChild.title }, subtaskCount: 0, completedSubtaskCount: 0,
};

function hierarchyWorkbench(overrides: Partial<React.ComponentProps<typeof TaskWorkbench>> = {}) {
  return <TaskWorkbench tasks={[hierarchyParent, hierarchyChild]} membersByTaskId={{}} members={members} lists={lists} settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} {...overrides} />;
}

function hierarchyRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll((node) => node.type === "tr" && node.props["data-task-id"]);
}

for (const view of ["list", "board"] as const) {
  test(`${view} renders a milestone diamond with the same reopen action and leaves ordinary tasks round`, async () => {
    const onTransition = mock(() => undefined);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(hierarchyWorkbench({
      tasks: [tasks[0]!, { ...tasks[1]!, isMilestone: true }],
      settings: { ...defaultTaskWorkbenchSettings, view, status: "all" }, onTransition,
    })); });
    try {
      const reopen = renderer.root.findByProps({ "aria-label": "Reopen task" });
      expect(reopen.props.className).toContain("rotate-45");
      expect(reopen.findAllByType("svg")).toHaveLength(1);
      expect(renderer.root.findByProps({ "aria-label": "Complete task" }).props.className).toContain("rounded-full");
      await act(async () => reopen.props.onClick({ currentTarget: reopen }));
      expect(onTransition).toHaveBeenCalledWith(expect.objectContaining({ id: tasks[1]!.id }), "reopen", reopen);
    } finally { await act(async () => renderer.unmount()); }
  });
}

test("list expands reachable subtasks by default and keeps independently matching root rows", async () => {
  const select = mock((_id: string) => undefined);
  const load = mock(async (id: string): Promise<DenProductTaskPage> => id === hierarchyParent.id
    ? { items: [hierarchyChild], membersByTaskId: { [hierarchyChild.id]: [{ memberId: members[1].id, role: "assignee" }] }, nextCursor: "" }
    : { items: [hierarchyGrandchild], nextCursor: "" });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(hierarchyWorkbench({ onLoadSubtasks: load, onSelect: select })); });
  try {
    const placements = () => hierarchyRows(renderer).map((row) => [row.props["data-task-id"], row.props["data-task-depth"]]);
    const row = (id: string, depth: number) => renderer.root.findByProps({ "data-task-id": id, "data-task-depth": depth });
    const toggle = (id: string, depth: number) => row(id, depth).findByProps({ "data-testid": `task-subtasks-toggle-${id}` });
    expect(placements()).toEqual([[hierarchyParent.id, 0], [hierarchyChild.id, 1], [hierarchyGrandchild.id, 2], [hierarchyChild.id, 0], [hierarchyGrandchild.id, 1]]);

    const link = row(hierarchyChild.id, 0).findByProps({ "data-testid": `task-parent-link-${hierarchyChild.id}` });
    expect(link.findByType("span").children).toEqual([hierarchyParent.title]);
    await act(async () => { link.props.onClick(); });
    expect(select.mock.calls).toEqual([[hierarchyParent.id]]);
    expect(row(hierarchyChild.id, 1).findAllByType("td")[0].props.style.paddingInlineStart).toBeGreaterThan(row(hierarchyChild.id, 0).findAllByType("td")[0].props.style.paddingInlineStart);
    expect(row(hierarchyChild.id, 1).findAllByProps({ "data-testid": `task-parent-link-${hierarchyChild.id}` })).toHaveLength(0);
    expect(row(hierarchyChild.id, 1).findByProps({ role: "img", "aria-label": "Alex Assignee" })).toBeDefined();

    await act(async () => { toggle(hierarchyChild.id, 1).props.onClick(); });
    expect(toggle(hierarchyChild.id, 0).props["aria-expanded"]).toBe(true);
    expect(placements()).toEqual([[hierarchyParent.id, 0], [hierarchyChild.id, 1], [hierarchyChild.id, 0], [hierarchyGrandchild.id, 1]]);
    await act(async () => { toggle(hierarchyParent.id, 0).props.onClick(); });
    expect(placements()).toEqual([[hierarchyParent.id, 0], [hierarchyChild.id, 0], [hierarchyGrandchild.id, 1]]);
  } finally { await act(async () => renderer.unmount()); }
});

test("list shows projected direct-child and comment counts, and counts only file attachments", async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(hierarchyWorkbench({ tasks: [hierarchyParent, hierarchyChild, hierarchyGrandchild, tasks[2]] })); });
  try {
    const count = (row: TestRenderer.ReactTestInstance, kind: string) => row.findByProps({ "data-testid": `task-title-count-${kind}` }).find((node) => node.type === "span" && node.props["aria-hidden"] === "true").children;
    const [parent, child, grandchild, legacy] = hierarchyRows(renderer);
    expect(count(parent, "subtasks")).toEqual(["1/3"]);
    expect(count(parent, "attachments")).toEqual(["2"]);
    expect(count(parent, "comments")).toEqual(["4"]);
    expect(parent.findByProps({ "data-testid": "task-title-count-comments" }).props.title).toBe("Comments: 4");
    expect(count(child, "subtasks")).toEqual(["0/1"]);
    expect(child.findAllByProps({ "data-testid": "task-title-count-comments" })).toHaveLength(0);
    for (const row of [grandchild, legacy]) {
      expect(row.findAll((node) => node.props["data-testid"]?.startsWith("task-title-count-"))).toHaveLength(0);
    }
  } finally { await act(async () => renderer.unmount()); }
});

test("open branches reload after invalidation, retry pagination, and ignore stale requests", async () => {
  let finishOld!: (page: DenProductTaskPage) => void;
  const firstLoad = mock(() => new Promise<DenProductTaskPage>((resolve) => { finishOld = resolve; }));
  const leaf = { ...hierarchyChild, subtaskCount: 0 };
  const nextChild = { ...leaf, id: "tree-next", title: "Another child" };
  let failPage = true;
  const load = mock(async (_id: string, cursor?: string): Promise<DenProductTaskPage> => {
    if (!cursor) return { items: [leaf, hierarchyGrandchild], nextCursor: "next" };
    if (cursor === "last") throw new DenApiError(403, "forbidden", "No longer visible");
    if (failPage) throw new Error("Failed page");
    return { items: [leaf, nextChild], nextCursor: "last" };
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  const render = (revision: number, loader: React.ComponentProps<typeof TaskWorkbench>["onLoadSubtasks"]) => hierarchyWorkbench({ tasks: [hierarchyParent], subtasksRevision: revision, onLoadSubtasks: loader });
  await act(async () => { renderer = TestRenderer.create(render(0, firstLoad)); });
  try {
    expect(firstLoad).toHaveBeenCalledTimes(1);
    await act(async () => { renderer.update(render(1, load)); });
    await act(async () => { finishOld({ items: [{ ...hierarchyChild, id: "stale-child" }], nextCursor: "" }); });
    const ids = () => hierarchyRows(renderer).map((row) => row.props["data-task-id"]);
    const status = () => renderer.root.findByProps({ "data-testid": `task-subtasks-status-${hierarchyParent.id}` });
    expect(ids()).toEqual([hierarchyParent.id, hierarchyChild.id]);
    await act(async () => { status().findByType("button").props.onClick(); });
    expect(status().findByProps({ role: "alert" })).toBeDefined();
    expect(ids()).toEqual([hierarchyParent.id, hierarchyChild.id]);
    failPage = false;
    await act(async () => { status().findByType("button").props.onClick(); });
    expect(ids()).toEqual([hierarchyParent.id, hierarchyChild.id, nextChild.id]);
    expect(load.mock.calls).toEqual([[hierarchyParent.id, undefined], [hierarchyParent.id, "next"], [hierarchyParent.id, "next"]]);
    await act(async () => { status().findByType("button").props.onClick(); });
    expect(status().findByProps({ role: "alert" })).toBeDefined();
    expect(ids()).toEqual([hierarchyParent.id]);
  } finally { await act(async () => renderer.unmount()); }
});

test("refreshing a paginated branch keeps its rows mounted until all visible pages are current", async () => {
  const child = { ...hierarchyChild, subtaskCount: 0 };
  const sibling = { ...child, id: "second-page-child" };
  const initial = async (_id: string, cursor?: string) => cursor
    ? { items: [sibling], nextCursor: "" }
    : { items: [child], nextCursor: "old-cursor" };
  let finishRefresh!: (page: DenProductTaskPage) => void;
  const refresh = mock(async (_id: string, cursor?: string) => cursor
    ? new Promise<DenProductTaskPage>((resolve) => { finishRefresh = resolve; })
    : { items: [child], nextCursor: "new-cursor" });
  const render = (revision: number, loader: typeof initial | typeof refresh) => hierarchyWorkbench({
    tasks: [hierarchyParent], subtasksRevision: revision, onLoadSubtasks: loader,
  });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(render(1, initial)); });
  try {
    const statusId = { "data-testid": `task-subtasks-status-${hierarchyParent.id}` };
    await act(async () => { renderer.root.findByProps(statusId).findByType("button").props.onClick(); });
    const secondRow = hierarchyRows(renderer)[2];
    await act(async () => { renderer.update(render(2, refresh)); });
    expect(refresh.mock.calls.map(([, cursor]) => cursor)).toEqual([undefined, "new-cursor"]);
    expect(renderer.root.findAllByProps(statusId)).toHaveLength(0);
    expect(hierarchyRows(renderer)[2]).toBe(secondRow);
    await act(async () => { finishRefresh({ items: [{ ...sibling, status: "todo" }], nextCursor: "" }); });
    expect(hierarchyRows(renderer)[2]).toBe(secondRow);
    expect(secondRow.findByProps({ "aria-label": "Complete task" })).toBeDefined();
  } finally { await act(async () => renderer.unmount()); }
});

test("a task list keeps its hierarchy independent of the system subtask visibility preference", async () => {
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  const scope = { baseUrl: "https://den.test", userId: "user_one", organizationId: "organization" };
  storage.set(taskWorkbenchStorageKey(scope, "all", "list_one"), JSON.stringify({ subtaskVisibility: "hide" }));
  const load = mock(async (id: string): Promise<DenProductTaskPage> => ({ items: id === hierarchyParent.id ? [hierarchyChild] : [], nextCursor: "" }));
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  try {
    const settings = readTaskWorkbenchSettings(scope, "all", "list_one");
    await act(async () => { renderer = TestRenderer.create(hierarchyWorkbench({ isTaskList: true, tasks: [hierarchyParent], settings, onLoadSubtasks: load })); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-subtask-visibility-menu" })).toHaveLength(0);
    expect(hierarchyRows(renderer!).map((row) => row.props["data-task-id"])).toEqual([hierarchyParent.id, hierarchyChild.id]);
  } finally {
    await act(async () => { renderer?.unmount(); });
    if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("list assignees use the fourth slot for overflow only when more than four are assigned", async () => {
  const [first, second] = members;
  const others = ["Morgan", "Taylor", "Jamie"].map((name) => ({ ...second, id: name, userId: name, user: { ...second.user, id: name, name } }));
  const people = [first, second, ...others];
  const task = { ...tasks[0], completionPolicy: "all_assignees" as const };
  const assignees = people.map((member, index) => ({ memberId: member.id, role: "assignee" as const, completedAt: index === 0 ? task.createdAt : null }));
  const render = (status: DenProductTask["status"], count = assignees.length) => <TaskWorkbench tasks={[{ ...task, status }]} membersByTaskId={{ [task.id]: assignees.slice(0, count) }} members={people} lists={lists} settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onAssigneesChange={async () => true} />;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(render("todo", 1)); });
  try {
    const trigger = () => renderer.root.find((node) => node.type === "button" && node.props["data-testid"] === `task-assignee-trigger-${task.id}`);
    const avatars = () => trigger().findAll((node) => node.type === "span" && node.props["data-slot"] === "avatar");
    const tooltip = () => renderer.root.findByProps({ role: "tooltip" }).findByType("span").children;
    expect(avatars()).toHaveLength(1);
    expect(trigger().findAll((node) => node.type === "span" && node.props.children === "Casey Creator")).toHaveLength(1);
    expect(tooltip()).toEqual(["Casey Creator"]);
    await act(async () => { renderer.update(render("todo", 4)); });
    expect(avatars()).toHaveLength(4);
    expect(trigger().findAll((node) => node.type === "span" && node.children.join("").startsWith("+"))).toHaveLength(0);
    expect(trigger().findAll((node) => node.type === "span" && node.props.children === "Casey Creator")).toHaveLength(0);
    expect(tooltip()).toEqual(["Casey Creator, Alex Assignee, Morgan, Taylor"]);
    await act(async () => { renderer.update(render("todo")); });
    expect(avatars()).toHaveLength(3);
    expect(trigger().find((node) => node.type === "span" && node.children.join("") === "+2").children).toEqual(["+", "2"]);
    expect(tooltip()).toEqual(["Casey Creator, Alex Assignee, Morgan, Taylor, Jamie"]);
    expect(trigger().props["aria-description"]).toContain("Morgan, Taylor, Jamie");
    expect(trigger().findAllByProps({ "data-testid": "task-assignee-completed" })).toHaveLength(1);
    await act(async () => { renderer.update(render("completed")); });
    expect(trigger().findAllByProps({ "data-testid": "task-assignee-completed" })).toHaveLength(1);
  } finally { await act(async () => renderer.unmount()); }
});

test("assignee cells open a searchable people picker and persist multi-assignee changes", async () => {
  const changes: Array<{ taskId: string; memberIds: string[] }> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async () => true, async (task, memberIds) => { changes.push({ taskId: task.id, memberIds }); return true; })); });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-assignee-trigger-task_todo_with_full_identifier" })).toBeDefined();
    const picker = renderer!.root.findByProps({ "data-testid": "task-assignee-picker-task_todo_with_full_identifier" });
    expect(picker.findAll((node) => node.props.children === "Assign to people")).toHaveLength(1);
    const selected = picker.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" });
    expect(selected.props["aria-checked"]).toBe(true);
    const creator = picker.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_creator" });
    expect(creator.props["aria-checked"]).toBe(false);

    await act(async () => { creator.props.onClick(); });
    expect(changes.at(-1)).toEqual({ taskId: "task_todo_with_full_identifier", memberIds: ["member_assignee", "member_creator"] });
    expect(renderer!.root.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_creator" }).props["aria-checked"]).toBe(true);

    const search = renderer!.root.findByProps({ "data-testid": "task-assignee-search-task_todo_with_full_identifier" });
    const typeSearch = (value: string) => act(async () => { search.props.onInput({ currentTarget: { value } }); });
    await typeSearch("al");
    expect(renderer!.root.findAllByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_creator" })).toHaveLength(0);
    await typeSearch("alx");
    expect(picker.findAllByProps({ role: "checkbox" })).toHaveLength(0);
    await typeSearch("");
    expect(picker.findAllByProps({ role: "checkbox" })).toHaveLength(2);
    expect(changes).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("assignee cells remove people and keep the previous selection when persistence fails", async () => {
  const changes: string[][] = [];
  let shouldSave = false;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async () => true, async (_task, memberIds) => { changes.push(memberIds); return shouldSave; })); });
  try {
    let selected = renderer!.root.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" });
    await act(async () => { selected.props.onClick(); });
    expect(changes.at(-1)).toEqual([]);
    expect(renderer!.root.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" }).props["aria-checked"]).toBe(true);

    shouldSave = true;
    selected = renderer!.root.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" });
    await act(async () => { selected.props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" }).props["aria-checked"]).toBe(false);
  } finally { await act(async () => renderer!.unmount()); }
});

test("assignee picker persists the completion rule and rolls back failed changes", async () => {
  const changes: DenProductTaskCompletionPolicy[] = [];
  let shouldSave = false;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async () => true, undefined, async (_task, policy) => { changes.push(policy); return shouldSave; })); });
  try {
    let all = renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-all_assignees" });
    expect(all.findAll((node) => node.props.children === "All assignees must complete")).toHaveLength(1);
    await act(async () => { all.props.onClick(); });
    expect(changes).toEqual(["all_assignees"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-any_assignee" }).findAll((node) => node.type === "svg")).toHaveLength(1);
    shouldSave = true;
    all = renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-all_assignees" });
    await act(async () => { all.props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-all_assignees" }).findAll((node) => node.type === "svg")).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("task time picker supports optional dates, active fields, and half-hour specific times", async () => {
  const changes: Array<string | null> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskDateTimeCell task={tasks[0]!} field="startAt" onChange={async (_task, _field, value) => { changes.push(value); return true; }} />); });
  try {
    const picker = renderer!.root.findByProps({ "data-testid": "task-time-picker-task_todo_with_full_identifier-startAt" });
    expect(picker.findByProps({ "data-testid": "task-time-date-input-task_todo_with_full_identifier-startAt" })).toBeDefined();
    expect(picker.findByProps({ "data-testid": "task-time-date-input-task_todo_with_full_identifier-dueAt" })).toBeDefined();
    expect([...new Set(picker.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-time-option-task_todo_with_full_identifier-startAt-")).map((node) => node.props["data-testid"]))]).toHaveLength(48);
    expect(picker.findByProps({ "data-testid": "task-time-option-task_todo_with_full_identifier-startAt-09-30" })).toBeDefined();
    const specific = picker.findByProps({ "data-testid": "task-time-specific-task_todo_with_full_identifier-startAt" });
    expect(specific.props.checked).toBe(true);
    await act(async () => { specific.props.onChange({ target: { checked: false } }); });
    expect(changes.at(-1)).toEqual(expect.any(String));
    const saved = new Date(changes.at(-1)!);
    expect(saved.getHours()).toBe(0);
    expect(saved.getMinutes()).toBe(0);
    expect(picker.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-time-option-task_todo_with_full_identifier-startAt-"))).toHaveLength(0);
    await act(async () => { picker.findByProps({ "data-testid": "task-time-date-input-task_todo_with_full_identifier-startAt" }).props.onClick(); });
    const day = picker.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-time-day-task_todo_with_full_identifier-startAt-") && node.props.disabled === false)[0]!;
    await act(async () => { day.props.onClick(); });
    expect(changes.at(-1)).toEqual(expect.any(String));
    await act(async () => { picker.findByProps({ "data-testid": "task-time-clear-task_todo_with_full_identifier-startAt" }).props.onClick(); });
    expect(changes.at(-1)).toBeNull();
  } finally { await act(async () => renderer!.unmount()); }
});

test("task calendar marks today, focuses due after start, and previews the range without saving it", async () => {
  const task = { ...tasks[0]!, startAt: null, dueAt: null };
  const fields: string[] = [];
  let focused = false;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskDateTimeCell task={task} field="startAt" onChange={async (_, field) => { fields.push(field); return true; }} />, { createNodeMock: (el) => ({ focus: () => { focused = el.props["data-testid"] === `task-time-date-input-${task.id}-dueAt`; } }) }); });
  try {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
    const day = (n: number) => renderer!.root.findByProps({ "aria-label": `${key}-${String(n).padStart(2, "0")}` });
    expect(day(today.getDate()).props["aria-current"]).toBe("date");
    await act(async () => { day(5).props.onClick(); });
    expect(focused).toBe(true);
    await act(async () => { day(15).props.onMouseEnter(); });
    expect(day(10).findAllByProps({ "aria-hidden": "true" })).toHaveLength(1);
    expect(fields).toEqual(["startAt"]);
    await act(async () => { day(15).props.onClick(); });
    expect(fields).toEqual(["startAt", "dueAt"]);
    expect(day(5).props["aria-pressed"]).toBe(true);
    expect(day(15).props["aria-pressed"]).toBe(true);
    expect(day(16).findAllByProps({ "aria-hidden": "true" })).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("due reminder options follow date precision", async () => {
  const reminders: TaskReminderDraft[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskDateTimeCell task={tasks[0]!} field="dueAt" onChange={async () => true} onLoadReminders={async () => []} onReminderChange={async (_task, reminder) => { reminders.push(reminder); return true; }} />); });
  try {
    expect([...new Set(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].includes("task-reminder-option-")).map((node) => node.props["data-testid"]))]).toEqual([
      "task-reminder-option-task_todo_with_full_identifier-before_5m",
      "task-reminder-option-task_todo_with_full_identifier-before_15m",
      "task-reminder-option-task_todo_with_full_identifier-before_30m",
      "task-reminder-option-task_todo_with_full_identifier-before_1h",
      "task-reminder-option-task_todo_with_full_identifier-before_2h",
      "task-reminder-option-task_todo_with_full_identifier-before_1d",
    ]);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-reminder-option-task_todo_with_full_identifier-before_30m" }).props.onClick(); });
    expect(reminders.at(-1)).toEqual({ mode: "due_relative", dueOffsetSeconds: -1800 });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-time-specific-task_todo_with_full_identifier-dueAt" }).props.onChange({ target: { checked: false } }); });
    expect([...new Set(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].includes("task-reminder-option-")).map((node) => node.props["data-testid"]))]).toEqual([
      "task-reminder-option-task_todo_with_full_identifier-same_day_18",
      "task-reminder-option-task_todo_with_full_identifier-before_1d_9",
      "task-reminder-option-task_todo_with_full_identifier-before_2d_9",
    ]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("task-list cell searches existing lists and creates a missing list", async () => {
  const moves: string[] = [];
  const creates: string[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, undefined, undefined, undefined, undefined, undefined, async (_task, listId) => { moves.push(listId); return true; }, async (_task, name) => { creates.push(name); return "list_created"; })); });
  try {
    const picker = renderer!.root.findByProps({ "data-testid": "task-list-picker-task_todo_with_full_identifier" });
    expect(picker.findByProps({ "data-testid": "task-list-option-task_todo_with_full_identifier-list_one" })).toBeDefined();
    const search = picker.findByProps({ "data-testid": "task-list-search-task_todo_with_full_identifier" });
    await act(async () => { search.props.onChange({ currentTarget: { value: "Testing list" } }); });
    const create = renderer!.root.findByProps({ "data-testid": "task-list-create-task_todo_with_full_identifier" });
    expect(create.findAll((node) => node.props.children === "Testing list")).toHaveLength(1);
    await act(async () => { create.props.onClick(); });
    expect(creates).toEqual(["Testing list"]);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-list-option-task_todo_with_full_identifier-list_one" }).props.onClick(); });
    expect(moves).toEqual(["list_one"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("list completion circle remains empty and actionable after the current assignee finishes their part", async () => {
  const transitions: string[] = [];
  const allTasks = [{ ...tasks[0]!, completionPolicy: "all_assignees" as const }];
  const allMembers = { [allTasks[0]!.id]: [{ memberId: "member_assignee", role: "assignee" as const, completedAt: "2026-11-03T10:00:00Z" }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={allTasks} membersByTaskId={allMembers} members={members} lists={lists} settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} quickCreateMemberId="member_assignee" onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={(_task, operation) => transitions.push(operation)} />); });
  try {
    const button = renderer!.root.findByProps({ "aria-label": "Complete task" });
    expect(button.findAllByType("svg")).toHaveLength(0);
    expect(renderer!.root.findByProps({ "data-testid": "task-assignee-completed" })).toBeDefined();
    await act(async () => { button.props.onClick(); });
    expect(transitions).toEqual(["complete-whole"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("ungrouped list renders exactly one trailing new-task action", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "none" })); });
  try {
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-bottom-trigger" })).toHaveLength(1);
    expect(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-inline-create-group-trigger-"))).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("toolbar and final-row creation insert a focused title input at their requested position", async () => {
  const titles: string[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async (title) => { titles.push(title); return true; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    let row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-top" });
    let input = row.findByType("input");
    expect(input.props.autoFocus).toBe(true);
    const bodyRows = renderer!.root.findByType("tbody").findAllByType("tr");
    expect(bodyRows[0]?.props["data-testid"]).toBe("task-inline-create-row-top");
    await act(async () => { input.props.onChange({ target: { value: "Top task" } }); });
    row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-top" });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(titles).toEqual(["Top task"]);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-row-top" })).toHaveLength(0);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-bottom-trigger" }).props.onClick(); });
    row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" });
    input = row.findByType("input");
    expect(input.props.autoFocus).toBe(true);
    expect(row.props.className).toContain("bg-dls-active");
    expect(row.findAllByType("td")).toHaveLength(defaultTaskWorkbenchSettings.fields.length + 1);
    expect(row.findByProps({ "aria-label": "Unassigned" }).props.className).toContain("text-dls-secondary/45");
    expect(row.findByProps({ "aria-label": "Start time" }).props.className).toContain("text-dls-secondary/45");
    expect(row.findByProps({ "aria-label": "Due time" }).props.className).toContain("text-dls-secondary/45");
    const updatedRows = renderer!.root.findByType("tbody").findAllByType("tr");
    expect(updatedRows.at(-2)?.props["data-testid"]).toBe("task-inline-create-row-bottom");
    expect(updatedRows.at(-1)?.findByProps({ "data-testid": "task-inline-create-bottom-trigger" })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("empty task assignee and times use muted add-person and calendar affordances", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async () => true, async () => true)); });
  try {
    const emptyTask = renderer!.root.findByProps({ "data-testid": "task-title-cell-task_canceled" }).parent?.parent?.parent!;
    const assigneeTrigger = emptyTask.findAllByProps({ "aria-label": "Edit assignees" }).find((node) => node.props["data-testid"] === "task-assignee-trigger-task_canceled")!;
    expect(assigneeTrigger.findByProps({ "aria-label": "Unassigned" }).props.className).toContain("text-dls-secondary/45");
    expect(emptyTask.findAllByProps({ "aria-label": "Start time" }).some((node) => node.props.className?.includes("text-dls-secondary/45"))).toBe(true);
    expect(emptyTask.findAllByProps({ "aria-label": "Due time" }).some((node) => node.props.className?.includes("text-dls-secondary/45"))).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("inline creation cancels an empty blur and submits a non-empty blur only once", async () => {
  const titles: string[] = [];
  let resolveCreate: ((created: boolean) => void) | undefined;
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async (title) => { titles.push(title); return new Promise<boolean>((resolve) => { resolveCreate = resolve; }); })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-bottom-trigger" }).props.onClick(); });
    let input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => { input.props.onBlur({ currentTarget: { value: "" } }); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-row-bottom" })).toHaveLength(0);
    expect(titles).toEqual([]);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-bottom-trigger" }).props.onClick(); });
    input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => { input.props.onChange({ currentTarget: { value: "  Blur task  " } }); });
    input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => { input.props.onBlur({ currentTarget: { value: "  Blur task  " } }); input.props.onBlur({ currentTarget: { value: "  Blur task  " } }); });
    expect(titles).toEqual(["Blur task"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input").props.disabled).toBe(true);
    await act(async () => { resolveCreate?.(true); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-row-bottom" })).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("inline creation submits the live input value when change and blur happen before rerender", async () => {
  const titles: string[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, () => undefined, () => undefined, async (title) => { titles.push(title); return true; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-bottom-trigger" }).props.onClick(); });
    const input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => {
      input.props.onChange({ currentTarget: { value: "  Immediate blur task  " } });
      input.props.onBlur({ currentTarget: { value: "  Immediate blur task  " } });
    });
    expect(titles).toEqual(["Immediate blur task"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("both list and board render the same active underline contract", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    let indicator = renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" });
    expect(indicator.parent?.props["data-testid"]).toBe("task-view-tab-list");
    expect(indicator.props.className).toContain("bottom-[3px]");
    // The list table header is sticky z-10 and would otherwise cover the indicator that overlaps the bar border.
    expect(renderer!.root.findByProps({ "data-testid": "task-view-tab-bar" }).props.className).toContain("z-20");
    await act(async () => { renderer!.update(workbench({ ...defaultTaskWorkbenchSettings, view: "board" })); });
    indicator = renderer!.root.findByProps({ "data-testid": "task-view-active-indicator" });
    expect(indicator.parent?.props["data-testid"]).toBe("task-view-tab-board");
    expect(indicator.props.className).toContain("bottom-[3px]");
    expect(renderer!.root.findByProps({ "data-testid": "task-view-tab-list" }).props.className).toContain("text-[14px]");
    expect(renderer!.root.findByProps({ "data-testid": "task-view-tab-board" }).props.className).toContain("text-[14px]");
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter refresh keeps the workbench rows mounted and shows only a local progress indicator", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(refreshingWorkbench()); });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-filter-refreshing" }).props.role).toBe("status");
    expect(renderer!.root.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "assigned-task-table" })).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("field control emits settings without the unchecked optional field", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    const fields = renderer!.root.findByProps({ "data-testid": "task-fields-menu" });
    const assignee = fields.findByProps({ "data-testid": "task-field-visibility-assignee" });
    expect(assignee.props["aria-pressed"]).toBe(true);
    await act(async () => { assignee.props.onClick(); });
    expect(changes.at(-1)?.fields).not.toContain("assignee");
    expect(changes.at(-1)?.fields).toContain("created");
  } finally { await act(async () => renderer!.unmount()); }
});

test("field settings expose all supported fields with screenshot visibility defaults", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    const fields = renderer!.root.findByProps({ "data-testid": "task-fields-menu" });
    const ordered = ["assignee", "start", "due", "creator", "assigner", "followers", "created", "completed", "updated", "id", "priority", "list"];
    expect(fields.findAll((node) => node.props.role === "listitem").map((node) => node.props["data-testid"])).toEqual(ordered.map((field) => `task-field-row-${field}`));
    for (const field of ordered) {
      expect(fields.findByProps({ "data-testid": `task-field-visibility-${field}` }).props["aria-pressed"]).toBe(defaultTaskWorkbenchSettings.fields.some((item) => item === field));
    }
  } finally { await act(async () => renderer!.unmount()); }
});

test("field reordering updates settings and the visible table column order", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    const fields = renderer!.root.findByProps({ "data-testid": "task-fields-menu" });
    const dueHandle = fields.findByProps({ "aria-label": "Reorder field: Due time" });
    await act(async () => { dueHandle.props.onKeyDown({ key: "ArrowUp", preventDefault: () => undefined }); });
    const next = changes.at(-1)!;
    expect(next.fieldOrder.slice(0, 3)).toEqual(["assignee", "due", "start"]);
    expect(next.fields.slice(0, 3)).toEqual(["assignee", "due", "start"]);
    await act(async () => { renderer!.update(workbench(next)); });
    const headerText = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : headerText(child)).join("");
    expect(renderer!.root.findByType("thead").findAllByType("th").slice(0, 4).map(headerText)).toEqual(["Task title", "Assignee", "Due time", "Start time"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("field drag handle reorders the configuration and visible fields", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    const fields = renderer!.root.findByProps({ "data-testid": "task-fields-menu" });
    const data = new Map<string, string>();
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? "" };
    await act(async () => { fields.findByProps({ "aria-label": "Reorder field: Due time" }).props.onDragStart({ dataTransfer }); });
    await act(async () => { fields.findByProps({ "data-testid": "task-field-row-assignee" }).props.onDrop({ preventDefault: () => undefined, dataTransfer }); });
    expect(changes.at(-1)?.fieldOrder.slice(0, 3)).toEqual(["due", "assignee", "start"]);
    expect(changes.at(-1)?.fields.slice(0, 3)).toEqual(["due", "assignee", "start"]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("optional people and lifecycle fields render joined member and task data", async () => {
  const settings = { ...defaultTaskWorkbenchSettings, fields: ["assigner", "followers", "completed", "updated"] as typeof defaultTaskWorkbenchSettings.fields };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(settings)); });
  try {
    const headerText = (node: TestRenderer.ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : headerText(child)).join("");
    expect(renderer!.root.findByType("thead").findAllByType("th").map(headerText)).toEqual(["Task title", "Assigner", "Followers", "Completed time", "Updated time"]);
    expect(renderer!.root.findAll((node) => node.props.children === "Casey Creator").length).toBeGreaterThan(1);
    const completedTaskRow = renderer!.root.findByProps({ "data-task-id": "task_done" });
    expect(headerText(completedTaskRow.findAllByType("td")[3]!)).not.toBe("Unavailable");
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter builder lists the requested fields and removes conditions", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-filter-add" }).props.onClick(); });
    const field = renderer!.root.findByProps({ "data-testid": "task-filter-field-0" });
    const requestedFields = ["assignee", "start", "due", "completed", "assigner", "follower", "creator", "created", "updated"];
    expect(field.props["data-filter-options"].split(",")).toEqual(requestedFields);
    await act(async () => { renderer!.root.findByProps({ "aria-label": "Remove condition" }).props.onClick(); });
    expect(changes.at(-1)?.assigneeMemberIds).toEqual([]);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-filter-condition-assignee" })).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter builder supports multi-value member conditions and avatar values", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => changes.push(next))); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-filter-add" }).props.onClick(); });
    const condition = renderer!.root.findByProps({ "data-testid": "task-filter-condition-assignee" });
    expect(condition.findAll((node) => node.props.children === "Assignee").length).toBeGreaterThan(0);
    expect(condition.findAll((node) => node.props.children === "Select organization members").length).toBeGreaterThan(0);
    await act(async () => { condition.findByProps({ "data-testid": "task-filter-member-assignee-member_creator" }).props.onClick(); });
    expect(changes.at(-1)?.assigneeMemberIds).toEqual(["member_creator"]);
    await act(async () => { renderer!.update(workbench({ ...defaultTaskWorkbenchSettings, assigneeMemberIds: ["member_creator"] }, (next) => changes.push(next))); });
    const updated = renderer!.root.findByProps({ "data-testid": "task-filter-condition-assignee" });
    expect(updated.findAll((node) => node.props.children === "Casey Creator").length).toBeGreaterThan(0);
    await act(async () => { updated.findByProps({ "data-testid": "task-filter-member-assignee-member_assignee" }).props.onClick(); });
    expect(changes.at(-1)?.assigneeMemberIds).toEqual(["member_creator", "member_assignee"]);
    await act(async () => { updated.findByProps({ "data-testid": "task-filter-operator-assignee" }).parent!.props.onValueChange("empty"); });
    expect(changes.at(-1)).toMatchObject({ assigneeMemberOperator: "empty", assigneeMemberIds: [] });
  } finally { await act(async () => renderer!.unmount()); }
});

test("filter badge counts active personnel conditions rather than selected people", async () => {
  const settings = { ...defaultTaskWorkbenchSettings, assigneeMemberIds: ["member_creator", "member_assignee"], creatorMemberOperator: "not_empty" as const };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(settings)); });
  try {
    const filter = renderer!.root.findByProps({ "data-testid": "task-filter-menu" });
    expect(filter.findAll((node) => node.props.children === 2).length).toBeGreaterThan(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("sort menu exposes per-field directions and defaults field selection to descending", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, sort: "updated_at", direction: "asc" }, (next) => changes.push(next))); });
  try {
    const sortMenu = renderer!.root.findByProps({ "data-testid": "task-sort-menu" });
    for (const sort of ["start_at", "due_at", "created_at", "updated_at", "completed_at"]) {
      expect(sortMenu.findByProps({ "data-testid": `task-sort-option-${sort}` })).toBeDefined();
      expect(sortMenu.findByProps({ "data-testid": `task-sort-${sort}-asc` })).toBeDefined();
      expect(sortMenu.findByProps({ "data-testid": `task-sort-${sort}-desc` })).toBeDefined();
    }
    expect(sortMenu.findAllByProps({ "data-testid": "task-sort-option-priority" })).toHaveLength(0);
    await act(async () => { sortMenu.findByProps({ "data-testid": "task-sort-option-created_at" }).findByProps({ role: "radio" }).props.onClick(); });
    expect(changes.at(-1)).toMatchObject({ sort: "created_at", direction: "desc" });
    await act(async () => { sortMenu.findByProps({ "data-testid": "task-sort-due_at-asc" }).props.onClick(); });
    expect(changes.at(-1)).toMatchObject({ sort: "due_at", direction: "asc" });
    expect(sortMenu.findByProps({ "data-testid": "task-sort-updated_at-asc" }).props["aria-pressed"]).toBe(true);
    const activeOption = sortMenu.findByProps({ "data-testid": "task-sort-option-updated_at" });
    const inactiveOption = sortMenu.findByProps({ "data-testid": "task-sort-option-created_at" });
    expect(activeOption.props.className).not.toContain(" bg-dls-hover ");
    expect(activeOption.findByProps({ role: "radio" }).props.className).toContain("text-blue-10");
    expect(activeOption.findByProps({ "data-testid": "task-sort-updated_at-asc" }).props.className).toContain("text-blue-10");
    const inactiveDirection = activeOption.findByProps({ "data-testid": "task-sort-updated_at-desc" });
    expect(inactiveDirection.props.className).toContain("text-dls-secondary");
    expect(inactiveDirection.props.className).toContain("w-0");
    expect(inactiveDirection.props.className).toContain("group-hover:w-8");
    expect(activeOption.findAll((node) => typeof node.props.className === "string" && node.props.className.includes("lucide-check"))).toHaveLength(0);
    const inactiveArrows = inactiveOption.find((node) => node.type === "div" && typeof node.props.className === "string" && node.props.className.includes("group-hover:opacity-100"));
    expect(inactiveArrows.props.className).toContain("opacity-0");
    expect(inactiveArrows.props.className).not.toContain("focus-within");
    expect(inactiveArrows.props.className).toContain("pointer-events-none");
    expect(inactiveOption.props.className).toContain("hover:bg-dls-hover");
  } finally { await act(async () => renderer!.unmount()); }
});

test("board renders workbench groups and accessible lifecycle actions", async () => {
  const actions: Array<[string, string]> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, view: "board", status: "all", group: "custom" }, () => undefined, (task, operation) => actions.push([task.id, operation]))); });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-board-group-custom-default" })).toBeDefined();
    expect(renderer!.root.findByProps({ "data-testid": "task-group-menu" }).props.title).toBeUndefined();
    const groupMenu = renderer!.root.findByProps({ "data-testid": "task-group-menu" });
    expect(groupMenu.findAll((node) => node.props.value === "none")).toHaveLength(0);
    expect(groupMenu.findAll((node) => node.props.value === "list").length).toBeGreaterThan(0);
    expect(renderer!.root.findAllByProps({ "aria-label": "Cancel task" })).toHaveLength(0);
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Complete task" })[0]!.props.onClick(); });
    await act(async () => { renderer!.root.findAllByProps({ "aria-label": "Reopen task" })[0]!.props.onClick(); });
    expect(actions).toEqual([["task_todo_with_full_identifier", "complete"], ["task_done", "reopen"]]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("entering a system board defaults an ungrouped workbench to priority grouping", async () => {
  const settings: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "none" }, (next) => settings.push(next))); });
  try {
    const tabs = renderer!.root.findAll((node) => typeof node.props.onValueChange === "function")[0]!;
    await act(async () => { tabs.props.onValueChange("board"); });
    expect(settings.at(-1)).toMatchObject({ view: "board", group: "priority" });
  } finally { await act(async () => renderer!.unmount()); }
});

test("switching from a task-list grouped board to List selects No grouping", async () => {
  const settings: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, view: "board", group: "list" }, (next) => settings.push(next))); });
  try {
    const tabs = renderer!.root.findAll((node) => typeof node.props.onValueChange === "function")[0]!;
    await act(async () => { tabs.props.onValueChange("list"); });
    expect(settings.at(-1)).toMatchObject({ view: "list", group: "none" });
  } finally { await act(async () => renderer!.unmount()); }
});

test("board groups cards by creator without changing active filters", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, view: "board", status: "all", group: "creator", priorities: ["high"] })); });
  try {
    expect(renderer!.root.findByProps({ "data-testid": "task-board-group-member_creator" })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-testid": "task-filter-menu" }).length).toBeGreaterThan(0);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-board-new-group-trigger" })).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("priority grouping is available in the menu, orders buckets, and inherits the group when creating a task", async () => {
  const chosen: Array<typeof defaultTaskWorkbenchSettings> = [];
  const creates: Array<{ title: string; defaults: Record<string, unknown> }> = [];
  const create = async (title: string, defaults: Record<string, unknown>) => { creates.push({ title, defaults }); return true; };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(defaultTaskWorkbenchSettings, (next) => chosen.push(next))); });
  try {
    const menu = renderer!.root.findByProps({ "data-testid": "task-group-menu" });
    expect(menu.findAll((node) => node.type === "button" && node.props.value === "priority").map((node) => node.props.children)).toEqual(["Priority"]);
    await act(async () => { menu.findAll((node) => typeof node.props.onValueChange === "function")[0]!.props.onValueChange("priority"); });
    expect(chosen.at(-1)?.group).toBe("priority");
    const settings = { ...chosen.at(-1)!, status: "all" as const };
    await act(async () => { renderer!.update(workbench(settings, () => undefined, () => undefined, create)); });
    const rows = renderer!.root.findByType("tbody").findAllByType("tr");
    const headers = rows.filter((row) => row.props["data-testid"]?.startsWith("task-group-row-"));
    expect(headers.map((row) => row.props["data-testid"])).toEqual(["task-group-row-high", "task-group-row-medium", "task-group-row-low", "task-group-row-none"]);
    expect(rows.indexOf(headers[0]!)).toBeLessThan(rows.findIndex((row) => row.findAllByProps({ "data-testid": `task-title-cell-${tasks[0]!.id}` }).length > 0));
    expect(rows.indexOf(headers[3]!)).toBeLessThan(rows.findIndex((row) => row.findAllByProps({ "data-testid": `task-title-cell-${tasks[1]!.id}` }).length > 0));

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-group-add-medium" }).props.onClick(); });
    const draft = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-medium" });
    await act(async () => { draft.findByType("input").props.onChange({ target: { value: "Follow up" } }); });
    await act(async () => { draft.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(creates).toEqual([{ title: "Follow up", defaults: { priority: "medium" } }]);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-none" })).toBeDefined();

    await act(async () => { renderer!.update(workbench({ ...settings, view: "board" })); });
    const columns = renderer!.root.findByProps({ "data-testid": "assigned-task-board" }).findAllByType("section");
    expect(columns.map((column) => column.props["data-testid"])).toEqual(["task-board-group-high", "task-board-group-medium", "task-board-group-low", "task-board-group-none"]);
    expect(columns[0]!.findByProps({ "data-testid": `task-board-card-${tasks[0]!.id}` })).toBeDefined();
    expect(columns[3]!.findByProps({ "data-testid": `task-board-card-${tasks[1]!.id}` })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("board groups a task once under each projected list, ignoring the stale legacy id", async () => {
  const projected = [{ ...tasks[0]!, listId: "legacy_hidden", listIds: ["list_one", "list_two"] }, { ...tasks[1]!, listId: "legacy_hidden", listIds: [] }];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.cloneElement(workbench({ ...defaultTaskWorkbenchSettings, view: "board", group: "list" }), { tasks: projected, lists: [...lists, { ...lists[0]!, id: "list_two", name: "Second" }] })); });
  try {
    const prefix = "task-board-group-";
    for (const id of ["list_one", "list_two", ""]) expect(renderer!.root.findByProps({ "data-testid": prefix + id })).toBeDefined();
    expect(renderer!.root.findAllByProps({ "data-testid": prefix + "legacy_hidden" })).toHaveLength(0);
    const row = "task-board-card-";
    expect(renderer!.root.findAllByProps({ "data-testid": row + projected[0]!.id })).toHaveLength(2);
    expect(renderer!.root.findAllByProps({ "data-testid": row + projected[1]!.id })).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom board creates a group inline while other board grouping hides the action", async () => {
  const settings: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  const custom = { ...defaultTaskWorkbenchSettings, view: "board" as const, group: "custom" as const };
  await act(async () => { renderer = TestRenderer.create(workbench(custom, (next) => settings.push(next))); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-board-new-group-trigger" }).props.onClick(); });
    const input = renderer!.root.findByProps({ "data-testid": "task-board-new-group-input" });
    await act(async () => { input.props.onChange({ currentTarget: { value: "Review" } }); input.props.onBlur({ currentTarget: { value: "Review" } }); });
    expect(settings.at(-1)?.customGroups.at(-1)?.name).toBe("Review");
  } finally { await act(async () => renderer!.unmount()); }
});

test("board group quick-create accepts a title and due date draft", async () => {
  const creates: Array<{ title: string; defaults: Record<string, unknown> }> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  const custom = { ...defaultTaskWorkbenchSettings, view: "board" as const, group: "custom" as const };
  await act(async () => { renderer = TestRenderer.create(workbench(custom, undefined, undefined, async (title, defaults) => { creates.push({ title, defaults }); return "task_created"; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-board-create-trigger-custom-default" }).props.onClick(); });
    const card = renderer!.root.findByProps({ "data-testid": "task-board-create-card-custom-default" });
    expect(card.findByProps({ "data-testid": "task-time-trigger-board-draft-custom-default-dueAt" })).toBeDefined();
    const title = card.findByProps({ "data-testid": "task-board-create-title-custom-default" });
    await act(async () => { title.props.onChange({ currentTarget: { value: "Board task" } }); title.props.onKeyDown({ key: "Enter", currentTarget: { value: "Board task" }, preventDefault: () => undefined }); });
    expect(creates).toEqual([{ title: "Board task", defaults: {} }]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("board drag moves tasks between custom groups and time groups", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  const timeChanges: Array<{ field: string; value: string | null }> = [];
  const dataTransfer = { effectAllowed: "move", dropEffect: "none", setData() {} };
  const event = { preventDefault: mock(() => {}), dataTransfer };
  const custom = { ...defaultTaskWorkbenchSettings, view: "board" as const, group: "custom" as const, sort: "due_at" as const, direction: "asc" as const, manualOrder: [tasks[1]!.id, tasks[0]!.id], customGroups: [{ id: "custom-review", name: "Review" }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(custom, (next) => changes.push(next))); });
  try {
    const source = renderer!.root.findByProps({ "data-testid": "task-board-card-task_todo_with_full_identifier" });
    const defaultLane = renderer!.root.findByProps({ "data-testid": `task-board-group-${defaultCustomTaskGroupKey}` });
    const reviewLane = renderer!.root.findByProps({ "data-testid": "task-board-group-custom-review" });
    await act(async () => { reviewLane.props.onDrop(event); });
    source.props.onDragStart({ dataTransfer });
    await act(async () => { defaultLane.props.onDragOver(event); defaultLane.props.onDrop(event); });
    expect(changes).toHaveLength(0);
    expect(event.preventDefault).not.toHaveBeenCalled();
    await act(async () => { reviewLane.props.onDragOver(event); reviewLane.props.onDrop(event); });
    expect(dataTransfer.dropEffect).toBe("move");
    expect(changes).toEqual([{ ...custom, customGroupAssignments: { task_todo_with_full_identifier: "custom-review" } }]);
  } finally { await act(async () => renderer!.unmount()); }

  const due = { ...defaultTaskWorkbenchSettings, view: "board" as const, group: "due" as const };
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={due} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onTimeChange={async (_task, field, value) => { timeChanges.push({ field, value }); return true; }} />); });
  try {
    renderer!.root.findByProps({ "data-testid": "task-board-card-task_todo_with_full_identifier" }).props.onDragStart({ dataTransfer });
    const sourceLane = renderer!.root.findByProps({ "data-testid": `task-board-group-${taskTimeGroup(tasks[0]!.dueAt, "due", new Date())}` });
    await act(async () => { sourceLane.props.onDrop(event); });
    expect(timeChanges).toHaveLength(0);
    const target = sourceLane.props["data-testid"] === "task-board-group-tomorrow" ? "unscheduled" : "tomorrow";
    await act(async () => { renderer!.root.findByProps({ "data-testid": `task-board-group-${target}` }).props.onDrop(event); });
    expect(timeChanges.at(-1)).toMatchObject({ field: "dueAt", value: target === "unscheduled" ? null : expect.any(String) });
  } finally { await act(async () => renderer!.unmount()); }
});

test("manual list ordering does not allow dropping into a different creator group", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  const settings = { ...defaultTaskWorkbenchSettings, group: "creator" as const, sort: "manual" as const, status: "all" as const };
  const groupedTasks = [tasks[0]!, { ...tasks[1]!, creatorMemberId: "member_assignee" }];
  const writes = mock(async () => true);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.cloneElement(workbench(settings, (next) => changes.push(next)), { isTaskList: true, tasks: groupedTasks, onPriorityChange: writes, onTimeChange: writes, onListMove: writes })); });
  try {
    const dataTransfer = { setData() {}, dropEffect: "none" };
    const event = { preventDefault: mock(() => {}), dataTransfer };
    const handle = renderer.root.findByProps({ "data-testid": `task-reorder-${tasks[0]!.id}` });
    const target = renderer.root.findByProps({ "data-task-id": tasks[1]!.id });
    await act(async () => { handle.props.onDragStart({ dataTransfer }); target.props.onDragOver(event); target.props.onDrop(event); });
    expect(target.props["data-drop-placement"]).toBeUndefined();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(changes).toHaveLength(0);
    expect(writes).not.toHaveBeenCalled();
    await act(async () => { renderer.update(React.cloneElement(workbench({ ...settings, view: "board" }), { isTaskList: true, tasks: groupedTasks, onPriorityChange: writes, onTimeChange: writes, onListMove: writes })); });
    expect(renderer.root.findByProps({ "data-testid": `task-board-card-${tasks[0]!.id}` }).props.draggable).toBe(false);
  } finally { await act(async () => renderer.unmount()); }
});

test.each(["list", "board"] as const)("%s drop updates priority and dates without changing sort preferences", async (view) => {
  const settings = { ...defaultTaskWorkbenchSettings, view, sort: "created_at" as const, direction: "asc" as const, status: "all" as const };
  const entry = tasks[0]!;
  const priority = mock(async () => true), time = mock(async () => true), preferences = mock(() => undefined);
  const render = (group: "priority" | "start" | "due") => React.cloneElement(workbench({ ...settings, group }, preferences), { tasks: [entry], onPriorityChange: priority, onTimeChange: time });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(render("priority")); });
  try {
    const drop = async (key: string) => {
      const dataTransfer = { setData() {}, dropEffect: "none" };
      const source = renderer.root.findByProps({ "data-testid": view === "list" ? `task-reorder-${entry.id}` : `task-board-card-${entry.id}` });
      const target = renderer.root.find((node) => node.type === (view === "list" ? "tr" : "section") && node.props["data-testid"] === `task-${view === "list" ? "group-row" : "board-group"}-${key}`);
      await act(async () => { source.props.onDragStart({ dataTransfer }); target.props.onDragOver({ preventDefault() {}, dataTransfer }); target.props.onDrop({ preventDefault() {}, dataTransfer }); });
      expect(dataTransfer.dropEffect).toBe("move");
    };
    await drop("none");
    expect(priority).toHaveBeenCalledWith(entry, "none");
    await act(async () => renderer.update(render("start")));
    await drop("unscheduled");
    expect(time).toHaveBeenCalledWith(entry, "startAt", null);
    await act(async () => renderer.update(render("due")));
    await drop("later");
    expect(time).toHaveBeenCalledWith(entry, "dueAt", expect.any(String));
    expect(taskTimeGroup(time.mock.calls[1]![2], "due")).toBe("later");
    expect(preferences).not.toHaveBeenCalled();
  } finally { await act(async () => renderer.unmount()); }
});

test("a legacy Task list grouping renders each task once in an ungrouped list", async () => {
  const entry = { ...tasks[0]!, listIds: ["list_one", "list_two"] };
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(React.cloneElement(workbench({ ...defaultTaskWorkbenchSettings, group: "list" }), { tasks: [entry] })); });
  try {
    expect(renderer.root.findAllByProps({ "data-task-id": entry.id })).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.props["data-testid"]).startsWith("task-group-row-"))).toHaveLength(0);
    expect(renderer.root.findByProps({ "data-testid": "task-group-menu" }).findAllByProps({ value: "list" })).toHaveLength(0);
  } finally { await act(async () => renderer.unmount()); }
});

test("task-list group menu places Custom group last", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom" })); });
  try {
    const menu = renderer!.root.findByProps({ "data-testid": "task-group-menu" });
    expect(menu.findAll((node) => node.type === "button" && typeof node.props.value === "string").map((node) => node.props.value)).toEqual(["none", "creator", "start", "due", "priority", "custom"]);
    const selected = menu.find((node) => node.type === "button" && node.props.value === "custom");
    expect(selected.props.children).toBe("Custom group");
    expect(selected.props.className).toContain("text-blue-10");
    expect(menu.find((node) => node.type === "button" && node.props.value === "none").props.className).not.toContain("text-blue-10");
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom grouping collects every task in one collapsible Default group", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom", status: "all" })); });
  try {
    const toggle = renderer!.root.findByProps({ "data-testid": `task-group-toggle-${defaultCustomTaskGroupKey}` });
    const groupHeader = renderer!.root.findByProps({ "data-testid": `task-group-row-${defaultCustomTaskGroupKey}` }).findByType("th");
    expect(groupHeader.props.className).not.toContain("border-b");
    expect(toggle.findAll((node) => node.props.children === "Default group")).toHaveLength(1);
    expect(toggle.findAll((node) => node.props.children === tasks.length)).toHaveLength(1);
    expect(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-group-row-"))).toHaveLength(1);
    for (const task of tasks) expect(renderer!.root.findAllByProps({ "data-testid": `task-title-cell-${task.id}` })).toHaveLength(1);
    await act(async () => { toggle.props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": `task-group-toggle-${defaultCustomTaskGroupKey}` }).props["aria-expanded"]).toBe(false);
    for (const task of tasks) expect(renderer!.root.findAllByProps({ "data-testid": `task-title-cell-${task.id}` })).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom Default group exposes hover actions, supports rename, and cannot be deleted", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom", status: "all" }, (next) => changes.push(next))); });
  try {
    const actions = renderer!.root.findByProps({ "data-testid": `task-custom-group-actions-${defaultCustomTaskGroupKey}` });
    expect(actions.props.className).toContain("opacity-0");
    expect(actions.props.className).toContain("group-hover/task-group:opacity-100");
    expect(actions.props.className).toContain("focus-within:opacity-100");
    expect(renderer!.root.findByProps({ "data-testid": `task-custom-group-delete-${defaultCustomTaskGroupKey}` }).props.disabled).toBe(true);
    const menu = renderer!.root.findByProps({ "data-testid": `task-custom-group-rename-${defaultCustomTaskGroupKey}` }).parent!;
    expect(menu.props.className).toContain("w-auto");
    expect(menu.props.className).toContain("min-w-32");
    expect(menu.props.className).not.toContain("w-48");

    await act(async () => { renderer!.root.findByProps({ "data-testid": `task-custom-group-rename-${defaultCustomTaskGroupKey}` }).props.onClick(); });
    let input = renderer!.root.findByProps({ "data-testid": "task-custom-group-name-input" });
    expect(input.props.value).toBe("Default group");
    expect(input.props.autoFocus).toBe(true);
    await act(async () => { input.props.onChange({ currentTarget: { value: "Planning" } }); });
    input = renderer!.root.findByProps({ "data-testid": "task-custom-group-name-input" });
    await act(async () => { input.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }); });
    expect(changes.at(-1)?.customGroupName).toBe("Planning");
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom grouping creates a persisted empty group from the trailing action", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  const originalCrypto = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { ...originalCrypto, randomUUID: () => "group-uuid" } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom", status: "all" }, (next) => changes.push(next))); });
  try {
    const trigger = renderer!.root.findByProps({ "data-testid": "task-custom-group-create-trigger" });
    expect(React.Children.toArray(trigger.props.children)).toContain("New group");
    await act(async () => { trigger.props.onClick(); });
    let input = renderer!.root.findByProps({ "data-testid": "task-custom-group-create-input" });
    expect(input.props.placeholder).toBe("Enter group title");
    expect(input.props.autoFocus).toBe(true);
    await act(async () => { input.props.onChange({ currentTarget: { value: "  Planning  " } }); });
    input = renderer!.root.findByProps({ "data-testid": "task-custom-group-create-input" });
    await act(async () => { input.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }); });
    expect(changes.at(-1)?.customGroups).toEqual([{ id: "custom-group-uuid", name: "Planning" }]);
  } finally {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: originalCrypto });
    await act(async () => renderer!.unmount());
  }
});

test("additional custom groups render empty and allow rename and delete", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  const settings = { ...defaultTaskWorkbenchSettings, group: "custom" as const, status: "all" as const, customGroups: [{ id: "custom-planning", name: "Planning" }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(settings, (next) => changes.push(next))); });
  try {
    const toggle = renderer!.root.findByProps({ "data-testid": "task-group-toggle-custom-planning" });
    expect(toggle.findAll((node) => node.props.children === "Planning")).toHaveLength(1);
    expect(toggle.findAll((node) => node.props.children === 0)).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": "task-custom-group-delete-custom-planning" }).props.disabled).toBe(false);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-custom-group-rename-custom-planning" }).props.onClick(); });
    let input = renderer!.root.findByProps({ "data-testid": "task-custom-group-name-input" });
    await act(async () => { input.props.onChange({ currentTarget: { value: "Backlog" } }); });
    input = renderer!.root.findByProps({ "data-testid": "task-custom-group-name-input" });
    await act(async () => { input.props.onKeyDown({ key: "Enter", preventDefault: () => undefined }); });
    expect(changes.at(-1)?.customGroups).toEqual([{ id: "custom-planning", name: "Backlog" }]);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-custom-group-delete-custom-planning" }).props.onClick(); });
    expect(changes.at(-1)?.customGroups).toEqual([]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("quick-created tasks stay assigned to the additional custom group", async () => {
  const changes: typeof defaultTaskWorkbenchSettings[] = [];
  const settings = { ...defaultTaskWorkbenchSettings, group: "custom" as const, status: "all" as const, customGroups: [{ id: "custom-group-two", name: "Group 2" }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench(settings, (next) => changes.push(next), () => undefined, async () => "task_created_in_group_two")); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-group-add-custom-group-two" }).props.onClick(); });
    let row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-custom-group-two" });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "Grouped task" } }); });
    row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-custom-group-two" });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(changes.at(-1)?.customGroupAssignments).toEqual({ task_created_in_group_two: "custom-group-two" });
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom group assignments render tasks in their persisted target group", async () => {
  const assignedTask = { ...tasks[0]!, id: "task_in_group_two", title: "Task in Group 2" };
  const settings = { ...defaultTaskWorkbenchSettings, group: "custom" as const, status: "all" as const, customGroups: [{ id: "custom-group-two", name: "Group 2" }], customGroupAssignments: { task_in_group_two: "custom-group-two" } };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench isTaskList tasks={[assignedTask]} membersByTaskId={{ task_in_group_two: [] }} members={members} lists={lists} settings={settings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />); });
  try {
    const defaultGroup = renderer!.root.findByProps({ "data-testid": `task-group-row-${defaultCustomTaskGroupKey}` });
    const targetGroup = renderer!.root.findByProps({ "data-testid": "task-group-row-custom-group-two" });
    expect(defaultGroup.findByProps({ "data-testid": `task-group-toggle-${defaultCustomTaskGroupKey}` }).findAll((node) => node.props.children === 0)).toHaveLength(1);
    expect(targetGroup.findByProps({ "data-testid": "task-group-toggle-custom-group-two" }).findAll((node) => node.props.children === 1)).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-title-cell-task_in_group_two" })).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom group renders its persisted renamed label", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom", customGroupName: "Planning", status: "all" })); });
  try {
    const toggle = renderer!.root.findByProps({ "data-testid": `task-group-toggle-${defaultCustomTaskGroupKey}` });
    expect(toggle.findAll((node) => node.props.children === "Planning")).toHaveLength(1);
    expect(toggle.findAll((node) => node.props.children === "Default group")).toHaveLength(0);
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom grouping keeps an empty Default group available for creation", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench isTaskList tasks={[]} membersByTaskId={{}} members={members} lists={lists} settings={{ ...defaultTaskWorkbenchSettings, group: "custom" }} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />); });
  try {
    const toggle = renderer!.root.findByProps({ "data-testid": `task-group-toggle-${defaultCustomTaskGroupKey}` });
    expect(toggle.findAll((node) => node.props.children === "Default group")).toHaveLength(1);
    expect(toggle.findAll((node) => node.props.children === 0)).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": `task-group-add-${defaultCustomTaskGroupKey}` })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("custom grouping toolbar creates inside Default group without field defaults", async () => {
  const creates: Array<{ title: string; defaults: Record<string, unknown> }> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom", status: "all" }, () => undefined, () => undefined, async (title, defaults) => { creates.push({ title, defaults }); return true; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    let row = renderer!.root.findByProps({ "data-testid": `task-inline-create-row-group-${defaultCustomTaskGroupKey}` });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "Default grouped task" } }); });
    row = renderer!.root.findByProps({ "data-testid": `task-inline-create-row-group-${defaultCustomTaskGroupKey}` });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(creates).toEqual([{ title: "Default grouped task", defaults: {} }]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("time grouping exposes all buckets and group rows collapse independently", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "due", status: "all" })); });
  try {
    for (const key of ["elapsed", "today", "tomorrow", "next7", "later", "unscheduled"]) {
      expect(renderer!.root.findByProps({ "data-testid": `task-group-toggle-${key}` })).toBeDefined();
    }
    const overdue = renderer!.root.findByProps({ "data-testid": "task-group-toggle-elapsed" });
    expect(overdue.findAll((node) => node.props.children === "Overdue")).toHaveLength(1);
    const unscheduled = renderer!.root.findByProps({ "data-testid": "task-group-toggle-unscheduled" });
    expect(unscheduled.findAll((node) => node.props.children === "Unscheduled")).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" })).toHaveLength(1);
    await act(async () => { overdue.props.onClick(); });
    expect(overdue.props["aria-expanded"]).toBe(false);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" })).toHaveLength(0);
    const today = renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" });
    expect(today.props["aria-expanded"]).toBe(false);
    await act(async () => { today.props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" }).props["aria-expanded"]).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-group-trigger-today" })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("time grouping uses local day boundaries and separates elapsed, seven-day, and later buckets", () => {
  const now = new Date(2026, 10, 5, 15, 0, 0);
  const localIso = (day: number, hour = 12) => new Date(2026, 10, day, hour, 0, 0).toISOString();
  expect(taskTimeGroup(localIso(5, 14), "start", now)).toBe("elapsed");
  expect(taskTimeGroup(localIso(5, 20), "start", now)).toBe("today");
  expect(taskTimeGroup(localIso(6), "due", now)).toBe("tomorrow");
  expect(taskTimeGroup(localIso(12), "due", now)).toBe("next7");
  expect(taskTimeGroup(localIso(13), "due", now)).toBe("later");
  expect(taskTimeGroup(null, "due", now)).toBe("unscheduled");
});

test("group quick-create defaults inherit task list and local time buckets", () => {
  const now = new Date(2026, 10, 5, 15, 0, 0);
  expect(taskGroupCreateDefaults("list", "list_one", now)).toEqual({ listId: "list_one" });
  expect(taskGroupCreateDefaults("due", "unscheduled", now)).toEqual({ dueAt: null });
  expect(taskTimeGroup(taskGroupCreateDefaults("start", "today", now).startAt ?? null, "start", now)).toBe("today");
  expect(taskTimeGroup(taskGroupCreateDefaults("due", "tomorrow", now).dueAt ?? null, "due", now)).toBe("tomorrow");
  expect(taskTimeGroup(taskGroupCreateDefaults("due", "next7", now).dueAt ?? null, "due", now)).toBe("next7");
  expect(taskTimeGroup(taskGroupCreateDefaults("due", "later", now).dueAt ?? null, "due", now)).toBe("later");
});

test("group new-task row submits inherited defaults", async () => {
  const creates: Array<{ title: string; defaults: Record<string, unknown> }> = [];
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "priority", status: "all" }, () => undefined, () => undefined, async (title, defaults) => { creates.push({ title, defaults }); return true; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-group-trigger-high" }).props.onClick(); });
    let row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-high" });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "Grouped task" } }); });
    row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-high" });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(creates).toEqual([{ title: "Grouped task", defaults: { priority: "high" } }]);
  } finally { await act(async () => renderer!.unmount()); }
});

test("group headers expose a hover plus and the Due toolbar draft defaults to Today", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "due", status: "all" })); });
  try {
    const plus = renderer!.root.findByProps({ "data-testid": "task-group-add-tomorrow" });
    expect(plus.props.className).toContain("opacity-0");
    expect(plus.props.className).toContain("group-hover/task-group:opacity-100");
    await act(async () => { plus.props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-tomorrow" }).props["aria-expanded"]).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-tomorrow" })).toBeDefined();

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-tomorrow" }).findByType("input").props.onKeyDown({ key: "Escape", preventDefault: () => undefined }); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    const todayRow = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-today" });
    expect(todayRow.findByType("input").props.autoFocus).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" }).props["aria-expanded"]).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("group header plus inserts first while trailing new task inserts last", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "priority", status: "all" })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-group-add-high" }).props.onClick(); });
    let rows = renderer!.root.findByType("tbody").findAllByType("tr");
    let headerIndex = rows.findIndex((row) => row.props["data-testid"] === "task-group-row-high");
    let draftIndex = rows.findIndex((row) => row.props["data-testid"] === "task-inline-create-row-group-high");
    let taskIndex = rows.findIndex((row) => row.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" }).length > 0);
    expect([headerIndex, draftIndex, taskIndex]).toEqual([0, 1, 2]);
    await act(async () => { rows[draftIndex]!.findByType("input").props.onKeyDown({ key: "Escape", preventDefault: () => undefined }); });

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-group-trigger-high" }).props.onClick(); });
    rows = renderer!.root.findByType("tbody").findAllByType("tr");
    headerIndex = rows.findIndex((row) => row.props["data-testid"] === "task-group-row-high");
    draftIndex = rows.findIndex((row) => row.props["data-testid"] === "task-inline-create-row-group-high");
    taskIndex = rows.findIndex((row) => row.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" }).length > 0);
    expect(headerIndex).toBeLessThan(taskIndex);
    expect(taskIndex).toBeLessThan(draftIndex);
  } finally { await act(async () => renderer!.unmount()); }
});

test("Start grouping toolbar draft defaults to Today", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "start", status: "all" })); });
  try {
    const today = renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" });
    await act(async () => { today.props.onClick(); });
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" }).props["aria-expanded"]).toBe(false);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    const todayRow = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-today" });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-today" }).props["aria-expanded"]).toBe(true);
    expect(todayRow.findByType("input").props.autoFocus).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("toolbar opens an ungrouped draft after restoring a legacy List grouping", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "list", status: "all" })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    const row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-top" });
    expect(row.findByType("input").props.autoFocus).toBe(true);
    expect(row.findAll((node) => node.props.children === "No task list")).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("Creator grouping renders avatar labels, hides per-group create actions, and toolbar creates under self", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={{ ...defaultTaskWorkbenchSettings, group: "creator", status: "all" }} selectedTaskId={null} canLoadMore={false} loadingMore={false} quickCreateMemberId="member_assignee" onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />); });
  try {
    const creatorLabel = renderer!.root.findByProps({ "data-testid": "task-creator-group-label-member_creator" });
    expect(creatorLabel.findAll((node) => node.props.children === "Casey Creator")).toHaveLength(1);
    expect(creatorLabel.findAll((node) => node.props.children === "C").length).toBeGreaterThan(0);
    expect(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-group-add-"))).toHaveLength(0);
    expect(renderer!.root.findAll((node) => typeof node.props["data-testid"] === "string" && node.props["data-testid"].startsWith("task-inline-create-group-trigger-"))).toHaveLength(0);
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-member_assignee" }).props["aria-expanded"]).toBe(true);
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-member_assignee" })).toBeDefined();
  } finally { await act(async () => renderer!.unmount()); }
});

test("Start sort is loaded-client-only and orders null values last", () => {
  const settings = { ...defaultTaskWorkbenchSettings, sort: "start_at" as const, direction: "asc" as const };
  expect(taskWorkbenchServerSort(settings)).toEqual({ sort: "updated_at", direction: "desc" });
  expect(sortLoadedProductTasks(tasks, settings).map((task) => task.id)).toEqual(["task_done", "task_todo_with_full_identifier", "task_canceled"]);
});

test("Completed sort preserves server order unless the legacy fallback is active", () => {
  const settings = { ...defaultTaskWorkbenchSettings, sort: "completed_at" as const, direction: "desc" as const };
  expect(taskWorkbenchServerSort(settings)).toEqual({ sort: "completed_at", direction: "desc" });
  expect(sortLoadedProductTasks(tasks, settings)).toBe(tasks);
  expect(sortLoadedProductTasks(tasks, settings, true).map((task) => task.id)).toEqual(["task_done", "task_todo_with_full_identifier", "task_canceled"]);
});

test("List view displays the task number and copies the exact internal ID", async () => {
  const writes: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { writes.push(value); } } });
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench()); });
  try {
    expect(renderer!.root.findByProps({ title: "task_todo_with_full_identifier" }).props.children).toBe("t100134");
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
    expect(renderer!.root.findAllByProps({ "data-testid": "task-filter-overdue-toggle" })).toHaveLength(0);
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

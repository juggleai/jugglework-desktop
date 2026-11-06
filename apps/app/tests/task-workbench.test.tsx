import { afterAll, expect, mock, spyOn, test } from "bun:test";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import type { DenOrganizationMember, DenProductTask, DenProductTaskCompletionPolicy, DenProductTaskList } from "../src/app/lib/den";

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
import { defaultTaskWorkbenchSettings } from "../src/react-app/domains/tasks/task-view-state";
import { TaskWorkbench, sortLoadedProductTasks, taskWorkbenchServerSort } from "../src/react-app/domains/tasks/task-workbench";
import { defaultCustomTaskGroupKey, taskGroupCreateDefaults, taskTimeGroup } from "../src/react-app/domains/tasks/task-list-table";

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

function workbench(settings = defaultTaskWorkbenchSettings, onSettingsChange = () => undefined, onTransition = () => undefined, onQuickCreate = async () => true, onAssigneesChange?: (task: DenProductTask, memberIds: string[]) => Promise<boolean>, onCompletionPolicyChange?: (task: DenProductTask, policy: DenProductTaskCompletionPolicy) => Promise<boolean>) {
  return <TaskWorkbench tasks={tasks} membersByTaskId={membersByTaskId} members={members} lists={lists} settings={settings} selectedTaskId={null} canLoadMore={false} loadingMore={false} quickCreateMemberId="member_assignee" onLoadMore={() => undefined} onSettingsChange={onSettingsChange} onSelect={() => undefined} onTransition={onTransition} onQuickCreate={onQuickCreate} onAssigneesChange={onAssigneesChange} onCompletionPolicyChange={onCompletionPolicyChange} />;
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
    for (const label of ["Assignee", "Start time", "Due time", "Creator", "Created time", "Task ID", "Priority", "Task list", "Alex Assignee", "Casey Creator", "Launch"]) {
      expect(renderer!.root.findAll((node) => node.props.children === label).length).toBeGreaterThan(0);
    }
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
  } finally { await act(async () => renderer!.unmount()); }
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
    await act(async () => { search.props.onChange({ currentTarget: { value: "alex" } }); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_assignee" })).toHaveLength(1);
    expect(renderer!.root.findAllByProps({ "data-testid": "task-assignee-option-task_todo_with_full_identifier-member_creator" })).toHaveLength(0);
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
    expect(all.findByType("input").props.checked).toBe(false);
    await act(async () => { all.findByType("input").props.onChange(); });
    expect(changes).toEqual(["all_assignees"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-any_assignee" }).findByType("input").props.checked).toBe(true);
    shouldSave = true;
    all = renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-all_assignees" });
    await act(async () => { all.findByType("input").props.onChange(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-completion-policy-task_todo_with_full_identifier-all_assignees" }).findByType("input").props.checked).toBe(true);
  } finally { await act(async () => renderer!.unmount()); }
});

test("all-assignees rows show the current assignee completion without transitioning again", async () => {
  const transitions: string[] = [];
  const allTasks = [{ ...tasks[0]!, completionPolicy: "all_assignees" as const }];
  const allMembers = { [allTasks[0]!.id]: [{ memberId: "member_assignee", role: "assignee" as const, completedAt: "2026-11-03T10:00:00Z" }] };
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={allTasks} membersByTaskId={allMembers} members={members} lists={lists} settings={defaultTaskWorkbenchSettings} selectedTaskId={null} canLoadMore={false} loadingMore={false} quickCreateMemberId="member_assignee" onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={(_task, operation) => transitions.push(operation)} />); });
  try {
    const button = renderer!.root.findByProps({ "aria-label": "Your part is complete" });
    expect(button.props.disabled).toBe(true);
    await act(async () => { button.props.onClick(); });
    expect(transitions).toEqual([]);
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
    const updatedRows = renderer!.root.findByType("tbody").findAllByType("tr");
    expect(updatedRows.at(-2)?.props["data-testid"]).toBe("task-inline-create-row-bottom");
    expect(updatedRows.at(-1)?.findByProps({ "data-testid": "task-inline-create-bottom-trigger" })).toBeDefined();
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
    await act(async () => { input.props.onBlur(); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-row-bottom" })).toHaveLength(0);
    expect(titles).toEqual([]);

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-bottom-trigger" }).props.onClick(); });
    input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => { input.props.onChange({ target: { value: "  Blur task  " } }); });
    input = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input");
    await act(async () => { input.props.onBlur(); input.props.onBlur(); });
    expect(titles).toEqual(["Blur task"]);
    expect(renderer!.root.findByProps({ "data-testid": "task-inline-create-row-bottom" }).findByType("input").props.disabled).toBe(true);
    await act(async () => { resolveCreate?.(true); });
    expect(renderer!.root.findAllByProps({ "data-testid": "task-inline-create-row-bottom" })).toHaveLength(0);
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
    const completedTaskRow = renderer!.root.find((node) => node.type === "button" && node.props.children === "Review brief").parent?.parent?.parent;
    expect(headerText(completedTaskRow!.findAllByType("td")[3]!)).not.toBe("Unavailable");
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
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-list_one" }).findAll((node) => node.props.children === "Launch")).toHaveLength(1);
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-" }).findAll((node) => node.props.children === "No task list")).toHaveLength(1);
  } finally { await act(async () => renderer!.unmount()); }
});

test("group menu places Custom group immediately after None", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "custom" })); });
  try {
    const menu = renderer!.root.findByProps({ "data-testid": "task-group-menu" });
    expect(menu.findAll((node) => node.type === "button" && typeof node.props.value === "string").map((node) => node.props.value)).toEqual(["none", "custom", "list", "creator", "start", "due"]);
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
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={[assignedTask]} membersByTaskId={{ task_in_group_two: [] }} members={members} lists={lists} settings={settings} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />); });
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
  await act(async () => { renderer = TestRenderer.create(<TaskWorkbench tasks={[]} membersByTaskId={{}} members={members} lists={lists} settings={{ ...defaultTaskWorkbenchSettings, group: "custom" }} selectedTaskId={null} canLoadMore={false} loadingMore={false} onLoadMore={() => undefined} onSettingsChange={() => undefined} onSelect={() => undefined} onTransition={() => undefined} onQuickCreate={async () => true} />); });
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
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "list", status: "all" }, () => undefined, () => undefined, async (title, defaults) => { creates.push({ title, defaults }); return true; })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-group-trigger-list_one" }).props.onClick(); });
    let row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-list_one" });
    await act(async () => { row.findByType("input").props.onChange({ target: { value: "Grouped task" } }); });
    row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-list_one" });
    await act(async () => { row.findByType("form").props.onSubmit({ preventDefault: () => undefined }); });
    expect(creates).toEqual([{ title: "Grouped task", defaults: { listId: "list_one" } }]);
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
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "list", status: "all" })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-group-add-list_one" }).props.onClick(); });
    let rows = renderer!.root.findByType("tbody").findAllByType("tr");
    let headerIndex = rows.findIndex((row) => row.props["data-testid"] === "task-group-row-list_one");
    let draftIndex = rows.findIndex((row) => row.props["data-testid"] === "task-inline-create-row-group-list_one");
    let taskIndex = rows.findIndex((row) => row.findAllByProps({ "data-testid": "task-title-cell-task_todo_with_full_identifier" }).length > 0);
    expect([headerIndex, draftIndex, taskIndex]).toEqual([0, 1, 2]);
    await act(async () => { rows[draftIndex]!.findByType("input").props.onKeyDown({ key: "Escape", preventDefault: () => undefined }); });

    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-group-trigger-list_one" }).props.onClick(); });
    rows = renderer!.root.findByType("tbody").findAllByType("tr");
    headerIndex = rows.findIndex((row) => row.props["data-testid"] === "task-group-row-list_one");
    draftIndex = rows.findIndex((row) => row.props["data-testid"] === "task-inline-create-row-group-list_one");
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

test("Task-list grouping toolbar draft defaults to No task list", async () => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(workbench({ ...defaultTaskWorkbenchSettings, group: "list", status: "all" })); });
  try {
    await act(async () => { renderer!.root.findByProps({ "data-testid": "task-inline-create-top-trigger" }).props.onClick(); });
    expect(renderer!.root.findByProps({ "data-testid": "task-group-toggle-" }).props["aria-expanded"]).toBe(true);
    const row = renderer!.root.findByProps({ "data-testid": "task-inline-create-row-group-" });
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

test("Completed sort is loaded-client-only for older servers and orders null values last", () => {
  const settings = { ...defaultTaskWorkbenchSettings, sort: "completed_at" as const, direction: "desc" as const };
  expect(taskWorkbenchServerSort(settings)).toEqual({ sort: "updated_at", direction: "desc" });
  expect(sortLoadedProductTasks(tasks, settings).map((task) => task.id)).toEqual(["task_done", "task_todo_with_full_identifier", "task_canceled"]);
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

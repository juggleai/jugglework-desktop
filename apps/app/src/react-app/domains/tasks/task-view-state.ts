import type { DenProductTaskPriority } from "@/app/lib/den";
import { productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type TaskWorkbenchSection = "assigned" | "following" | "all" | "created" | "delegated" | "completed";

export type TaskWorkbenchView = "list" | "board";
export type TaskWorkbenchStatus = "incomplete" | "completed" | "all";
export const taskTimeSorts = ["start_at", "due_at", "created_at", "updated_at", "completed_at"] as const;
export type TaskWorkbenchTimeSort = (typeof taskTimeSorts)[number];
export type TaskWorkbenchSort = "manual" | TaskWorkbenchTimeSort;
type TaskManualFetchOrder = { sort: Exclude<TaskWorkbenchTimeSort, "start_at">; direction: "asc" | "desc" };

function isTaskTimeSort(value: unknown): value is TaskWorkbenchTimeSort {
  return taskTimeSorts.some((sort) => sort === value);
}
const taskWorkbenchGroups = ["none", "custom", "list", "creator", "start", "due", "priority"] as const;
export type TaskWorkbenchGroup = (typeof taskWorkbenchGroups)[number];

export type TaskWorkbenchCapabilities = { allowCustomGrouping: boolean; allowSubtaskVisibility: boolean; allowManualSort: boolean };

export function taskWorkbenchCapabilities(section: TaskWorkbenchSection | null | undefined, isTaskList: boolean): TaskWorkbenchCapabilities {
  const allowCustomGrouping = isTaskList || section === "assigned" || section === "following";
  return { allowCustomGrouping, allowSubtaskVisibility: !allowCustomGrouping, allowManualSort: allowCustomGrouping };
}

export function taskWorkbenchGroupForView(group: TaskWorkbenchGroup, view: TaskWorkbenchView, allowCustomGrouping: boolean): TaskWorkbenchGroup {
  if (view === "list" && group === "list") return "none";
  const availableGroup = !allowCustomGrouping && group === "custom" ? "none" : group;
  if (view === "board" && availableGroup === "none") return allowCustomGrouping ? "custom" : "priority";
  return availableGroup;
}

function isTaskWorkbenchGroup(value: unknown): value is TaskWorkbenchGroup {
  return taskWorkbenchGroups.some((group) => group === value);
}
export type TaskWorkbenchField = "assignee" | "start" | "due" | "creator" | "assigner" | "followers" | "created" | "completed" | "updated" | "id" | "priority" | "list";
export type TaskPersonFilterOperator = "contains" | "not_contains" | "empty" | "not_empty";
export type TaskCustomGroup = { id: string; name: string };
export type TaskWorkbenchSettings = {
  view: TaskWorkbenchView;
  status: TaskWorkbenchStatus;
  priorities: DenProductTaskPriority[];
  listIds: string[];
  assigneeMemberIds: string[];
  assigneeMemberOperator: TaskPersonFilterOperator;
  assignerMemberIds: string[];
  assignerMemberOperator: TaskPersonFilterOperator;
  creatorMemberIds: string[];
  creatorMemberOperator: TaskPersonFilterOperator;
  followerMemberIds: string[];
  followerMemberOperator: TaskPersonFilterOperator;
  overdue: boolean;
  sort: TaskWorkbenchSort;
  direction: "asc" | "desc";
  manualOrder: string[];
  manualFetchOrder?: TaskManualFetchOrder;
  group: TaskWorkbenchGroup;
  subtaskVisibility: "show" | "hide";
  customGroupName: string;
  customGroups: TaskCustomGroup[];
  customGroupAssignments: Record<string, string>;
  fieldOrder: TaskWorkbenchField[];
  fields: TaskWorkbenchField[];
};

export const taskWorkbenchFields: TaskWorkbenchField[] = ["assignee", "start", "due", "creator", "assigner", "followers", "created", "completed", "updated", "id", "priority", "list"];
export const defaultVisibleTaskWorkbenchFields: TaskWorkbenchField[] = ["assignee", "start", "due", "creator", "created", "id", "priority", "list"];
const legacyDefaultTaskWorkbenchFields: TaskWorkbenchField[] = ["creator", "created", "id", "list"];

export function reorderTaskWorkbenchFields(order: TaskWorkbenchField[], source: TaskWorkbenchField, target: TaskWorkbenchField): TaskWorkbenchField[] {
  if (source === target) return order;
  const sourceIndex = order.indexOf(source);
  const targetIndex = order.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return order;
  const next = [...order];
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, source);
  return next;
}

export type TaskOrderPlacement = "before" | "after";

export function moveTaskWithinGroup(visible: string[], siblings: string[], source: string, anchor: string, placement: TaskOrderPlacement) {
  const from = siblings.indexOf(source);
  const to = siblings.indexOf(anchor);
  if (from < 0 || to < 0 || from === to || (placement === "before" ? from === to - 1 : from === to + 1)) return visible;
  const reordered = siblings.filter((id) => id !== source);
  reordered.splice(reordered.indexOf(anchor) + (placement === "after" ? 1 : 0), 0, source);
  const siblingIds = new Set(siblings);
  let index = 0;
  // Keep the other groups in place, even when their tasks are interleaved in the root sequence.
  return visible.map((id) => siblingIds.has(id) ? reordered[index++]! : id);
}

export function mergeTaskManualOrder(saved: string[], visible: string[]) {
  const visibleIds = new Set(visible);
  let index = 0;
  // Replace only the visible slots; filtered or unloaded tasks keep their relative order.
  const next = saved.map((id) => visibleIds.has(id) ? visible[index++]! : id);
  return next.concat(visible.slice(index));
}

export const defaultTaskWorkbenchSettings: TaskWorkbenchSettings = {
  view: "list",
  status: "incomplete",
  priorities: [],
  listIds: [],
  assigneeMemberIds: [],
  assigneeMemberOperator: "contains",
  assignerMemberIds: [],
  assignerMemberOperator: "contains",
  creatorMemberIds: [],
  creatorMemberOperator: "contains",
  followerMemberIds: [],
  followerMemberOperator: "contains",
  overdue: false,
  sort: "updated_at",
  direction: "desc",
  manualOrder: [],
  group: "none",
  subtaskVisibility: "show",
  customGroupName: "",
  customGroups: [],
  customGroupAssignments: {},
  fieldOrder: taskWorkbenchFields,
  fields: defaultVisibleTaskWorkbenchFields,
};

export const taskWorkbenchSections: TaskWorkbenchSection[] = ["assigned", "following", "all", "created", "delegated", "completed"];

export function isTaskWorkbenchSection(section: string): section is TaskWorkbenchSection {
  return taskWorkbenchSections.includes(section as TaskWorkbenchSection);
}

export function defaultTaskWorkbenchSettingsForSection(section: TaskWorkbenchSection): TaskWorkbenchSettings {
  if (section === "completed") return { ...defaultTaskWorkbenchSettings, status: "completed", sort: "completed_at" };
  if (section === "all") return { ...defaultTaskWorkbenchSettings, status: "all", sort: "due_at" };
  if (section === "created" || section === "delegated") return { ...defaultTaskWorkbenchSettings, sort: "due_at" };
  return defaultTaskWorkbenchSettings;
}

export function taskSectionDefaultSettings(section: TaskWorkbenchSection, currentMemberId: string | null, settings = defaultTaskWorkbenchSettingsForSection(section)): TaskWorkbenchSettings {
  const memberIds = currentMemberId ? [currentMemberId] : [];
  const next: TaskWorkbenchSettings = {
    ...settings,
    status: section === "all" ? "all" : section === "completed" ? "completed" : "incomplete",
    overdue: false,
    assigneeMemberIds: [],
    assigneeMemberOperator: "contains",
    assignerMemberIds: [],
    assignerMemberOperator: "contains",
    creatorMemberIds: [],
    creatorMemberOperator: "contains",
    followerMemberIds: [],
    followerMemberOperator: "contains",
  };
  if (section === "assigned") return { ...next, assigneeMemberIds: memberIds };
  if (section === "following") return {
    ...next,
    followerMemberIds: memberIds,
    creatorMemberIds: memberIds,
    creatorMemberOperator: "not_contains",
    assigneeMemberIds: memberIds,
    assigneeMemberOperator: "not_contains",
  };
  if (section === "created") return { ...next, creatorMemberIds: memberIds };
  if (section === "delegated") return {
    ...next,
    assigneeMemberIds: memberIds,
    assigneeMemberOperator: "not_contains",
    assignerMemberIds: memberIds,
  };
  return next;
}

function normalizeTaskWorkbenchFieldOrder(value: unknown): TaskWorkbenchField[] {
  if (!Array.isArray(value)) return taskWorkbenchFields;
  const persisted = [...new Set(value.filter((item): item is TaskWorkbenchField => taskWorkbenchFields.includes(item as TaskWorkbenchField)))];
  const next = [...persisted];
  for (const field of taskWorkbenchFields) {
    if (next.includes(field)) continue;
    if (field === "priority" && next.includes("list")) next.splice(next.indexOf("list"), 0, field);
    else next.push(field);
  }
  return next;
}

function normalizeTaskWorkbenchFields(value: unknown, fieldOrder: TaskWorkbenchField[], migrateLegacyDefault: boolean, migratePriority: boolean): TaskWorkbenchField[] {
  if (!Array.isArray(value)) return defaultVisibleTaskWorkbenchFields;
  const selected = new Set(value.filter((item): item is TaskWorkbenchField => taskWorkbenchFields.includes(item as TaskWorkbenchField)));
  const legacyFields = fieldOrder.filter((field) => selected.has(field));
  if (migrateLegacyDefault && legacyFields.length === legacyDefaultTaskWorkbenchFields.length && legacyDefaultTaskWorkbenchFields.every((field, index) => legacyFields[index] === field)) return defaultVisibleTaskWorkbenchFields;
  if (migratePriority && selected.has("list")) selected.add("priority");
  const fields = fieldOrder.filter((field) => selected.has(field));
  return fields;
}

function normalizeTaskCustomGroups(value: unknown): TaskCustomGroup[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const groups: TaskCustomGroup[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<TaskCustomGroup>;
    const id = typeof candidate.id === "string" ? candidate.id.trim().slice(0, 100) : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 80) : "";
    if (!id || !name || id === "custom-default" || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name });
  }
  return groups.slice(0, 100);
}

function normalizeTaskCustomGroupAssignments(value: unknown, groups: TaskCustomGroup[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const groupIds = new Set(groups.map((group) => group.id));
  const assignments: Record<string, string> = {};
  for (const [taskId, groupId] of Object.entries(value)) {
    if (taskId && typeof groupId === "string" && groupIds.has(groupId)) assignments[taskId] = groupId;
  }
  return assignments;
}

export function taskWorkbenchStorageKey(scope: ProductTaskScope | null, section: TaskWorkbenchSection = "assigned", listId?: string | null): string {
	return `jugglework:tasks:workbench:${productTaskScopeKey(scope)}:${listId ? `list:${listId}` : section}`;
}

export function readTaskWorkbenchSettings(scope: ProductTaskScope | null, section: TaskWorkbenchSection = "assigned", listId?: string | null): TaskWorkbenchSettings {
	const defaults = listId ? { ...defaultTaskWorkbenchSettings, group: "custom" as const } : defaultTaskWorkbenchSettingsForSection(section);
	if (typeof localStorage === "undefined") return defaults;
	try {
		const value = JSON.parse(localStorage.getItem(taskWorkbenchStorageKey(scope, section, listId)) ?? "null") as Partial<TaskWorkbenchSettings> | null;
		if (!value || typeof value !== "object") return defaults;
    const priorities = Array.isArray(value.priorities) ? [...new Set(value.priorities.filter((item): item is DenProductTaskPriority => ["none", "low", "medium", "high"].includes(String(item))))] : [];
    const listIds = Array.isArray(value.listIds) ? [...new Set(value.listIds.filter((item): item is string => typeof item === "string"))] : [];
    const memberIds = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
    const memberOperator = (input: unknown): TaskPersonFilterOperator => input === "not_contains" || input === "empty" || input === "not_empty" ? input : "contains";
    const fieldOrder = normalizeTaskWorkbenchFieldOrder(value.fieldOrder);
    const fields = normalizeTaskWorkbenchFields(value.fields, fieldOrder, !Array.isArray(value.fieldOrder), !Array.isArray(value.fieldOrder) || !value.fieldOrder.includes("priority"));
    const status = value.status === "completed" || value.status === "all" ? value.status : "incomplete";
    const customGroups = normalizeTaskCustomGroups(value.customGroups);
    const view = value.view === "board" ? "board" : "list";
    const group = isTaskWorkbenchGroup(value.group) ? value.group : defaults.group;
    const { allowCustomGrouping, allowSubtaskVisibility, allowManualSort } = taskWorkbenchCapabilities(section, Boolean(listId));
    const fetchOrder: { sort?: unknown; direction?: unknown } | undefined = value.manualFetchOrder;
    const manualFetchOrder: TaskManualFetchOrder | undefined = allowManualSort && isTaskTimeSort(fetchOrder?.sort) && fetchOrder.sort !== "start_at" && (fetchOrder.direction === "asc" || fetchOrder.direction === "desc") ? { sort: fetchOrder.sort, direction: fetchOrder.direction } : undefined;
    return {
      view,
      status,
      priorities,
      listIds,
      assigneeMemberIds: memberIds(value.assigneeMemberIds),
      assigneeMemberOperator: memberOperator(value.assigneeMemberOperator),
      assignerMemberIds: memberIds(value.assignerMemberIds),
      assignerMemberOperator: memberOperator(value.assignerMemberOperator),
      creatorMemberIds: memberIds(value.creatorMemberIds),
      creatorMemberOperator: memberOperator(value.creatorMemberOperator),
      followerMemberIds: memberIds(value.followerMemberIds),
      followerMemberOperator: memberOperator(value.followerMemberOperator),
      overdue: status !== "completed" && value.overdue === true,
      sort: (allowManualSort && value.sort === "manual") || isTaskTimeSort(value.sort) ? value.sort : defaults.sort,
      direction: value.direction === "asc" || value.direction === "desc" ? value.direction : defaults.direction,
      manualOrder: allowManualSort ? memberIds(value.manualOrder) : [],
      ...(manualFetchOrder ? { manualFetchOrder } : {}),
      group: taskWorkbenchGroupForView(group, view, allowCustomGrouping),
      subtaskVisibility: allowSubtaskVisibility && value.subtaskVisibility === "hide" ? "hide" : "show",
      customGroupName: typeof value.customGroupName === "string" ? value.customGroupName.trim().slice(0, 80) : "",
      customGroups,
      customGroupAssignments: normalizeTaskCustomGroupAssignments(value.customGroupAssignments, customGroups),
      fieldOrder,
      fields,
    };
	} catch {
		return defaults;
	}
}

export function writeTaskWorkbenchSettings(scope: ProductTaskScope | null, settings: TaskWorkbenchSettings, section: TaskWorkbenchSection = "assigned", listId?: string | null): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(taskWorkbenchStorageKey(scope, section, listId), JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in hardened renderer contexts; settings remain usable in memory.
  }
}

export function removeTaskWorkbenchSettings(scope: ProductTaskScope | null, section: TaskWorkbenchSection = "assigned", listId?: string | null): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.removeItem(taskWorkbenchStorageKey(scope, section, listId));
	} catch {
		// Storage can be unavailable in hardened renderer contexts.
	}
}

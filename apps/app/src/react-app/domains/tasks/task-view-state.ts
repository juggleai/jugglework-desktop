import type { DenProductTaskPriority } from "@/app/lib/den";
import { productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type TaskWorkbenchView = "list" | "board";
export type TaskWorkbenchStatus = "incomplete" | "completed" | "all";
export type TaskWorkbenchSort = "updated_at" | "created_at" | "start_at" | "due_at" | "completed_at";
export type TaskWorkbenchGroup = "none" | "custom" | "list" | "creator" | "start" | "due";
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
  group: TaskWorkbenchGroup;
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
  group: "none",
  customGroupName: "",
  customGroups: [],
  customGroupAssignments: {},
  fieldOrder: taskWorkbenchFields,
  fields: defaultVisibleTaskWorkbenchFields,
};

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

export function taskWorkbenchStorageKey(scope: ProductTaskScope | null): string {
  return `jugglework:tasks:workbench:${productTaskScopeKey(scope)}:assigned`;
}

export function readTaskWorkbenchSettings(scope: ProductTaskScope | null): TaskWorkbenchSettings {
  if (typeof localStorage === "undefined") return defaultTaskWorkbenchSettings;
  try {
    const value = JSON.parse(localStorage.getItem(taskWorkbenchStorageKey(scope)) ?? "null") as Partial<TaskWorkbenchSettings> | null;
    if (!value || typeof value !== "object") return defaultTaskWorkbenchSettings;
    const priorities = Array.isArray(value.priorities) ? [...new Set(value.priorities.filter((item): item is DenProductTaskPriority => ["none", "low", "medium", "high"].includes(String(item))))] : [];
    const listIds = Array.isArray(value.listIds) ? [...new Set(value.listIds.filter((item): item is string => typeof item === "string"))] : [];
    const memberIds = (input: unknown) => Array.isArray(input) ? [...new Set(input.filter((item): item is string => typeof item === "string" && item.length > 0))] : [];
    const memberOperator = (input: unknown): TaskPersonFilterOperator => input === "not_contains" || input === "empty" || input === "not_empty" ? input : "contains";
    const fieldOrder = normalizeTaskWorkbenchFieldOrder(value.fieldOrder);
    const fields = normalizeTaskWorkbenchFields(value.fields, fieldOrder, !Array.isArray(value.fieldOrder), !Array.isArray(value.fieldOrder) || !value.fieldOrder.includes("priority"));
    const status = value.status === "completed" || value.status === "all" ? value.status : "incomplete";
    const customGroups = normalizeTaskCustomGroups(value.customGroups);
    return {
      view: value.view === "board" ? "board" : "list",
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
      sort: ["updated_at", "created_at", "start_at", "due_at", "completed_at"].includes(String(value.sort)) ? value.sort as TaskWorkbenchSort : "updated_at",
      direction: value.direction === "asc" ? "asc" : "desc",
      group: value.group === "custom" || value.group === "list" || value.group === "creator" || value.group === "start" || value.group === "due" ? value.group : "none",
      customGroupName: typeof value.customGroupName === "string" ? value.customGroupName.trim().slice(0, 80) : "",
      customGroups,
      customGroupAssignments: normalizeTaskCustomGroupAssignments(value.customGroupAssignments, customGroups),
      fieldOrder,
      fields,
    };
  } catch {
    return defaultTaskWorkbenchSettings;
  }
}

export function writeTaskWorkbenchSettings(scope: ProductTaskScope | null, settings: TaskWorkbenchSettings): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(taskWorkbenchStorageKey(scope), JSON.stringify(settings));
  } catch {
    // Storage can be unavailable in hardened renderer contexts; settings remain usable in memory.
  }
}

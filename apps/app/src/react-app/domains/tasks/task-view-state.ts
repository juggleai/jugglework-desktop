import type { DenProductTaskPriority } from "@/app/lib/den";
import { productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type TaskWorkbenchView = "list" | "board";
export type TaskWorkbenchStatus = "incomplete" | "completed" | "all";
export type TaskWorkbenchSort = "updated_at" | "created_at" | "start_at" | "due_at" | "priority";
export type TaskWorkbenchGroup = "none" | "list" | "creator";
export type TaskWorkbenchField = "assignee" | "start" | "due" | "creator" | "created" | "id" | "list";
export type TaskWorkbenchSettings = {
  view: TaskWorkbenchView;
  status: TaskWorkbenchStatus;
  priorities: DenProductTaskPriority[];
  listIds: string[];
  overdue: boolean;
  sort: TaskWorkbenchSort;
  direction: "asc" | "desc";
  group: TaskWorkbenchGroup;
  fields: TaskWorkbenchField[];
};

export const taskWorkbenchFields: TaskWorkbenchField[] = ["assignee", "start", "due", "creator", "created", "id", "list"];
export const defaultTaskWorkbenchSettings: TaskWorkbenchSettings = {
  view: "list",
  status: "incomplete",
  priorities: [],
  listIds: [],
  overdue: false,
  sort: "updated_at",
  direction: "desc",
  group: "none",
  fields: ["creator", "created", "id", "list"],
};

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
    const fields = Array.isArray(value.fields) ? [...new Set(value.fields.filter((item): item is TaskWorkbenchField => taskWorkbenchFields.includes(item as TaskWorkbenchField)))] : taskWorkbenchFields;
    const status = value.status === "completed" || value.status === "all" ? value.status : "incomplete";
    return {
      view: value.view === "board" ? "board" : "list",
      status,
      priorities,
      listIds,
      overdue: status !== "completed" && value.overdue === true,
      sort: ["updated_at", "created_at", "start_at", "due_at", "priority"].includes(String(value.sort)) ? value.sort as TaskWorkbenchSort : "updated_at",
      direction: value.direction === "asc" ? "asc" : "desc",
      group: value.group === "list" || value.group === "creator" ? value.group : "none",
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

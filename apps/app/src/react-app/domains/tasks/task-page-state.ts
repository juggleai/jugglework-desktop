import type { DenProductTask, DenProductTaskUpdateInput, DenProductTaskView } from "@/app/lib/den";
import { productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type TaskSection = Exclude<DenProductTaskView, "inbox" | "trash"> | "activity";
export type ProductTaskEditDraft = {
  taskId: string;
  title: string;
  description: string;
  expectedVersion: number;
};

const TASK_SECTIONS: TaskSection[] = ["today", "assigned", "following", "activity", "all", "created", "delegated", "completed"];

export function taskSectionStorageKey(scope: ProductTaskScope | null): string {
  if (!scope) return "jugglework:tasks:section:anonymous";
  return `jugglework:tasks:section:${productTaskScopeKey(scope)}`;
}

export function readTaskSection(scope: ProductTaskScope | null): TaskSection {
  if (typeof sessionStorage === "undefined") return "today";
  const key = taskSectionStorageKey(scope);
  const value = sessionStorage.getItem(key);
  if (TASK_SECTIONS.some((section) => section === value)) return value as TaskSection;
  if (value !== null) sessionStorage.setItem(key, "today");
  return "today";
}

export function writeTaskSection(scope: ProductTaskScope | null, section: TaskSection): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(taskSectionStorageKey(scope), section);
}

export function productTaskEditDraft(taskId: string, patch: DenProductTaskUpdateInput): ProductTaskEditDraft {
  return {
    taskId,
    title: patch.title ?? "",
    description: patch.description ?? "",
    expectedVersion: patch.expectedVersion,
  };
}

export function reapplyProductTaskDraft(task: DenProductTask, draft: ProductTaskEditDraft | null): ProductTaskEditDraft {
  if (!draft || draft.taskId !== task.id) {
    return { taskId: task.id, title: task.title, description: task.description, expectedVersion: task.version };
  }
  return { ...draft, expectedVersion: task.version };
}

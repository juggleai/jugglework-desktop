import type { DenProductTask, DenProductTaskUpdateInput, DenProductTaskView } from "@/app/lib/den";
import { productTaskScopeKey, type ProductTaskScope } from "./task-queries";

export type TaskSection = DenProductTaskView | "activity" | "archived";
export type ProductTaskEditDraft = {
  taskId: string;
  title: string;
  description: string;
  expectedVersion: number;
};

const TASK_SECTIONS: TaskSection[] = ["today", "inbox", "assigned", "created", "following", "activity", "all", "completed", "trash", "archived"];

export function taskSectionStorageKey(scope: ProductTaskScope | null): string {
  if (!scope) return "jugglework:tasks:section:anonymous";
  return `jugglework:tasks:section:${productTaskScopeKey(scope)}`;
}

export function readTaskSection(scope: ProductTaskScope | null): TaskSection {
  if (typeof sessionStorage === "undefined") return "today";
  const value = sessionStorage.getItem(taskSectionStorageKey(scope));
  return TASK_SECTIONS.some((section) => section === value) ? value as TaskSection : "today";
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

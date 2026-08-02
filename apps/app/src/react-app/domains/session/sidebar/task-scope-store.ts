/**
 * Which task list the home sidebar shows: local workspaces or cloud (remote)
 * ones. Kept outside the sidebar tree because the navigation rail switches it
 * from surfaces where the sidebar is not mounted (Settings / Chat / Apps).
 */
import { create } from "zustand";

import type { WorkspaceInfo } from "../../../../app/lib/desktop";

export type TaskScope = "local" | "remote";

type TaskScopeStore = {
  scope: TaskScope;
  setScope: (scope: TaskScope) => void;
};

export const useTaskScopeStore = create<TaskScopeStore>((set) => ({
  scope: "local",
  setScope: (scope) => set((current) => (current.scope === scope ? current : { scope })),
}));

export function useTaskScope(): TaskScope {
  return useTaskScopeStore((state) => state.scope);
}

export function setTaskScope(scope: TaskScope) {
  useTaskScopeStore.getState().setScope(scope);
}

export function workspaceTaskScope(workspace: WorkspaceInfo): TaskScope {
  return workspace.workspaceType === "remote" ? "remote" : "local";
}

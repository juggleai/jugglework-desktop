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
  /** Last workspace visited per scope, so switching the rail scope returns
   * the user to where they were instead of the first workspace in the list. */
  lastWorkspaceByScope: Record<TaskScope, string | null>;
  rememberWorkspace: (scope: TaskScope, workspaceId: string) => void;
};

export const useTaskScopeStore = create<TaskScopeStore>((set) => ({
  scope: "local",
  setScope: (scope) => set((current) => (current.scope === scope ? current : { scope })),
  lastWorkspaceByScope: { local: null, remote: null },
  rememberWorkspace: (scope, workspaceId) => set((current) => {
    const id = workspaceId.trim();
    if (!id || current.lastWorkspaceByScope[scope] === id) return current;
    return { lastWorkspaceByScope: { ...current.lastWorkspaceByScope, [scope]: id } };
  }),
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

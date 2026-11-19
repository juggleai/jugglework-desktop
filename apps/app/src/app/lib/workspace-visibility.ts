import type { WorkspaceWire } from "@jugglework/types/workspace";

/** 内部文件助手可精确寻址，不作为普通工作区入口或自动恢复目标。 */
export function isOrdinaryWorkspace(workspace: Pick<WorkspaceWire, "fileAssistantManaged" | "hidden">): boolean {
  return !workspace.fileAssistantManaged && !workspace.hidden;
}

export function ordinaryWorkspaceId<T extends Pick<WorkspaceWire, "id" | "fileAssistantManaged" | "hidden">>(workspaces: T[], ...preferred: Array<string | null | undefined>): string {
  const visible = workspaces.filter(isOrdinaryWorkspace);
  return preferred.find((id) => visible.some((workspace) => workspace.id === id)) || visible[0]?.id || "";
}

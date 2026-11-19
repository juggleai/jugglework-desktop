import type { FileWindowState } from "@jugglework/types/file-window";

/** 将单来源测试场景发布为 Main 的逐标签 DTO。 */
export function singleSourceState(input: Pick<FileWindowState, "workspaceId" | "sessionId" | "workspaceRoot" | "platform" | "activePath" | "recent" | "conversation" | "local" | "appearance"> & { tabs: Array<{ path: string; name: string }> }): FileWindowState {
  const source = { workspaceId: input.workspaceId, sessionId: input.sessionId, workspaceRoot: input.workspaceRoot };
  return {
    ...input,
    group: { kind: "conversation", workspaceId: input.workspaceId, sessionId: input.sessionId },
    activeTabId: input.activePath,
    tabs: input.tabs.map((tab) => ({ ...tab, tabId: tab.path, source, conversation: input.conversation })),
  };
}

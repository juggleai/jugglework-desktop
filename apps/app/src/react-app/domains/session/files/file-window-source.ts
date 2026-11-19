import type { FileWindowSource, FileWindowState } from "@jugglework/types/file-window";

/** 同来源标签共享聊天状态，文件路径和活动标签不参与聊天身份。 */
export function fileWindowSourceKey(source: FileWindowSource): string {
  return JSON.stringify([source.workspaceId, source.sessionId, source.workspaceRoot]);
}

export function activeFileWindowTab(state: FileWindowState | null) {
  return state?.tabs.find((tab) => tab.tabId === state.activeTabId);
}

/** 顶层字段只是 Main 的兼容投影；renderer 始终以活动标签的固定来源为准。 */
export function projectFileWindowSource(state: FileWindowState): FileWindowState {
  const tab = activeFileWindowTab(state);
  return {
    ...state,
    workspaceId: tab?.source.workspaceId ?? "",
    sessionId: tab?.source.sessionId ?? "",
    workspaceRoot: tab?.source.workspaceRoot ?? "",
    activePath: tab?.path ?? null,
    conversation: tab?.conversation,
  };
}

import type { FileWindowConversationOptions } from "@jugglework/types/file-window";
import type { LocalPreferences } from "./local-provider";
import { readSessionAgentChoice } from "./session-agent-store";
import { readSessionChoices, resolveSessionModelChoice } from "./session-model-store";

/**
 * 读取目标会话的开窗快照，复用聊天的选择规则，不写入偏好或会话。
 * @param workspaceId 文件所属工作区
 * @param sessionId 文件所属会话，不依赖当前聚焦会话
 * @param prefs 主 App 当前内存中的默认模型及档位
 */
export function readFileWindowConversationOptions(
  workspaceId: string,
  sessionId: string,
  prefs: Pick<LocalPreferences, "defaultModel" | "modelVariant">,
): FileWindowConversationOptions {
  const { model, variant } = resolveSessionModelChoice({
    choices: readSessionChoices(workspaceId),
    sessionId,
    defaultModel: prefs.defaultModel,
    defaultVariant: prefs.modelVariant ?? null,
  });
  return {
    model: model ? { providerID: model.providerID, modelID: model.modelID } : null,
    agent: readSessionAgentChoice(workspaceId, sessionId),
    variant,
  };
}

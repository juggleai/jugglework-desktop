import type { DynamicToolUIPart, ToolUIPart, UIMessage } from "ai"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isGlobToolPart,
  isGrepToolPart,
  isLspToolPart,
  isQuestionToolPart,
  isReadToolPart,
  isSkillToolPart,
  isTaskToolPart,
  isTodoWriteToolPart,
  isWebFetchToolPart,
  isWebSearchToolPart,
  isWriteToolPart,
} from "@/lib/build-in-tools"
import { t } from "@/i18n"
import { collectToolParts, isToolPartInFlight } from "@/lib/tool-activity"

type AnyToolPart = ToolUIPart | DynamicToolUIPart

/**
 * 助手当前正在做的事，取值可枚举。
 *
 * TIPS: 此前底部只有一个渐变球加固定的「Thinking…」，无论在跑命令还是在写文件都一样。
 * 这里把在途工具的种类与阶段映射成具体动作，`responding` 作为兜底。
 */
export type LiveActivityKind =
  | "responding"
  | "thinking"
  | "command_preparing"
  | "command_running"
  | "writing_file"
  | "editing_file"
  | "reading_file"
  | "searching_files"
  | "searching_web"
  | "reading_web"
  | "loading_skill"
  | "updating_plan"
  | "inspecting_code"
  | "asking"
  | "delegating"
  | "tool_calling"

/**
 * 由在途工具推断动作
 * @param part 在途的工具 part
 * @returns 动作种类
 */
function toolActivityKind(part: AnyToolPart): LiveActivityKind {
  // input-streaming 表示模型还在生成调用参数，尚未真正执行。
  const preparing = part.state === "input-streaming"
  if (isBashToolPart(part)) return preparing ? "command_preparing" : "command_running"
  if (isWriteToolPart(part)) return "writing_file"
  if (isEditToolPart(part) || isApplyPatchToolPart(part)) return "editing_file"
  if (isReadToolPart(part)) return "reading_file"
  if (isGrepToolPart(part) || isGlobToolPart(part)) return "searching_files"
  if (isWebSearchToolPart(part)) return "searching_web"
  if (isWebFetchToolPart(part)) return "reading_web"
  if (isSkillToolPart(part)) return "loading_skill"
  if (isTodoWriteToolPart(part)) return "updating_plan"
  if (isLspToolPart(part)) return "inspecting_code"
  if (isQuestionToolPart(part)) return "asking"
  if (isTaskToolPart(part)) return "delegating"
  return "tool_calling"
}

/**
 * 是否有正在流式输出的推理内容
 * @param messages 当前会话消息
 * @returns 最后一条助手消息里是否有 streaming 状态的 reasoning part
 */
function hasStreamingReasoning(messages: UIMessage[]): boolean {
  const last = messages.at(-1)
  if (!last || last.role !== "assistant") return false
  return last.parts.some((part) => part.type === "reasoning" && part.state === "streaming")
}

/**
 * 推断助手当前的实时动作
 *
 * TIPS: 在途工具优先级最高（取最后一个，即最新发起的那次调用）；
 * 其次是推理流；都没有就落到「生成回复中」。
 * @param messages 当前会话消息
 * @returns 动作种类
 */
export function getLiveActivityKind(messages: UIMessage[]): LiveActivityKind {
  const toolParts = collectToolParts(messages)
  for (let index = toolParts.length - 1; index >= 0; index -= 1) {
    const part = toolParts[index]
    if (part && isToolPartInFlight(part)) return toolActivityKind(part)
  }
  if (hasStreamingReasoning(messages)) return "thinking"
  return "responding"
}

/**
 * 动作的展示文案
 * @param kind 动作种类
 * @returns 已本地化的文案
 */
export function liveActivityLabel(kind: LiveActivityKind): string {
  return t(`live_activity.${kind}`)
}

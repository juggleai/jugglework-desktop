import type { DynamicToolUIPart, ToolUIPart } from "ai"
import {
  Bot,
  BookOpen,
  FilePen,
  Globe,
  KeyRound,
  ListTodo,
  MessageCircleQuestion,
  Search,
  Sparkles,
  SquareCode,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react"
import {
  isApplyPatchToolPart,
  isBashToolPart,
  isEditToolPart,
  isEnvVarRequestToolPart,
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

type AnyToolPart = ToolUIPart | DynamicToolUIPart

/** 按工具类型选择行首图标；未识别的工具（如 MCP）使用扳手。 */
export function toolIcon(part: AnyToolPart): LucideIcon {
  if (isBashToolPart(part)) return SquareTerminal
  if (isReadToolPart(part)) return BookOpen
  if (isEditToolPart(part) || isWriteToolPart(part) || isApplyPatchToolPart(part)) return FilePen
  if (isGrepToolPart(part) || isGlobToolPart(part) || isWebSearchToolPart(part)) return Search
  if (isWebFetchToolPart(part)) return Globe
  if (isLspToolPart(part)) return SquareCode
  if (isSkillToolPart(part)) return Sparkles
  if (isTodoWriteToolPart(part)) return ListTodo
  if (isQuestionToolPart(part)) return MessageCircleQuestion
  if (isEnvVarRequestToolPart(part)) return KeyRound
  if (isTaskToolPart(part)) return Bot
  return Wrench
}

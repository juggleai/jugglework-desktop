import { getLiveActivityKind, liveActivityLabel } from "@/lib/live-activity";
import { formatToolProgressSummary, getToolActivitySummary } from "@/lib/tool-activity";
import { splitAssistantTaskMessages } from "@/components/chat/utils";
import { redactSensitiveReasoning } from "@/components/chat/reasoning-redaction";
import type { UIMessage } from "ai";
import type { TodoItem } from "@/app/types";
import { SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX, SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "@/app/types";
import { analyzeRunCompletion } from "../sync/run-completion-diagnostics";
import { getSessionActivityStatusLabel, type SessionActivityRecord } from "./session-activity-store";

/** 当前真实用户轮次及会话原有状态的展示投影，供聊天和桌面宠物共用。 */
export function sessionTaskPresentation(messages: UIMessage[], todos: TodoItem[], activity?: SessionActivityRecord) {
  const userIndex = messages.findLastIndex((message) => message.role === "user");
  const turnCreatedAt = (messages[userIndex]?.metadata as { opencode?: { created?: number } } | undefined)?.opencode?.created;
  const turn = messages.slice(userIndex + 1).filter((message) => !message.id.startsWith(SYNTHETIC_RUN_DIAGNOSTIC_MESSAGE_PREFIX));
  const failed = turn.some((message) => message.id.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX));
  const active = Boolean(activity?.runActive || activity?.compacting);
  const waiting = Boolean(activity?.waitingPermissionIds.length || activity?.waitingQuestionIds.length);
  const incomplete = !active && !waiting && Boolean(analyzeRunCompletion(messages, todos, { finishReason: activity?.finishReason }));
  const status = waiting ? "waiting" : activity?.status ?? "idle";
  const { processItems, summaryItems } = splitAssistantTaskMessages(turn.map((message, index) => ({ message, index })), active);
  const process = processItems.map((item) => item.message);
  const authored = process.some((message) => message.parts.some((part) => part.type === "text" && part.text.trim()));
  const summary = authored ? null : getToolActivitySummary(process);
  // TIPS: 卡片只展示面向用户的正文和可观察进度；reasoning不能作为任务摘要兜底。
  const lastText = process.flatMap((message) => message.parts).findLast((part) => part.type === "text" && part.text.trim());
  const actualProgress = summary ? formatToolProgressSummary(liveActivityLabel(getLiveActivityKind(process)), summary)
    : lastText?.type === "text" ? redactSensitiveReasoning(lastText.text).trim().split("\n")[0] : undefined;
  const openTodo = todos.find((todo) => todo.status === "in_progress") ?? todos.find((todo) => todo.status === "pending");
  const resumable = !active && !waiting && (incomplete || failed || (userIndex >= 0 && !turn.some((message) => message.role === "assistant")) || Boolean(activity?.errorActive || activity?.completionBlocked));
  const terminal = turn.findLast((message) => message.role === "assistant");
  const metadata = (terminal?.metadata as { opencode?: { finish?: string; completed?: number; stopped?: boolean } } | undefined)?.opencode;
  const stopped = !active && !waiting && (metadata?.stopped === true || activity?.finishReason === "user_cancelled");
  // TIPS: 空闲不是成功证据；绿色完成标记须有当前轮真实输出及明确结束信息，失败/待继续优先。
  const responseText = summaryItems.flatMap((item) => item.message.parts).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
  const completed = userIndex >= 0 && !active && !waiting && !resumable && Boolean(responseText) &&
    (metadata?.finish === "stop" || typeof metadata?.completed === "number" || activity?.finishReason === "stop");
  return {
    turnKey: messages[userIndex]?.id ?? "",
    turnCreatedAt,
    active, waiting, resumable, completed, stopped,
    responseText: completed ? responseText : undefined,
    statusText: active && (status === "thinking" || status === "responding") && turn.length ? liveActivityLabel(getLiveActivityKind(turn)) : getSessionActivityStatusLabel(status),
    progressText: actualProgress || openTodo?.content,
  };
}

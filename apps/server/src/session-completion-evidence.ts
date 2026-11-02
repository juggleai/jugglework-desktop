/**
 * 从本轮最新 assistant 读取终态证据；调用方仍须确认引擎及委派任务已空闲。
 * @param messages 引擎持久化消息，不使用 UI 自报状态；普通工具错误不构成终态
 * @param startedAt 当前宿主运行开始时间
 */
export function currentRunTerminalStatus(messages: unknown, startedAt: number): "completed" | "failed" | "aborted" | null {
  if (!Array.isArray(messages)) return null;
  const assistants = messages.filter((message) => message?.info?.role === "assistant");
  const latestMessage = assistants.sort((a, b) => (a.info.time?.created ?? 0) - (b.info.time?.created ?? 0)).at(-1);
  const latest = latestMessage?.info;
  if (!latest || latest.summary === true || typeof latest.time?.created !== "number" || latest.time.created < startedAt) return null;
  // TIPS: OpenCode 的 provider 错误可能没有 completed 时间；仅接受本轮顶层 assistant 的明确错误身份。
  if (typeof latest.error?.name === "string" && latest.error.name.trim())
    return latest.error.name === "MessageAbortedError" ? "aborted" : "failed";
  // TIPS: 固定版本引擎在用户拒绝权限后只持久化此工具错误并转 idle，不产生 assistant.error/final。
  // 只接纳精确的原生拒绝标记，且本轮全部工具已结束；普通失败、旧错误及仍在执行的工具不能释放运行。
  if (!latest.error && latest.finish === "tool-calls" && typeof latest.time?.completed === "number") {
    const parts: Array<{ type?: string; state?: { status?: string; error?: unknown; time?: { end?: number } } }> =
      Array.isArray(latestMessage.parts) ? latestMessage.parts : [];
    const tools = parts.filter((part) => part?.type === "tool");
    if (tools.length && tools.every((part) => part.state?.status === "completed" || part.state?.status === "error") &&
        tools.some((part) => part.state?.status === "error" &&
          part.state.error === "The user rejected permission to use this specific tool call." &&
          typeof part.state.time?.end === "number" && part.state.time.end >= startedAt)) return "aborted";
  }
  return !latest.error &&
    typeof latest.time?.completed === "number" &&
    (latest.finish === "stop" || latest.finish === "end_turn") ? "completed" : null;
}

/** 仅成功终态证明完成；错误证据不能被上层解释为成功回复。 */
export function hasCurrentRunFinalResponse(messages: unknown, startedAt: number): boolean {
  return currentRunTerminalStatus(messages, startedAt) === "completed";
}

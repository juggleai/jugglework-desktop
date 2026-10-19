import { JuggleWorkServerError } from "@/app/lib/jugglework-server";

export function isSessionBusyError(error: unknown): error is JuggleWorkServerError {
  return error instanceof JuggleWorkServerError && error.status === 409 && error.code === "session_busy";
}

export function effectiveSessionRunning(input: {
  sending: boolean;
  liveStatus: string;
  activityRunActive: boolean;
  activityRunEnded: boolean;
  coordinatorActive: boolean;
  activityTerminalFailure?: boolean;
}): boolean {
  if (input.sending) return true;
  if (input.coordinatorActive && !input.activityTerminalFailure) return true;
  // A plain engine idle may be a delegation/turn boundary. Explicit failure
  // still ends the local presentation while its server receipt reconciles.
  if (input.activityRunEnded) return false;
  return input.activityRunActive || input.coordinatorActive ||
    input.liveStatus === "busy" || input.liveStatus === "retry";
}

/**
 * 判断中止请求失败后是否应向用户报告错误。
 *
 * @param input.abortRequested 引擎是否已接受中止请求
 * @param input.activeRunsRefreshSucceeded 权威运行列表是否刷新成功
 * @param input.coordinatorActive 刷新后当前会话是否仍有活动运行
 * @returns 仅在无法确认运行已结束时返回 true
 */
export function shouldReportAbortFailure(input: {
  abortRequested: boolean;
  activeRunsRefreshSucceeded: boolean;
  coordinatorActive: boolean;
}): boolean {
  if (input.abortRequested) return false;
  return !input.activeRunsRefreshSucceeded || input.coordinatorActive;
}

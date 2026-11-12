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

export type EffectiveThreadStatus = "submitted" | "streaming" | "retrying" | "ready";

/**
 * Keep transcript activity aligned with the composer controls. A coordinator
 * receipt can be the only surviving proof of a run after switching sessions
 * or missing the initial runtime event, so `liveStatus` alone is insufficient.
 */
export function effectiveThreadStatus(input: {
  sending: boolean;
  liveStatus: string;
  running: boolean;
}): EffectiveThreadStatus {
  if (input.sending) return "submitted";
  if (input.liveStatus === "retry") return "retrying";
  if (input.running) return "streaming";
  return "ready";
}

/**
 * The server-owned active-run list stopped reporting a run that the local
 * projection still treats as running. The terminal `session.idle` event may
 * have been lost, so the authoritative snapshot must be read now instead of
 * waiting for the next periodic reconciliation. The snapshot decides the
 * final state; a run-list gap alone never forces idle, because a delegated
 * turn boundary can briefly drop the run from the list.
 */
export function shouldReconcileAfterCoordinatorEnded(input: {
  activeRunsSucceeded: boolean;
  previousCoordinatorActive: boolean;
  coordinatorActive: boolean;
  liveStatus: string;
  activityRunActive: boolean;
}): boolean {
  if (!input.activeRunsSucceeded || input.coordinatorActive || !input.previousCoordinatorActive) return false;
  return input.liveStatus === "busy" || input.liveStatus === "retry" || input.activityRunActive;
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

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
 * Recover a renderer that retained busy/retry after the durable coordinator
 * had already disappeared. The snapshot must have completed no earlier than
 * the active-run read so an old pre-dispatch idle snapshot cannot cancel a new
 * run that has not reached the coordinator response yet.
 */
export function shouldSettleStaleRunProjection(input: {
  activeRunsSucceeded: boolean;
  coordinatorActive: boolean;
  snapshotStatus: string | null;
  snapshotUpdatedAt: number;
  activeRunsUpdatedAt: number;
  sending: boolean;
  liveStatus: string;
  activityRunActive: boolean;
}): boolean {
  if (!input.activeRunsSucceeded || input.coordinatorActive || input.sending) return false;
  if (input.snapshotStatus !== "idle") return false;
  if (input.snapshotUpdatedAt < input.activeRunsUpdatedAt) return false;
  return input.activityRunActive || input.liveStatus === "busy" || input.liveStatus === "retry";
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

/** How long Stop may stay pending before the renderer re-reads authoritative state. */
export const STOP_RECONCILE_TIMEOUT_MS = 5_000;

/**
 * Decide what a Stop that has been pending too long should do. The renderer
 * must not trust a busy projection that the server and the latest snapshot no
 * longer back: it drops the pending state and lets the normal recovery effect
 * run against fresh reads.
 *
 * @param input.pendingForMs how long the abort request has been outstanding
 * @returns `wait` while still inside the window, otherwise `reconcile`
 */
export function stopReconcileAction(input: { pendingForMs: number }): "wait" | "reconcile" {
  return input.pendingForMs >= STOP_RECONCILE_TIMEOUT_MS ? "reconcile" : "wait";
}

/**
 * Whether a Stop click should start a new abort. A second click while one is
 * outstanding would only stack identical requests, so it is ignored.
 */
export function canStartStop(input: { chatStreaming: boolean; stopPending: boolean }): boolean {
  return input.chatStreaming && !input.stopPending;
}

/**
 * Run one Stop at a time. Repeat calls while one is outstanding are dropped,
 * and if it is still unresolved after `timeoutMs` the `onTimeout` reconcile
 * fires once so the caller can re-read authoritative state.
 *
 * @returns `false` when the call was dropped because a Stop was already running
 */
export function createStopGuard(options: {
  timeoutMs?: number;
  onPendingChange?: (pending: boolean) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}) {
  const timeoutMs = options.timeoutMs ?? STOP_RECONCILE_TIMEOUT_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  let pending = false;
  return {
    isPending: () => pending,
    async run(input: { chatStreaming: boolean; abort: () => Promise<void>; onTimeout: () => void }): Promise<boolean> {
      if (!canStartStop({ chatStreaming: input.chatStreaming, stopPending: pending })) return false;
      pending = true;
      options.onPendingChange?.(true);
      const timer = setTimer(input.onTimeout, timeoutMs);
      try {
        await input.abort();
      } finally {
        clearTimer(timer);
        pending = false;
        options.onPendingChange?.(false);
      }
      return true;
    },
  };
}

export type SessionMcpMaintenanceCompletion =
  | { status: "ok" }
  | { status: "error"; detail: string }
  | { status: "timed_out" };

export type SessionMcpMaintenanceRun = {
  started: boolean;
  completion: SessionMcpMaintenanceCompletion;
};

export type SessionMcpResumeWaitResult =
  | { outcome: "not_running" | "ready" }
  | { outcome: "failed"; detail: string }
  | { outcome: "timed_out" };

type MaintenanceEntry = {
  token: symbol;
  promise: Promise<SessionMcpMaintenanceCompletion>;
};

const maintenanceByTarget = new Map<string, MaintenanceEntry>();
const resumeMaintenanceByTarget = new Map<string, Promise<SessionMcpMaintenanceCompletion>>();

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 以 Singleflight 方式执行工作区 MCP 维护任务
 * @param input.targetKey 维护目标唯一键
 * @param input.task 实际维护任务
 * @param input.timeoutMs 单次维护超时时间
 * @returns 是否由当前调用启动，以及共享任务的最终结果
 */
export async function runSessionMcpMaintenanceSingleflight(input: {
  targetKey: string;
  task: () => Promise<void>;
  timeoutMs: number;
}): Promise<SessionMcpMaintenanceRun> {
  const existing = maintenanceByTarget.get(input.targetKey);
  if (existing) {
    return { started: false, completion: await existing.promise };
  }

  const token = Symbol("session-mcp-maintenance-run");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SessionMcpMaintenanceCompletion>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed_out" }), input.timeoutMs);
  });
  const task = Promise.resolve()
    .then(input.task)
    .then<SessionMcpMaintenanceCompletion>(() => ({ status: "ok" }))
    .catch<SessionMcpMaintenanceCompletion>((error: unknown) => ({
      status: "error",
      detail: errorDetail(error),
    }));
  const promise = Promise.race([task, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (maintenanceByTarget.get(input.targetKey)?.token === token) {
      maintenanceByTarget.delete(input.targetKey);
    }
  });
  maintenanceByTarget.set(input.targetKey, { token, promise });
  return { started: true, completion: await promise };
}

/**
 * 将页面恢复触发的维护任务登记为发送屏障
 * @param targetKey 维护目标唯一键
 * @param task 当前恢复维护任务
 */
export function trackSessionMcpResumeMaintenance(
  targetKey: string,
  task: Promise<SessionMcpMaintenanceRun>,
): void {
  const completion = task.then((result) => result.completion);
  resumeMaintenanceByTarget.set(targetKey, completion);
  void completion.finally(() => {
    if (resumeMaintenanceByTarget.get(targetKey) === completion) {
      resumeMaintenanceByTarget.delete(targetKey);
    }
  });
}

/**
 * 等待当前页面恢复维护任务，不主动发起额外探活
 * @param targetKey 维护目标唯一键
 * @param timeoutMs 发送最多等待时长
 * @returns 当前恢复任务的等待结果
 */
export async function waitForSessionMcpResumeMaintenance(
  targetKey: string,
  timeoutMs: number,
): Promise<SessionMcpResumeWaitResult> {
  const active = resumeMaintenanceByTarget.get(targetKey);
  if (!active) return { outcome: "not_running" };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SessionMcpResumeWaitResult>((resolve) => {
    timer = setTimeout(() => resolve({ outcome: "timed_out" }), timeoutMs);
  });
  try {
    return await Promise.race([
      active.then<SessionMcpResumeWaitResult>((completion) => {
        if (completion.status === "ok") return { outcome: "ready" };
        if (completion.status === "timed_out") return { outcome: "timed_out" };
        return { outcome: "failed", detail: completion.detail };
      }),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 创建页面重新可见时的维护触发器
 * @param input.visibilityState 获取当前页面可见状态
 * @param input.run 触发恢复维护
 * @returns visibilitychange 事件处理函数
 */
export function createSessionMcpVisibilityResumeHandler(input: {
  visibilityState: () => DocumentVisibilityState;
  run: () => void;
}): () => void {
  return () => {
    if (input.visibilityState() === "visible") input.run();
  };
}

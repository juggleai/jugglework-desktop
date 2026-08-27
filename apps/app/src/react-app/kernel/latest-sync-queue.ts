export type LatestSyncQueue<Reason> = {
  run: (reason: Reason) => Promise<void>;
};

/**
 * 串行执行同步任务，并将执行期间收到的重复请求合并为最后一次尾随任务。
 * @param task 接收最新原因并执行一次同步的异步任务
 * @returns 可供多个调用方共享并等待完整尾随同步的队列
 */
export function createLatestSyncQueue<Reason>(
  task: (reason: Reason) => Promise<void>,
): LatestSyncQueue<Reason> {
  let inFlight: Promise<void> | null = null;
  let queuedReason: Reason | null = null;

  const run = (reason: Reason): Promise<void> => {
    queuedReason = reason;
    if (inFlight) return inFlight;

    const request = (async () => {
      while (queuedReason !== null) {
        const currentReason = queuedReason;
        queuedReason = null;
        await task(currentReason);
      }
    })();

    inFlight = request.finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { run };
}

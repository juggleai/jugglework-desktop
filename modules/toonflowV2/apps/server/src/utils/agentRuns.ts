import { AsyncLocalStorage } from "node:async_hooks";
import { isAbsolute, normalize } from "node:path";

type Run = { directory: string; controller: AbortController; done: Promise<void>; finish(): void; tasks: Set<Promise<unknown>>; errors: unknown[]; failure?: unknown };
// One module instance per authenticated sidecar generation/workspace. Retained
// records make repeated stop idempotent and preserve cleanup failures.
const context = new AsyncLocalStorage<Run>();
const runs = new Map<string, Run>();

function identity(runId: string, directory: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId) || directory.length > 4096 || !isAbsolute(directory) || normalize(directory) !== directory || directory.includes("\0")) throw Object.assign(new Error("Agent run 标识或规范目录无效"), { status: 400 });
  return runId.toLowerCase();
}

function createRun(directory: string): Run {
  let finish = () => {};
  const done = new Promise<void>(resolve => { finish = resolve; });
  return { directory, controller: new AbortController(), done, finish, tasks: new Set(), errors: [] };
}

function reserve(id: string, run: Run) {
  // Never evict used IDs in this sidecar generation: late starts cannot reuse
  // an expired cancellation. Bound memory and fail closed until restart.
  if (runs.size >= 4096) throw Object.assign(new Error("Agent run 标识已达上限，请重新打开漫剧工厂"), { status: 409 });
  runs.set(id, run);
}

export function trackAgentCleanup<T>(operation: () => Promise<T>): Promise<T> {
  const run = context.getStore();
  const task = operation();
  if (run) {
    run.tasks.add(task);
    void task.catch(error => { if (run.controller.signal.aborted && error !== run.controller.signal.reason) run.errors.push(error); }).finally(() => run.tasks.delete(task));
  }
  return task;
}

export function agentRunSignal(signal?: AbortSignal) {
  const run = context.getStore();
  return run ? AbortSignal.any([run.controller.signal, ...(signal ? [signal] : [])]) : signal;
}

export async function runAgentRequest(runId: string, directory: string, operation: (signal: AbortSignal) => Promise<void>) {
  const id = identity(runId, directory);
  const previous = runs.get(id);
  if (previous) throw Object.assign(new Error(previous.controller.signal.aborted ? "Agent run 已取消" : "Agent run 标识不可复用"), { status: 409 });
  const run = createRun(directory);
  reserve(id, run); // Before the first await, including workspace/model lookup.
  try {
    await context.run(run, async () => {
      run.controller.signal.throwIfAborted();
      await operation(run.controller.signal);
    });
  } catch (error) {
    if (error !== run.controller.signal.reason) run.failure = error;
    throw error;
  } finally {
    while (run.tasks.size) await Promise.allSettled([...run.tasks]);
    if (run.errors.length) run.failure = new AggregateError(run.errors, "Agent 工具清理失败");
    run.finish();
    if (run.failure && run.controller.signal.aborted) throw run.failure;
  }
}

export async function cancelAgentRequest(runId: string, directory: string) {
  const id = identity(runId, directory);
  let run = runs.get(id);
  if (run && run.directory !== directory) throw Object.assign(new Error("Agent run 不属于此项目"), { status: 403 });
  if (!run) {
    run = createRun(directory);
    reserve(id, run);
    context.run(run, () => run!.controller.abort(new Error("Agent run 已取消")));
    run.finish();
  } else context.run(run, () => run!.controller.abort(new Error("Agent run 已取消")));
  await run.done;
  if (run.failure) throw run.failure;
  return { settled: true };
}

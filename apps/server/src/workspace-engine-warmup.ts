import type { ServerConfig, WorkspaceInfo } from "./types.js";

/**
 * 预热一个本地工作区目录在引擎中的实例。
 *
 * 引擎是单进程多目录：第一次请求某个目录时才会为它初始化实例（读配置、加载插件）。
 * 实测新目录的首次请求要几秒（3.9 到 14.5 秒不等），并且云同步、MCP 注册、
 * `provider.list` 会同时打到这个还在初始化的目录上，互相拖慢甚至触发 10 秒超时。
 *
 * 这里在工作区创建/激活后，于后台发一次只读的 `GET /config`，让实例先初始化；
 * 之后的请求命中的是已经就绪的实例。
 *
 * 约束：
 * - 只读，不 dispose，不会中止运行中的任务。
 * - 同一目录的预热合并为一次（单飞），并在冷却时间内不重复发起。
 * - 永不抛错、不阻塞调用方；失败只记录，后续真实请求仍按原路径初始化。
 * - 只预热一个目录，不对其他工作区做预热（避免提前占用内存）。
 */
export type WarmFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  body?: { cancel: () => Promise<unknown> } | null;
}>;

export type WarmResult = "warmed" | "skipped" | "failed";

export type WarmupOptions = {
  fetchImpl: WarmFetch;
  /** 解析目录；返回 null 表示该工作区不适合预热（远程、无目录）。 */
  resolveTarget: (config: ServerConfig, workspace: WorkspaceInfo) => {
    baseUrl: string;
    directory: string;
    headers: Record<string, string>;
  } | null;
  now?: () => number;
  timeoutMs?: number;
  cooldownMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_COOLDOWN_MS = 60_000;

export function createWorkspaceEngineWarmup(options: WarmupOptions) {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const inflight = new Map<string, Promise<WarmResult>>();
  const lastWarmedAt = new Map<string, number>();

  async function run(key: string, target: NonNullable<ReturnType<WarmupOptions["resolveTarget"]>>): Promise<WarmResult> {
    try {
      const url = new URL(target.baseUrl);
      url.pathname = "/config";
      url.search = "";
      url.searchParams.set("directory", target.directory);
      const response = await options.fetchImpl(url.toString(), {
        headers: target.headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel();
      if (!response.ok) return "failed";
      lastWarmedAt.set(key, now());
      return "warmed";
    } catch {
      return "failed";
    }
  }

  return {
    /**
     * 触发预热并立即返回（不等待结果）。需要等待时使用返回的 Promise。
     */
    warm(config: ServerConfig, workspace: WorkspaceInfo): Promise<WarmResult> {
      let target: ReturnType<WarmupOptions["resolveTarget"]> = null;
      try {
        target = options.resolveTarget(config, workspace);
      } catch {
        return Promise.resolve("skipped");
      }
      if (!target) return Promise.resolve("skipped");

      const key = `${target.baseUrl}\n${target.directory}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const last = lastWarmedAt.get(key);
      if (last !== undefined && now() - last < cooldownMs) return Promise.resolve("skipped");

      const task = run(key, target).finally(() => { inflight.delete(key); });
      inflight.set(key, task);
      return task;
    },
    /** 引擎被 dispose / 重启后，之前的预热不再代表实例就绪。 */
    forget(config: ServerConfig, workspace: WorkspaceInfo): void {
      try {
        const target = options.resolveTarget(config, workspace);
        if (target) lastWarmedAt.delete(`${target.baseUrl}\n${target.directory}`);
      } catch {
        // 无法解析目标时没有可遗忘的预热记录。
      }
    },
  };
}

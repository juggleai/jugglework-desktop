import { ApiError } from "../errors.js";
import type { AutomationEventTrigger } from "@jugglework/types/automation";

/**
 * 到 jugglework-server 事件中继 API 的边界。
 *
 * TIPS: 这是桌面端到 `jugglework-server`（`add-github-event-trigger-relay` 变更）的网络边界。
 * 那一侧的 `/api/v1/automations/github-*` 端点在本次改动里同步实现（见 jugglework-server 仓库），
 * 认证凭据的注入点是 `resolveAuth`——它读取的是当前登录会话已经持有的云端 token，具体接线依赖
 * 已有的登录/会话状态存取逻辑，不在这个模块内重复实现。未配置（`resolveAuth` 返回 null，例如
 * 用户尚未登录云端账号）时，所有方法优雅返回“未就绪”结果，而不是抛出让调用方处理不完的错误。
 */
export type GithubEventRelayAuth = { baseUrl: string; token: string };

/** 一次运行期 GitHub App 写回授权；`token`/`expiresAt` 不落库，只在这次 run 的进程内存活期使用。 */
export type GithubAppWriteBackGrant = { token: string; expiresAt: number };

export type GithubEventRelayClient = {
  listRepositories(): Promise<Array<{ connectorId: string; owner: string; name: string; visibility: "public" | "private" }>>;
  checkReadiness(repo: { owner: string; name: string }): Promise<"not_connected" | "pending_configuration" | "ready">;
  requestInstall(): Promise<void>;
  requestBind(repo: { owner: string; name: string }): Promise<void>;
  estimateFrequency(trigger: AutomationEventTrigger): Promise<number | null>;
  /**
   * 换取一次运行期写回授权，见服务端 PRD §4.8。
   * TIPS: 每次调用都是独立铸造，调用方（executor 的 preflight）必须在每一轮触发（含会话延续
   * 的每一轮）都重新调用，不能缓存上一轮的结果——这是这条能力设计上的核心约束，不是可选项。
   */
  fetchWriteBackGrant(automationId: string, repo: { owner: string; name: string }): Promise<GithubAppWriteBackGrant>;
};

export function createGithubEventRelayClient(
  resolveAuth: () => Promise<GithubEventRelayAuth | null>,
  fetchImpl: typeof fetch = fetch,
): GithubEventRelayClient {
  async function relay<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const auth = await resolveAuth();
    if (!auth) throw new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session");
    const response = await fetchImpl(`${auth.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) throw new ApiError(response.status, "github_event_relay_error", `GitHub event relay returned ${response.status}`);
    return response.json() as Promise<T>;
  }

  return {
    listRepositories: () => relay<{ items: Array<{ connectorId: string; owner: string; name: string; visibility: "public" | "private" }> }>(
      "/api/v1/automations/github-repositories",
    ).then((response) => response.items),
    checkReadiness: (repo) => relay<{ state: "not_connected" | "pending_configuration" | "ready" }>(
      `/api/v1/automations/github-readiness?repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`,
    ).then((response) => response.state),
    requestInstall: () => relay("/api/v1/automations/github-install-request", { method: "POST" }).then(() => undefined),
    requestBind: (repo) => relay("/api/v1/automations/github-repository-bind", { method: "POST", body: repo }).then(() => undefined),
    estimateFrequency: (trigger) => relay<{ perWeek: number | null }>(
      "/api/v1/automations/github-event-frequency", { method: "POST", body: trigger },
    ).then((response) => response.perWeek),
    fetchWriteBackGrant: (automationId, repo) => relay<GithubAppWriteBackGrant>(
      "/api/v1/automations/github-app-grant", { method: "POST", body: { automationId, repo } },
    ),
  };
}

/**
 * 未配置 relay（例如尚未接线云端会话）时的兜底实现。
 * TIPS: 就绪态一律返回 `not_connected`，仓库列表返回空，行为上等价于"组织还没连接 GitHub 事件能力"，
 * 这跟真的未装 App 时应该展示的引导文案一致，不需要在 UI 层区分"relay 未接线"和"App 真的没装"。
 */
export function createUnconfiguredGithubEventRelayClient(): GithubEventRelayClient {
  return {
    listRepositories: () => Promise.resolve([]),
    checkReadiness: () => Promise.resolve("not_connected"),
    requestInstall: () => Promise.resolve(),
    requestBind: () => Promise.resolve(),
    estimateFrequency: () => Promise.resolve(null),
    fetchWriteBackGrant: () => Promise.reject(new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session")),
  };
}

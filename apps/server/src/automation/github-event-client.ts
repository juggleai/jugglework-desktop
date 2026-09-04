import { ApiError } from "../errors.js";
import type { AutomationEventTrigger } from "@jugglework/types/automation";

/**
 * 到 jugglework-server 事件中继 API 的边界。
 *
 * TIPS: 这是桌面端到 `jugglework-server`（`add-github-event-trigger-relay` 变更）的网络边界。
 * 那一侧的 `/api/v1/automations/github-*` 端点已经在 jugglework-server 仓库实现并测试过——
 * 这个文件的每一次 HTTP 调用形状（路径/方法/请求体/响应体）都是对着那一侧真实源码核对过的，
 * 不是猜的契约。认证凭据的注入点是 `resolveAuth`——它读取的是当前登录会话已经持有的云端 token
 * 加上设备 agent token，具体接线依赖已有的登录/会话状态存取逻辑，不在这个模块内重复实现。
 * `resolveAuth` 的两半（session token / 设备 agent token）都已经在真实运行时接线并实测过，
 * 见 `server.ts`（`githubEventAuthStore` + `resolveGithubEventAuthFromEnv`）和 openspec 变更
 * `add-event-triggered-automation` 的 tasks.md 3.1。
 * 未配置（`resolveAuth` 返回 null，例如用户尚未登录云端账号）时，所有方法优雅返回"未就绪"结果，
 * 而不是抛出让调用方处理不完的错误。
 */
export type GithubEventRelayAuth = {
  baseUrl: string;
  token: string;
  /**
   * 设备 agent token（`X-JuggleWork-Desktop-Agent-Token`）——jugglework-server 的投递
   * 轮询/认领/写回授权铸造这几个"设备"接口都要求这个头，跟 `token`（session bearer）是
   * 两个独立凭据。缺失时这几个方法直接拒绝，不悄悄发一个注定 401 的请求。
   */
  agentToken?: string;
};

/** 一次运行期 GitHub App 写回授权；`token`/`expiresAt` 不落库，只在这次 run 的进程内存活期使用。 */
export type GithubAppWriteBackGrant = { token: string; expiresAt: number };

/** 已绑定仓库的最小展示信息，供事件触发编辑器的仓库选择器使用。 */
export type GithubEventRelayRepositoryRef = { connectorId: string; owner: string; name: string; visibility: "public" | "private" };

/** 轮询接口返回的投递摘要——只够做列表展示/去重判断，完整内容要另外 `claimDelivery`。 */
export type GithubEventDeliverySummary = {
  id: string;
  automationId: string;
  eventType: string;
  action?: string;
  entityRef: string;
  /** GitHub 原始事件时间戳（毫秒），不是服务端接收时间。 */
  eventTimestampMs: number;
  createdAtMs: number;
};

/** 认领/详情接口返回的完整投递——`event-pipeline.ts` 的 `GithubEventDelivery` 由它组装。 */
export type GithubEventDeliveryDetail = {
  id: string;
  automationId: string;
  eventType: string;
  action?: string;
  entityRef: string;
  eventTimestampMs: number;
  payload: unknown;
  /** 见服务端 automation_trigger_deliveries.author_is_app_identity 字段注释。 */
  authorIsAppIdentity: boolean;
};

export type GithubEventRelayClient = {
  listRepositories(): Promise<GithubEventRelayRepositoryRef[]>;
  checkReadiness(repo: { owner: string; name: string }): Promise<"not_connected" | "pending_configuration" | "ready">;
  /**
   * 请求组织管理员安装 GitHub App（未连接状态）或绑定这个仓库（已连接但仓库未绑定）——
   * 服务端只有一个端点覆盖这两种情况，都要求带上目标仓库，见
   * `AutomationReadinessRequestService.RequestInstall` 的实现：不存在"不针对具体仓库的
   * 安装请求"这回事。两个方法名分开保留是为了配合 UI 上两种不同状态各自的文案/按钮，
   * 不是两条独立的服务端能力。
   */
  requestInstall(repo: { owner: string; name: string }): Promise<void>;
  requestBind(repo: { owner: string; name: string }): Promise<void>;
  estimateFrequency(trigger: AutomationEventTrigger): Promise<number | null>;
  /**
   * 换取一次运行期写回授权，见服务端 PRD §4.8。
   * TIPS: 每次调用都是独立铸造，调用方（executor 的 preflight）必须在每一轮触发（含会话延续
   * 的每一轮）都重新调用，不能缓存上一轮的结果——这是这条能力设计上的核心约束，不是可选项。
   */
  fetchWriteBackGrant(automationId: string, repo: { owner: string; name: string }): Promise<GithubAppWriteBackGrant>;
  /** 轮询本设备名下待处理的投递（task 3.1）——游标翻页，不传 cursor 取第一页。 */
  listPendingDeliveries(cursor?: string | null): Promise<{ items: GithubEventDeliverySummary[]; nextCursor: string | null }>;
  /**
   * 认领一条投递并换取完整明文详情（task 3.1）——幂等，重复认领同一条返回同样的内容。
   * 保留窗口已过的投递会抛出 code 为 `automation_event_delivery_expired` 的 ApiError
   * （服务端 410），调用方（task 3.6 的"on reconnect"处理）据此识别为需要记一条
   * backlog-dropped，而不是当成普通网络错误重试。
   */
  claimDelivery(deliveryId: string): Promise<GithubEventDeliveryDetail>;
  /**
   * 创建/更新这条自动化在服务端的事件订阅路由元数据——没有这一步，`routeAutomationEvent`
   * 找不到任何订阅，事件永远不会变成一条待认领的投递，`listPendingDeliveries`/`claimDelivery`
   * 再怎么轮询也是空的。见 `subscription-sync.ts`：这个方法本身只是网络边界，谁在什么时机调用
   * 它是那个模块的职责。
   */
  upsertEventSubscription(automationId: string, input: GithubEventSubscriptionInput): Promise<void>;
  /** 移除这条自动化在服务端的事件订阅——触发方式切走、任务被暂停/删除时用。 */
  deleteEventSubscription(automationId: string): Promise<void>;
};

/** 推给服务端的订阅路由元数据——字段名和 jugglework-server `automationEventSubscriptionRequest` 一一对应。 */
export type GithubEventSubscriptionInput = {
  connectorInstanceId: string;
  eventTypes: string[];
  branchFilter: string[];
  labelFilter: string[];
  permissionTier: string;
  enabled: boolean;
};

function splitRepositoryFullName(fullName: string): { owner: string; name: string } | null {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0]?.trim() || !parts[1]?.trim()) return null;
  return { owner: parts[0].trim(), name: parts[1].trim() };
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function createGithubEventRelayClient(
  resolveAuth: () => Promise<GithubEventRelayAuth | null>,
  fetchImpl: typeof fetch = fetch,
): GithubEventRelayClient {
  async function relay<T>(
    path: string,
    init?: { method?: string; body?: unknown; requireAgentToken?: boolean },
  ): Promise<T> {
    const auth = await resolveAuth();
    if (!auth) throw new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session");
    if (init?.requireAgentToken && !auth.agentToken) {
      throw new ApiError(503, "github_event_relay_agent_unavailable", "No desktop agent token is available for this session");
    }
    const response = await fetchImpl(`${auth.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        ...(init?.requireAgentToken ? { "X-JuggleWork-Desktop-Agent-Token": auth.agentToken as string } : {}),
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      // TIPS：服务端错误响应体形状是 {"error": "<code>", "message": "<message>"}
      // （见 jugglework-server apis/validate.go 的 WriteError）——尽量透出真实的错误码
      // （比如 automation_event_delivery_expired），解析失败时才退化成通用错误。
      let code = "github_event_relay_error";
      let message = `GitHub event relay returned ${response.status}`;
      try {
        const parsed = text ? JSON.parse(text) : null;
        if (parsed && typeof parsed === "object") {
          if (typeof (parsed as Record<string, unknown>).error === "string") code = (parsed as Record<string, unknown>).error as string;
          if (typeof (parsed as Record<string, unknown>).message === "string") message = (parsed as Record<string, unknown>).message as string;
        }
      } catch {
        // body wasn't JSON — keep the generic code/message above.
      }
      throw new ApiError(response.status, code, message);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function requestReadinessAction(repo: { owner: string; name: string }): Promise<void> {
    await relay("/api/v1/automations/github-install-request", {
      method: "POST",
      body: { repository: `${repo.owner}/${repo.name}` },
    });
  }

  return {
    listRepositories: () =>
      relay<{ items: Array<{ id: string; name: string; instanceConfigJson?: Record<string, unknown> | null }> }>(
        "/api/v1/connector-instances?connectorType=github&status=active",
      ).then((response) =>
        response.items.flatMap((item) => {
          const parsed = splitRepositoryFullName(item.name);
          if (!parsed) return [];
          const isPrivate = item.instanceConfigJson?.private === true;
          return [{ connectorId: item.id, owner: parsed.owner, name: parsed.name, visibility: isPrivate ? "private" : "public" } as const];
        }),
      ),
    checkReadiness: (repo) =>
      relay<{ state: "not_connected" | "pending_configuration" | "ready" }>(
        `/api/v1/automations/github-readiness?repo=${encodeURIComponent(`${repo.owner}/${repo.name}`)}`,
      ).then((response) => response.state),
    requestInstall: (repo) => requestReadinessAction(repo),
    requestBind: (repo) => requestReadinessAction(repo),
    estimateFrequency: (trigger) => {
      const eventTypes = trigger.matches.map((match) => match.event).join(",");
      const repo = `${trigger.repository.owner}/${trigger.repository.name}`;
      return relay<{ eventsPerDay: number }>(
        `/api/v1/automations/github-event-frequency?repo=${encodeURIComponent(repo)}&eventTypes=${encodeURIComponent(eventTypes)}`,
      ).then((response) => (typeof response.eventsPerDay === "number" ? Math.round(response.eventsPerDay * 7) : null));
    },
    fetchWriteBackGrant: (automationId, repo) =>
      relay<{ token: string; expiresAt: string }>(
        "/api/v1/automations/github-app-grant",
        { method: "POST", body: { automationId, repository: `${repo.owner}/${repo.name}` }, requireAgentToken: true },
      ).then((response) => ({ token: response.token, expiresAt: toEpochMs(response.expiresAt) })),
    listPendingDeliveries: (cursor) =>
      relay<{ items: Array<{ id: string; automationId: string; eventType: string; action?: string; entityRef: string; eventTimestamp: string; createdAt: string }>; nextCursor: string | null }>(
        `/api/v1/automation-event-deliveries${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        { requireAgentToken: true },
      ).then((response) => ({
        items: response.items.map((item) => ({
          id: item.id,
          automationId: item.automationId,
          eventType: item.eventType,
          action: item.action,
          entityRef: item.entityRef,
          eventTimestampMs: toEpochMs(item.eventTimestamp),
          createdAtMs: toEpochMs(item.createdAt),
        })),
        nextCursor: response.nextCursor,
      })),
    claimDelivery: (deliveryId) =>
      relay<{ id: string; automationId: string; eventType: string; action?: string; entityRef: string; eventTimestamp: string; payload: unknown; authorIsAppIdentity: boolean }>(
        `/api/v1/automation-event-deliveries/${encodeURIComponent(deliveryId)}`,
        { requireAgentToken: true },
      ).then((response) => ({
        id: response.id,
        automationId: response.automationId,
        eventType: response.eventType,
        action: response.action,
        entityRef: response.entityRef,
        eventTimestampMs: toEpochMs(response.eventTimestamp),
        payload: response.payload,
        authorIsAppIdentity: response.authorIsAppIdentity,
      })),
    upsertEventSubscription: (automationId, input) =>
      relay(`/api/v1/automations/${encodeURIComponent(automationId)}/event-subscription`, {
        method: "PUT", body: input, requireAgentToken: true,
      }).then(() => undefined),
    deleteEventSubscription: (automationId) =>
      relay(`/api/v1/automations/${encodeURIComponent(automationId)}/event-subscription`, {
        method: "DELETE", requireAgentToken: true,
      }).then(() => undefined),
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
    listPendingDeliveries: () => Promise.resolve({ items: [], nextCursor: null }),
    claimDelivery: () => Promise.reject(new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session")),
    upsertEventSubscription: () => Promise.reject(new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session")),
    deleteEventSubscription: () => Promise.reject(new ApiError(503, "github_event_relay_unavailable", "GitHub event relay is not configured for this session")),
  };
}

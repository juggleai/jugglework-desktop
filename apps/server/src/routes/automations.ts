import { randomUUID } from "node:crypto";
import type { AutomationDefinition, AutomationDraft, AutomationRun, AutomationSchedule } from "@jugglework/types/automation";
import type { AutomationRepository } from "../automation/repository.js";
import {
  automationDraftFromUnknown,
  mergeAutomationRawDocument,
  systemAutomationTimezone,
  validateAutomationDraft,
  validateAutomationSchedule,
  validateAutomationActiveRange,
} from "../automation/validation.js";
import { previewAutomationSchedule } from "../automation/schedule.js";
import { createUnconfiguredGithubEventRelayClient, type GithubEventRelayClient } from "../automation/github-event-client.js";
import type { GithubEventAuthStore } from "../automation/github-event-auth-store.js";
import { ApiError } from "../errors.js";
import type { McpItem, ServerConfig, TokenScope } from "../types.js";
import type { WorkspaceInfo } from "../types.js";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { addRoute, type RequestContext, type Route } from "./registry.js";

/** 会话与自动化共用的内置默认智能体名，选择器里以“默认智能体”呈现，不重复列出。 */
const DEFAULT_AGENT_NAME = "jugglework";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

export interface RegisterAutomationRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  repository: AutomationRepository;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  onChanged?: () => void;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
  resolveWorkspace?: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient?: (config: ServerConfig, workspace: WorkspaceInfo) => ReturnType<typeof createOpencodeClient>;
  listWorkspaceMcp?: (config: ServerConfig, workspaceId: string, workspaceRoot: string) => Promise<McpItem[]>;
  /** 到 jugglework-server 事件中继 API 的客户端；未提供时回落到"未配置"兜底实现。 */
  githubEventRelay?: GithubEventRelayClient;
  /**
   * resolveAuth 的真实生产落点——渲染进程登录后把云端 session token（可选带设备
   * agent token）推给这个进程，见下面 `PUT /automations/github-event-auth`。未提供时
   * 这两个端点直接 404（保持跟其它可选能力一致的降级方式），githubEventRelay 的
   * resolveAuth 继续走它自己的兜底（当前是环境变量，见 github-event-auth.ts）。
   */
  githubEventAuthStore?: GithubEventAuthStore;
  enabled?: boolean;
}

/** 注册本机自动化任务、运行记录和同步 outbox API。 */
export function registerAutomationRoutes(options: RegisterAutomationRoutesOptions): void {
  if (options.enabled === false) return;
  const { routes, config, repository, jsonResponse, readJsonBody } = options;

  addRoute(routes, "POST", "/automations/preview", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const schedule = validateAutomationSchedule(body.schedule as AutomationSchedule | undefined);
    const activeRange = validateAutomationActiveRange(body.activeRange as AutomationDraft["activeRange"]);
    return jsonResponse(previewAutomationSchedule(schedule, activeRange, Date.now(), typeof body.locale === "string" ? body.locale : "zh-CN"));
  });

  // TIPS:以下五个路由都是到 jugglework-server 事件中继 API 的直通代理，没有本地状态、
  // 没有本地校验（校验在 jugglework-server 那一侧做）——本地只负责转发和把 relay 的失败
  // 转成对桌面 UI 友好的响应形状，见 github-event-client.ts 顶部注释里的边界说明。
  const relay = options.githubEventRelay ?? createUnconfiguredGithubEventRelayClient();
  addRoute(routes, "GET", "/automations/github-repositories", "client", async () => jsonResponse({ items: await relay.listRepositories() }));
  addRoute(routes, "GET", "/automations/github-readiness", "client", async (ctx) => {
    const owner = ctx.url.searchParams.get("owner")?.trim() ?? "";
    const name = ctx.url.searchParams.get("name")?.trim() ?? "";
    if (!owner || !name) throw new ApiError(400, "invalid_request", "owner and name are required");
    return jsonResponse({ state: await relay.checkReadiness({ owner, name }) });
  });
  addRoute(routes, "POST", "/automations/github-install-request", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!owner || !name) throw new ApiError(400, "invalid_request", "owner and name are required");
    await relay.requestInstall({ owner, name });
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/automations/github-repository-bind", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const owner = typeof body.owner === "string" ? body.owner.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!owner || !name) throw new ApiError(400, "invalid_request", "owner and name are required");
    await relay.requestBind({ owner, name });
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/automations/github-event-frequency", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const perWeek = await relay.estimateFrequency(body as unknown as Parameters<GithubEventRelayClient["estimateFrequency"]>[0]);
    return jsonResponse({ perWeek });
  });
  if (options.githubEventAuthStore) {
    const authStore = options.githubEventAuthStore;
    // TIPS: resolveAuth 的真实生产落点。渲染进程本来就持有真实的云端登录态，这里只是把
    // 它转发进这个进程——不在这个进程里重新做一遍登录或者设备身份认证。baseUrl/token 是
    // 必填的（没有它们轮询/写回这些能力就完全没法工作），agentToken 是可选的（只有设备已经
    // 通过远程控制那套流程完成过 enrollment、渲染进程才拿得到，见桌面端设备身份基础设施——
    // 缺了它只是"需要设备 agent token 的那几个方法"继续优雅拒绝，不影响其余方法）。
    addRoute(routes, "PUT", "/automations/github-event-auth", "client", async (ctx) => {
      requireMutation(ctx, options);
      const body = await readJsonBody(ctx.request);
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!baseUrl || !token) throw new ApiError(400, "invalid_request", "baseUrl and token are required");
      const agentToken = typeof body.agentToken === "string" ? body.agentToken.trim() : "";
      authStore.set({ baseUrl, token, ...(agentToken ? { agentToken } : {}) });
      return jsonResponse({ ok: true });
    });
    // TIPS: 渲染进程登出时调用——清掉这份内存里的凭据，避免旧会话的 token 在用户切换账号
    // 之后还继续被拿去签轮询/写回请求。
    addRoute(routes, "DELETE", "/automations/github-event-auth", "client", async (ctx) => {
      requireMutation(ctx, options);
      authStore.set(null);
      return jsonResponse({ ok: true });
    });
  }

  // TIPS:workspaceId 是可选的。创建页在选工作空间之前就要能看到模型、智能体、技能和连接器，
  // 因此未指定时回落到第一个本机工作空间——模型和智能体本来就是用户级配置，技能和连接器则在
  // 选定工作空间后按该空间重新查询，从而补上项目级安装的条目。
  addRoute(routes, "GET", "/automations/dependencies", "client", async (ctx) => {
    const requestedId = ctx.url.searchParams.get("workspaceId")?.trim() ?? "";
    if (!options.resolveWorkspace || !options.createWorkspaceOpencodeClient) {
      throw new ApiError(503, "automation_dependencies_unavailable", "Automation dependencies are unavailable");
    }
    const fallbackId = config.workspaces.find((entry) => entry.workspaceType !== "remote")?.id ?? "";
    const workspaceId = requestedId || fallbackId;
    if (!workspaceId) return jsonResponse({ models: [], agents: [], skills: [], connectors: [] });
    const workspace = await options.resolveWorkspace(config, workspaceId);
    if (workspace.workspaceType !== "local") throw new ApiError(400, "workspace_unavailable", "Automation requires a local workspace");
    const opencode = options.createWorkspaceOpencodeClient(config, workspace);
    const [providers, agents, skills, connectors] = await Promise.all([
      opencode.provider.list(),
      opencode.app.agents(),
      opencode.app.skills(),
      options.listWorkspaceMcp?.(config, workspace.id, workspace.path) ?? Promise.resolve([]),
    ]);
    // TIPS:与会话输入栏的模型选择口径一致——只列 engine 报告为已连接的 provider，
    // 且过滤掉没有模型的自定义 provider；否则 models.dev 全量目录里大量没有凭据的模型都会进来。
    const connectedProviderIds = new Set(providers.data?.connected ?? []);
    const connectedProviders = (providers.data?.all ?? []).filter((provider) =>
      connectedProviderIds.has(provider.id)
      && (provider.source !== "custom" || provider.id === "opencode" || Object.keys(provider.models ?? {}).length > 0)
    );
    return jsonResponse({
      models: connectedProviders.flatMap((provider) => Object.values(provider.models).map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
        providerSource: provider.source,
        modelId: model.id,
        modelName: model.name,
        variants: model.variants ? Object.keys(model.variants) : [],
      }))),
      // TIPS:与会话输入栏的智能体选择口径一致——隐藏项、子智能体和内置默认智能体都不作为可选项。
      agents: (agents.data ?? [])
        .filter((agent) => !agent.hidden && agent.mode !== "subagent" && agent.name !== DEFAULT_AGENT_NAME)
        .map((agent) => ({ id: agent.name, name: agent.name, description: agent.description ?? "" })),
      skills: (skills.data ?? []).map((skill) => ({ id: skill.name, name: skill.name, description: skill.description ?? "" })),
      connectors: connectors.map((item) => ({ id: item.name, label: item.name, ready: item.disabledByTools !== true })),
    });
  });

  addRoute(routes, "GET", "/automations", "client", async (ctx) => {
    const limit = optionalInteger(ctx.url.searchParams.get("limit"), "limit");
    const cursor = ctx.url.searchParams.get("cursor")?.trim() || undefined;
    return jsonResponse(repository.listDefinitions({ limit, cursor }));
  });

  addRoute(routes, "GET", "/automations/:automationId", "client", async (ctx) => {
    const item = repository.getDefinition(ctx.params.automationId);
    if (!item) throw new ApiError(404, "automation_not_found", "Automation not found");
    return jsonResponse({ item });
  });

  addRoute(routes, "POST", "/automations", "client", async (ctx) => {
    requireMutation(ctx, options);
    const body = await readJsonBody(ctx.request);
    const now = Date.now();
    const id = optionalIdentifier(body.id) ?? randomUUID();
    const source = body.draft ?? body;
    const draft = automationDraftFromUnknown(source, requireExecutorDeviceId(source));
    const definition = validateAutomationDraft(draft, validationContext(config, now), { id, revision: 1, createdAt: now });
    const rawDocument = mergeAutomationRawDocument(undefined, definition);
    const item = repository.createDefinition(definition, rawDocument);
    options.onChanged?.();
    return jsonResponse({ item }, 201);
  });

  addRoute(routes, "PUT", "/automations/:automationId", "client", async (ctx) => {
    requireMutation(ctx, options);
    const current = repository.getDefinition(ctx.params.automationId);
    if (!current) throw new ApiError(404, "automation_not_found", "Automation not found");
    const body = await readJsonBody(ctx.request);
    const baseRevision = requiredPositiveInteger(body.baseRevision, "baseRevision");
    const now = Date.now();
    const draft = automationDraftFromUnknown(body.draft ?? body, current.definition.executorDeviceId);
    const definition = validateAutomationDraft(draft, validationContext(config, now), {
      id: current.definition.id,
      revision: baseRevision + 1,
      createdAt: current.definition.createdAt,
    });
    const rawDocument = mergeAutomationRawDocument(current.rawDocument, definition);
    const item = repository.updateDefinition(definition, rawDocument, baseRevision);
    options.onChanged?.();
    return jsonResponse({ item });
  });

  addRoute(routes, "POST", "/automations/:automationId/pause", "client", async (ctx) =>
    updateLifecycle(ctx, options, "paused"));

  addRoute(routes, "POST", "/automations/:automationId/resume", "client", async (ctx) =>
    updateLifecycle(ctx, options, "enabled"));

  addRoute(routes, "POST", "/automations/:automationId/duplicate", "client", async (ctx) => {
    requireMutation(ctx, options);
    const current = repository.getDefinition(ctx.params.automationId);
    if (!current) throw new ApiError(404, "automation_not_found", "Automation not found");
    const body = await readJsonBody(ctx.request);
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : `${current.definition.name} 副本`;
    const draft = definitionToDraft(current.definition, { name, lifecycle: "paused", permission: undefined });
    return jsonResponse({ draft, sourceAutomationId: current.definition.id });
  });

  addRoute(routes, "DELETE", "/automations/:automationId", "client", async (ctx) => {
    requireMutation(ctx, options);
    const body = await readJsonBody(ctx.request);
    const baseRevision = requiredPositiveInteger(body.baseRevision, "baseRevision");
    const item = repository.tombstoneDefinition(ctx.params.automationId, baseRevision, Date.now());
    options.onChanged?.();
    return jsonResponse({ item });
  });

  addRoute(routes, "POST", "/automations/:automationId/run", "client", async (ctx) => {
    requireMutation(ctx, options);
    const current = repository.getDefinition(ctx.params.automationId);
    if (!current) throw new ApiError(404, "automation_not_found", "Automation not found");
    const now = Date.now();
    const item = repository.createManualRun(current.definition, randomUUID(), now);
    options.onChanged?.();
    return jsonResponse({ item }, 201);
  });

  addRoute(routes, "GET", "/automation-runs", "client", async (ctx) => {
    const search = ctx.url.searchParams;
    return jsonResponse(repository.listRuns({
      automationId: search.get("automationId")?.trim() || undefined,
      states: parseEnumList<AutomationRun["state"]>(search.get("status"), ["queued", "running", "succeeded", "failed", "skipped", "cancelled"], "status"),
      triggerSources: parseEnumList<AutomationRun["triggerSource"]>(search.get("trigger"), ["scheduled", "catchup", "manual"], "trigger"),
      scheduledFrom: optionalInteger(search.get("scheduledFrom"), "scheduledFrom"),
      scheduledTo: optionalInteger(search.get("scheduledTo"), "scheduledTo"),
      limit: optionalInteger(search.get("limit"), "limit"),
      cursor: search.get("cursor")?.trim() || undefined,
    }));
  });

  addRoute(routes, "GET", "/automation-runs/:runId", "client", async (ctx) => {
    const item = repository.getRun(ctx.params.runId);
    if (!item) throw new ApiError(404, "automation_run_not_found", "Automation run not found");
    return jsonResponse({ item });
  });

  addRoute(routes, "GET", "/automation-sync/outbox", "client", async (ctx) => {
    const limit = optionalInteger(ctx.url.searchParams.get("limit"), "limit");
    return jsonResponse({ items: repository.readOutbox({ limit }) });
  });

  addRoute(routes, "POST", "/automation-sync/ack", "client", async (ctx) => {
    requireMutation(ctx, options);
    const body = await readJsonBody(ctx.request);
    const mutationId = requiredIdentifier(body.mutationId, "mutationId");
    const entityId = requiredIdentifier(body.entityId, "entityId");
    const localRevision = requiredPositiveInteger(body.localRevision, "localRevision");
    if (!repository.acknowledgeOutbox(mutationId, entityId, localRevision)) {
      throw new ApiError(409, "automation_sync_ack_conflict", "Outbox acknowledgement does not match");
    }
    options.log?.("automation_sync_acknowledged", { entityId, localRevision });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/automation-sync/fail", "client", async (ctx) => {
    requireMutation(ctx, options);
    const body = await readJsonBody(ctx.request);
    const mutationId = requiredIdentifier(body.mutationId, "mutationId");
    const errorCode = requiredIdentifier(body.errorCode, "errorCode") as Parameters<AutomationRepository["failOutbox"]>[1];
    const errorMessage = typeof body.errorMessage === "string" ? body.errorMessage : "Automation sync failed";
    const nextAttemptAt = requiredPositiveInteger(body.nextAttemptAt, "nextAttemptAt");
    if (!repository.failOutbox(mutationId, errorCode, errorMessage, nextAttemptAt)) {
      throw new ApiError(404, "automation_sync_mutation_not_found", "Outbox mutation not found");
    }
    // TIPS: 同步日志只记录稳定错误码，禁止写入服务端返回文本或 envelope 内容。
    options.log?.("automation_sync_failed", { errorCode, nextAttemptAt });
    return jsonResponse({ ok: true });
  });
}

async function updateLifecycle(
  ctx: RequestContext,
  options: RegisterAutomationRoutesOptions,
  lifecycle: "enabled" | "paused",
): Promise<Response> {
  requireMutation(ctx, options);
  const current = options.repository.getDefinition(ctx.params.automationId);
  if (!current) throw new ApiError(404, "automation_not_found", "Automation not found");
  const body = await options.readJsonBody(ctx.request);
  const baseRevision = requiredPositiveInteger(body.baseRevision, "baseRevision");
  const now = Date.now();
  const draft = definitionToDraft(current.definition, { lifecycle });
  const definition = validateAutomationDraft(draft, validationContext(options.config, now), {
    id: current.definition.id,
    revision: baseRevision + 1,
    createdAt: current.definition.createdAt,
  });
  const rawDocument = mergeAutomationRawDocument(current.rawDocument, definition);
  const item = options.repository.updateDefinition(definition, rawDocument, baseRevision);
  options.onChanged?.();
  return options.jsonResponse({ item });
}

function definitionToDraft(definition: AutomationDefinition, patch: Partial<AutomationDraft>): AutomationDraft {
  return {
    name: definition.name,
    workspace: definition.workspace,
    prompt: definition.prompt,
    timezone: definition.trigger.kind === "event" ? systemAutomationTimezone() : definition.trigger.timezone,
    trigger: definition.trigger,
    ...(definition.activeRange ? { activeRange: definition.activeRange } : {}),
    model: definition.model,
    ...(definition.agentId ? { agentId: definition.agentId } : {}),
    skillIds: definition.skillIds,
    connectors: definition.connectors,
    permission: definition.permission,
    lifecycle: definition.lifecycle === "paused" ? "paused" : "enabled",
    executorDeviceId: definition.executorDeviceId,
    ...(definition.extensions ? { extensions: definition.extensions } : {}),
    ...patch,
  };
}

function validationContext(config: ServerConfig, now: number) {
  return {
    now,
    workspaces: config.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.displayName?.trim() || workspace.name,
      path: workspace.path,
      workspaceType: workspace.workspaceType,
    })),
  };
}

function requireMutation(ctx: RequestContext, options: RegisterAutomationRoutesOptions): void {
  options.ensureWritable(options.config);
  options.requireClientScope(ctx, "collaborator");
}

function requireExecutorDeviceId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_automation_definition", "执行设备不能为空", { field: "executorDeviceId" });
  }
  return requiredIdentifier((value as Record<string, unknown>).executorDeviceId, "executorDeviceId");
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 256) {
    throw new ApiError(400, "invalid_payload", `${field} is required`, { field });
  }
  return value.trim();
}

function optionalIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new ApiError(400, "invalid_payload", `${field} must be a positive integer`, { field });
  }
  return Number(value);
}

function optionalInteger(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new ApiError(400, "invalid_query", `${field} must be a non-negative integer`);
  }
  return number;
}

function parseEnumList<T extends string>(value: string | null, allowed: readonly T[], field: string): T[] | undefined {
  if (!value?.trim()) return undefined;
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.some((item) => !allowed.includes(item as T))) {
    throw new ApiError(400, "invalid_query", `${field} contains an unsupported value`);
  }
  return values as T[];
}

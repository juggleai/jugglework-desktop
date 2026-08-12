import { randomUUID } from "node:crypto";
import type { AutomationDefinition, AutomationDraft, AutomationRun } from "@jugglework/types/automation";
import type { AutomationRepository } from "../automation/repository.js";
import {
  automationDraftFromUnknown,
  mergeAutomationRawDocument,
  validateAutomationDraft,
  validateAutomationSchedule,
  validateAutomationActiveRange,
} from "../automation/validation.js";
import { previewAutomationSchedule } from "../automation/schedule.js";
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
  enabled?: boolean;
}

/** 注册本机自动化任务、运行记录和同步 outbox API。 */
export function registerAutomationRoutes(options: RegisterAutomationRoutesOptions): void {
  if (options.enabled === false) return;
  const { routes, config, repository, jsonResponse, readJsonBody } = options;

  addRoute(routes, "POST", "/automations/preview", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const schedule = validateAutomationSchedule(body.schedule as AutomationDraft["schedule"]);
    const activeRange = validateAutomationActiveRange(body.activeRange as AutomationDraft["activeRange"]);
    return jsonResponse(previewAutomationSchedule(schedule, activeRange, Date.now(), typeof body.locale === "string" ? body.locale : "zh-CN"));
  });

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
    return jsonResponse({
      models: (providers.data?.all ?? []).flatMap((provider) => Object.values(provider.models).map((model) => ({
        providerId: provider.id,
        providerName: provider.name,
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
    timezone: definition.schedule.timezone,
    schedule: definition.schedule,
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

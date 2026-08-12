import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationErrorCode, type AutomationPromptPart }
  from "@jugglework/types/automation";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { AutomationRepository, type AutomationRunSnapshot } from "./repository.js";

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type AutomationExecutorOptions = {
  config: ServerConfig;
  repository: AutomationRepository;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

/** 在后台创建独立工作空间会话并以无人值守完整权限执行已认领的运行。 */
export class AutomationExecutor {
  private disposed = false;
  private readonly now: () => number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: AutomationExecutorOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
  }

  /** 停止等待新的终态；不会主动中止已经交给 OpenCode 的会话。 */
  dispose(): void {
    this.disposed = true;
  }

  /** 执行单个冻结版本的运行，并把所有状态变化持久化。 */
  async execute(snapshot: AutomationRunSnapshot): Promise<void> {
    let current = snapshot.run;
    try {
      const workspace = await this.resolveLocalWorkspace(snapshot);
      const opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
      const definition = snapshot.definition;
      const unattended = definition.permission.profile === AUTOMATION_PERMISSION_PROFILE;
      const created = await opencode.session.create({
        title: `自动化 · ${definition.name} · ${new Date(current.scheduledFor).toLocaleString("zh-CN")}`,
        ...(definition.agentId ? { agent: definition.agentId } : {}),
        ...(definition.model.mode === "explicit" ? {
          model: {
            id: definition.model.modelId,
            providerID: definition.model.providerId,
            ...(definition.model.variant ? { variant: definition.model.variant } : {}),
          },
        } : {}),
        metadata: {
          automationId: definition.id,
          automationRunId: current.id,
          automationTrigger: current.triggerSource,
          automationScheduledFor: current.scheduledFor,
          automationDefinitionRevision: definition.revision,
        },
        // TIPS:只有「完全访问权限」才放开全部权限并屏蔽提问；选了「默认权限」的任务保留工作空间
        // 原有的确认策略，敏感操作会停在等待用户确认的状态——这正是该模式向用户声明的行为。
        ...(unattended ? {
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "question", pattern: "*", action: "deny" },
          ],
        } : {}),
      });
      if (!created.data) throw failure("execution_failed", "无法创建自动化会话");
      current = this.options.repository.updateRun(current.id, current.revision, { sessionId: created.data.id }, this.now());

      const toolAllowlist = await this.preflight(snapshot, workspace, opencode);
      current = this.options.repository.updateRun(current.id, current.revision, {
        state: "running",
        startedAt: this.now(),
        ...(definition.model.mode === "explicit" ? {
          concreteModel: {
            providerId: definition.model.providerId,
            modelId: definition.model.modelId,
            ...(definition.model.variant ? { variant: definition.model.variant } : {}),
          },
        } : {}),
        ...(definition.agentId ? { agentId: definition.agentId } : {}),
        connectorIds: definition.connectors.map((connector) => connector.id),
      }, this.now());

      const dispatched = await opencode.session.promptAsync({
        sessionID: current.sessionId!,
        ...(definition.model.mode === "explicit" ? {
          model: { providerID: definition.model.providerId, modelID: definition.model.modelId },
          ...(definition.model.variant ? { variant: definition.model.variant } : {}),
        } : {}),
        ...(definition.agentId ? { agent: definition.agentId } : {}),
        ...(unattended
          ? { system: "这是无人值守自动化任务。不得询问用户或等待交互；信息不足时作出合理假设并继续，或明确失败。" }
          : { system: "这是自动化任务，但运行在默认权限下：敏感操作需要用户确认，请在需要时正常发起确认。" }),
        tools: toolAllowlist,
        parts: promptParts(definition.prompt.parts, workspace.path),
      });
      if (dispatched.error !== undefined) throw failure("execution_failed", "OpenCode 未接受自动化提示词");
      await this.waitForTerminalEvent(opencode, current.sessionId!);
      if (this.disposed) throw failure("session_lost", "客户端退出，自动化会话已停止跟踪");
      await this.completeFromSession(opencode, current);
    } catch (error) {
      const latest = this.options.repository.getRun(current.id);
      if (!latest || isTerminal(latest.state)) return;
      const normalized = normalizeFailure(error);
      this.options.repository.updateRun(latest.id, latest.revision, {
        state: "failed",
        endedAt: this.now(),
        errorCode: normalized.code,
        errorMessage: normalized.message,
      }, this.now());
    }
  }

  /** 重启后根据既有 OpenCode 会话恢复运行终态，绝不重新派发提示词。 */
  async reconcile(snapshot: AutomationRunSnapshot): Promise<void> {
    const current = this.options.repository.getRun(snapshot.run.id);
    if (!current || current.state !== "running") return;
    try {
      if (!current.sessionId) throw failure("session_lost", "运行缺少可恢复的会话");
      const workspace = await this.resolveLocalWorkspace(snapshot);
      const opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
      const session = await opencode.session.get({ sessionID: current.sessionId });
      if (!session.data) throw failure("session_lost", "自动化会话已不存在");
      const statuses = await opencode.session.status();
      const status = statuses.data?.[current.sessionId];
      if (status?.type === "busy" || status?.type === "retry") {
        await this.waitForTerminalEvent(opencode, current.sessionId);
      }
      if (this.disposed) throw failure("session_lost", "客户端退出，自动化会话已停止跟踪");
      await this.completeFromSession(opencode, this.options.repository.getRun(current.id) ?? current);
    } catch (error) {
      this.failRun(current.id, error);
    }
  }

  private async resolveLocalWorkspace(snapshot: AutomationRunSnapshot): Promise<WorkspaceInfo> {
    try {
      const workspace = await this.options.resolveWorkspace(this.options.config, snapshot.definition.workspace.id);
      if (workspace.workspaceType !== "local") throw new Error("remote workspace");
      return workspace;
    } catch {
      throw failure("workspace_unavailable", "任务工作空间不可用");
    }
  }

  private async preflight(
    snapshot: AutomationRunSnapshot,
    workspace: WorkspaceInfo,
    opencode: WorkspaceOpencodeClient,
  ): Promise<Record<string, boolean>> {
    const definition = snapshot.definition;
    for (const part of definition.prompt.parts) {
      if (part.type !== "file") continue;
      try {
        await access(resolve(workspace.path, part.relativePath));
      } catch {
        throw failure("file_unavailable", `引用文件不可用：${part.relativePath}`);
      }
    }
    if (definition.model.mode === "explicit") {
      const model = definition.model;
      const providers = await opencode.provider.list();
      const providerList = providers.data?.all ?? [];
      const provider = providerList.find((item) => item.id === model.providerId);
      if (!provider || !Object.prototype.hasOwnProperty.call(provider.models, model.modelId)) {
        throw failure("model_unavailable", "指定模型当前不可用");
      }
    }
    if (definition.agentId) {
      const agents = await opencode.app.agents();
      if (!agents.data?.some((agent) => agent.name === definition.agentId)) {
        throw failure("agent_unavailable", "指定 Agent 当前不可用");
      }
    }
    if (definition.skillIds.length) {
      const skills = await opencode.app.skills();
      const available = new Set((skills.data ?? []).map((skill) => skill.name));
      if (definition.skillIds.some((skillId) => !available.has(skillId))) {
        throw failure("skill_unavailable", "一个或多个技能当前不可用");
      }
    }
    return this.resolveConnectorToolAllowlist(snapshot, opencode);
  }

  /** 解析任务级 MCP 工具白名单；未勾选连接器的工具必须显式关闭。 */
  private async resolveConnectorToolAllowlist(
    snapshot: AutomationRunSnapshot,
    opencode: WorkspaceOpencodeClient,
  ): Promise<Record<string, boolean>> {
    const selected = snapshot.definition.connectors;
    if (selected.some((connector) => connector.source === "cloud")) {
      // TIPS：云连接器必须先注入任务专用短期凭证，禁止复用交互会话的普通用户令牌。
      throw failure("connector_scope_unavailable", "云连接器暂时无法取得任务级授权，请重新授权后再试");
    }

    const [statusResult, toolResult] = await Promise.all([opencode.mcp.status(), opencode.tool.ids()]);
    if (!statusResult.data || !toolResult.data) {
      throw failure("connector_unavailable", "无法读取当前连接器工具清单");
    }
    const selectedIds = new Set(selected.map((connector) => connector.id));
    for (const connector of selected) {
      const status = statusResult.data[connector.id];
      if (!status || status.status !== "connected") {
        const code = status?.status === "needs_auth" || status?.status === "needs_client_registration"
          ? "connector_reauth_required"
          : "connector_unavailable";
        throw failure(code, `连接器不可用：${connector.label}`);
      }
    }

    const serverNames = Object.keys(statusResult.data).sort((left, right) => right.length - left.length);
    const allowlist: Record<string, boolean> = {};
    for (const toolId of toolResult.data) {
      const serverName = serverNames.find((name) => toolId.startsWith(`${name}_`));
      if (serverName) allowlist[toolId] = selectedIds.has(serverName);
    }
    return allowlist;
  }

  private async waitForTerminalEvent(opencode: WorkspaceOpencodeClient, sessionId: string): Promise<void> {
    const controller = new AbortController();
    let subscription: Awaited<ReturnType<WorkspaceOpencodeClient["event"]["subscribe"]>>;
    try {
      subscription = await opencode.event.subscribe(undefined, { signal: controller.signal });
    } catch {
      await this.pollUntilIdle(opencode, sessionId);
      return;
    }
    try {
      await Promise.race([
        this.consumeSessionEvents(subscription.stream, sessionId, controller.signal),
        this.pollUntilIdle(opencode, sessionId, controller.signal),
      ]);
    } finally {
      controller.abort();
    }
  }

  private async consumeSessionEvents(stream: AsyncIterable<unknown>, sessionId: string, signal: AbortSignal): Promise<void> {
    for await (const raw of stream) {
      if (signal.aborted || this.disposed) return;
      const event = automationEvent(raw);
      if (!event || event.sessionId !== sessionId) continue;
      if (event.type === "session.error") throw failure("execution_failed", event.message ?? "自动化会话返回终止错误");
      if (event.type === "session.idle" || event.type === "session.status" && event.status === "idle") return;
    }
  }

  private async pollUntilIdle(opencode: WorkspaceOpencodeClient, sessionId: string, signal?: AbortSignal): Promise<void> {
    let observedBusy = false;
    for (let attempt = 0; !this.disposed && !signal?.aborted; attempt += 1) {
      await this.wait(attempt === 0 ? 350 : 1_000);
      if (signal?.aborted) return;
      const result = await opencode.session.status();
      if (!result.data) throw failure("execution_failed", "无法读取自动化会话状态");
      const status = result.data[sessionId];
      if (status?.type === "busy" || status?.type === "retry") {
        observedBusy = true;
        continue;
      }
      if (observedBusy || attempt >= 1) return;
    }
  }

  private async completeFromSession(opencode: WorkspaceOpencodeClient, current: AutomationRunSnapshot["run"]): Promise<void> {
    const messages = await opencode.session.messages({ sessionID: current.sessionId!, limit: 20 });
    const assistant = [...(messages.data ?? [])].reverse().map((message) => message.info).find((message) => message.role === "assistant");
    if (assistant?.role === "assistant" && assistant.error) {
      throw failure("execution_failed", "自动化会话返回终止错误");
    }
    const latest = this.options.repository.getRun(current.id);
    if (!latest || isTerminal(latest.state)) return;
    this.options.repository.updateRun(latest.id, latest.revision, {
      state: "succeeded",
      endedAt: this.now(),
      ...(assistant?.role === "assistant" ? {
        concreteModel: { providerId: assistant.providerID, modelId: assistant.modelID, ...(assistant.variant ? { variant: assistant.variant } : {}) },
        agentId: assistant.agent,
      } : {}),
    }, this.now());
  }

  private failRun(runId: string, error: unknown): void {
    const latest = this.options.repository.getRun(runId);
    if (!latest || isTerminal(latest.state)) return;
    const normalized = normalizeFailure(error);
    this.options.repository.updateRun(latest.id, latest.revision, {
      state: "failed",
      endedAt: this.now(),
      errorCode: normalized.code,
      errorMessage: normalized.message,
    }, this.now());
  }
}

function promptParts(parts: AutomationPromptPart[], workspacePath: string) {
  return parts.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    if (part.type === "file") return {
      type: "file" as const,
      mime: "text/plain",
      filename: part.label ?? part.relativePath,
      url: pathToFileURL(resolve(workspacePath, part.relativePath)).href,
    };
    return { type: "text" as const, text: `请使用技能：${part.skillId}` };
  });
}

function failure(code: AutomationErrorCode, message: string): Error & { code: AutomationErrorCode } {
  return Object.assign(new Error(message), { code });
}

function normalizeFailure(error: unknown): { code: AutomationErrorCode; message: string } {
  if (error instanceof Error) {
    const code = (error as Error & { code?: AutomationErrorCode }).code;
    return { code: code ?? "execution_failed", message: sanitizeError(error.message) };
  }
  return { code: "execution_failed", message: "自动化任务执行失败" };
}

function sanitizeError(message: string): string {
  return message.replace(/(bearer|token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]").slice(0, 500);
}

function automationEvent(raw: unknown): { type: string; sessionId?: string; status?: string; message?: string } | null {
  const candidate = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(candidate) || typeof candidate.type !== "string" || !isRecord(candidate.properties)) return null;
  const properties = candidate.properties;
  return {
    type: candidate.type,
    ...(typeof properties.sessionID === "string" ? { sessionId: properties.sessionID } : {}),
    ...(isRecord(properties.status) && typeof properties.status.type === "string" ? { status: properties.status.type } : {}),
    ...(properties.error !== undefined ? { message: sanitizeError(errorText(properties.error)) } : {}),
  };
}

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "自动化会话返回终止错误";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTerminal(state: AutomationRunSnapshot["run"]["state"]): boolean {
  return ["succeeded", "failed", "skipped", "cancelled"].includes(state);
}

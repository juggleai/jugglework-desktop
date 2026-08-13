import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentRuntimeModel, CanonicalAgentSession, CanonicalSessionSnapshot } from "@jugglework/types/agent-runtime";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationErrorCode, type AutomationPromptPart }
  from "@jugglework/types/automation";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { AutomationRepository, type AutomationRunSnapshot } from "./repository.js";

export type AutomationAgentRuntime = {
  createSession(input: { workspaceId: string; title: string; configuration: CanonicalAgentSession["configuration"] }): Promise<CanonicalAgentSession>;
  startRun(input: { workspaceId: string; sessionId: string; prompt: Record<string, unknown> }): Promise<void>;
  readSession(workspaceId: string, sessionId: string): Promise<CanonicalAgentSession>;
  snapshot(workspaceId: string, sessionId: string, limit?: number): Promise<CanonicalSessionSnapshot>;
  activity(workspaceId: string, sessionId: string): Promise<"idle" | "busy">;
  listModels(workspaceId: string): Promise<AgentRuntimeModel[]>;
  listAgentProfiles(workspaceId: string): Promise<Array<{ id: string }>>;
  listSkills(workspaceId: string): Promise<Array<{ id: string }>>;
  listTools(workspaceId: string): Promise<Array<{ id: string; source: string | null; available: boolean }>>;
};

export type AutomationExecutorOptions = {
  config: ServerConfig;
  repository: AutomationRepository;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  runtime: AutomationAgentRuntime;
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

  /** 停止等待新的终态；不会主动中止已经交给 runtime 的会话。 */
  dispose(): void {
    this.disposed = true;
  }

  /** 执行单个冻结版本的运行，并把所有状态变化持久化。 */
  async execute(snapshot: AutomationRunSnapshot): Promise<void> {
    let current = snapshot.run;
    try {
      const workspace = await this.resolveLocalWorkspace(snapshot);
      const definition = snapshot.definition;
      const unattended = definition.permission.profile === AUTOMATION_PERMISSION_PROFILE;
      const created = await this.options.runtime.createSession({
        workspaceId: workspace.id,
        title: `自动化 · ${definition.name} · ${new Date(current.scheduledFor).toLocaleString("zh-CN")}`,
        configuration: {
          ...(definition.agentId ? { agentProfile: definition.agentId } : {}),
          ...(definition.model.mode === "explicit" ? {
            model: { providerId: definition.model.providerId, modelId: definition.model.modelId },
            ...(definition.model.variant ? { execution: { effort: definition.model.variant } } : {}),
          } : {}),
        },
      });
      current = this.options.repository.updateRun(current.id, current.revision, { sessionId: created.id }, this.now());

      const toolAllowlist = await this.preflight(snapshot, workspace);
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

      await this.options.runtime.startRun({
        workspaceId: workspace.id,
        sessionId: current.sessionId!,
        prompt: {
          metadata: {
            automationId: definition.id,
            automationRunId: current.id,
            automationTrigger: current.triggerSource,
            automationScheduledFor: current.scheduledFor,
            automationDefinitionRevision: definition.revision,
          },
          ...(unattended
            ? { system: "这是无人值守自动化任务。不得询问用户或等待交互；信息不足时作出合理假设并继续，或明确失败。" }
            : { system: "这是自动化任务，但运行在默认权限下：敏感操作需要用户确认，请在需要时正常发起确认。" }),
          tools: toolAllowlist,
          parts: promptParts(definition.prompt.parts, workspace.path),
        },
      });
      await this.waitUntilIdle(workspace.id, current.sessionId!);
      if (this.disposed) throw failure("session_lost", "客户端退出，自动化会话已停止跟踪");
      await this.completeFromSession(workspace.id, current);
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

  /** 重启后根据既有 canonical 会话恢复运行终态，绝不重新派发提示词。 */
  async reconcile(snapshot: AutomationRunSnapshot): Promise<void> {
    const current = this.options.repository.getRun(snapshot.run.id);
    if (!current || current.state !== "running") return;
    try {
      if (!current.sessionId) throw failure("session_lost", "运行缺少可恢复的会话");
      const workspace = await this.resolveLocalWorkspace(snapshot);
      try {
        await this.options.runtime.readSession(workspace.id, current.sessionId);
      } catch {
        throw failure("session_lost", "运行对应的会话不可恢复");
      }
      if (await this.options.runtime.activity(workspace.id, current.sessionId) === "busy") await this.waitUntilIdle(workspace.id, current.sessionId);
      if (this.disposed) throw failure("session_lost", "客户端退出，自动化会话已停止跟踪");
      await this.completeFromSession(workspace.id, this.options.repository.getRun(current.id) ?? current);
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
      const models = await this.options.runtime.listModels(workspace.id);
      if (!models.some((item) => item.providerId === model.providerId && item.id === model.modelId)) {
        throw failure("model_unavailable", "指定模型当前不可用");
      }
    }
    if (definition.agentId) {
      const agents = await this.options.runtime.listAgentProfiles(workspace.id);
      if (!agents.some((agent) => agent.id === definition.agentId)) {
        throw failure("agent_unavailable", "指定 Agent 当前不可用");
      }
    }
    if (definition.skillIds.length) {
      const skills = await this.options.runtime.listSkills(workspace.id);
      const available = new Set(skills.map((skill) => skill.id));
      if (definition.skillIds.some((skillId) => !available.has(skillId))) {
        throw failure("skill_unavailable", "一个或多个技能当前不可用");
      }
    }
    return this.resolveConnectorToolAllowlist(snapshot, workspace.id);
  }

  /** 解析任务级 MCP 工具白名单；未勾选连接器的工具必须显式关闭。 */
  private async resolveConnectorToolAllowlist(
    snapshot: AutomationRunSnapshot,
    workspaceId: string,
  ): Promise<Record<string, boolean>> {
    const selected = snapshot.definition.connectors;
    if (selected.some((connector) => connector.source === "cloud")) {
      // TIPS：云连接器必须先注入任务专用短期凭证，禁止复用交互会话的普通用户令牌。
      throw failure("connector_scope_unavailable", "云连接器暂时无法取得任务级授权，请重新授权后再试");
    }

    const tools = await this.options.runtime.listTools(workspaceId);
    const selectedIds = new Set(selected.map((connector) => connector.id));
    for (const connector of selected) {
      if (!tools.some((tool) => tool.source === connector.id && tool.available)) {
        const code = "connector_unavailable";
        throw failure(code, `连接器不可用：${connector.label}`);
      }
    }

    const allowlist: Record<string, boolean> = {};
    for (const tool of tools) {
      if (tool.source) allowlist[tool.id] = selectedIds.has(tool.source) && tool.available;
    }
    return allowlist;
  }

  private async waitUntilIdle(workspaceId: string, sessionId: string): Promise<void> {
    let observedBusy = false;
    for (let attempt = 0; !this.disposed; attempt += 1) {
      await this.wait(attempt === 0 ? 350 : 1_000);
      if (await this.options.runtime.activity(workspaceId, sessionId) === "busy") {
        observedBusy = true;
        continue;
      }
      if (observedBusy || attempt >= 1) return;
    }
  }

  private async completeFromSession(workspaceId: string, current: AutomationRunSnapshot["run"]): Promise<void> {
    const snapshot = await this.options.runtime.snapshot(workspaceId, current.sessionId!, 20);
    const assistant = [...snapshot.messages].reverse().find((message) => message.role === "assistant");
    if (assistant?.parts.some((part) => part.type === "error")) {
      throw failure("execution_failed", "自动化会话返回终止错误");
    }
    const latest = this.options.repository.getRun(current.id);
    if (!latest || isTerminal(latest.state)) return;
    this.options.repository.updateRun(latest.id, latest.revision, {
      state: "succeeded",
      endedAt: this.now(),
      ...(assistant?.role === "assistant" && typeof assistant.metadata?.providerId === "string" && typeof assistant.metadata?.modelId === "string" ? {
        concreteModel: {
          providerId: assistant.metadata.providerId,
          modelId: assistant.metadata.modelId,
          ...(typeof assistant.metadata.variant === "string" ? { variant: assistant.metadata.variant } : {}),
        },
        ...(typeof assistant.metadata.agent === "string" ? { agentId: assistant.metadata.agent } : {}),
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

function isTerminal(state: AutomationRunSnapshot["run"]["state"]): boolean {
  return ["succeeded", "failed", "skipped", "cancelled"].includes(state);
}

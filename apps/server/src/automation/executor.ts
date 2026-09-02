import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationErrorCode, type AutomationPromptPart }
  from "@jugglework/types/automation";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { applyMcpWorkspacePolicyToPrompt, readMcpWorkspaceToolPolicy } from "../mcp-workspace-tool-policy.js";
import { AutomationRepository, type AutomationRunSnapshot } from "./repository.js";
import type { GithubEventRelayClient } from "./github-event-client.js";

type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export type AutomationExecutorOptions = {
  config: ServerConfig;
  repository: AutomationRepository;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  /** 用于事件触发运行的写回授权铸造；省略时事件触发运行的 `github-app` preflight 直接判定不可用。 */
  githubEventRelay?: GithubEventRelayClient;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
};

/**
 * 事件触发运行的会话延续上下文，由调用方（事件管道）在分发前算好传入。
 * TIPS: `extraPromptParts` 已经是渲染好的、包含不可信数据边界和增量摘要的完整 parts
 * （见 event-pipeline.ts 的 `appendEventContextPromptParts`）——executor 本身不理解
 * GitHub 事件的具体形状，只负责把这些 parts 追加到既有 prompt 后面。
 */
export type AutomationEventExecutionContext = {
  entityRef: string;
  extraPromptParts: AutomationPromptPart[];
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

  /**
   * 执行单个冻结版本的运行，并把所有状态变化持久化。
   * @param eventContext 事件触发的会话延续上下文；省略时保持原有"每次触发都新建会话"的行为。
   */
  async execute(snapshot: AutomationRunSnapshot, eventContext?: AutomationEventExecutionContext): Promise<void> {
    let current = snapshot.run;
    try {
      const workspace = await this.resolveLocalWorkspace(snapshot);
      const opencode = this.options.createWorkspaceOpencodeClient(this.options.config, workspace);
      const definition = snapshot.definition;
      const unattended = definition.permission.profile === AUTOMATION_PERMISSION_PROFILE;

      const resolved = await this.resolveSessionId(definition, workspace, opencode, current, eventContext);
      current = this.options.repository.updateRun(current.id, current.revision, {
        sessionId: resolved.sessionId,
        ...(resolved.previousSessionUnavailable ? { eventMetadata: { previousSessionUnavailable: true } } : {}),
      }, this.now());

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

      const policy = await readMcpWorkspaceToolPolicy(this.options.config, workspace.id);
      const observedToolIds = Object.keys(toolAllowlist);
      const prompt = applyMcpWorkspacePolicyToPrompt({
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
        parts: promptParts(
          eventContext ? [...definition.prompt.parts, ...eventContext.extraPromptParts] : definition.prompt.parts,
          workspace.path,
        ),
      }, observedToolIds, policy.disabledServerNames);
      const dispatched = await opencode.session.promptAsync(prompt as Parameters<typeof opencode.session.promptAsync>[0]);
      if (dispatched.error !== undefined) throw failure("execution_failed", "OpenCode 未接受自动化提示词");
      // TIPS:这一次 updateRun 只在 prompt 真正被 OpenCode 接受之后才发生——重连重连（reconcile）
      // 就是靠这个标记分辨"崩溃发生在分发之前"还是"分发之后"，见 reconcile() 的注释。
      current = this.options.repository.updateRun(current.id, current.revision, { eventMetadata: { dispatched: true } }, this.now());
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
      // TIPS: 会话延续场景下，一个 session 可能已经承载过多轮历史 run——重启后"session 现在
      // idle"既可能是"上一轮正常结束的稳态"，也可能是"这一轮 prompt 还没来得及发出去就崩溃了"。
      // `eventMetadata.dispatched` 是 execute() 在 promptAsync 确认成功之后才写入的标记，只有
      // 它为真，才能把"idle"解读成"这一轮真的跑完了"；否则必须当失败处理，不能盲目判定成功——
      // 见桌面 PRD 4.8 的"重启重连"分支和 design.md 决策 9。
      const latestBeforeComplete = this.options.repository.getRun(current.id) ?? current;
      if (!latestBeforeComplete.eventMetadata?.dispatched) {
        throw failure("session_lost", "重启前未能确认这一轮提示词已成功分发，不判定为完成");
      }
      await this.completeFromSession(opencode, latestBeforeComplete);
    } catch (error) {
      this.failRun(current.id, error);
    }
  }

  /**
   * 决定这一轮触发用新会话还是复用已有会话。
   * TIPS: 只有事件触发（`eventContext` 有值）才会走复用路径；定时/手动触发的行为完全不变，
   * 继续每次新建——这是 add-local-automation-tasks 决策 #6 对事件触发场景的一次例外，不是
   * 全局改动，见 design.md 决策 8。
   */
  private async resolveSessionId(
    definition: AutomationRunSnapshot["definition"],
    workspace: WorkspaceInfo,
    opencode: WorkspaceOpencodeClient,
    current: AutomationRunSnapshot["run"],
    eventContext?: AutomationEventExecutionContext,
  ): Promise<{ sessionId: string; previousSessionUnavailable: boolean }> {
    // TIPS: 先记下"进来的时候是不是有一条 active 的归属映射"，这是唯一能判断"要不要标注
    // previousSessionUnavailable"的时机——新建分支里马上就会 upsert 覆盖掉这条记录，事后
    // 再查就只能看到新状态了。
    const hadActiveMapping = eventContext
      ? this.options.repository.getEntitySessionMapping(definition.id, eventContext.entityRef)?.status === "active"
      : false;
    if (eventContext && hadActiveMapping) {
      const mapping = this.options.repository.getEntitySessionMapping(definition.id, eventContext.entityRef)!;
      try {
        const existing = await opencode.session.get({ sessionID: mapping.sessionId });
        if (existing.data) {
          this.options.repository.upsertEntitySessionMapping(definition.id, eventContext.entityRef, workspace.id, mapping.sessionId, this.now());
          return { sessionId: mapping.sessionId, previousSessionUnavailable: false };
        }
      } catch {
        // 会话查询失败视同不可解析，走下面的新建分支，不在这里重试或抛出。
      }
    }
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
      ...(definition.permission.profile === AUTOMATION_PERMISSION_PROFILE ? {
        permission: [
          { permission: "*", pattern: "*", action: "allow" },
          { permission: "question", pattern: "*", action: "deny" },
        ],
      } : {}),
    });
    if (!created.data) throw failure("execution_failed", "无法创建自动化会话");
    if (eventContext) {
      this.options.repository.upsertEntitySessionMapping(definition.id, eventContext.entityRef, workspace.id, created.data.id, this.now());
    }
    return { sessionId: created.data.id, previousSessionUnavailable: hadActiveMapping };
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
    if (definition.trigger.kind === "event" && definition.connectors.some((connector) => connector.source === "github-app")) {
      await this.fetchWriteBackGrant(definition);
    }
    return this.resolveConnectorToolAllowlist(snapshot, opencode);
  }

  /**
   * 换取本轮运行期 GitHub App 写回授权，preflight 阶段失败即整轮失败。
   * TIPS: 只做到"换取成功/失败"这一步——换到的短时效凭据如何真正注入到 agent 后续调用
   * GitHub 工具的执行链路（MCP 连接器凭据覆盖），依赖尚未探明的 OpenCode 侧接口，留给
   * 后续接线；这里已经完整实现了"每轮独立换取、换取失败即挡在 preflight"这条不变量。
   */
  private async fetchWriteBackGrant(definition: AutomationRunSnapshot["definition"]): Promise<void> {
    if (definition.trigger.kind !== "event") return;
    if (!this.options.githubEventRelay) {
      throw failure("connector_unavailable", "运行期 GitHub App 写回授权服务当前不可用");
    }
    try {
      await this.options.githubEventRelay.fetchWriteBackGrant(definition.id, definition.trigger.repository);
    } catch (error) {
      const code = (error as { code?: string } | undefined)?.code;
      if (code === "github_event_relay_unavailable") throw failure("connector_unavailable", "运行期写回授权服务当前不可用");
      throw failure("connector_reauth_required", "无法换取运行期 GitHub App 写回授权，请检查组织安装状态");
    }
  }

  /** 解析任务级 MCP 工具白名单；未勾选连接器的工具必须显式关闭。 */
  private async resolveConnectorToolAllowlist(
    snapshot: AutomationRunSnapshot,
    opencode: WorkspaceOpencodeClient,
  ): Promise<Record<string, boolean>> {
    // TIPS: `github-app` 连接器不是 MCP 服务器——它是运行期写回授权的标记，可用性已经在
    // fetchWriteBackGrant()（preflight 更早的一步）单独检查过，这里不该再按 mcp.status() 的
    // "connected" 语义去要求它，否则任何事件触发自动化都会在这一步被误判为连接器不可用。
    const selected = snapshot.definition.connectors.filter((connector) => connector.source !== "github-app");
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

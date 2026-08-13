import {
  agentRuntimeDescriptorSchema,
  agentRuntimeHealthSchema,
  canonicalAgentEventSchema,
  canonicalAgentSessionSchema,
  canonicalInteractionResolutionSchema,
  canonicalSessionSnapshotSchema,
  type AgentRuntimeCapabilities,
  type AgentRuntimeDescriptor,
  type AgentRuntimeHealth,
  type AgentRuntimeModel,
  type CanonicalAgentEvent,
  type CanonicalAgentEventData,
  type CanonicalAgentMessage,
  type CanonicalAgentSession,
  type CanonicalInteraction,
  type CanonicalSessionSnapshot,
  type CanonicalSessionStatus,
  type AgentRuntimeCurrentTurnConfiguration,
  type ClaudeAdvancedFeature,
} from "@jugglework/types/agent-runtime";

import {
  ClaudeWorkerClientError,
  type ClaudeWorkerCapabilities,
  type ClaudeWorkerEvent,
  type ClaudeWorkerRunRequest,
  type ClaudeWorkerMcpConfiguration,
} from "../claude-worker-client.js";
import { AgentEngineError } from "./errors.js";
import { InteractionResolutionError } from "../interaction-resolution-coordinator.js";
import type { ClaudeCredentialReadiness } from "../claude-credentials.js";
import { ClaudeAdvancedRollout } from "../claude-advanced-rollout.js";
import {
  RuntimeNeutralPreToolPolicy,
  type CanonicalToolOperation,
  type PreToolPolicyDecision,
} from "../agent-tool-policy/pre-tool-policy.js";
import type {
  AbortAgentRunInput,
  AgentEngineContext,
  AgentEnginePort,
  CreateAgentSessionInput,
  ReadAgentSessionInput,
  ResolveAgentInteractionInput,
  StartAgentRunInput,
  StopAgentSubagentInput,
  UpdateAgentSessionInput,
  ForkAgentSessionInput,
  ForkAgentSessionResult,
} from "./port.js";

export const CLAUDE_AGENT_RUNTIME_ID = "claude-agent";
const MAX_SEEN_WORKER_EVENTS_PER_WORKSPACE = 2_000;
export const CLAUDE_AGENT_MODELS: AgentRuntimeModel[] = [
  {
    id: "sonnet",
    providerId: "anthropic",
    label: "Claude Sonnet",
    description: "Balanced Claude model alias resolved by the bundled Claude Agent SDK.",
    isDefault: true,
    capabilities: ["effort:low", "effort:medium", "effort:high", "effort:xhigh", "effort:max"],
  },
  {
    id: "opus",
    providerId: "anthropic",
    label: "Claude Opus",
    description: "Most capable Claude model alias resolved by the bundled Claude Agent SDK.",
    isDefault: false,
    capabilities: ["effort:low", "effort:medium", "effort:high", "effort:xhigh", "effort:max"],
  },
  {
    id: "haiku",
    providerId: "anthropic",
    label: "Claude Haiku",
    description: "Fast Claude model alias resolved by the bundled Claude Agent SDK.",
    isDefault: false,
    capabilities: ["effort:low", "effort:medium", "effort:high"],
  },
];

export interface ClaudeWorkerApi {
  health(): Promise<{
    status: AgentRuntimeHealth["status"];
    checkedAt: string;
    reasonCode: string | null;
    message: string | null;
  }>;
  capabilities(): Promise<ClaudeWorkerCapabilities>;
  run(input: ClaudeWorkerRunRequest): Promise<{ accepted: true; runId: string; status: "starting"; backendSessionId?: string | null }>;
  abort(sessionId: string, runId: string): Promise<void>;
  events(cursor?: number, signal?: AbortSignal): AsyncIterable<ClaudeWorkerEvent>;
  resolveInteraction(interactionId: string, sessionId: string, runId: string, resolution: Record<string, unknown>): Promise<void>;
  refreshConfiguration(configuration: ClaudeWorkerMcpConfiguration): Promise<unknown>;
  mcpDiagnostics?(workspaceId: string): Promise<unknown>;
  reconnectMcp?(workspaceId: string, serverName: string): Promise<void>;
  stopSubagent(sessionId: string, runId: string, taskId: string): Promise<void>;
  forkSession(input: { sourceBackendSessionId: string; cwd: string; title?: string; upToMessageId?: string }): Promise<{
    accepted: true;
    backendSessionId: string;
    filesystemState: ForkAgentSessionResult["filesystemState"];
  }>;
}

export type ClaudeMcpConfigurationLease = {
  configuration: ClaudeWorkerMcpConfiguration;
  release(): void | Promise<void>;
};

export interface ClaudeAgentEngineAdapterOptions {
  getClient: () => ClaudeWorkerApi | Promise<ClaudeWorkerApi>;
  unavailableHealth?: AgentRuntimeHealth;
  models?: AgentRuntimeModel[];
  now?: () => number;
  dispose?: () => Promise<void>;
  resolveMcpConfiguration?: (context: AgentEngineContext) => Promise<ClaudeMcpConfigurationLease>;
  authorizedRoots?: readonly string[];
  permissionPolicy?: ClaudeWorkerRunRequest["permissionPolicy"];
  approvalDeadlineMs?: number;
  credentialReadiness?: () => Promise<ClaudeCredentialReadiness>;
  advancedRollout?: ClaudeAdvancedRollout;
  onTelemetry?: (event:
    | { type: "mcp"; state: "initializing" | "pending" | "connected" | "failed" | "needs_auth" | "expired" | "removed" | "output_truncated" }
    | { type: "transport_lost" }) => void;
}

type SessionState = {
  session: CanonicalAgentSession;
  messages: Map<string, CanonicalAgentMessage>;
  interactions: Map<string, CanonicalInteraction>;
  latestSequence: number;
  activeRunMayHaveMutated: boolean;
};

const baseCapabilities: AgentRuntimeCapabilities = {
  models: false,
  variants: false,
  "reasoning-stream": true,
  commands: false,
  shell: false,
  compact: false,
  resume: true,
  fork: false,
  steer: false,
  enqueue: false,
  permissions: false,
  questions: false,
  todos: false,
    mcp: false,
  subagents: false,
  "file-checkpointing": false,
  "usage-and-cost": true,
  prewarm: false,
  "resident-session": false,
  "plan-mode": false,
  rewind: false,
  "dynamic-model": false,
  "dynamic-effort": false,
  "dynamic-permission-mode": false,
};

function engineError(error: unknown, operation: string): AgentEngineError {
  if (error instanceof AgentEngineError) return error;
  const unavailable = error instanceof ClaudeWorkerClientError && error.code === "ownership_lost";
  return new AgentEngineError(
    unavailable ? "runtime_unavailable" : "runtime_request_failed",
    `Claude Agent ${operation} failed`,
    { runtimeId: CLAUDE_AGENT_RUNTIME_ID, operation },
    { cause: error },
  );
}

function capabilityMap(worker: ClaudeWorkerCapabilities, hasModels: boolean, rollout?: ClaudeAdvancedRollout): AgentRuntimeCapabilities {
  const enabled = (feature: ClaudeAdvancedFeature, supported: boolean) =>
    rollout ? rollout.enabled(feature, supported) : supported;
  return {
    ...baseCapabilities,
    models: hasModels,
    enqueue: worker.operations.run,
    prewarm: enabled("prewarm", worker.advanced.prewarm),
    "resident-session": enabled("resident", worker.advanced.residentSession),
    steer: enabled("steer", worker.advanced.steer),
    permissions: worker.operations.interactions,
    questions: worker.operations.interactions,
    mcp: worker.operations.configurationRefresh,
    subagents: enabled("subagents", worker.advanced.subagentProjection),
    fork: enabled("fork", worker.advanced.nativeFork && worker.operations.nativeFork),
    "plan-mode": enabled("plan", worker.advanced.planMode && worker.operations.currentTurnConfiguration),
    "file-checkpointing": enabled("checkpoint", worker.advanced.fileCheckpointing),
    rewind: enabled("rewind", worker.advanced.fileCheckpointing && worker.advanced.rewind),
    "dynamic-model": enabled("dynamic-model", hasModels && worker.operations.currentTurnConfiguration && worker.advanced.dynamicModel),
    "dynamic-effort": enabled("dynamic-effort", hasModels && worker.operations.currentTurnConfiguration && worker.advanced.dynamicEffort),
    "dynamic-permission-mode": enabled("dynamic-permission", worker.operations.currentTurnConfiguration && worker.advanced.dynamicPermissionMode),
  };
}

function workerEventData(value: ClaudeWorkerEvent): {
  workspaceId: string;
  sessionId: string;
  backendSessionId?: string | null;
  data: CanonicalAgentEventData;
} | null {
  const payload = value.payload;
  const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : null;
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  if (!workspaceId || !sessionId) return null;
  const data = workerCanonicalData(value.type, payload);
  if (!data) return null;
  const candidate = canonicalAgentEventSchema.safeParse({
    schemaVersion: 1,
    id: value.id,
    workspaceId,
    sessionId,
    runtimeId: CLAUDE_AGENT_RUNTIME_ID,
    sequence: 1,
    occurredAt: Date.parse(value.createdAt),
    data,
  });
  if (!candidate.success) return null;
  return {
    workspaceId,
    sessionId,
    ...(payload.backendSessionId === null || typeof payload.backendSessionId === "string"
      ? { backendSessionId: payload.backendSessionId }
      : {}),
    data: candidate.data.data,
  };
}

function workerCanonicalData(type: string, payload: Record<string, unknown>): Record<string, unknown> | null {
  if (type === "agent.event") {
    return typeof payload.data === "object" && payload.data !== null ? payload.data as Record<string, unknown> : null;
  }
  if (type === "session.status") return { type, status: payload.status };
  if (type === "message.updated") return { type, message: payload.message };
  if (type === "message.part.updated") return { type, messageId: payload.messageId, part: payload.part };
  if (type === "message.part.delta") {
    return { type, messageId: payload.messageId, partId: payload.partId, field: payload.field, delta: payload.delta };
  }
  if (type === "run.usage") return { type, runId: payload.runId, usage: payload.usage };
  if (type === "run.completed") return { type, runId: payload.runId, ...(payload.usage ? { usage: payload.usage } : {}) };
  if (type === "run.failed") {
    return { type, runId: payload.runId, code: payload.code, message: payload.message, retryable: payload.retryable };
  }
  if (type === "run.aborted") return { type, runId: payload.runId };
  return null;
}

function promptText(prompt: Record<string, unknown>): string {
  const parts = Array.isArray(prompt.parts) ? prompt.parts : [];
  const text = parts.flatMap((part) => typeof part === "object" && part !== null
    && (part as Record<string, unknown>).type === "text"
    && typeof (part as Record<string, unknown>).text === "string"
    ? [(part as Record<string, unknown>).text as string] : []).join("\n");
  if (!text.trim()) throw new AgentEngineError("runtime_request_failed", "Claude Agent prompt has no text content", {
    runtimeId: CLAUDE_AGENT_RUNTIME_ID,
  });
  return text;
}

function configuredModel(configuration: CanonicalAgentSession["configuration"]): string | undefined {
  const model = configuration.model;
  if (typeof model !== "object" || model === null || Array.isArray(model)) return undefined;
  return typeof model.modelId === "string" ? model.modelId : undefined;
}

function claudePermissionMode(configuration: AgentRuntimeCurrentTurnConfiguration | undefined): "default" | "acceptEdits" | "dontAsk" {
  const mode = configuration?.permissionMode;
  return mode === "accept-edits" ? "acceptEdits" : mode === "dont-ask" ? "dontAsk" : "default";
}

const ASK_USER_OPERATION: CanonicalToolOperation = { effect: "read", allowedInputKeys: ["questions"] };
const WEB_FETCH_OPERATION: CanonicalToolOperation = {
  effect: "network",
  allowedInputKeys: ["url", "prompt"],
  networkDestinations: [{ inputKey: "url" }],
};

function claudeToolOperation(toolName: string, input: Record<string, unknown>): CanonicalToolOperation | null {
  if (toolName === "AskUserQuestion") return ASK_USER_OPERATION;
  if (toolName === "WebFetch") return WEB_FETCH_OPERATION;
  const definitions: Record<string, { effect: "read" | "write"; pathKey?: string; allowMissing?: boolean; keys: string[] }> = {
    Read: { effect: "read", pathKey: "file_path", keys: ["file_path", "offset", "limit", "pages"] },
    Write: { effect: "write", pathKey: "file_path", allowMissing: true, keys: ["file_path", "content"] },
    Edit: { effect: "write", pathKey: "file_path", keys: ["file_path", "old_string", "new_string", "replace_all"] },
    NotebookEdit: { effect: "write", pathKey: "notebook_path", keys: ["notebook_path", "cell_id", "new_source", "cell_type", "edit_mode"] },
    Glob: { effect: "read", pathKey: typeof input.path === "string" ? "path" : undefined, keys: ["pattern", "path"] },
    Grep: { effect: "read", pathKey: typeof input.path === "string" ? "path" : undefined, keys: ["pattern", "path", "glob", "type", "output_mode", "-B", "-A", "-C", "-n", "-i", "head_limit", "offset", "multiline"] },
  };
  const definition = definitions[toolName];
  if (!definition) return null;
  return {
    effect: definition.effect,
    allowedInputKeys: definition.keys,
    ...(definition.pathKey ? {
      paths: [{
        inputKey: definition.pathKey,
        access: definition.effect === "read" ? "read" : "write",
        allowMissing: definition.allowMissing,
      }],
    } : {}),
  };
}

export class ClaudeAgentEngineAdapter implements AgentEnginePort {
  readonly runtimeId = CLAUDE_AGENT_RUNTIME_ID;

  readonly #now: () => number;
  readonly #models: AgentRuntimeModel[];
  readonly #sessions = new Map<string, SessionState>();
  readonly #activeRuns = new Map<string, string>();
  readonly #preToolPolicy: RuntimeNeutralPreToolPolicy;
  readonly #seenWorkerEvents = new Map<string, { ids: Set<string>; order: string[] }>();
  #disposed = false;
  readonly #mcpLeases = new Map<string, ClaudeMcpConfigurationLease>();

  constructor(private readonly options: ClaudeAgentEngineAdapterOptions) {
    this.#now = options.now ?? Date.now;
    this.#models = options.models ?? [];
    this.#preToolPolicy = new RuntimeNeutralPreToolPolicy({ authorizedRoots: options.authorizedRoots ?? [] });
  }

  async descriptor(): Promise<AgentRuntimeDescriptor> {
    let health = await this.health();
    let capabilities = baseCapabilities;
    try {
      if (this.options.unavailableHealth) throw new Error("runtime unavailable");
      const worker = await (await this.#client()).capabilities();
      capabilities = capabilityMap(worker, this.#models.length > 0, this.options.advancedRollout);
      if (!worker.sandbox.supported || !worker.sandbox.enabled || !worker.sandbox.failClosed || worker.sandbox.allowUnsandboxedCommands) {
        health = {
          status: "unavailable",
          checkedAt: this.#now(),
          reasonCode: worker.sandbox.reasonCode,
          message: "Claude Agent requires the fail-closed SDK sandbox on this host.",
        };
      }
    } catch {
      // Keep discovery available so callers receive the health diagnostic.
    }
    return agentRuntimeDescriptorSchema.parse({
      schemaVersion: 1,
      id: this.runtimeId,
      engine: "claude-agent-sdk",
      label: "Claude Agent",
      description: "Claude Agent SDK running in an isolated JuggleWork worker",
      isDefault: false,
      capabilities,
      health,
      models: this.#models,
      limitations: [
        ...(!capabilities["file-checkpointing"] ? [{ capability: "file-checkpointing" as const, code: "run_per_query_no_checkpoint_handle", message: "Claude file checkpoints are unavailable until a checkpoint-enabled resident Query is initialized." }] : []),
        ...(!capabilities.rewind ? [{ capability: "rewind" as const, code: "filesystem_rewind_unavailable", message: "Conversation rewind does not imply filesystem rewind; no files will be restored unless the runtime advertises rewind." }] : []),
        ...(capabilities.fork ? [{ capability: "fork" as const, code: "shared_working_tree", message: "Claude-native forks copy conversation history only. They share the current working tree and do not copy checkpoint or undo history." }] : []),
      ],
    });
  }

  async health(): Promise<AgentRuntimeHealth> {
    if (this.#disposed) {
      return { status: "stopping", checkedAt: this.#now(), reasonCode: null, message: null };
    }
    if (this.options.unavailableHealth) return this.options.unavailableHealth;
    try {
      const credential = await this.options.credentialReadiness?.();
      if (credential && !credential.ready) {
        return {
          status: "unavailable",
          checkedAt: this.#now(),
          reasonCode: credential.reasonCode,
          message: credential.provider && credential.authMethod
            ? `Claude Agent ${credential.provider} authentication is unavailable (${credential.authMethod}).`
            : "Claude Agent credentials are unavailable.",
        };
      }
      const client = await this.#client();
      const [health, worker] = await Promise.all([client.health(), client.capabilities()]);
      if (!worker.sandbox.supported || !worker.sandbox.enabled || !worker.sandbox.failClosed || worker.sandbox.allowUnsandboxedCommands) {
        return {
          status: "unavailable",
          checkedAt: this.#now(),
          reasonCode: worker.sandbox.reasonCode,
          message: "Claude Agent requires the fail-closed SDK sandbox on this host.",
        };
      }
      return agentRuntimeHealthSchema.parse({
        status: health.status,
        checkedAt: Date.parse(health.checkedAt),
        reasonCode: health.reasonCode,
        message: health.message,
      });
    } catch (error) {
      return {
        status: "failed",
        checkedAt: this.#now(),
        reasonCode: "worker_unavailable",
        message: "Claude Agent Worker is unavailable.",
      };
    }
  }

  async listModels(): Promise<AgentRuntimeModel[]> {
    return [...this.#models];
  }

  async createSession(input: CreateAgentSessionInput): Promise<CanonicalAgentSession> {
    this.#assertActive();
    const now = this.#now();
    const session = canonicalAgentSessionSchema.parse({
      id: input.sessionId,
      workspaceId: input.workspaceId,
      runtimeId: this.runtimeId,
      backendSessionId: null,
      title: input.title,
      canonicalCwd: input.directory,
      status: { type: "idle" },
      configuration: input.configuration,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });
    this.#sessions.set(session.id, {
      session,
      messages: new Map(),
      interactions: new Map(),
      latestSequence: 0,
      activeRunMayHaveMutated: false,
    });
    return session;
  }

  restoreSession(session: CanonicalAgentSession): void {
    if (session.runtimeId !== this.runtimeId) return;
    const existing = this.#sessions.get(session.id);
    if (existing) {
      existing.session = session;
      return;
    }
    this.#sessions.set(session.id, {
      session,
      messages: new Map(),
      interactions: new Map(),
      latestSequence: 0,
      activeRunMayHaveMutated: false,
    });
  }

  async listSessions(context: AgentEngineContext): Promise<CanonicalAgentSession[]> {
    return [...this.#sessions.values()].map(({ session }) => session).filter(({ workspaceId }) => workspaceId === context.workspaceId);
  }

  async readSession(input: ReadAgentSessionInput): Promise<CanonicalAgentSession> {
    return this.#state(input).session;
  }

  async readMessages(input: ReadAgentSessionInput): Promise<CanonicalAgentMessage[]> {
    const messages = [...this.#state(input).messages.values()].sort((left, right) => left.createdAt - right.createdAt);
    return input.limit === undefined ? messages : messages.slice(-input.limit);
  }

  async readSnapshot(input: ReadAgentSessionInput): Promise<CanonicalSessionSnapshot> {
    const state = this.#state(input);
    return canonicalSessionSnapshotSchema.parse({
      schemaVersion: 1,
      session: state.session,
      messages: await this.readMessages(input),
      todos: [],
      interactions: [...state.interactions.values()],
      latestSequence: state.latestSequence,
    });
  }

  async deleteSession(input: ReadAgentSessionInput): Promise<void> {
    this.#sessions.delete(input.sessionId);
    this.#activeRuns.delete(input.sessionId);
  }

  async updateSession(input: UpdateAgentSessionInput): Promise<CanonicalAgentSession> {
    const state = this.#state(input);
    state.session = { ...state.session, title: input.title, updatedAt: this.#now() };
    return state.session;
  }

  async startRun(input: StartAgentRunInput): Promise<void> {
    const state = this.#state(input);
    this.#assertBackendBinding(state, input.backendSessionId);
    const previousActiveRun = this.#activeRuns.get(input.sessionId);
    state.activeRunMayHaveMutated = false;
    this.#activeRuns.set(input.sessionId, input.runId);
    try {
      const workerCapabilities = await (await this.#client()).capabilities();
      for (const [feature, supported] of [
        ["prewarm", workerCapabilities.advanced.prewarm],
        ["resident", workerCapabilities.advanced.residentSession],
      ] as const) {
        if (!this.#useAdvanced(feature, supported)) this.options.advancedRollout?.fallback(feature);
      }
      if (input.delivery === "enqueue"
        && !this.#useAdvanced("queued-input", workerCapabilities.advanced.queuedInput)) {
        this.options.advancedRollout?.fallback("queued-input");
      }
      if (input.delivery === "steer" && !this.#useAdvanced("steer", workerCapabilities.advanced.steer)) {
        throw new AgentEngineError("runtime_capability_unsupported", "Claude Agent does not support steering", {
          runtimeId: this.runtimeId,
          capability: "steer",
        });
      }
      if (input.currentTurn?.model && !this.#useAdvanced("dynamic-model", workerCapabilities.advanced.dynamicModel)) throw this.#unsupported("dynamic-model");
      if (input.currentTurn?.effort && !this.#useAdvanced("dynamic-effort", workerCapabilities.advanced.dynamicEffort)) throw this.#unsupported("dynamic-effort");
      if (input.currentTurn?.permissionMode && input.currentTurn.permissionMode !== "default"
        && !this.#useAdvanced("dynamic-permission", workerCapabilities.advanced.dynamicPermissionMode)) throw this.#unsupported("dynamic-permission-mode");
      if (input.currentTurn?.planMode && !this.#useAdvanced("plan", workerCapabilities.advanced.planMode)) throw this.#unsupported("plan-mode");
      if (this.options.resolveMcpConfiguration) await this.reloadConfiguration(input);
      const result = await (await this.#client()).run({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId ?? state.session.backendSessionId,
        runId: input.runId,
        cwd: input.directory,
        prompt: promptText(input.prompt),
        delivery: input.delivery === "steer" ? "steer" : input.delivery === "enqueue" ? "enqueue" : "start",
        limits: {
          maxTurns: 50,
          maxBudgetUsd: 100,
          wallClockMs: 30 * 60_000,
          hardCloseMs: 2_000,
          approvalDeadlineMs: Math.max(100, Math.min(this.options.approvalDeadlineMs ?? 2 * 60_000, 10 * 60_000)),
        },
        permissionPolicy: this.options.permissionPolicy ?? { mode: "default" },
        permissionMode: claudePermissionMode(input.currentTurn),
        planMode: input.currentTurn?.planMode === true,
        ...(input.currentTurn?.effort ? { effort: input.currentTurn.effort } : {}),
        ...(input.currentTurn?.model?.modelId || configuredModel(state.session.configuration)
          ? { model: input.currentTurn?.model?.modelId ?? configuredModel(state.session.configuration) }
          : {}),
      });
      const updatedAt = this.#now();
      state.session = {
        ...state.session,
        backendSessionId: result.backendSessionId ?? state.session.backendSessionId,
        ...(this.#activeRuns.get(input.sessionId) === input.runId ? { status: { type: "starting" } as const } : {}),
        updatedAt,
      };
    } catch (error) {
      if (this.#activeRuns.get(input.sessionId) === input.runId) {
        if (previousActiveRun) this.#activeRuns.set(input.sessionId, previousActiveRun);
        else this.#activeRuns.delete(input.sessionId);
      }
      if (input.delivery === "steer" && error instanceof ClaudeWorkerClientError && error.code === "unsupported_capability") {
        throw this.#unsupported("steer");
      }
      if (error instanceof ClaudeWorkerClientError && (error.code === "request_failed" || error.code === "invalid_response")) {
        state.session = {
          ...state.session,
          status: {
            type: "interrupted",
            ambiguous: true,
            message: "Claude Agent transport was lost while starting the turn. The turn may have changed external state.",
          },
          updatedAt: this.#now(),
        };
        throw new AgentEngineError(
          "runtime_request_failed",
          "Claude Agent run start was interrupted with an ambiguous outcome",
          { runtimeId: this.runtimeId, operation: "run start", interruptedAmbiguous: true },
          { cause: error },
        );
      }
      throw engineError(error, "run start");
    }
  }

  async abortRun(input: AbortAgentRunInput): Promise<void> {
    const state = this.#state(input);
    this.#assertBackendBinding(state, input.backendSessionId);
    try {
      if (this.options.advancedRollout) {
        const capabilities = await (await this.#client()).capabilities();
        if (!this.#useAdvanced("interrupt", capabilities.advanced.protocolInterrupt)) {
          this.options.advancedRollout.fallback("interrupt");
        }
      }
      await (await this.#client()).abort(input.sessionId, input.runId);
      state.session = { ...state.session, status: { type: "aborting" }, updatedAt: this.#now() };
    } catch (error) {
      throw engineError(error, "run abort");
    }
  }

  async stopSubagent(input: StopAgentSubagentInput): Promise<void> {
    const state = this.#state(input);
    this.#assertBackendBinding(state, input.backendSessionId);
    const capabilities = await (await this.#client()).capabilities();
    if (!this.#useAdvanced("subagents", capabilities.advanced.subagentStop && capabilities.operations.stopSubagent)) throw this.#unsupported("subagents");
    await (await this.#client()).stopSubagent(input.sessionId, input.runId, input.taskId);
  }

  async forkSession(input: ForkAgentSessionInput): Promise<ForkAgentSessionResult> {
    const source = this.#sessions.get(input.sourceSessionId);
    if (!source || source.session.backendSessionId !== input.sourceBackendSessionId) {
      throw new AgentEngineError("runtime_session_mismatch", "Claude fork source does not match its backend binding", { runtimeId: this.runtimeId });
    }
    const capabilities = await (await this.#client()).capabilities();
    if (!this.#useAdvanced("fork", capabilities.advanced.nativeFork && capabilities.operations.nativeFork)) throw this.#unsupported("fork");
    const result = await (await this.#client()).forkSession({
      sourceBackendSessionId: input.sourceBackendSessionId,
      cwd: input.directory,
      title: input.title,
      ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
    });
    const now = this.#now();
    const session = canonicalAgentSessionSchema.parse({
      id: input.targetSessionId,
      workspaceId: input.workspaceId,
      runtimeId: this.runtimeId,
      backendSessionId: result.backendSessionId,
      title: input.title,
      canonicalCwd: input.directory,
      status: { type: "idle" },
      configuration: source.session.configuration,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });
    this.restoreSession(session);
    return { session, filesystemState: result.filesystemState };
  }

  async *subscribeEvents(context: AgentEngineContext, signal?: AbortSignal): AsyncIterable<CanonicalAgentEvent> {
    let cursor = 0;
    try {
      for await (const raw of (await this.#client()).events(cursor, signal)) {
        cursor = raw.sequence;
        const rawWorkspaceId = typeof raw.payload.workspaceId === "string" ? raw.payload.workspaceId : null;
        if (rawWorkspaceId && rawWorkspaceId !== context.workspaceId) continue;
        if (rawWorkspaceId && this.#hasSeenWorkerEvent(rawWorkspaceId, raw.id)) continue;
        if (raw.type === "mcp.diagnostic") {
          const state = raw.payload.code === "mcp_output_truncated" ? "output_truncated" : raw.payload.state;
          if (state === "initializing" || state === "pending" || state === "connected" || state === "failed"
            || state === "needs_auth" || state === "expired" || state === "removed" || state === "output_truncated") {
            this.options.onTelemetry?.({ type: "mcp", state });
          }
          if (rawWorkspaceId) this.#markWorkerEventSeen(rawWorkspaceId, raw.id);
          continue;
        }
        if (raw.type === "tool.policy.requested") {
          await this.#resolveToolPolicy(context, raw);
          if (rawWorkspaceId) this.#markWorkerEventSeen(rawWorkspaceId, raw.id);
          continue;
        }
        if (raw.type.startsWith("worker.")) continue;
        if (raw.type === "run.mutation.possible") {
          const sessionId = typeof raw.payload.sessionId === "string" ? raw.payload.sessionId : null;
          const runId = typeof raw.payload.runId === "string" ? raw.payload.runId : null;
          const state = sessionId ? this.#sessions.get(sessionId) : null;
          if (state && runId && this.#activeRuns.get(sessionId!) === runId) state.activeRunMayHaveMutated = true;
          if (rawWorkspaceId) this.#markWorkerEventSeen(rawWorkspaceId, raw.id);
          continue;
        }
        const mapped = workerEventData(raw);
        if (!mapped || mapped.workspaceId !== context.workspaceId) continue;
        const state = this.#sessions.get(mapped.sessionId);
        if (!state) continue;
        if (mapped.backendSessionId !== undefined) {
          this.#assertBackendBinding(state, mapped.backendSessionId);
          state.session = { ...state.session, backendSessionId: mapped.backendSessionId };
        }
        this.#applyEvent(state, mapped.data);
        const event = canonicalAgentEventSchema.parse({
          schemaVersion: 1,
          id: raw.id,
          workspaceId: mapped.workspaceId,
          sessionId: mapped.sessionId,
          runtimeId: this.runtimeId,
          sequence: ++state.latestSequence,
          occurredAt: Date.parse(raw.createdAt),
          data: mapped.data,
        });
        this.#markWorkerEventSeen(mapped.workspaceId, raw.id);
        yield event;
      }
    } catch (error) {
      if (signal?.aborted) return;
      this.options.onTelemetry?.({ type: "transport_lost" });
      yield* this.#interruptedEvents(context);
      throw engineError(error, "event subscription");
    }
    if (!signal?.aborted) yield* this.#interruptedEvents(context);
  }

  async resolveInteraction(input: ResolveAgentInteractionInput): Promise<void> {
    const state = this.#state(input);
    this.#assertBackendBinding(state, input.backendSessionId);
    try {
      await (await this.#client()).resolveInteraction(
        input.interactionId,
        input.sessionId,
        interactionRunId(state, input.interactionId),
        canonicalInteractionResolutionSchema.parse(input.resolution),
      );
    } catch (error) {
      if (error instanceof ClaudeWorkerClientError && error.code === "already_resolved") {
        throw new InteractionResolutionError("already_resolved");
      }
      throw engineError(error, "interaction resolution");
    }
  }

  async reloadConfiguration(context: AgentEngineContext): Promise<void> {
    if (!this.options.resolveMcpConfiguration) throw this.#unsupported("mcp");
    const lease = await this.options.resolveMcpConfiguration(context);
    try {
      if (lease.configuration.workspaceId !== context.workspaceId) {
        throw new AgentEngineError("runtime_session_mismatch", "Claude MCP configuration belongs to another workspace", {
          runtimeId: this.runtimeId,
          workspaceId: context.workspaceId,
        });
      }
      await (await this.#client()).refreshConfiguration(lease.configuration);
      const previous = this.#mcpLeases.get(context.workspaceId);
      this.#mcpLeases.set(context.workspaceId, lease);
      await previous?.release();
    } catch (error) {
      await lease.release();
      throw engineError(error, "configuration refresh");
    }
  }

  async registerMcp(context: AgentEngineContext, _name: string, _configuration: Record<string, unknown>): Promise<void> {
    await this.reloadConfiguration(context);
  }

  async disconnectMcp(context: AgentEngineContext, _name: string): Promise<void> {
    await this.reloadConfiguration(context);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sessions.clear();
    this.#activeRuns.clear();
    this.#seenWorkerEvents.clear();
    await Promise.allSettled([...this.#mcpLeases.values()].map((lease) => Promise.resolve(lease.release())));
    this.#mcpLeases.clear();
    await this.options.dispose?.();
  }

  async #client(): Promise<ClaudeWorkerApi> {
    this.#assertActive();
    try {
      return await this.options.getClient();
    } catch (error) {
      throw engineError(error, "connection");
    }
  }

  async #resolveToolPolicy(context: AgentEngineContext, event: ClaudeWorkerEvent): Promise<void> {
    const payload = event.payload;
    const workspaceId = typeof payload.workspaceId === "string" ? payload.workspaceId : "";
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const runId = typeof payload.runId === "string" ? payload.runId : "";
    const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    const input = typeof payload.input === "object" && payload.input !== null && !Array.isArray(payload.input)
      ? payload.input as Record<string, unknown> : {};
    let decision: PreToolPolicyDecision = {
      decision: "deny",
      code: "invalid_policy_request",
      reason: "Claude tool is not registered with mandatory policy",
      basis: ["unknown_tool"],
    };
    const operation = claudeToolOperation(toolName, input);
    if (workspaceId === context.workspaceId && sessionId && runId && requestId && operation) {
      decision = await this.#preToolPolicy.evaluate({
        runtimeId: this.runtimeId,
        toolName,
        workspaceId,
        sessionId,
        workspaceRoot: context.directory,
        actor: { id: "claude-runtime", scope: "collaborator", workspaceId, sessionId },
        input,
        operation,
      });
    }
    if (!requestId || !sessionId || !runId) return;
    await (await this.#client()).resolveInteraction(
      requestId,
      sessionId,
      runId,
      decision.decision === "allow"
        ? { outcome: "allow", updatedInput: decision.input }
        : { outcome: "deny", reason: decision.reason },
    );
  }

  #state(input: ReadAgentSessionInput | StartAgentRunInput | AbortAgentRunInput | ResolveAgentInteractionInput): SessionState {
    this.#assertActive();
    const state = this.#sessions.get(input.sessionId);
    if (!state) {
      throw new AgentEngineError("runtime_request_failed", "Claude Agent session is not loaded", {
        runtimeId: this.runtimeId,
        sessionId: input.sessionId,
      });
    }
    if (state.session.workspaceId !== input.workspaceId) {
      throw new AgentEngineError("runtime_session_mismatch", "Claude Agent session belongs to another workspace", {
        runtimeId: this.runtimeId,
        sessionId: input.sessionId,
      });
    }
    if ("backendSessionId" in input && input.backendSessionId !== undefined) {
      this.#assertBackendBinding(state, input.backendSessionId);
    }
    return state;
  }

  #assertBackendBinding(state: SessionState, supplied: string | null | undefined): void {
    const expected = state.session.backendSessionId;
    if (expected && supplied && expected !== supplied) {
      throw new AgentEngineError("runtime_session_mismatch", "Claude backend session does not match the runtime binding", {
        runtimeId: this.runtimeId,
        sessionId: state.session.id,
        expectedBackendSessionId: expected,
        backendSessionId: supplied,
      });
    }
  }

  #applyEvent(state: SessionState, data: CanonicalAgentEventData): void {
    const updatedAt = this.#now();
    if (data.type === "session.created" || data.type === "session.updated") {
      state.session = { ...data.session, id: state.session.id, workspaceId: state.session.workspaceId, runtimeId: this.runtimeId };
    } else if (data.type === "session.status") {
      state.session = { ...state.session, status: data.status, updatedAt };
    } else if (data.type === "message.updated") {
      state.messages.set(data.message.id, data.message);
    } else if (data.type === "message.part.updated") {
      const message = state.messages.get(data.messageId);
      if (message) {
        const index = message.parts.findIndex(({ id }) => id === data.part.id);
        state.messages.set(message.id, {
          ...message,
          parts: index < 0
            ? [...message.parts, data.part]
            : message.parts.map((part, partIndex) => partIndex === index ? data.part : part),
        });
      }
    } else if (data.type === "interaction.requested" || data.type === "interaction.resolved") {
      state.interactions.set(data.interaction.id, data.interaction);
    } else if (data.type === "run.completed" || data.type === "run.failed" || data.type === "run.aborted") {
      if (this.#activeRuns.get(state.session.id) !== data.runId) return;
      state.session = { ...state.session, status: { type: "idle" }, updatedAt };
      state.activeRunMayHaveMutated = false;
      this.#activeRuns.delete(state.session.id);
    }
  }

  *#interruptedEvents(context: AgentEngineContext): Iterable<CanonicalAgentEvent> {
    for (const [sessionId, runId] of [...this.#activeRuns]) {
      const state = this.#sessions.get(sessionId);
      if (!state || state.session.workspaceId !== context.workspaceId) continue;
      const ambiguous = state.activeRunMayHaveMutated;
      const message = ambiguous
        ? "Claude Agent was interrupted after a tool may have changed external state. Verify the result before retrying."
        : "Claude Agent was interrupted before any potentially mutating tool was observed."
      state.session = {
        ...state.session,
        status: { type: "interrupted", ambiguous, message },
        updatedAt: this.#now(),
      };
      state.activeRunMayHaveMutated = false;
      this.#activeRuns.delete(sessionId);
      yield canonicalAgentEventSchema.parse({
        schemaVersion: 1,
        id: `claude:transport-loss:${runId}`,
        workspaceId: context.workspaceId,
        sessionId,
        runtimeId: this.runtimeId,
        sequence: ++state.latestSequence,
        occurredAt: this.#now(),
        data: {
          type: "run.failed",
          runId,
          code: ambiguous ? "worker_transport_lost_ambiguous" : "worker_transport_lost_safe",
          message,
          retryable: !ambiguous,
        },
      });
    }
  }

  #assertActive(): void {
    if (!this.#disposed) return;
    throw new AgentEngineError("runtime_unavailable", "Claude Agent adapter has been disposed", {
      runtimeId: this.runtimeId,
    });
  }

  #unsupported(capability: string): AgentEngineError {
    return new AgentEngineError("runtime_capability_unsupported", `Claude Agent does not support ${capability}`, {
      runtimeId: this.runtimeId,
      capability,
    });
  }

  #useAdvanced(feature: ClaudeAdvancedFeature, supported: boolean): boolean {
    return this.options.advancedRollout?.use(feature, supported) ?? supported;
  }

  #hasSeenWorkerEvent(workspaceId: string, eventId: string): boolean {
    return this.#seenWorkerEvents.get(workspaceId)?.ids.has(eventId) ?? false;
  }

  #markWorkerEventSeen(workspaceId: string, eventId: string): void {
    const seen = this.#seenWorkerEvents.get(workspaceId) ?? { ids: new Set<string>(), order: [] };
    if (seen.ids.has(eventId)) return;
    seen.ids.add(eventId);
    seen.order.push(eventId);
    while (seen.order.length > MAX_SEEN_WORKER_EVENTS_PER_WORKSPACE) {
      const expired = seen.order.shift();
      if (expired) seen.ids.delete(expired);
    }
    this.#seenWorkerEvents.set(workspaceId, seen);
  }
}

function interactionRunId(state: SessionState, interactionId: string): string {
  const interaction = state.interactions.get(interactionId);
  if (!interaction) {
    throw new AgentEngineError("runtime_request_failed", "Claude Agent interaction is not loaded", {
      runtimeId: CLAUDE_AGENT_RUNTIME_ID,
      interactionId,
    });
  }
  return interaction.runId;
}

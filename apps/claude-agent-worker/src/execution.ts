import { createHash } from "node:crypto"
import { dirname } from "node:path"

import {
  AbortError,
  forkSession as sdkForkSession,
  query as sdkQuery,
  startup as sdkStartup,
  type CanUseTool,
  type HookCallback,
  type Options as ClaudeQueryOptions,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"

import type {
  ClaudeWorkerEvent,
  ClaudeWorkerRunObservation,
  ClaudeWorkerRunRequest,
  ClaudeWorkerRunResponse,
  ClaudeWorkerInteractionResolution,
  ClaudeWorkerForkRequest,
  ClaudeWorkerForkResponse,
} from "./schemas.js"
import { buildClaudeSubprocessEnvironment, scrubClaudeSubprocessSecrets } from "./environment.js"
import {
  ClaudeInputQueue,
  ClaudeStartupPool,
  resolveClaudeAdvancedRuntimePolicy,
  type ClaudeAdvancedRuntimeCapabilities,
  type ClaudeAdvancedRuntimePolicy,
  type ClaudeStartupFactory,
} from "./advanced-runtime.js"
import type { ClaudeMcpRuntime } from "./mcp-runtime.js"
import { boundAndRedactMcpOutput } from "./mcp-runtime.js"
import {
  failClosedClaudeSandboxSettings,
  inspectClaudeSandboxCapability,
  type ClaudeSandboxCapability,
} from "./sandbox.js"

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
type PublishEvent = (type: ClaudeWorkerEvent["type"], payload?: Record<string, unknown>) => ClaudeWorkerEvent

export interface ClaudeQueryFactory {
  (params: { prompt: string; options: ClaudeQueryOptions }): Query
}

export interface ClaudeRunController {
  start(input: ClaudeWorkerRunRequest): Promise<ClaudeWorkerRunResponse>
  abort(sessionId: string, runId: string): Promise<void>
  observe(runId: string): ClaudeWorkerRunObservation | null
  resolveInteraction(
    interactionId: string,
    sessionId: string,
    runId: string,
    resolution: ClaudeWorkerInteractionResolution,
  ): Promise<void>
  advancedCapabilities?(): ClaudeAdvancedRuntimeCapabilities
  stopSubagent?(sessionId: string, runId: string, taskId: string): Promise<void>
  forkSession?(input: ClaudeWorkerForkRequest): Promise<ClaudeWorkerForkResponse>
  closeAll(): Promise<void>
}

export interface ClaudeRunServiceResourceCounts {
  activeSessions: number
  retainedRuns: number
  messages: number
  tools: number
  toolResolutionStates: number
  completedMessages: number
  pendingInteractions: number
  pendingToolPolicies: number
  resolvedInteractions: number
}

export class ClaudeRunError extends Error {
  constructor(
    readonly code: "run_not_found" | "session_busy" | "unsupported_capability" | "session_mismatch" | "interaction_not_found" | "already_resolved",
    message: string,
  ) {
    super(message)
    this.name = "ClaudeRunError"
  }
}

interface ActiveRun {
  input: ClaudeWorkerRunRequest
  query: Query
  controller: AbortController
  observation: ClaudeWorkerRunObservation
  approvalCancellations: Set<() => void>
  completion: Promise<void>
  resolveCompletion: () => void
  settled: boolean
  finished: boolean
  abortReason: "user" | "wall_clock" | "shutdown" | null
  hardCloseTimer: ReturnType<typeof setTimeout> | null
  wallClockTimer: ReturnType<typeof setTimeout> | null
  detachMcp: () => void
  resident: boolean
  prewarm: { key: string; options: ClaudeQueryOptions } | null
}

interface ResidentSession {
  sessionId: string
  workspaceId: string
  cwd: string
  backendSessionId: string | null
  query: Query
  controller: AbortController
  input: ClaudeInputQueue
  runs: ActiveRun[]
  current: ActiveRun
  initialized: boolean
  capabilities: Set<string>
  idleTimer: ReturnType<typeof setTimeout> | null
  detachMcp: () => void
}

interface MessageState {
  id: string
  createdAt: number
  textByPart: Map<number, string>
  reasoningByPart: Map<number, string>
}

interface ToolState {
  messageId: string
  partId: string
  toolCallId: string
  toolName: string
  ordinal: number
  createdAt: number
  input?: JsonValue
}

interface SubagentState {
  label: string
  parentToolUseId: string | null
}

interface PendingInteraction {
  id: string
  run: ActiveRun
  kind: "permission" | "question"
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  questions: Array<{ id: string; prompt: string; options?: string[]; multiple: boolean }>
  settle: (resolution: ClaudeWorkerInteractionResolution) => void
  removeAbortListener: () => void
  deadlineTimer: ReturnType<typeof setTimeout>
}

interface PendingToolPolicy {
  id: string
  run: ActiveRun
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  settle: (resolution: ClaudeWorkerInteractionResolution) => void
  removeAbortListener: () => void
  deadlineTimer: ReturnType<typeof setTimeout>
}

export interface ClaudeRunServiceOptions {
  claudeExecutablePath: string
  claudeConfigDir: string
  publishEvent: PublishEvent
  query?: ClaudeQueryFactory
  streamingQuery?: (params: { prompt: AsyncIterable<SDKUserMessage>; options: ClaudeQueryOptions }) => Query
  startup?: ClaudeStartupFactory
  forkSession?: typeof sdkForkSession
  advancedPolicy?: Partial<ClaudeAdvancedRuntimePolicy>
  now?: () => number
  claudeEnv?: Record<string, string | undefined>
  mcpRuntime?: ClaudeMcpRuntime
  sandboxCapability?: ClaudeSandboxCapability
  maxRetainedRuns?: number
  maxRetainedProjectionEntries?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

function jsonValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value)
    return encoded === undefined ? null : JSON.parse(encoded) as JsonValue
  } catch {
    return null
  }
}

function canonicalId(kind: string, ...backendIds: Array<string | number>): string {
  const digest = createHash("sha256").update(backendIds.join("\0"), "utf8").digest("base64url").slice(0, 32)
  return `claude:${kind}:${digest}`
}

function errorMessage(error: unknown, env: NodeJS.ProcessEnv): string {
  return scrubClaudeSubprocessSecrets(error, env).slice(0, 20_000)
}

function aggregateUsage(message: Record<string, unknown>): Record<string, unknown> {
  const modelUsage = isRecord(message.modelUsage) ? message.modelUsage : {}
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  for (const usage of Object.values(modelUsage)) {
    if (!isRecord(usage)) continue
    inputTokens += numberValue(usage.inputTokens) ?? 0
    outputTokens += numberValue(usage.outputTokens) ?? 0
    cacheReadTokens += numberValue(usage.cacheReadInputTokens) ?? 0
    cacheWriteTokens += numberValue(usage.cacheCreationInputTokens) ?? 0
  }
  const fallback = isRecord(message.usage) ? message.usage : {}
  return {
    inputTokens: inputTokens || numberValue(fallback.input_tokens) || 0,
    outputTokens: outputTokens || numberValue(fallback.output_tokens) || 0,
    cacheReadTokens: cacheReadTokens || numberValue(fallback.cache_read_input_tokens) || 0,
    cacheWriteTokens: cacheWriteTokens || numberValue(fallback.cache_creation_input_tokens) || 0,
    turns: numberValue(message.num_turns) ?? 0,
    durationMs: numberValue(message.duration_ms) ?? 0,
    apiDurationMs: numberValue(message.duration_api_ms) ?? 0,
    estimatedCostUsd: numberValue(message.total_cost_usd) ?? 0,
    estimateOnly: true,
    modelUsage: jsonValue(modelUsage),
  }
}

function retryableResult(subtype: unknown): boolean {
  return subtype === "error_during_execution"
}

function taskState(value: unknown): "pending" | "running" | "completed" | "error" | "cancelled" {
  if (value === "completed") return "completed"
  if (value === "failed") return "error"
  if (value === "stopped" || value === "killed") return "cancelled"
  if (value === "pending" || value === "paused") return "pending"
  return "running"
}

const NON_MUTATING_TOOLS = new Set([
  "AskUserQuestion",
  "Glob",
  "Grep",
  "Read",
  "TodoRead",
  "WebFetch",
  "WebSearch",
])

function mayMutate(toolName: string): boolean {
  return !NON_MUTATING_TOOLS.has(toolName)
}

function userMessage(prompt: string, priority?: SDKUserMessage["priority"]): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
    ...(priority ? { priority } : {}),
  }
}

export class ClaudeRunService implements ClaudeRunController {
  readonly #activeBySession = new Map<string, ActiveRun>()
  readonly #runs = new Map<string, ActiveRun>()
  readonly #query: ClaudeQueryFactory
  readonly #forkSession: typeof sdkForkSession
  readonly #now: () => number
  readonly #messages = new Map<string, MessageState>()
  readonly #tools = new Map<string, ToolState>()
  readonly #toolResolutionStates = new Map<string, "running" | "cancelled">()
  readonly #completedMessages = new Set<string>()
  readonly #subagents = new Map<string, SubagentState>()
  readonly #pendingInteractions = new Map<string, PendingInteraction>()
  readonly #pendingToolPolicies = new Map<string, PendingToolPolicy>()
  readonly #resolvedInteractions = new Set<string>()
  readonly #sandboxCapability: ClaudeSandboxCapability
  readonly #maxRetainedRuns: number
  readonly #maxRetainedProjectionEntries: number
  readonly #completedRunIds: string[] = []
  readonly #advancedPolicy: ClaudeAdvancedRuntimePolicy
  readonly #startupPool: ClaudeStartupPool | null
  readonly #residentBySession = new Map<string, ResidentSession>()
  #residentInitialized = false
  #protocolCapabilities = new Set<string>()

  constructor(private readonly options: ClaudeRunServiceOptions) {
    this.#query = options.query ?? sdkQuery
    this.#forkSession = options.forkSession ?? sdkForkSession
    this.#now = options.now ?? Date.now
    this.#sandboxCapability = options.sandboxCapability ?? inspectClaudeSandboxCapability()
    this.#maxRetainedRuns = positiveInteger(options.maxRetainedRuns ?? 1_000, "maxRetainedRuns")
    this.#maxRetainedProjectionEntries = positiveInteger(
      options.maxRetainedProjectionEntries ?? 10_000,
      "maxRetainedProjectionEntries",
    )
    this.#advancedPolicy = { ...resolveClaudeAdvancedRuntimePolicy({}), ...options.advancedPolicy }
    this.#startupPool = this.#advancedPolicy.prewarm ? new ClaudeStartupPool({
      startup: options.startup ?? sdkStartup,
      maxSize: this.#advancedPolicy.prewarmPoolSize,
      idleMs: this.#advancedPolicy.prewarmIdleMs,
      now: this.#now,
    }) : null
    if (!options.claudeExecutablePath.trim()) throw new Error("Claude executable path is required")
    if (!options.claudeConfigDir.trim()) throw new Error("Isolated Claude config directory is required")
  }

  async start(input: ClaudeWorkerRunRequest): Promise<ClaudeWorkerRunResponse> {
    if (input.planMode && !this.#advancedPolicy.planMode) {
      throw new ClaudeRunError("unsupported_capability", "Claude plan mode is disabled")
    }
    const resident = this.#residentBySession.get(input.sessionId)
    if (resident) return this.#startResidentInput(resident, input)
    if (input.delivery === "steer") {
      throw new ClaudeRunError("unsupported_capability", "Claude steering requires an initialized resident session")
    }
    if (this.#activeBySession.has(input.sessionId)) {
      throw new ClaudeRunError("session_busy", "Claude session already has an active run")
    }

    let controller = new AbortController()
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    let run!: ActiveRun
    const currentRun = () => this.#activeBySession.get(input.sessionId) ?? run
    const canUseTool: CanUseTool = async (toolName, toolInput, callbackOptions) => {
      const active = currentRun()
      const policy = await this.#requestToolPolicy(active, toolName, toolInput, callbackOptions.toolUseID, callbackOptions.signal, "permission")
      if (policy.behavior === "deny") return policy
      if (toolName === "AskUserQuestion") {
        return this.#requestToolInteraction(active, toolName, policy.updatedInput ?? toolInput, callbackOptions)
      }
      if (active.input.permissionPolicy.mode === "headless") {
        if (active.input.permissionPolicy.action === "deny") {
          return { behavior: "deny", message: "Headless permission policy denies unapproved tools", toolUseID: callbackOptions.toolUseID }
        }
        if (active.input.permissionPolicy.action === "preapproved") {
          if (mayMutate(toolName)) {
            this.#publish(active, "run.mutation.possible", {
              toolName,
              toolUseId: callbackOptions.toolUseID,
            })
          }
          return { behavior: "allow", updatedInput: policy.updatedInput ?? toolInput, toolUseID: callbackOptions.toolUseID }
        }
      }
      return this.#requestToolInteraction(active, toolName, policy.updatedInput ?? toolInput, callbackOptions)
    }
    const preToolUse: HookCallback = async (hookInput, toolUseID, hookOptions) => {
      if (hookInput.hook_event_name !== "PreToolUse") {
        return { continue: false, stopReason: "Invalid mandatory policy hook input" }
      }
      const policy = await this.#requestToolPolicy(
        currentRun(),
        hookInput.tool_name,
        hookInput.tool_input,
        toolUseID ?? hookInput.tool_use_id,
        hookOptions.signal,
        "pre_tool_hook",
      )
      if (policy.behavior === "deny") {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: policy.message,
          },
        }
      }
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "defer",
          updatedInput: policy.updatedInput ?? (isRecord(hookInput.tool_input) ? hookInput.tool_input : {}),
        },
      }
    }
    const sandbox = failClosedClaudeSandboxSettings(this.#sandboxCapability)
    const queryOptions: ClaudeQueryOptions = {
        abortController: controller,
        cwd: input.cwd,
        ...(input.backendSessionId ? { resume: input.backendSessionId } : {}),
        includePartialMessages: true,
        maxTurns: input.limits.maxTurns,
        maxBudgetUsd: input.limits.maxBudgetUsd,
        pathToClaudeCodeExecutable: this.options.claudeExecutablePath,
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: this.options.mcpRuntime?.configurationForRun(input) ?? {},
        permissionMode: input.planMode ? "plan" : input.permissionMode ?? "default",
        allowDangerouslySkipPermissions: false,
        forwardSubagentText: this.#advancedPolicy.subagents,
        agentProgressSummaries: this.#advancedPolicy.subagents,
        hooks: {
          PreToolUse: [{
            hooks: [preToolUse],
            timeout: Math.max(1, Math.ceil(input.limits.approvalDeadlineMs / 1_000)),
          }],
        },
        sandbox,
        canUseTool,
        onElicitation: async (request) => this.options.mcpRuntime?.rejectInteractiveOAuth(
          input.workspaceId,
          request.serverName,
        ) ?? { action: "decline" },
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        env: {
          ...buildClaudeSubprocessEnvironment({
            ...process.env,
            ...this.options.claudeEnv,
            JUGGLEWORK_CLAUDE_PROFILE_DATA_DIR: dirname(this.options.claudeConfigDir),
            CLAUDE_CONFIG_DIR: this.options.claudeConfigDir,
          }),
          CLAUDE_AGENT_SDK_CLIENT_APP: "jugglework-claude-agent-worker/1",
        },
      }
    const warmKey = this.#warmKey(input, queryOptions)
    const warm = this.#startupPool?.take(warmKey)
    if (warm) controller = warm.controller
    const residentInput = this.#advancedPolicy.residentSession ? new ClaudeInputQueue() : null
    if (residentInput) residentInput.push(userMessage(input.prompt))
    const query = warm?.query(residentInput ?? input.prompt)
      ?? (residentInput
        ? (this.options.streamingQuery ?? sdkQuery)({ prompt: residentInput, options: queryOptions })
        : this.#query({ prompt: input.prompt, options: queryOptions }))
    run = {
      input,
      query,
      controller,
      observation: {
        runId: input.runId,
        sessionId: input.sessionId,
        backendSessionId: input.backendSessionId,
        status: "starting",
        terminal: false,
        errorCode: null,
      },
      approvalCancellations: new Set(),
      completion,
      resolveCompletion,
      settled: false,
      finished: false,
      abortReason: null,
      hardCloseTimer: null,
      wallClockTimer: null,
      detachMcp: () => undefined,
      resident: Boolean(residentInput),
      prewarm: residentInput ? null : { key: warmKey, options: queryOptions },
    }
    run.detachMcp = this.options.mcpRuntime?.attachQuery(input.workspaceId, query) ?? (() => undefined)
    this.#runs.set(input.runId, run)
    this.#activeBySession.set(input.sessionId, run)
    if (residentInput) {
      this.#residentBySession.set(input.sessionId, {
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        cwd: input.cwd,
        backendSessionId: input.backendSessionId,
        query,
        controller,
        input: residentInput,
        runs: [],
        current: run,
        initialized: false,
        capabilities: new Set(),
        idleTimer: null,
        detachMcp: run.detachMcp,
      })
    }
    this.#publish(run, "session.status", { status: { type: "starting" } })
    run.wallClockTimer = setTimeout(() => {
      void this.#cancel(run, "wall_clock")
    }, input.limits.wallClockMs)
    void this.#consume(run)
    return { accepted: true, runId: input.runId, status: "starting" }
  }

  async abort(sessionId: string, runId: string): Promise<void> {
    const run = this.#runs.get(runId)
    if (!run || run.input.sessionId !== sessionId) {
      throw new ClaudeRunError("run_not_found", "Claude run was not found")
    }
    if (run.observation.terminal) return
    const resident = this.#residentBySession.get(sessionId)
    if (resident?.current === run && this.advancedCapabilities().protocolInterrupt) {
      await resident.query.interrupt()
      this.#terminalAbort(run)
      this.#completeResidentTurn(resident, run)
      return
    }
    await this.#cancel(run, "user")
  }

  async stopSubagent(sessionId: string, runId: string, taskId: string): Promise<void> {
    if (!this.#advancedPolicy.subagents) {
      throw new ClaudeRunError("unsupported_capability", "Claude subagent controls are disabled")
    }
    const run = this.#runs.get(runId)
    if (!run || run.input.sessionId !== sessionId || run.observation.terminal) {
      throw new ClaudeRunError("run_not_found", "Claude run was not found")
    }
    if (typeof run.query.stopTask !== "function") {
      throw new ClaudeRunError("unsupported_capability", "Installed Claude SDK does not support subagent stop")
    }
    await run.query.stopTask(taskId)
  }

  async forkSession(input: ClaudeWorkerForkRequest): Promise<ClaudeWorkerForkResponse> {
    if (!this.#advancedPolicy.nativeFork) {
      throw new ClaudeRunError("unsupported_capability", "Claude native conversation fork is disabled")
    }
    if (this.#activeBySession.size > 0) {
      throw new ClaudeRunError("session_busy", "Claude native fork requires the worker to be idle")
    }
    if (typeof this.#forkSession !== "function") {
      throw new ClaudeRunError("unsupported_capability", "Installed Claude SDK does not support native conversation fork")
    }
    const result = await this.#forkSession(input.sourceBackendSessionId, {
      dir: input.cwd,
      ...(input.title ? { title: input.title } : {}),
      ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
    })
    return {
      accepted: true,
      backendSessionId: result.sessionId,
      filesystemState: {
        sharedWorkingTree: true,
        checkpointHistoryCopied: false,
        filesRewound: false,
        warning: "Conversation history was forked, but both sessions share the current working tree. File changes were not isolated or rewound, and Claude checkpoint/undo history was not copied.",
      },
    }
  }

  advancedCapabilities(): ClaudeAdvancedRuntimeCapabilities {
    const resident = this.#advancedPolicy.residentSession && this.#residentInitialized
    const protocolInterrupt = resident && this.#advancedPolicy.protocolInterrupt
      && this.#protocolCapabilities.has("interrupt_receipt_v1")
    return {
      prewarm: Boolean(this.#startupPool),
      residentSession: resident,
      protocolInterrupt,
      queuedInput: resident && this.#advancedPolicy.queuedInput,
      steer: protocolInterrupt && this.#advancedPolicy.steer,
      dynamicModel: this.#advancedPolicy.dynamicModel,
      dynamicEffort: this.#advancedPolicy.dynamicEffort,
      dynamicPermissionMode: this.#advancedPolicy.dynamicPermissionMode,
      subagentProjection: this.#advancedPolicy.subagents,
      subagentProgress: this.#advancedPolicy.subagents,
      subagentStop: this.#advancedPolicy.subagents,
      planMode: this.#advancedPolicy.planMode,
      fileCheckpointing: this.#advancedPolicy.fileCheckpointing,
      rewind: this.#advancedPolicy.fileCheckpointing && this.#advancedPolicy.rewind,
      nativeFork: this.#advancedPolicy.nativeFork,
    }
  }

  async #startResidentInput(resident: ResidentSession, input: ClaudeWorkerRunRequest): Promise<ClaudeWorkerRunResponse> {
    if (resident.workspaceId !== input.workspaceId || resident.cwd !== input.cwd) {
      throw new ClaudeRunError("session_mismatch", "Claude resident session context does not match")
    }
    if (resident.backendSessionId && input.backendSessionId && resident.backendSessionId !== input.backendSessionId) {
      throw new ClaudeRunError("session_mismatch", "Claude resident backend session does not match")
    }
    if (!resident.initialized) {
      throw new ClaudeRunError("session_busy", "Claude resident session has not completed initialization")
    }
    const protocolInterrupt = this.#advancedPolicy.protocolInterrupt
      && resident.capabilities.has("interrupt_receipt_v1")
    if (input.delivery === "steer" && !(protocolInterrupt && this.#advancedPolicy.steer)) {
      throw new ClaudeRunError("unsupported_capability", "Claude resident session does not advertise steering")
    }
    if (input.delivery === "enqueue" && !this.#advancedPolicy.queuedInput) {
      throw new ClaudeRunError("unsupported_capability", "Claude resident session does not advertise queued input")
    }
    if (input.delivery === "start" && !resident.current.settled) {
      throw new ClaudeRunError("session_busy", "Claude resident session already has an active run")
    }
    if (resident.idleTimer) {
      clearTimeout(resident.idleTimer)
      resident.idleTimer = null
    }
    const run = this.#residentRun(resident, input)
    this.#runs.set(input.runId, run)
    if (input.delivery === "steer") {
      await resident.query.interrupt()
      resident.runs.unshift(run)
      this.#terminalAbort(resident.current)
    } else if (resident.current.settled && resident.runs.length === 0) this.#activateResidentRun(resident, run)
    else resident.runs.push(run)
    resident.input.push(userMessage(input.prompt, input.delivery === "steer" ? "now" : input.delivery === "enqueue" ? "next" : undefined))
    return { accepted: true, runId: input.runId, status: "starting" }
  }

  #residentRun(resident: ResidentSession, input: ClaudeWorkerRunRequest): ActiveRun {
    let resolveCompletion!: () => void
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve })
    return {
      input,
      query: resident.query,
      controller: resident.controller,
      observation: {
        runId: input.runId,
        sessionId: input.sessionId,
        backendSessionId: resident.backendSessionId,
        status: "starting",
        terminal: false,
        errorCode: null,
      },
      approvalCancellations: new Set(),
      completion,
      resolveCompletion,
      settled: false,
      finished: false,
      abortReason: null,
      hardCloseTimer: null,
      wallClockTimer: null,
      detachMcp: () => undefined,
      resident: true,
      prewarm: null,
    }
  }

  #activateResidentRun(resident: ResidentSession, run: ActiveRun): void {
    resident.current = run
    this.#activeBySession.set(run.input.sessionId, run)
    this.#publish(run, "session.status", { status: { type: "starting" } })
    run.wallClockTimer = setTimeout(() => void this.#cancel(run, "wall_clock"), run.input.limits.wallClockMs)
  }

  #completeResidentTurn(resident: ResidentSession, run: ActiveRun): void {
    this.#finish(run)
    const next = resident.runs.shift()
    if (next) {
      this.#activateResidentRun(resident, next)
      return
    }
    resident.idleTimer = setTimeout(() => this.#closeResident(resident), this.#advancedPolicy.residentIdleMs)
  }

  #closeResident(resident: ResidentSession): void {
    if (resident.idleTimer) clearTimeout(resident.idleTimer)
    resident.input.close()
    resident.query.close()
    resident.detachMcp()
    this.#residentBySession.delete(resident.sessionId)
  }

  #warmKey(input: ClaudeWorkerRunRequest, options: ClaudeQueryOptions): string {
    return JSON.stringify({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      cwd: input.cwd,
      backendSessionId: input.backendSessionId,
      model: input.model ?? null,
      effort: input.effort ?? null,
      permissionMode: input.permissionMode ?? "default",
      mcpServers: Object.keys(options.mcpServers ?? {}).sort(),
    })
  }

  observe(runId: string): ClaudeWorkerRunObservation | null {
    const observation = this.#runs.get(runId)?.observation
    return observation ? { ...observation } : null
  }

  resourceCounts(): ClaudeRunServiceResourceCounts {
    return {
      activeSessions: this.#activeBySession.size,
      retainedRuns: this.#runs.size,
      messages: this.#messages.size,
      tools: this.#tools.size,
      toolResolutionStates: this.#toolResolutionStates.size,
      completedMessages: this.#completedMessages.size,
      pendingInteractions: this.#pendingInteractions.size,
      pendingToolPolicies: this.#pendingToolPolicies.size,
      resolvedInteractions: this.#resolvedInteractions.size,
    }
  }

  async resolveInteraction(
    interactionId: string,
    sessionId: string,
    runId: string,
    resolution: ClaudeWorkerInteractionResolution,
  ): Promise<void> {
    const policy = this.#pendingToolPolicies.get(interactionId)
    if (policy) {
      if (policy.run.input.sessionId !== sessionId || policy.run.input.runId !== runId) {
        throw new ClaudeRunError("interaction_not_found", "Claude tool policy request was not found")
      }
      if (resolution.outcome !== "allow" && resolution.outcome !== "deny" && resolution.outcome !== "timeout" && resolution.outcome !== "cancelled") {
        throw new ClaudeRunError("unsupported_capability", "Tool policy requires allow or deny")
      }
      policy.settle(resolution)
      return
    }
    const pending = this.#pendingInteractions.get(interactionId)
    if (!pending) {
      if (this.#resolvedInteractions.has(interactionId)) {
        throw new ClaudeRunError("already_resolved", "Claude interaction is already resolved")
      }
      throw new ClaudeRunError("interaction_not_found", "Claude interaction was not found")
    }
    if (pending.run.input.sessionId !== sessionId || pending.run.input.runId !== runId) {
      throw new ClaudeRunError("interaction_not_found", "Claude interaction was not found")
    }
    if (pending.kind === "permission" && resolution.outcome === "answer") {
      throw new ClaudeRunError("unsupported_capability", "Permission interactions cannot be answered")
    }
    if (pending.kind === "question" && (resolution.outcome === "allow" || resolution.outcome === "deny")) {
      throw new ClaudeRunError("unsupported_capability", "Question interactions require an answer or rejection")
    }
    pending.settle(resolution)
  }

  registerApprovalWait(runId: string, cancel: () => void): () => void {
    const run = this.#runs.get(runId)
    if (!run || run.observation.terminal) {
      cancel()
      return () => undefined
    }
    run.approvalCancellations.add(cancel)
    return () => run.approvalCancellations.delete(cancel)
  }

  async waitForRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId)
    if (!run) throw new ClaudeRunError("run_not_found", "Claude run was not found")
    await run.completion
  }

  async closeAll(): Promise<void> {
    const active = [...this.#activeBySession.values()]
    await Promise.all(active.map((run) => this.#cancel(run, "shutdown")))
    await Promise.all(active.map((run) => run.completion))
    this.#startupPool?.close()
    for (const resident of this.#residentBySession.values()) this.#closeResident(resident)
    this.#residentBySession.clear()
  }

  async executeCustomToolHandler<T>(input: {
    runId: string
    toolName: string
    toolUseId: string
    toolInput: unknown
    signal: AbortSignal
    handler: (authorizedInput: Record<string, unknown>) => T | Promise<T>
  }): Promise<T> {
    const run = this.#runs.get(input.runId)
    if (!run || run.observation.terminal) throw new ClaudeRunError("run_not_found", "Claude run was not found")
    const policy = await this.#requestToolPolicy(
      run,
      input.toolName,
      input.toolInput,
      input.toolUseId,
      input.signal,
      "custom_handler",
    )
    if (policy.behavior === "deny") throw new Error(policy.message)
    if (mayMutate(input.toolName)) {
      this.#publish(run, "run.mutation.possible", {
        toolName: input.toolName,
        toolUseId: input.toolUseId,
      })
    }
    return input.handler(policy.updatedInput ?? {})
  }

  async #requestToolPolicy(
    run: ActiveRun,
    toolName: string,
    input: unknown,
    toolUseId: string,
    signal: AbortSignal,
    enforcementPoint: "pre_tool_hook" | "permission" | "custom_handler",
  ): Promise<PermissionResult> {
    const requestId = canonicalId("policy", run.input.sessionId, toolUseId, enforcementPoint)
    if (this.#pendingToolPolicies.has(requestId)) {
      return { behavior: "deny", message: "Duplicate tool policy request", toolUseID: toolUseId }
    }
    return new Promise<PermissionResult>((resolve) => {
      let settled = false
      const finish = (resolution: ClaudeWorkerInteractionResolution) => {
        if (settled) return
        settled = true
        const pending = this.#pendingToolPolicies.get(requestId)
        pending?.removeAbortListener()
        if (pending) clearTimeout(pending.deadlineTimer)
        this.#pendingToolPolicies.delete(requestId)
        run.approvalCancellations.delete(cancelWait)
        const authorizedInput = resolution.outcome === "allow" && isRecord(resolution.updatedInput)
          ? resolution.updatedInput
          : null
        const allowed = authorizedInput !== null
        this.options.publishEvent("tool.policy.resolved", {
          workspaceId: run.input.workspaceId,
          sessionId: run.input.sessionId,
          runId: run.input.runId,
          requestId,
          toolName,
          toolUseId,
          enforcementPoint,
          decision: allowed ? "allow" : "deny",
          inputModified: allowed && JSON.stringify(authorizedInput) !== JSON.stringify(input),
        })
        resolve(allowed
          ? { behavior: "allow", updatedInput: authorizedInput, toolUseID: toolUseId }
          : {
              behavior: "deny",
              message: resolution.outcome === "deny" ? resolution.reason
                : resolution.outcome === "timeout" ? "Mandatory tool policy timed out" : "Run was cancelled",
              interrupt: resolution.outcome === "cancelled",
              toolUseID: toolUseId,
            })
      }
      const cancelWait = () => finish({ outcome: "cancelled" })
      const onAbort = () => cancelWait()
      signal.addEventListener("abort", onAbort, { once: true })
      const pending: PendingToolPolicy = {
        id: requestId,
        run,
        toolName,
        toolUseId,
        input: isRecord(input) ? input : {},
        settle: finish,
        removeAbortListener: () => signal.removeEventListener("abort", onAbort),
        deadlineTimer: setTimeout(() => finish({ outcome: "timeout" }), run.input.limits.approvalDeadlineMs),
      }
      this.#pendingToolPolicies.set(requestId, pending)
      run.approvalCancellations.add(cancelWait)
      this.options.publishEvent("tool.policy.requested", {
        workspaceId: run.input.workspaceId,
        sessionId: run.input.sessionId,
        runId: run.input.runId,
        requestId,
        toolName,
        toolUseId,
        enforcementPoint,
        input: jsonValue(input),
      })
      if (signal.aborted) queueMicrotask(cancelWait)
    })
  }

  async #requestToolInteraction(
    run: ActiveRun,
    toolName: string,
    input: Record<string, unknown>,
    callbackOptions: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const interactionId = canonicalId("interaction", run.input.sessionId, callbackOptions.requestId)
    if (this.#pendingInteractions.has(interactionId)) {
      throw new ClaudeRunError("already_resolved", "Claude interaction is already pending")
    }
    const question = toolName === "AskUserQuestion"
    const questions = question ? this.#questions(interactionId, input) : []
    const requestedAt = this.#now()
    const tool = this.#tools.get(`${run.input.sessionId}\0${callbackOptions.toolUseID}`)
    if (tool) {
      this.#publish(run, "message.part.updated", {
        messageId: tool.messageId,
        part: this.#toolPart(run, tool, "waiting", requestedAt),
      })
    }

    return new Promise<PermissionResult>((resolve) => {
      let settled = false
      const finish = (resolution: ClaudeWorkerInteractionResolution) => {
        if (settled) return
        settled = true
        const pending = this.#pendingInteractions.get(interactionId)
        pending?.removeAbortListener()
        if (pending) clearTimeout(pending.deadlineTimer)
        this.#pendingInteractions.delete(interactionId)
        this.#resolvedInteractions.add(interactionId)
        if (this.#resolvedInteractions.size > 1_000) {
          this.#resolvedInteractions.delete(this.#resolvedInteractions.values().next().value!)
        }
        run.approvalCancellations.delete(cancelWait)
        const resolvedAt = this.#now()
        const state = resolution.outcome === "allow" || resolution.outcome === "answer" ? "running" : "cancelled"
        this.#toolResolutionStates.set(`${run.input.sessionId}\0${callbackOptions.toolUseID}`, state)
        if (tool) {
          this.#publish(run, "message.part.updated", {
            messageId: tool.messageId,
            part: this.#toolPart(run, tool, state, resolvedAt),
          })
        }
        this.#publishAgentEvent(run, {
          type: "interaction.resolved",
          interaction: {
            ...this.#interaction(run, interactionId, toolName, input, questions, requestedAt, callbackOptions, question),
            state: resolution.outcome === "timeout" ? "timed_out" : resolution.outcome === "cancelled" ? "cancelled" : "resolved",
            resolvedAt,
            resolution,
          },
        })
        if (resolution.outcome === "allow") {
          if (mayMutate(toolName)) {
            this.#publish(run, "run.mutation.possible", {
              toolName,
              toolUseId: callbackOptions.toolUseID,
            })
          }
          resolve({ behavior: "allow", updatedInput: isRecord(resolution.updatedInput) ? resolution.updatedInput : input, toolUseID: callbackOptions.toolUseID })
        } else if (resolution.outcome === "answer") {
          resolve({
            behavior: "allow",
            updatedInput: { ...input, answers: this.#questionAnswers(questions, resolution.values) },
            toolUseID: callbackOptions.toolUseID,
          })
        } else {
          const reason = resolution.outcome === "deny" ? resolution.reason
            : resolution.outcome === "reject" ? resolution.reason ?? "User rejected the question"
              : resolution.outcome === "timeout" ? "Approval timed out" : "Run was cancelled"
          resolve({ behavior: "deny", message: reason, interrupt: resolution.outcome === "cancelled", toolUseID: callbackOptions.toolUseID })
        }
      }
      const cancelWait = () => finish({ outcome: "cancelled" })
      const onAbort = () => cancelWait()
      callbackOptions.signal.addEventListener("abort", onAbort, { once: true })
      const pending: PendingInteraction = {
        id: interactionId,
        run,
        kind: question ? "question" : "permission",
        toolName,
        toolUseId: callbackOptions.toolUseID,
        input,
        questions,
        settle: finish,
        removeAbortListener: () => callbackOptions.signal.removeEventListener("abort", onAbort),
        deadlineTimer: setTimeout(
          () => finish({ outcome: "timeout" }),
          run.input.limits.approvalDeadlineMs,
        ),
      }
      this.#pendingInteractions.set(interactionId, pending)
      run.approvalCancellations.add(cancelWait)
      this.#publishAgentEvent(run, {
        type: "interaction.requested",
        interaction: this.#interaction(run, interactionId, toolName, input, questions, requestedAt, callbackOptions, question),
      })
      if (callbackOptions.signal.aborted) queueMicrotask(cancelWait)
    })
  }

  #interaction(
    run: ActiveRun,
    interactionId: string,
    toolName: string,
    input: Record<string, unknown>,
    questions: PendingInteraction["questions"],
    requestedAt: number,
    callbackOptions: Parameters<CanUseTool>[2],
    question: boolean,
  ): Record<string, unknown> {
    return {
      id: interactionId,
      sessionId: run.input.sessionId,
      runId: run.input.runId,
      kind: question ? "question" : "permission",
      state: "pending",
      title: callbackOptions.title ?? callbackOptions.displayName ?? (question ? "Claude has a question" : `Allow ${toolName}?`),
      ...(callbackOptions.description ? { description: callbackOptions.description } : {}),
      toolName,
      input: jsonValue(input),
      ...(questions.length ? { questions } : {}),
      requestedAt,
      deadlineAt: requestedAt + run.input.limits.approvalDeadlineMs,
      resolvedAt: null,
      resolution: null,
      metadata: {
        toolCallId: canonicalId("tool-call", run.input.sessionId, callbackOptions.toolUseID),
        toolPartId: canonicalId("tool-part", run.input.sessionId, callbackOptions.toolUseID),
        backendToolUseId: callbackOptions.toolUseID,
        requestId: callbackOptions.requestId,
        ...(callbackOptions.decisionReason ? { decisionReason: callbackOptions.decisionReason } : {}),
      },
    }
  }

  #questions(interactionId: string, input: Record<string, unknown>): PendingInteraction["questions"] {
    const raw = Array.isArray(input.questions) ? input.questions : []
    return raw.flatMap((value, index) => {
      if (!isRecord(value)) return []
      const prompt = stringValue(value.question) ?? stringValue(value.prompt)
      if (!prompt) return []
      const options = Array.isArray(value.options)
        ? value.options.flatMap((option) => isRecord(option) && stringValue(option.label) ? [stringValue(option.label)!] : typeof option === "string" ? [option] : [])
        : []
      return [{
        id: canonicalId("question", interactionId, index),
        prompt,
        ...(options.length ? { options } : {}),
        multiple: value.multiSelect === true || value.multiple === true,
      }]
    })
  }

  #questionAnswers(questions: PendingInteraction["questions"], values: string[]): Record<string, string> {
    const answers: Record<string, string> = {}
    questions.forEach((question, index) => {
      const value = index === questions.length - 1 ? values.slice(index).join(", ") : values[index]
      if (value !== undefined) answers[question.prompt] = value
    })
    return answers
  }

  #publishAgentEvent(run: ActiveRun, data: Record<string, unknown>): void {
    this.options.publishEvent("agent.event", {
      workspaceId: run.input.workspaceId,
      sessionId: run.input.sessionId,
      runId: run.input.runId,
      backendSessionId: run.observation.backendSessionId,
      data,
    })
  }

  async #cancel(run: ActiveRun, reason: ActiveRun["abortReason"]): Promise<void> {
    if (run.settled || run.abortReason) return
    run.abortReason = reason
    run.observation = { ...run.observation, status: "aborting" }
    this.#publish(run, "session.status", { status: { type: "aborting" } })
    this.#cancelApprovalWaits(run)
    run.controller.abort(new AbortError())
    run.hardCloseTimer = setTimeout(() => {
      try {
        run.query.close()
      } catch {
        // The iterator owns terminal error mapping; close is best-effort cleanup.
      }
      if (!run.settled) {
        if (run.abortReason === "wall_clock") {
          this.#terminalFailure(run, "wall_clock_limit", "Claude run exceeded its wall-clock limit", false)
        } else {
          this.#terminalAbort(run)
        }
      }
      this.#finish(run)
    }, run.input.limits.hardCloseMs)
  }

  async #consume(run: ActiveRun): Promise<void> {
    try {
      for await (const message of run.query) {
        const resident = this.#residentBySession.get(run.input.sessionId)
        const current = resident?.current ?? run
        this.#mapMessage(current, message)
        if (resident && current.settled) this.#completeResidentTurn(resident, current)
      }
      const current = this.#residentBySession.get(run.input.sessionId)?.current ?? run
      if (!current.settled) {
        if (current.abortReason) this.#terminalAbort(current)
        else this.#terminalFailure(current, "query_ended_without_result", "Claude query ended without a result", false)
      }
    } catch (error) {
      const current = this.#residentBySession.get(run.input.sessionId)?.current ?? run
      if (current.abortReason || error instanceof AbortError || current.controller.signal.aborted) {
        if (current.abortReason === "wall_clock") {
          this.#terminalFailure(current, "wall_clock_limit", "Claude run exceeded its wall-clock limit", false)
        } else {
          this.#terminalAbort(current)
        }
      } else {
        this.#terminalFailure(current, "query_failed", errorMessage(error, { ...process.env, ...this.options.claudeEnv }), true)
      }
    } finally {
      const resident = this.#residentBySession.get(run.input.sessionId)
      if (resident) {
        for (const queued of resident.runs.splice(0)) {
          this.#terminalFailure(queued, "resident_session_closed", "Claude resident session closed before queued input completed", true)
          this.#finish(queued)
        }
        if (!resident.current.finished) this.#finish(resident.current)
        this.#closeResident(resident)
      } else this.#finish(run)
    }
  }

  #mapMessage(run: ActiveRun, sdkMessage: SDKMessage): void {
    const message = sdkMessage as unknown as Record<string, unknown>
    const backendSessionId = stringValue(message.session_id)
    const firstBackendSession = backendSessionId ? this.#bindBackendSession(run, backendSessionId) : false

    if (message.type === "system" && message.subtype === "init") {
      const capabilities = new Set(Array.isArray(message.capabilities)
        ? message.capabilities.filter((value): value is string => typeof value === "string")
        : [])
      const resident = this.#residentBySession.get(run.input.sessionId)
      if (resident) {
        resident.initialized = true
        resident.backendSessionId = backendSessionId ?? resident.backendSessionId
        resident.capabilities = capabilities
        this.#residentInitialized = true
        this.#protocolCapabilities = new Set([...this.#protocolCapabilities, ...capabilities])
      }
      run.observation = { ...run.observation, status: "running" }
      this.#publish(run, "session.initialized", {
        model: stringValue(message.model),
        cwd: stringValue(message.cwd),
        claudeCodeVersion: stringValue(message.claude_code_version),
        capabilities: [...capabilities],
        advancedCapabilities: {
          subagentProjection: this.#advancedPolicy.subagents,
          subagentProgress: this.#advancedPolicy.subagents,
          subagentStop: this.#advancedPolicy.subagents && typeof run.query.stopTask === "function",
          planMode: this.#advancedPolicy.planMode && (message.permissionMode === "plan" || run.input.planMode === true),
          fileCheckpointing: this.#advancedPolicy.fileCheckpointing,
          rewind: this.#advancedPolicy.fileCheckpointing && this.#advancedPolicy.rewind,
          nativeFork: this.#advancedPolicy.nativeFork && typeof this.#forkSession === "function",
        },
        mcpServers: Array.isArray(message.mcp_servers)
          ? message.mcp_servers.map((status) => isRecord(status) ? {
              name: stringValue(status.name),
              status: stringValue(status.status),
            } : null).filter(Boolean)
          : [],
        firstRun: firstBackendSession,
      })
      this.options.mcpRuntime?.recordInitialization(run.input.workspaceId, message.mcp_servers)
      this.#publish(run, "session.status", { status: { type: "running" } })
      return
    }
    if (message.type === "system" && message.subtype === "task_started") {
      if (!this.#advancedPolicy.subagents) return
      this.#mapTask(run, message, "running")
      return
    }
    if (message.type === "system" && message.subtype === "task_progress") {
      if (!this.#advancedPolicy.subagents) return
      this.#mapTask(run, message, "running")
      return
    }
    if (message.type === "system" && message.subtype === "task_updated") {
      if (!this.#advancedPolicy.subagents) return
      const patch = isRecord(message.patch) ? message.patch : {}
      this.#mapTask(run, { ...message, ...patch }, taskState(patch.status))
      return
    }
    if (message.type === "system" && message.subtype === "task_notification") {
      if (!this.#advancedPolicy.subagents) return
      this.#mapTask(run, message, taskState(message.status))
      return
    }
    if (firstBackendSession) this.#publish(run, "session.initialized", { firstRun: true })
    if (message.type === "stream_event") {
      this.#mapPartial(run, message)
      return
    }
    if (message.type === "assistant") {
      this.#mapAssistant(run, message)
      return
    }
    if (message.type === "user") {
      this.#mapToolResults(run, message)
      return
    }
    if (message.type === "tool_progress") {
      this.#mapToolProgress(run, message)
      return
    }
    if (message.type === "system" && message.subtype === "api_retry") {
      const delayMs = numberValue(message.retry_delay_ms) ?? 0
      run.observation = { ...run.observation, status: "retrying" }
      this.#publish(run, "session.status", {
        status: {
          type: "retrying",
          attempt: Math.max(1, numberValue(message.attempt) ?? 1),
          message: stringValue(message.error) ?? "Claude API request is retrying",
          nextAt: this.#now() + delayMs,
        },
        maxRetries: numberValue(message.max_retries),
        errorStatus: numberValue(message.error_status),
      })
      return
    }
    if (message.type === "system" && message.subtype === "compact_boundary") {
      this.#publish(run, "session.compacted", {
        backendEventId: stringValue(message.uuid),
        metadata: jsonValue(message.compact_metadata),
      })
      return
    }
    if (message.type === "system" && message.subtype === "status") {
      const status = message.status === "compacting" ? "running" : message.status === "requesting" ? "running" : null
      if (status) this.#publish(run, "session.status", { status: { type: status }, detail: message.status })
      return
    }
    if (message.type === "result") this.#mapResult(run, message)
  }

  #bindBackendSession(run: ActiveRun, backendSessionId: string): boolean {
    const expected = run.observation.backendSessionId
    if (expected && expected !== backendSessionId) {
      throw new ClaudeRunError("session_mismatch", "Claude resumed a different backend session")
    }
    if (!expected) {
      run.observation = { ...run.observation, backendSessionId }
      return true
    }
    return false
  }

  #messageState(run: ActiveRun, backendMessageId: string): MessageState {
    const key = `${run.input.sessionId}\0${backendMessageId}`
    let state = this.#messages.get(key)
    if (!state) {
      state = {
        id: canonicalId("message", run.input.sessionId, backendMessageId),
        createdAt: this.#now(),
        textByPart: new Map(),
        reasoningByPart: new Map(),
      }
      this.#messages.set(key, state)
    }
    return state
  }

  #mapPartial(run: ActiveRun, message: Record<string, unknown>): void {
    const backendMessageId = stringValue(message.uuid)
    const event = isRecord(message.event) ? message.event : null
    if (!backendMessageId || !event) return
    const state = this.#messageState(run, backendMessageId)
    const index = numberValue(event.index) ?? 0
    const block = isRecord(event.content_block) ? event.content_block : null
    const delta = isRecord(event.delta) ? event.delta : null
    if (event.type === "content_block_start" && block?.type === "tool_use") {
      this.#upsertTool(run, state, index, block, "running")
      return
    }
    if (event.type !== "content_block_delta" || !delta) return
    const text = stringValue(delta.text) ?? stringValue(delta.thinking)
    if (text === null) return
    const reasoning = delta.type === "thinking_delta"
    const target = reasoning ? state.reasoningByPart : state.textByPart
    target.set(index, (target.get(index) ?? "") + text)
    this.#publish(run, "message.part.delta", {
      messageId: state.id,
      partId: canonicalId(reasoning ? "reasoning" : "text", state.id, index),
      field: reasoning ? "reasoning" : "text",
      delta: text,
    })
  }

  #mapAssistant(run: ActiveRun, message: Record<string, unknown>): void {
    const backendMessageId = stringValue(message.uuid)
    const backend = isRecord(message.message) ? message.message : null
    if (!backendMessageId || !backend || this.#completedMessages.has(`${run.input.sessionId}\0${backendMessageId}`)) return
    const state = this.#messageState(run, backendMessageId)
    const content = Array.isArray(backend.content) ? backend.content : []
    const completedAt = this.#now()
    const parts: Array<Record<string, unknown>> = []
    content.forEach((rawBlock, index) => {
      if (!isRecord(rawBlock)) return
      if (rawBlock.type === "text") {
        parts.push({
          id: canonicalId("text", state.id, index),
          messageId: state.id,
          sessionId: run.input.sessionId,
          ordinal: index,
          type: "text",
          text: stringValue(rawBlock.text) ?? state.textByPart.get(index) ?? "",
          state: "complete",
          createdAt: state.createdAt,
          updatedAt: completedAt,
        })
      } else if (rawBlock.type === "thinking") {
        parts.push({
          id: canonicalId("reasoning", state.id, index),
          messageId: state.id,
          sessionId: run.input.sessionId,
          ordinal: index,
          type: "reasoning",
          text: stringValue(rawBlock.thinking) ?? state.reasoningByPart.get(index) ?? "",
          visibility: "visible",
          state: "complete",
          createdAt: state.createdAt,
          updatedAt: completedAt,
        })
      } else if (rawBlock.type === "tool_use") {
        const tool = this.#upsertTool(run, state, index, rawBlock, "running")
        if (tool) parts.push(this.#toolPart(run, tool, "running", completedAt))
      }
    })
    if (stringValue(message.error)) {
      parts.push({
        id: canonicalId("error", state.id, String(message.error)),
        messageId: state.id,
        sessionId: run.input.sessionId,
        ordinal: parts.length,
        type: "error",
        code: message.error,
        message: `Claude assistant error: ${message.error}`,
        retryable: ["rate_limit", "overloaded", "server_error"].includes(String(message.error)),
        createdAt: completedAt,
        updatedAt: completedAt,
      })
    }
    this.#completedMessages.add(`${run.input.sessionId}\0${backendMessageId}`)
    this.#publish(run, "message.updated", {
      message: {
        id: state.id,
        sessionId: run.input.sessionId,
        role: "assistant",
        parentId: null,
        createdAt: state.createdAt,
        completedAt,
        parts,
        metadata: {
          backendMessageId,
          model: stringValue(backend.model),
          parentToolUseId: stringValue(message.parent_tool_use_id),
          subagentType: stringValue(message.subagent_type),
          taskDescription: stringValue(message.task_description),
        },
      },
    })
  }

  #mapTask(
    run: ActiveRun,
    message: Record<string, unknown>,
    state: "pending" | "running" | "completed" | "error" | "cancelled",
  ): void {
    const taskId = stringValue(message.task_id)
    if (!taskId) return
    const key = `${run.input.sessionId}\0${taskId}`
    const previous = this.#subagents.get(key)
    const parentToolUseId = stringValue(message.tool_use_id) ?? previous?.parentToolUseId ?? null
    const label = stringValue(message.description) ?? previous?.label ?? stringValue(message.subagent_type) ?? "Claude subagent"
    this.#subagents.set(key, { label, parentToolUseId })
    const messageId = canonicalId("subagent-message", run.input.sessionId, taskId)
    const usage = isRecord(message.usage) ? {
      totalTokens: numberValue(message.usage.total_tokens) ?? 0,
      toolUses: numberValue(message.usage.tool_uses) ?? 0,
      durationMs: numberValue(message.usage.duration_ms) ?? 0,
    } : undefined
    const now = this.#now()
    this.#publish(run, "message.updated", {
      message: {
        id: messageId,
        sessionId: run.input.sessionId,
        role: "assistant",
        parentId: null,
        createdAt: now,
        completedAt: state === "running" || state === "pending" ? null : now,
        parts: [{
          id: canonicalId("subagent-part", run.input.sessionId, taskId),
          messageId,
          sessionId: run.input.sessionId,
          ordinal: 0,
          type: "agent",
          agentId: canonicalId("subagent", run.input.sessionId, taskId),
          ...(parentToolUseId ? { parentToolCallId: canonicalId("tool-call", run.input.sessionId, parentToolUseId) } : {}),
          label,
          state,
          createdAt: now,
          updatedAt: now,
          metadata: {
            backendTaskId: taskId,
            ...(parentToolUseId ? { backendParentToolUseId: parentToolUseId } : {}),
            ...(stringValue(message.description) ? { description: stringValue(message.description) } : {}),
            ...(stringValue(message.summary) ? { summary: stringValue(message.summary) } : {}),
            ...(stringValue(message.last_tool_name) ? { lastToolName: stringValue(message.last_tool_name) } : {}),
            ...(usage ? { usage } : {}),
            runId: run.input.runId,
            stoppable: state === "running" && typeof run.query.stopTask === "function",
          },
        }],
        metadata: { backendTaskId: taskId },
      },
    })
  }

  #upsertTool(
    run: ActiveRun,
    message: MessageState,
    index: number,
    block: Record<string, unknown>,
    state: "running" | "waiting" | "completed" | "error" | "cancelled",
  ): ToolState | null {
    const backendToolId = stringValue(block.id)
    if (!backendToolId) return null
    let tool = this.#tools.get(`${run.input.sessionId}\0${backendToolId}`)
    if (!tool) {
      tool = {
        messageId: message.id,
        partId: canonicalId("tool-part", run.input.sessionId, backendToolId),
        toolCallId: canonicalId("tool-call", run.input.sessionId, backendToolId),
        toolName: stringValue(block.name) ?? "tool",
        ordinal: index,
        createdAt: this.#now(),
        ...(block.input !== undefined ? { input: jsonValue(block.input) } : {}),
      }
      this.#tools.set(`${run.input.sessionId}\0${backendToolId}`, tool)
    }
    const resolvedState = this.#toolResolutionStates.get(`${run.input.sessionId}\0${backendToolId}`)
    this.#publish(run, "message.part.updated", {
      messageId: tool.messageId,
      part: this.#toolPart(run, tool, resolvedState ?? state, this.#now()),
    })
    return tool
  }

  #toolPart(
    run: ActiveRun,
    tool: ToolState,
    state: "running" | "waiting" | "completed" | "error" | "cancelled",
    updatedAt: number,
    output?: JsonValue,
    error?: string,
  ): Record<string, unknown> {
    return {
      id: tool.partId,
      messageId: tool.messageId,
      sessionId: run.input.sessionId,
      ordinal: tool.ordinal,
      type: "tool",
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      state,
      ...(tool.input !== undefined ? { input: tool.input } : {}),
      ...(output !== undefined ? { output } : {}),
      ...(error ? { error } : {}),
      createdAt: tool.createdAt,
      updatedAt,
    }
  }

  #mapToolResults(run: ActiveRun, message: Record<string, unknown>): void {
    const backend = isRecord(message.message) ? message.message : null
    const content = backend && Array.isArray(backend.content) ? backend.content : []
    for (const block of content) {
      if (!isRecord(block) || block.type !== "tool_result") continue
      const backendToolId = stringValue(block.tool_use_id)
      const tool = backendToolId ? this.#tools.get(`${run.input.sessionId}\0${backendToolId}`) : null
      if (!tool) continue
      const failed = block.is_error === true
      const rawOutput = message.tool_use_result ?? block.content
      const mcpServerName = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(tool.toolName)?.[1]
      const bounded = mcpServerName ? boundAndRedactMcpOutput(rawOutput) : null
      if (bounded?.truncated) this.options.mcpRuntime?.recordOutputTruncated(run.input.workspaceId, mcpServerName!)
      const output = bounded?.value ?? jsonValue(rawOutput)
      this.#publish(run, "message.part.updated", {
        messageId: tool.messageId,
        part: this.#toolPart(
          run,
          tool,
          failed ? "error" : "completed",
          this.#now(),
          output,
          failed ? (mcpServerName ? "MCP tool failed" : typeof block.content === "string" ? block.content : "Claude tool failed") : undefined,
        ),
      })
    }
  }

  #mapToolProgress(run: ActiveRun, message: Record<string, unknown>): void {
    const backendToolId = stringValue(message.tool_use_id)
    const tool = backendToolId ? this.#tools.get(`${run.input.sessionId}\0${backendToolId}`) : null
    if (!tool) return
    this.#publish(run, "message.part.updated", {
      messageId: tool.messageId,
      part: this.#toolPart(run, tool, "running", this.#now()),
      progress: {
        elapsedSeconds: numberValue(message.elapsed_time_seconds) ?? 0,
        heartbeat: message.heartbeat === true,
        retry: jsonValue(message.subagent_retry),
      },
    })
  }

  #mapResult(run: ActiveRun, message: Record<string, unknown>): void {
    if (run.settled) return
    const usage = aggregateUsage(message)
    this.#publish(run, "run.usage", { usage })
    if (message.subtype === "success" && message.is_error !== true) {
      run.observation = { ...run.observation, status: "completed", terminal: true }
      this.#publish(run, "run.completed", {
        usage,
        stopReason: stringValue(message.stop_reason),
        terminalReason: stringValue(message.terminal_reason),
      })
      run.settled = true
      return
    }
    const errors = Array.isArray(message.errors) ? message.errors.filter((item): item is string => typeof item === "string") : []
    this.#terminalFailure(
      run,
      stringValue(message.subtype) ?? "claude_result_error",
      errors.join("\n") || `Claude run failed: ${String(message.subtype ?? "unknown")}`,
      retryableResult(message.subtype),
      usage,
    )
  }

  #terminalAbort(run: ActiveRun): void {
    if (run.settled) return
    run.observation = { ...run.observation, status: "aborted", terminal: true }
    this.#publish(run, "run.aborted")
    run.settled = true
  }

  #terminalFailure(
    run: ActiveRun,
    code: string,
    message: string,
    retryable: boolean,
    usage?: Record<string, unknown>,
  ): void {
    if (run.settled) return
    run.observation = { ...run.observation, status: "failed", terminal: true, errorCode: code }
    this.#publish(run, "run.failed", { code, message, retryable, ...(usage ? { usage } : {}) })
    run.settled = true
  }

  #publish(run: ActiveRun, type: ClaudeWorkerEvent["type"], payload: Record<string, unknown> = {}): void {
    this.options.publishEvent(type, {
      workspaceId: run.input.workspaceId,
      sessionId: run.input.sessionId,
      runId: run.input.runId,
      backendSessionId: run.observation.backendSessionId,
      ...payload,
    })
  }

  #finish(run: ActiveRun): void {
    if (run.finished) return
    run.finished = true
    if (!run.resident) run.detachMcp()
    if (run.wallClockTimer) clearTimeout(run.wallClockTimer)
    if (run.hardCloseTimer) clearTimeout(run.hardCloseTimer)
    this.#cancelApprovalWaits(run)
    if (this.#activeBySession.get(run.input.sessionId) === run) this.#activeBySession.delete(run.input.sessionId)
    this.#completedRunIds.push(run.input.runId)
    while (this.#completedRunIds.length > this.#maxRetainedRuns) {
      const expiredRunId = this.#completedRunIds.shift()
      if (expiredRunId) this.#runs.delete(expiredRunId)
    }
    this.#trimProjectionCaches()
    if (run.prewarm && run.settled && run.abortReason === null) {
      const backendSessionId = run.observation.backendSessionId
      const options = {
        ...run.prewarm.options,
        ...(backendSessionId ? { resume: backendSessionId } : {}),
      }
      this.#startupPool?.warm(this.#warmKey({ ...run.input, backendSessionId }, options), options)
    }
    run.resolveCompletion()
  }

  #cancelApprovalWaits(run: ActiveRun): void {
    for (const cancel of [...run.approvalCancellations]) {
      try {
        cancel()
      } catch {
        // One faulty waiter must not prevent the query and remaining waits from being released.
      }
    }
    run.approvalCancellations.clear()
  }

  #trimProjectionCaches(): void {
    const isActive = (key: string) => this.#activeBySession.has(key.split("\0", 1)[0] ?? "")
    trimInactiveMap(this.#messages, this.#maxRetainedProjectionEntries, isActive)
    trimInactiveMap(this.#tools, this.#maxRetainedProjectionEntries, isActive)
    trimInactiveMap(this.#toolResolutionStates, this.#maxRetainedProjectionEntries, isActive)
    trimInactiveSet(this.#completedMessages, this.#maxRetainedProjectionEntries, isActive)
    trimInactiveMap(this.#subagents, this.#maxRetainedProjectionEntries, isActive)
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function trimInactiveMap<T>(map: Map<string, T>, limit: number, isActive: (key: string) => boolean): void {
  if (map.size <= limit) return
  for (const key of map.keys()) {
    if (!isActive(key)) map.delete(key)
    if (map.size <= limit) return
  }
}

function trimInactiveSet(set: Set<string>, limit: number, isActive: (key: string) => boolean): void {
  if (set.size <= limit) return
  for (const key of set) {
    if (!isActive(key)) set.delete(key)
    if (set.size <= limit) return
  }
}

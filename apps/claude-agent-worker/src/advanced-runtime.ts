import type { Options, Query, SDKUserMessage, WarmQuery } from "@anthropic-ai/claude-agent-sdk"

export const CLAUDE_PREWARM_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_PREWARM_ENABLED" as const
export const CLAUDE_PREWARM_KILL_SWITCH = "JUGGLEWORK_CLAUDE_PREWARM_KILL_SWITCH" as const
export const CLAUDE_RESIDENT_SESSION_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_ENABLED" as const
export const CLAUDE_RESIDENT_SESSION_KILL_SWITCH = "JUGGLEWORK_CLAUDE_RESIDENT_SESSIONS_KILL_SWITCH" as const
export const CLAUDE_PROTOCOL_INTERRUPT_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_ENABLED" as const
export const CLAUDE_PROTOCOL_INTERRUPT_KILL_SWITCH = "JUGGLEWORK_CLAUDE_PROTOCOL_INTERRUPT_KILL_SWITCH" as const
export const CLAUDE_QUEUED_INPUT_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_QUEUED_INPUT_ENABLED" as const
export const CLAUDE_QUEUED_INPUT_KILL_SWITCH = "JUGGLEWORK_CLAUDE_QUEUED_INPUT_KILL_SWITCH" as const
export const CLAUDE_STEER_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_STEER_ENABLED" as const
export const CLAUDE_STEER_KILL_SWITCH = "JUGGLEWORK_CLAUDE_STEER_KILL_SWITCH" as const
export const CLAUDE_DYNAMIC_MODEL_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_DYNAMIC_MODEL_ENABLED" as const
export const CLAUDE_DYNAMIC_MODEL_KILL_SWITCH = "JUGGLEWORK_CLAUDE_DYNAMIC_MODEL_KILL_SWITCH" as const
export const CLAUDE_DYNAMIC_EFFORT_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_DYNAMIC_EFFORT_ENABLED" as const
export const CLAUDE_DYNAMIC_EFFORT_KILL_SWITCH = "JUGGLEWORK_CLAUDE_DYNAMIC_EFFORT_KILL_SWITCH" as const
export const CLAUDE_DYNAMIC_PERMISSION_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_DYNAMIC_PERMISSION_MODE_ENABLED" as const
export const CLAUDE_DYNAMIC_PERMISSION_KILL_SWITCH = "JUGGLEWORK_CLAUDE_DYNAMIC_PERMISSION_MODE_KILL_SWITCH" as const
export const CLAUDE_SUBAGENTS_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_SUBAGENTS_ENABLED" as const
export const CLAUDE_SUBAGENTS_KILL_SWITCH = "JUGGLEWORK_CLAUDE_SUBAGENTS_KILL_SWITCH" as const
export const CLAUDE_PLAN_MODE_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_PLAN_MODE_ENABLED" as const
export const CLAUDE_PLAN_MODE_KILL_SWITCH = "JUGGLEWORK_CLAUDE_PLAN_MODE_KILL_SWITCH" as const
export const CLAUDE_FILE_CHECKPOINTING_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_FILE_CHECKPOINTING_ENABLED" as const
export const CLAUDE_FILE_CHECKPOINTING_KILL_SWITCH = "JUGGLEWORK_CLAUDE_FILE_CHECKPOINTING_KILL_SWITCH" as const
export const CLAUDE_REWIND_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_REWIND_ENABLED" as const
export const CLAUDE_REWIND_KILL_SWITCH = "JUGGLEWORK_CLAUDE_REWIND_KILL_SWITCH" as const
export const CLAUDE_NATIVE_FORK_FEATURE_FLAG = "JUGGLEWORK_CLAUDE_NATIVE_FORK_ENABLED" as const
export const CLAUDE_NATIVE_FORK_KILL_SWITCH = "JUGGLEWORK_CLAUDE_NATIVE_FORK_KILL_SWITCH" as const
export const CLAUDE_PREWARM_POOL_SIZE_ENV = "JUGGLEWORK_CLAUDE_PREWARM_POOL_SIZE" as const
export const CLAUDE_PREWARM_IDLE_MS_ENV = "JUGGLEWORK_CLAUDE_PREWARM_IDLE_MS" as const
export const CLAUDE_RESIDENT_IDLE_MS_ENV = "JUGGLEWORK_CLAUDE_RESIDENT_IDLE_MS" as const

export interface ClaudeAdvancedRuntimePolicy {
  prewarm: boolean
  residentSession: boolean
  protocolInterrupt: boolean
  queuedInput: boolean
  steer: boolean
  dynamicModel: boolean
  dynamicEffort: boolean
  dynamicPermissionMode: boolean
  subagents: boolean
  planMode: boolean
  fileCheckpointing: boolean
  rewind: boolean
  nativeFork: boolean
  prewarmPoolSize: number
  prewarmIdleMs: number
  residentIdleMs: number
}

export interface ClaudeAdvancedRuntimeCapabilities {
  prewarm: boolean
  residentSession: boolean
  protocolInterrupt: boolean
  queuedInput: boolean
  steer: boolean
  dynamicModel: boolean
  dynamicEffort: boolean
  dynamicPermissionMode: boolean
  subagentProjection: boolean
  subagentProgress: boolean
  subagentStop: boolean
  planMode: boolean
  fileCheckpointing: boolean
  rewind: boolean
  nativeFork: boolean
}

export type ClaudeStartupFactory = (params: { options?: Options; initializeTimeoutMs?: number }) => Promise<WarmQuery>

function explicitTrue(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "")
}

function enabled(env: NodeJS.ProcessEnv, flag: string, killSwitch: string): boolean {
  const policy = flag.replace(/_ENABLED$/, "_POLICY_ALLOWED")
  return explicitTrue(env[flag]) && explicitTrue(env[policy]) && !explicitTrue(env[killSwitch])
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback
}

export function resolveClaudeAdvancedRuntimePolicy(env: NodeJS.ProcessEnv = process.env): ClaudeAdvancedRuntimePolicy {
  return {
    prewarm: enabled(env, CLAUDE_PREWARM_FEATURE_FLAG, CLAUDE_PREWARM_KILL_SWITCH),
    residentSession: enabled(env, CLAUDE_RESIDENT_SESSION_FEATURE_FLAG, CLAUDE_RESIDENT_SESSION_KILL_SWITCH),
    protocolInterrupt: enabled(env, CLAUDE_PROTOCOL_INTERRUPT_FEATURE_FLAG, CLAUDE_PROTOCOL_INTERRUPT_KILL_SWITCH),
    queuedInput: enabled(env, CLAUDE_QUEUED_INPUT_FEATURE_FLAG, CLAUDE_QUEUED_INPUT_KILL_SWITCH),
    steer: enabled(env, CLAUDE_STEER_FEATURE_FLAG, CLAUDE_STEER_KILL_SWITCH),
    dynamicModel: enabled(env, CLAUDE_DYNAMIC_MODEL_FEATURE_FLAG, CLAUDE_DYNAMIC_MODEL_KILL_SWITCH),
    dynamicEffort: enabled(env, CLAUDE_DYNAMIC_EFFORT_FEATURE_FLAG, CLAUDE_DYNAMIC_EFFORT_KILL_SWITCH),
    dynamicPermissionMode: enabled(env, CLAUDE_DYNAMIC_PERMISSION_FEATURE_FLAG, CLAUDE_DYNAMIC_PERMISSION_KILL_SWITCH),
    subagents: enabled(env, CLAUDE_SUBAGENTS_FEATURE_FLAG, CLAUDE_SUBAGENTS_KILL_SWITCH),
    planMode: enabled(env, CLAUDE_PLAN_MODE_FEATURE_FLAG, CLAUDE_PLAN_MODE_KILL_SWITCH),
    fileCheckpointing: enabled(env, CLAUDE_FILE_CHECKPOINTING_FEATURE_FLAG, CLAUDE_FILE_CHECKPOINTING_KILL_SWITCH),
    rewind: enabled(env, CLAUDE_REWIND_FEATURE_FLAG, CLAUDE_REWIND_KILL_SWITCH),
    nativeFork: enabled(env, CLAUDE_NATIVE_FORK_FEATURE_FLAG, CLAUDE_NATIVE_FORK_KILL_SWITCH),
    prewarmPoolSize: boundedInteger(env[CLAUDE_PREWARM_POOL_SIZE_ENV], 2, 1, 8),
    prewarmIdleMs: boundedInteger(env[CLAUDE_PREWARM_IDLE_MS_ENV], 30_000, 1_000, 5 * 60_000),
    residentIdleMs: boundedInteger(env[CLAUDE_RESIDENT_IDLE_MS_ENV], 60_000, 1_000, 30 * 60_000),
  }
}

interface WarmEntry {
  key: string
  handle: WarmQuery
  controller: AbortController
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

export class ClaudeStartupPool {
  readonly #entries: WarmEntry[] = []
  readonly #pendingKeys = new Set<string>()
  #closed = false

  constructor(private readonly options: { startup: ClaudeStartupFactory; maxSize: number; idleMs: number; now?: () => number }) {
    if (!Number.isSafeInteger(options.maxSize) || options.maxSize < 1 || options.maxSize > 8) {
      throw new Error("Claude prewarm pool size must be between 1 and 8")
    }
    if (!Number.isSafeInteger(options.idleMs) || options.idleMs < 1_000 || options.idleMs > 5 * 60_000) {
      throw new Error("Claude prewarm idle expiry must be between 1 second and 5 minutes")
    }
  }

  get size(): number {
    return this.#entries.length
  }

  take(key: string): { query(prompt: string | AsyncIterable<SDKUserMessage>): Query; controller: AbortController } | null {
    this.#expire()
    const index = this.#entries.findIndex((entry) => entry.key === key)
    if (index < 0) return null
    const [entry] = this.#entries.splice(index, 1)
    if (!entry) return null
    clearTimeout(entry.timer)
    return { query: (prompt) => entry.handle.query(prompt), controller: entry.controller }
  }

  warm(key: string, options: Options): void {
    this.#expire()
    if (this.#closed || this.#pendingKeys.has(key) || this.#entries.some((entry) => entry.key === key)) return
    if (this.#entries.length + this.#pendingKeys.size >= this.options.maxSize) return
    this.#pendingKeys.add(key)
    const controller = new AbortController()
    void this.options.startup({ options: { ...options, abortController: controller } }).then((handle) => {
      if (this.#closed) {
        handle.close()
        return
      }
      this.#entries.push({
        key,
        handle,
        controller,
        expiresAt: this.#now() + this.options.idleMs,
        timer: setTimeout(() => this.#remove(handle), this.options.idleMs),
      })
    }).catch(() => {
      controller.abort()
      // Prewarm is opportunistic. A later turn falls back to run-per-query.
    }).finally(() => this.#pendingKeys.delete(key))
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const entry of this.#entries.splice(0)) {
      clearTimeout(entry.timer)
      entry.controller.abort()
      entry.handle.close()
    }
  }

  #expire(): void {
    const now = this.#now()
    for (const entry of [...this.#entries]) {
      if (entry.expiresAt <= now) this.#remove(entry.handle)
    }
  }

  #remove(handle: WarmQuery): void {
    const index = this.#entries.findIndex((entry) => entry.handle === handle)
    if (index < 0) return
    const [entry] = this.#entries.splice(index, 1)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.controller.abort()
    entry.handle.close()
  }

  #now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

export class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  readonly #values: SDKUserMessage[] = []
  readonly #waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = []
  #closed = false

  push(value: SDKUserMessage): void {
    if (this.#closed) throw new Error("Claude resident input queue is closed")
    const waiter = this.#waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.#values.shift()
        if (value) return Promise.resolve({ value, done: false })
        if (this.#closed) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.#waiters.push(resolve))
      },
    }
  }
}

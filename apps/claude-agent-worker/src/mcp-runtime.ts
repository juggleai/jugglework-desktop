import type { McpServerConfig, McpServerStatus, Query } from "@anthropic-ai/claude-agent-sdk"
import { createInternalToolBridge, createJuggleWorkSdkMcpServer } from "./internal-tools.js"

import {
  CLAUDE_WORKER_MAX_MCP_OUTPUT_BYTES,
  type ClaudeWorkerEvent,
  type ClaudeWorkerMcpConfiguration,
  type ClaudeWorkerMcpDiagnostic,
  type ClaudeWorkerMcpDiagnosticsResponse,
  type ClaudeWorkerMcpRefreshResponse,
  claudeWorkerMcpConfigurationSchema,
  claudeWorkerMcpDiagnosticSchema,
  claudeWorkerMcpDiagnosticsResponseSchema,
  claudeWorkerMcpRefreshResponseSchema,
} from "./schemas.js"

type PublishEvent = (type: ClaudeWorkerEvent["type"], payload?: Record<string, unknown>) => ClaudeWorkerEvent
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|secret|password|api[_-]?key|client[_-]?secret)$/i
const SECRET_TEXT = /(Bearer\s+)[A-Za-z0-9._~+\/-]+=*|\b(?:access|refresh)[_-]?token\s*[=:]\s*[^\s,;]+|\b(?:api[_-]?key|secret|password)\s*[=:]\s*[^\s,;]+/gi

function scrubText(value: string): string {
  return value.replace(SECRET_TEXT, (match, bearer: string | undefined) => bearer ? `${bearer}[REDACTED]` : "[REDACTED]")
}

function scrubValue(value: unknown, seen = new Set<object>()): JsonValue {
  if (typeof value === "string") return scrubText(value)
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (typeof value === "boolean" || value === null) return value
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, seen))
  if (typeof value !== "object" || value === null) return String(value)
  if (seen.has(value)) return "[REDACTED]"
  seen.add(value)
  const output: Record<string, JsonValue> = {}
  for (const [key, nested] of Object.entries(value)) {
    output[key] = SECRET_KEY.test(key) ? "[REDACTED]" : scrubValue(nested, seen)
  }
  seen.delete(value)
  return output
}

export function boundAndRedactMcpOutput(
  value: unknown,
  maxBytes = CLAUDE_WORKER_MAX_MCP_OUTPUT_BYTES,
): { value: JsonValue; truncated: boolean; originalBytes: number } {
  const scrubbed = scrubValue(value)
  const encoded = JSON.stringify(scrubbed)
  const originalBytes = Buffer.byteLength(encoded)
  if (originalBytes <= maxBytes) return { value: scrubbed, truncated: false, originalBytes }
  const markerBytes = Buffer.byteLength(JSON.stringify({ truncated: true, originalBytes, preview: "" }))
  const preview = Buffer.from(encoded).subarray(0, Math.max(0, maxBytes - markerBytes)).toString("utf8")
  return {
    value: { truncated: true, originalBytes, preview: scrubText(preview) },
    truncated: true,
    originalBytes,
  }
}

function sameServer(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function sdkConfiguration(input: ClaudeWorkerMcpConfiguration, now: number): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, server] of Object.entries(input.servers)) {
    if (server.credentialExpiresAt !== undefined && server.credentialExpiresAt <= now) continue
    servers[name] = {
      type: server.type,
      url: server.url,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
      ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
      ...(server.alwaysLoad !== undefined ? { alwaysLoad: server.alwaysLoad } : {}),
    }
  }
  return servers
}

export class ClaudeMcpRuntimeError extends Error {
  constructor(readonly code: "configuration_stale" | "mcp_not_found", message: string) {
    super(message)
    this.name = "ClaudeMcpRuntimeError"
  }
}

export class ClaudeMcpRuntime {
  readonly #configurations = new Map<string, ClaudeWorkerMcpConfiguration>()
  readonly #diagnostics = new Map<string, Map<string, ClaudeWorkerMcpDiagnostic>>()
  readonly #queries = new Map<string, Set<Query>>()
  readonly #now: () => number

  constructor(private readonly options: { publishEvent: PublishEvent; now?: () => number }) {
    this.#now = options.now ?? Date.now
  }

  configurationForRun(run: { workspaceId: string; sessionId: string }): Record<string, McpServerConfig> {
    const configuration = this.#configurations.get(run.workspaceId)
    if (!configuration) return {}
    const now = this.#now()
    for (const [name, server] of Object.entries(configuration.servers)) {
      this.#diagnose(run.workspaceId, name, server.credentialExpiresAt !== undefined && server.credentialExpiresAt <= now
        ? { state: "expired", code: "mcp_credential_expired", retryable: true }
        : { state: "initializing", code: "mcp_initializing", retryable: true })
    }
    const servers = sdkConfiguration(configuration, now)
    if (configuration.internalTools && configuration.internalTools.credentialExpiresAt > now) {
      servers.jugglework = createJuggleWorkSdkMcpServer({
        bridge: createInternalToolBridge({ configuration: configuration.internalTools, run, now: this.#now }),
      })
    }
    return servers
  }

  attachQuery(workspaceId: string, query: Query): () => void {
    const queries = this.#queries.get(workspaceId) ?? new Set<Query>()
    queries.add(query)
    this.#queries.set(workspaceId, queries)
    return () => {
      queries.delete(query)
      if (queries.size === 0) this.#queries.delete(workspaceId)
    }
  }

  async refresh(input: ClaudeWorkerMcpConfiguration): Promise<ClaudeWorkerMcpRefreshResponse> {
    const next = claudeWorkerMcpConfigurationSchema.parse(input)
    const previous = this.#configurations.get(next.workspaceId)
    if (previous && next.revision < previous.revision) {
      throw new ClaudeMcpRuntimeError("configuration_stale", "MCP configuration revision is stale")
    }
    if (previous && next.revision === previous.revision) {
      if (!sameServer(previous, next)) throw new ClaudeMcpRuntimeError("configuration_stale", "MCP configuration revision was reused")
      return claudeWorkerMcpRefreshResponseSchema.parse({
        accepted: true,
        workspaceId: next.workspaceId,
        revision: next.revision,
        added: [],
        updated: [],
        removed: [],
      })
    }

    const before = previous?.servers ?? {}
    const after = next.servers
    const added = Object.keys(after).filter((name) => !(name in before))
    const updated = Object.keys(after).filter((name) => name in before && !sameServer(before[name], after[name]))
    const removed = Object.keys(before).filter((name) => !(name in after))
    this.#configurations.set(next.workspaceId, next)

    for (const name of removed) this.#diagnose(next.workspaceId, name, { state: "removed", code: "mcp_removed", retryable: false })
    for (const name of [...added, ...updated]) {
      const server = after[name]!
      this.#diagnose(next.workspaceId, name, server.credentialExpiresAt !== undefined && server.credentialExpiresAt <= this.#now()
        ? { state: "expired", code: "mcp_credential_expired", retryable: true }
        : { state: "pending", code: "mcp_updated", retryable: true })
    }

    const active = this.#queries.get(next.workspaceId) ?? []
    const servers = sdkConfiguration(next, this.#now())
    for (const query of active) {
      try {
        const result = await query.setMcpServers(servers)
        for (const name of result.added) this.#diagnose(next.workspaceId, name, { state: "pending", code: "mcp_pending", retryable: true })
        for (const name of result.removed) this.#diagnose(next.workspaceId, name, { state: "removed", code: "mcp_removed", retryable: false })
        for (const name of Object.keys(result.errors)) this.#diagnose(next.workspaceId, name, { state: "failed", code: "mcp_failed", retryable: true })
      } catch {
        for (const name of [...added, ...updated]) this.#diagnose(next.workspaceId, name, { state: "failed", code: "mcp_failed", retryable: true })
      }
    }

    return claudeWorkerMcpRefreshResponseSchema.parse({
      accepted: true,
      workspaceId: next.workspaceId,
      revision: next.revision,
      added,
      updated,
      removed,
    })
  }

  async reconnect(workspaceId: string, serverName: string): Promise<void> {
    if (!this.#configurations.get(workspaceId)?.servers[serverName]) {
      throw new ClaudeMcpRuntimeError("mcp_not_found", "MCP server was not found")
    }
    const queries = this.#queries.get(workspaceId)
    if (!queries?.size) {
      this.#diagnose(workspaceId, serverName, { state: "pending", code: "mcp_pending", retryable: true })
      return
    }
    try {
      await Promise.all([...queries].map((query) => query.reconnectMcpServer(serverName)))
      this.#diagnose(workspaceId, serverName, { state: "connected", code: "mcp_reconnected", retryable: false })
    } catch {
      this.#diagnose(workspaceId, serverName, { state: "failed", code: "mcp_failed", retryable: true })
      throw new ClaudeMcpRuntimeError("mcp_not_found", "MCP reconnect failed")
    }
  }

  recordInitialization(workspaceId: string, statuses: unknown): void {
    if (!Array.isArray(statuses)) return
    for (const status of statuses as McpServerStatus[]) {
      if (!status || typeof status.name !== "string") continue
      const mapped = status.status === "connected"
        ? { state: "connected" as const, code: "mcp_connected" as const, retryable: false }
        : status.status === "needs-auth"
          ? { state: "needs_auth" as const, code: "mcp_needs_auth" as const, retryable: true }
          : status.status === "failed"
            ? { state: "failed" as const, code: "mcp_failed" as const, retryable: true }
            : { state: "pending" as const, code: "mcp_pending" as const, retryable: true }
      this.#diagnose(workspaceId, status.name, mapped)
    }
  }

  rejectInteractiveOAuth(workspaceId: string, serverName: string): { action: "decline" } {
    this.#diagnose(workspaceId, serverName, { state: "needs_auth", code: "mcp_needs_auth", retryable: true })
    return { action: "decline" }
  }

  recordHandlerFailure(workspaceId: string, serverName: string): void {
    this.#diagnose(workspaceId, serverName, { state: "failed", code: "mcp_handler_failed", retryable: true })
  }

  recordOutputTruncated(workspaceId: string, serverName: string): void {
    this.#diagnose(workspaceId, serverName, { state: "connected", code: "mcp_output_truncated", retryable: false })
  }

  async executeHandler<T>(input: {
    workspaceId: string
    serverName: string
    handler: () => T | Promise<T>
    maxOutputBytes?: number
  }): Promise<{ value: JsonValue; truncated: boolean; originalBytes: number }> {
    try {
      const bounded = boundAndRedactMcpOutput(await input.handler(), input.maxOutputBytes)
      if (bounded.truncated) this.recordOutputTruncated(input.workspaceId, input.serverName)
      return bounded
    } catch (error) {
      this.recordHandlerFailure(input.workspaceId, input.serverName)
      throw new Error("MCP handler failed", { cause: error })
    }
  }

  diagnostics(workspaceId: string): ClaudeWorkerMcpDiagnosticsResponse {
    return claudeWorkerMcpDiagnosticsResponseSchema.parse({
      workspaceId,
      revision: this.#configurations.get(workspaceId)?.revision ?? 0,
      items: [...(this.#diagnostics.get(workspaceId)?.values() ?? [])],
    })
  }

  #diagnose(
    workspaceId: string,
    serverName: string,
    input: Pick<ClaudeWorkerMcpDiagnostic, "state" | "code" | "retryable">,
  ): void {
    const diagnostic = claudeWorkerMcpDiagnosticSchema.parse({
      workspaceId,
      serverName,
      ...input,
      revision: this.#configurations.get(workspaceId)?.revision ?? 0,
      occurredAt: this.#now(),
    })
    const workspace = this.#diagnostics.get(workspaceId) ?? new Map<string, ClaudeWorkerMcpDiagnostic>()
    workspace.set(serverName, diagnostic)
    this.#diagnostics.set(workspaceId, workspace)
    this.options.publishEvent("mcp.diagnostic", diagnostic)
  }
}

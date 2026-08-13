import { z } from "zod"

export const CLAUDE_AGENT_SDK_VERSION = "0.3.226" as const
export const CLAUDE_WORKER_PROTOCOL_VERSION = 1 as const

export const CLAUDE_WORKER_MAX_HEADER_BYTES = 16 * 1024
export const CLAUDE_WORKER_MAX_REQUEST_BYTES = 256 * 1024
export const CLAUDE_WORKER_MAX_EVENT_BYTES = 64 * 1024
export const CLAUDE_WORKER_MAX_RETAINED_EVENTS = 1_000
export const CLAUDE_WORKER_MAX_MCP_OUTPUT_BYTES = 32 * 1024

const workerIdSchema = z.string().trim().min(1).max(256)

export const claudeWorkerGenerationTokenSchema = z.string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "generation token must be base64url encoded")

export const claudeWorkerHealthStatusSchema = z.enum([
  "disabled",
  "unavailable",
  "starting",
  "healthy",
  "degraded",
  "failed",
  "stopping",
])
export type ClaudeWorkerHealthStatus = z.infer<typeof claudeWorkerHealthStatusSchema>

export const claudeWorkerDiagnosticCodeSchema = z.enum([
  "feature_disabled",
  "unsupported_platform",
  "unsupported_architecture",
  "unsupported_node_version",
  "worker_not_provisioned",
  "claude_executable_not_provisioned",
  "worker_starting",
  "worker_ready",
  "worker_stopping",
  "mcp_initializing",
  "mcp_pending",
  "mcp_connected",
  "mcp_failed",
  "mcp_needs_auth",
  "mcp_credential_expired",
  "mcp_reconnected",
  "mcp_updated",
  "mcp_removed",
  "mcp_output_truncated",
  "mcp_handler_failed",
])
export type ClaudeWorkerDiagnosticCode = z.infer<typeof claudeWorkerDiagnosticCodeSchema>

export const claudeWorkerHealthSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  status: claudeWorkerHealthStatusSchema,
  checkedAt: z.string().datetime({ offset: true }),
  reasonCode: claudeWorkerDiagnosticCodeSchema.nullable(),
  message: z.string().trim().min(1).max(2_000).nullable(),
}).strict()
export type ClaudeWorkerHealth = z.infer<typeof claudeWorkerHealthSchema>

export const claudeWorkerCapabilitiesSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  sdkVersion: z.literal(CLAUDE_AGENT_SDK_VERSION),
  cliVersion: z.string().trim().min(1).max(128),
  nodeVersion: z.string().trim().min(1).max(64),
  transport: z.literal("loopback-http"),
  limits: z.object({
    maxHeaderBytes: z.literal(CLAUDE_WORKER_MAX_HEADER_BYTES),
    maxRequestBytes: z.literal(CLAUDE_WORKER_MAX_REQUEST_BYTES),
    maxEventBytes: z.literal(CLAUDE_WORKER_MAX_EVENT_BYTES),
    maxRetainedEvents: z.literal(CLAUDE_WORKER_MAX_RETAINED_EVENTS),
  }).strict(),
  operations: z.object({
    health: z.literal(true),
    capabilities: z.literal(true),
    events: z.literal(true),
    shutdown: z.literal(true),
    run: z.boolean(),
    abort: z.boolean(),
    interactions: z.boolean(),
    configurationRefresh: z.boolean(),
    currentTurnConfiguration: z.boolean(),
    stopSubagent: z.boolean(),
    nativeFork: z.boolean(),
  }).strict(),
  advanced: z.object({
    subagentProjection: z.boolean(),
    subagentProgress: z.boolean(),
    subagentStop: z.boolean(),
    planMode: z.boolean(),
    fileCheckpointing: z.boolean(),
    rewind: z.boolean(),
    nativeFork: z.boolean(),
    partialFallback: z.literal(true),
    filesystemState: z.literal("shared-working-tree"),
    prewarm: z.boolean(),
    residentSession: z.boolean(),
    protocolInterrupt: z.boolean(),
    queuedInput: z.boolean(),
    steer: z.boolean(),
    dynamicModel: z.boolean(),
    dynamicEffort: z.boolean(),
    dynamicPermissionMode: z.boolean(),
  }).strict(),
  sandbox: z.object({
    supported: z.boolean(),
    enabled: z.boolean(),
    failClosed: z.literal(true),
    allowUnsandboxedCommands: z.literal(false),
    backend: z.enum(["seatbelt", "bubblewrap", "windows-sandbox", "unsupported"]),
    reasonCode: z.enum(["sandbox_supported", "sandbox_unsupported_host"]),
  }).strict(),
}).strict()
export type ClaudeWorkerCapabilities = z.infer<typeof claudeWorkerCapabilitiesSchema>

export const claudeWorkerEventTypeSchema = z.enum([
  "worker.ready",
  "worker.health.changed",
  "worker.stopping",
  "session.initialized",
  "session.status",
  "session.compacted",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "run.usage",
  "run.completed",
  "run.failed",
  "run.aborted",
  "run.mutation.possible",
  "agent.event",
  "mcp.diagnostic",
  "tool.policy.requested",
  "tool.policy.resolved",
])

export const claudeWorkerEventSchema = z.object({
  protocolVersion: z.literal(CLAUDE_WORKER_PROTOCOL_VERSION),
  sequence: z.number().int().positive(),
  id: z.string().trim().min(1).max(128),
  type: claudeWorkerEventTypeSchema,
  createdAt: z.string().datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
}).strict()
export type ClaudeWorkerEvent = z.infer<typeof claudeWorkerEventSchema>

export const claudeWorkerRunLimitsSchema = z.object({
  maxTurns: z.number().int().min(1).max(1_000).default(50),
  maxBudgetUsd: z.number().positive().max(100_000).default(100),
  wallClockMs: z.number().int().min(100).max(24 * 60 * 60 * 1_000).default(30 * 60 * 1_000),
  hardCloseMs: z.number().int().min(10).max(30_000).default(2_000),
  approvalDeadlineMs: z.number().int().min(100).max(10 * 60_000).default(2 * 60_000),
}).strict()
export type ClaudeWorkerRunLimits = z.infer<typeof claudeWorkerRunLimitsSchema>

export const claudeWorkerPermissionPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("default") }).strict(),
  z.object({ mode: z.literal("headless"), action: z.enum(["deny", "preapproved", "wait"]) }).strict(),
])
export type ClaudeWorkerPermissionPolicy = z.infer<typeof claudeWorkerPermissionPolicySchema>

export const claudeWorkerRunRequestSchema = z.object({
  workspaceId: workerIdSchema,
  sessionId: workerIdSchema,
  runId: workerIdSchema,
  backendSessionId: z.string().uuid().nullable(),
  cwd: z.string().trim().min(1).max(8_192),
  prompt: z.string().min(1).max(200_000),
  delivery: z.enum(["start", "enqueue", "steer"]).default("start"),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "dontAsk"]).optional(),
  planMode: z.boolean().optional(),
  limits: claudeWorkerRunLimitsSchema.default({
    maxTurns: 50,
    maxBudgetUsd: 100,
    wallClockMs: 30 * 60 * 1_000,
    hardCloseMs: 2_000,
    approvalDeadlineMs: 2 * 60_000,
  }),
  permissionPolicy: claudeWorkerPermissionPolicySchema.default({ mode: "default" }),
}).strict()
export type ClaudeWorkerRunRequest = z.infer<typeof claudeWorkerRunRequestSchema>

export const claudeWorkerRunResponseSchema = z.object({
  accepted: z.literal(true),
  runId: workerIdSchema,
  status: z.literal("starting"),
}).strict()
export type ClaudeWorkerRunResponse = z.infer<typeof claudeWorkerRunResponseSchema>

export const claudeWorkerAbortRequestSchema = z.object({
  sessionId: workerIdSchema,
  runId: workerIdSchema,
}).strict()
export type ClaudeWorkerAbortRequest = z.infer<typeof claudeWorkerAbortRequestSchema>

export const claudeWorkerStopSubagentRequestSchema = z.object({
  sessionId: workerIdSchema,
  runId: workerIdSchema,
  taskId: workerIdSchema,
}).strict()
export type ClaudeWorkerStopSubagentRequest = z.infer<typeof claudeWorkerStopSubagentRequestSchema>

export const claudeWorkerStopSubagentResponseSchema = z.object({
  accepted: z.literal(true),
  taskId: workerIdSchema,
  status: z.literal("stopping"),
}).strict()

export const claudeWorkerForkRequestSchema = z.object({
  sourceBackendSessionId: z.string().uuid(),
  cwd: z.string().trim().min(1).max(8_192),
  title: z.string().trim().min(1).max(512).optional(),
  upToMessageId: workerIdSchema.optional(),
}).strict()
export type ClaudeWorkerForkRequest = z.infer<typeof claudeWorkerForkRequestSchema>

export const claudeWorkerForkResponseSchema = z.object({
  accepted: z.literal(true),
  backendSessionId: z.string().uuid(),
  filesystemState: z.object({
    sharedWorkingTree: z.literal(true),
    checkpointHistoryCopied: z.literal(false),
    filesRewound: z.literal(false),
    warning: z.string().trim().min(1).max(2_000),
  }).strict(),
}).strict()
export type ClaudeWorkerForkResponse = z.infer<typeof claudeWorkerForkResponseSchema>

export const claudeWorkerAbortResponseSchema = z.object({
  accepted: z.literal(true),
  runId: workerIdSchema,
  status: z.literal("aborting"),
}).strict()
export type ClaudeWorkerAbortResponse = z.infer<typeof claudeWorkerAbortResponseSchema>

export const claudeWorkerInteractionResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow"), updatedInput: z.json().optional() }).strict(),
  z.object({ outcome: z.literal("deny"), reason: z.string().trim().min(1).max(4_000) }).strict(),
  z.object({ outcome: z.literal("answer"), values: z.array(z.string().max(20_000)).max(100) }).strict(),
  z.object({ outcome: z.literal("reject"), reason: z.string().max(4_000).optional() }).strict(),
  z.object({ outcome: z.literal("timeout") }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
])
export type ClaudeWorkerInteractionResolution = z.infer<typeof claudeWorkerInteractionResolutionSchema>

export const claudeWorkerResolveInteractionRequestSchema = z.object({
  sessionId: workerIdSchema,
  runId: workerIdSchema,
  resolution: claudeWorkerInteractionResolutionSchema,
}).strict()
export type ClaudeWorkerResolveInteractionRequest = z.infer<typeof claudeWorkerResolveInteractionRequestSchema>

export const claudeWorkerResolveInteractionResponseSchema = z.object({
  accepted: z.literal(true),
  interactionId: workerIdSchema,
}).strict()

export const claudeWorkerRunStatusSchema = z.enum([
  "starting",
  "running",
  "retrying",
  "aborting",
  "completed",
  "failed",
  "aborted",
])
export type ClaudeWorkerRunStatus = z.infer<typeof claudeWorkerRunStatusSchema>

export const claudeWorkerRunObservationSchema = z.object({
  runId: workerIdSchema,
  sessionId: workerIdSchema,
  backendSessionId: z.string().uuid().nullable(),
  status: claudeWorkerRunStatusSchema,
  terminal: z.boolean(),
  errorCode: z.string().trim().min(1).max(128).nullable(),
}).strict()
export type ClaudeWorkerRunObservation = z.infer<typeof claudeWorkerRunObservationSchema>

const mcpServerNameSchema = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const mcpHeaderNameSchema = z.string().trim().min(1).max(128).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/)
const mcpHeadersSchema = z.record(mcpHeaderNameSchema, z.string().max(8_192)).superRefine((headers, context) => {
  if (Object.keys(headers).length > 64) context.addIssue({ code: "custom", message: "MCP headers exceed the count limit" })
  if (Buffer.byteLength(JSON.stringify(headers)) > 16 * 1024) context.addIssue({ code: "custom", message: "MCP headers exceed the size limit" })
})

export const claudeWorkerMcpServerSchema = z.object({
  type: z.enum(["http", "sse"]),
  url: z.string().trim().url().max(8_192).refine((value) => {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.hash
  }, "MCP URL must be credential-free HTTP(S)"),
  headers: mcpHeadersSchema.optional(),
  credentialExpiresAt: z.number().int().positive().optional(),
  timeoutMs: z.number().int().min(1_000).max(10 * 60_000).optional(),
  alwaysLoad: z.boolean().optional(),
}).strict()
export type ClaudeWorkerMcpServer = z.infer<typeof claudeWorkerMcpServerSchema>

export const claudeWorkerInternalToolsSchema = z.object({
  url: z.string().trim().url().refine((value) => {
    const url = new URL(value)
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "::1")
      && !url.username && !url.password && !url.hash
  }, "Internal tools URL must use credential-free loopback HTTP"),
  credential: claudeWorkerGenerationTokenSchema,
  actor: z.literal("claude-worker"),
  schemaVersion: z.literal(1),
  credentialExpiresAt: z.number().int().positive(),
}).strict()
export type ClaudeWorkerInternalTools = z.infer<typeof claudeWorkerInternalToolsSchema>

export const claudeWorkerMcpConfigurationSchema = z.object({
  workspaceId: workerIdSchema,
  revision: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  servers: z.record(mcpServerNameSchema, claudeWorkerMcpServerSchema).superRefine((servers, context) => {
    if (Object.keys(servers).length > 64) context.addIssue({ code: "custom", message: "MCP server count exceeds the limit" })
  }),
  internalTools: claudeWorkerInternalToolsSchema.optional(),
}).strict()
export type ClaudeWorkerMcpConfiguration = z.infer<typeof claudeWorkerMcpConfigurationSchema>

export const claudeWorkerMcpRefreshResponseSchema = z.object({
  accepted: z.literal(true),
  workspaceId: workerIdSchema,
  revision: z.number().int().nonnegative(),
  added: z.array(mcpServerNameSchema),
  updated: z.array(mcpServerNameSchema),
  removed: z.array(mcpServerNameSchema),
}).strict()
export type ClaudeWorkerMcpRefreshResponse = z.infer<typeof claudeWorkerMcpRefreshResponseSchema>

export const claudeWorkerMcpDiagnosticStateSchema = z.enum([
  "initializing",
  "pending",
  "connected",
  "failed",
  "needs_auth",
  "expired",
  "removed",
])

export const claudeWorkerMcpDiagnosticSchema = z.object({
  workspaceId: workerIdSchema,
  serverName: mcpServerNameSchema,
  state: claudeWorkerMcpDiagnosticStateSchema,
  code: claudeWorkerDiagnosticCodeSchema,
  revision: z.number().int().nonnegative(),
  occurredAt: z.number().int().nonnegative(),
  retryable: z.boolean(),
}).strict()
export type ClaudeWorkerMcpDiagnostic = z.infer<typeof claudeWorkerMcpDiagnosticSchema>

export const claudeWorkerMcpDiagnosticsResponseSchema = z.object({
  workspaceId: workerIdSchema,
  revision: z.number().int().nonnegative(),
  items: z.array(claudeWorkerMcpDiagnosticSchema).max(64),
}).strict()
export type ClaudeWorkerMcpDiagnosticsResponse = z.infer<typeof claudeWorkerMcpDiagnosticsResponseSchema>

export const claudeWorkerShutdownRequestSchema = z.object({
  reason: z.string().trim().min(1).max(256).optional(),
}).strict()

export const claudeWorkerShutdownResponseSchema = z.object({
  accepted: z.literal(true),
  status: z.literal("stopping"),
}).strict()

export const claudeWorkerErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum([
      "unauthorized",
      "forbidden_client",
      "not_found",
      "method_not_allowed",
      "invalid_content_type",
      "invalid_request",
      "payload_too_large",
      "event_cursor_invalid",
      "run_not_found",
      "session_busy",
      "unsupported_capability",
      "interaction_not_found",
      "already_resolved",
      "configuration_stale",
      "mcp_not_found",
      "internal_error",
    ]),
    message: z.string().trim().min(1).max(512),
  }).strict(),
}).strict()
export type ClaudeWorkerErrorResponse = z.infer<typeof claudeWorkerErrorResponseSchema>

import { z } from "zod"

export const AGENT_RUNTIME_SUPPORT_DIAGNOSTICS_VERSION = 1 as const
export const AGENT_RUNTIME_TELEMETRY_MAX_COUNT = 1_000_000_000
export const AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1_000
export const AGENT_RUNTIME_TELEMETRY_MAX_TOKENS = 1_000_000_000_000

export const claudeAdvancedFeatureSchema = z.enum([
  "prewarm",
  "resident",
  "interrupt",
  "queued-input",
  "steer",
  "dynamic-model",
  "dynamic-effort",
  "dynamic-permission",
  "subagents",
  "plan",
  "checkpoint",
  "rewind",
  "fork",
  "provider-gateway",
  "provider-bedrock",
  "provider-vertex",
  "provider-foundry",
])
export const CLAUDE_ADVANCED_FEATURES = claudeAdvancedFeatureSchema.options
export type ClaudeAdvancedFeature = z.infer<typeof claudeAdvancedFeatureSchema>

const countSchema = z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_COUNT)
const durationSchema = z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_DURATION_MS)
const timestampSchema = z.number().int().min(0).max(10_000_000_000_000)

export const agentRuntimeTelemetryDistributionSchema = z.object({
  count: countSchema,
  total: durationSchema,
  max: durationSchema,
}).strict()

export const agentRuntimeSupportDiagnosticsSchema = z.object({
  schemaVersion: z.literal(AGENT_RUNTIME_SUPPORT_DIAGNOSTICS_VERSION),
  capturedAt: timestampSchema,
  windowStartedAt: timestampSchema,
  worker: z.object({
    status: z.enum(["disabled", "stopped", "starting", "healthy", "backoff", "circuit_open", "failed", "stopping"]),
    statusChanges: countSchema,
    starts: countSchema,
    restarts: countSchema,
    crashes: countSchema,
    circuitOpens: countSchema,
  }).strict(),
  query: z.object({
    active: countSchema,
    started: countSchema,
    completed: countSchema,
    failed: countSchema,
    aborted: countSchema,
    durationMs: agentRuntimeTelemetryDistributionSchema,
  }).strict(),
  mcp: z.object({
    events: countSchema,
    initializing: countSchema,
    pending: countSchema,
    connected: countSchema,
    failed: countSchema,
    needsAuth: countSchema,
    expired: countSchema,
    removed: countSchema,
    outputTruncated: countSchema,
  }).strict(),
  interaction: z.object({
    requested: countSchema,
    resolved: countSchema,
    allowed: countSchema,
    denied: countSchema,
    answered: countSchema,
    rejected: countSchema,
    timedOut: countSchema,
    cancelled: countSchema,
    failed: countSchema,
    durationMs: agentRuntimeTelemetryDistributionSchema,
  }).strict(),
  event: z.object({
    observed: countSchema,
    persisted: countSchema,
    duplicates: countSchema,
    streamErrors: countSchema,
    lagMs: agentRuntimeTelemetryDistributionSchema,
  }).strict(),
  queue: z.object({
    created: countSchema,
    pending: countSchema,
    dispatching: countSchema,
    admitted: countSchema,
    completed: countSchema,
    failed: countSchema,
    cancelled: countSchema,
    waitMs: agentRuntimeTelemetryDistributionSchema,
  }).strict(),
  advancedRollout: z.object({
    features: z.array(z.object({
      feature: claudeAdvancedFeatureSchema,
      enabled: z.boolean(),
      attempts: countSchema,
      used: countSchema,
      fallbacks: countSchema,
      flagDisabled: countSchema,
      policyDenied: countSchema,
      killed: countSchema,
      capabilityMissing: countSchema,
    }).strict()).length(CLAUDE_ADVANCED_FEATURES.length).superRefine((features, context) => {
      const observed = new Set(features.map(({ feature }) => feature))
      if (observed.size !== CLAUDE_ADVANCED_FEATURES.length) {
        context.addIssue({ code: "custom", message: "Advanced rollout metrics must contain every feature exactly once" })
      }
    }),
  }).strict(),
  usage: z.object({
    samples: countSchema,
    inputTokens: z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_TOKENS),
    outputTokens: z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_TOKENS),
    cacheReadTokens: z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_TOKENS),
    cacheWriteTokens: z.number().int().min(0).max(AGENT_RUNTIME_TELEMETRY_MAX_TOKENS),
    turns: countSchema,
    durationMs: durationSchema,
    estimatedCostUsd: z.number().min(0).max(1_000_000_000),
  }).strict(),
  crash: z.object({
    total: countSchema,
    worker: countSchema,
    query: countSchema,
    eventStream: countSchema,
    lastAt: timestampSchema.nullable(),
    lastReason: z.enum(["worker_exit", "startup_failed", "circuit_open", "transport_lost", "event_stream_failed"]).nullable(),
  }).strict(),
}).strict()

export type AgentRuntimeTelemetryDistribution = z.infer<typeof agentRuntimeTelemetryDistributionSchema>
export type AgentRuntimeSupportDiagnostics = z.infer<typeof agentRuntimeSupportDiagnosticsSchema>

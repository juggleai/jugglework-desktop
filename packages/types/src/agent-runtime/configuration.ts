import { z } from "zod"

import type { AgentRuntimeDescriptor, AgentRuntimeModel } from "./runtime.js"

const executionBudgetSchema = z.object({
  maxTurns: z.number().int().positive().max(10_000).optional(),
  maxCostUsd: z.number().positive().max(1_000_000).optional(),
  maxDurationMs: z.number().int().positive().max(7 * 24 * 60 * 60 * 1_000).optional(),
}).strict()

export const agentRuntimeSessionConfigurationSchema = z.object({
  agentProfile: z.string().trim().min(1).max(128).optional(),
  model: z.object({
    providerId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(256),
  }).strict().optional(),
  execution: z.object({
    effort: z.string().trim().min(1).max(64).optional(),
    budget: executionBudgetSchema.optional(),
  }).strict().optional(),
}).strict()
export type AgentRuntimeSessionConfiguration = z.infer<typeof agentRuntimeSessionConfigurationSchema>

export const agentRuntimeEffortValues = ["low", "medium", "high", "xhigh", "max"] as const
export const agentRuntimeEffortSchema = z.enum(agentRuntimeEffortValues)
export type AgentRuntimeEffort = z.infer<typeof agentRuntimeEffortSchema>

// Bypass and plan are deliberately excluded. They require separate product and policy controls.
export const agentRuntimePermissionModeValues = ["default", "accept-edits", "dont-ask"] as const
export const agentRuntimePermissionModeSchema = z.enum(agentRuntimePermissionModeValues)
export type AgentRuntimePermissionMode = z.infer<typeof agentRuntimePermissionModeSchema>

export const agentRuntimeCurrentTurnConfigurationSchema = z.object({
  model: z.object({
    providerId: z.string().trim().min(1).max(128),
    modelId: z.string().trim().min(1).max(256),
  }).strict().optional(),
  effort: agentRuntimeEffortSchema.optional(),
  permissionMode: agentRuntimePermissionModeSchema.optional(),
  planMode: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "current-turn configuration cannot be empty")
export type AgentRuntimeCurrentTurnConfiguration = z.infer<typeof agentRuntimeCurrentTurnConfigurationSchema>

export type AgentRuntimeConfigurationIssueCode =
  | "invalid_shape"
  | "models_unsupported"
  | "model_unavailable"
  | "effort_unsupported"
  | "effort_unavailable"
  | "budget_unsupported"

export type AgentRuntimeConfigurationValidation =
  | { success: true; configuration: AgentRuntimeSessionConfiguration }
  | { success: false; code: AgentRuntimeConfigurationIssueCode; field: string }

function selectedModel(
  descriptor: AgentRuntimeDescriptor,
  configuration: AgentRuntimeSessionConfiguration,
): AgentRuntimeModel | null {
  if (!configuration.model) return null
  return descriptor.models.find((model) =>
    model.providerId === configuration.model?.providerId && model.id === configuration.model.modelId) ?? null
}

/** Validate only canonical, runtime-scoped settings. Raw backend options never pass this boundary. */
export function validateAgentRuntimeSessionConfiguration(
  descriptor: AgentRuntimeDescriptor,
  value: unknown,
): AgentRuntimeConfigurationValidation {
  const parsed = agentRuntimeSessionConfigurationSchema.safeParse(value ?? {})
  if (!parsed.success) return { success: false, code: "invalid_shape", field: parsed.error.issues[0]?.path.join(".") || "configuration" }

  const configuration = parsed.data
  if (configuration.model && !descriptor.capabilities.models) {
    return { success: false, code: "models_unsupported", field: "model" }
  }
  const model = selectedModel(descriptor, configuration)
  if (configuration.model && !model) {
    return { success: false, code: "model_unavailable", field: "model" }
  }
  const effort = configuration.execution?.effort
  if (effort && !descriptor.capabilities.variants) {
    return { success: false, code: "effort_unsupported", field: "execution.effort" }
  }
  const advertisedEfforts = model?.capabilities.flatMap((capability) =>
    capability.startsWith("effort:") ? [capability.slice("effort:".length)] : []) ?? []
  if (effort && advertisedEfforts.length > 0 && !advertisedEfforts.includes(effort)) {
    return { success: false, code: "effort_unavailable", field: "execution.effort" }
  }
  if (configuration.execution?.budget && !descriptor.capabilities["usage-and-cost"]) {
    return { success: false, code: "budget_unsupported", field: "execution.budget" }
  }
  return { success: true, configuration }
}

/** Convert canonical settings to the narrow shape understood by an adapter. */
export function agentRuntimeAdapterConfiguration(
  descriptor: AgentRuntimeDescriptor,
  configuration: AgentRuntimeSessionConfiguration,
): Record<string, unknown> {
  // Adapters receive canonical configuration and own all backend translation.
  // Keeping the complete shape here also lets run-time model choices survive
  // session creation without exposing OpenCode fields to the control plane.
  if (descriptor.engine === "opencode") return configuration
  return configuration
}

export const agentRuntimeDiagnosticCategoryValues = [
  "runtime_selection",
  "availability",
  "startup",
  "provider",
  "policy",
  "mcp",
  "timeout",
  "crash",
] as const
export const agentRuntimeDiagnosticCategorySchema = z.enum(agentRuntimeDiagnosticCategoryValues)
export type AgentRuntimeDiagnosticCategory = z.infer<typeof agentRuntimeDiagnosticCategorySchema>

/** Classify stable codes only. Messages, paths, prompts and backend payloads are intentionally ignored. */
export function classifyAgentRuntimeDiagnostic(code: string | null | undefined): AgentRuntimeDiagnosticCategory {
  const normalized = code?.trim().toLowerCase() ?? ""
  if (normalized.includes("timeout") || normalized.includes("deadline")) return "timeout"
  if (normalized.includes("crash") || normalized.includes("circuit") || normalized.includes("ownership_lost")) return "crash"
  if (normalized.includes("mcp")) return "mcp"
  if (normalized.includes("policy") || normalized.includes("permission") || normalized.includes("forbidden")) return "policy"
  if (normalized.includes("provider") || normalized.includes("credential") || normalized.includes("auth")) return "provider"
  if (normalized.includes("start") || normalized.includes("worker") || normalized.includes("binary") || normalized.includes("executable")) return "startup"
  if (normalized.includes("unavailable") || normalized.includes("disabled") || normalized.includes("unsupported") || normalized.includes("provision")) return "availability"
  return "runtime_selection"
}

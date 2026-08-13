import { z } from "zod"

import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  agentJsonObjectSchema,
  agentRuntimeIdSchema,
  agentTimestampSchema,
} from "./common.js"

export const agentRuntimeCapabilityValues = [
  "models",
  "variants",
  "reasoning-stream",
  "commands",
  "shell",
  "compact",
  "resume",
  "fork",
  "steer",
  "enqueue",
  "permissions",
  "questions",
  "todos",
  "mcp",
  "subagents",
  "file-checkpointing",
  "usage-and-cost",
  "prewarm",
  "resident-session",
  "plan-mode",
  "rewind",
  "dynamic-model",
  "dynamic-effort",
  "dynamic-permission-mode",
] as const

export const agentRuntimeCapabilitySchema = z.enum(agentRuntimeCapabilityValues)
export type AgentRuntimeCapability = z.infer<typeof agentRuntimeCapabilitySchema>

export const agentRuntimeCapabilitiesSchema = z.object(
  Object.fromEntries(agentRuntimeCapabilityValues.map((capability) => [capability, z.boolean()])) as {
    [K in AgentRuntimeCapability]: z.ZodBoolean
  },
).strict()
export type AgentRuntimeCapabilities = z.infer<typeof agentRuntimeCapabilitiesSchema>

export const agentRuntimeHealthStatusValues = [
  "disabled",
  "unavailable",
  "starting",
  "healthy",
  "degraded",
  "failed",
  "stopping",
] as const
export const agentRuntimeHealthStatusSchema = z.enum(agentRuntimeHealthStatusValues)
export type AgentRuntimeHealthStatus = z.infer<typeof agentRuntimeHealthStatusSchema>

export const agentRuntimeHealthSchema = z.object({
  status: agentRuntimeHealthStatusSchema,
  checkedAt: agentTimestampSchema,
  reasonCode: z.string().trim().min(1).max(128).nullable(),
  message: z.string().trim().min(1).max(2_000).nullable(),
  details: agentJsonObjectSchema.optional(),
}).strict().superRefine((health, ctx) => {
  if (["disabled", "unavailable", "degraded", "failed"].includes(health.status) && !health.reasonCode) {
    ctx.addIssue({ code: "custom", path: ["reasonCode"], message: `${health.status} health requires a reasonCode` })
  }
})
export type AgentRuntimeHealth = z.infer<typeof agentRuntimeHealthSchema>

export const agentRuntimeModelSchema = z.object({
  id: z.string().trim().min(1).max(256),
  providerId: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(256),
  description: z.string().max(2_000).optional(),
  isDefault: z.boolean(),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(64),
}).strict()
export type AgentRuntimeModel = z.infer<typeof agentRuntimeModelSchema>

export const agentRuntimeDescriptorSchema = z.object({
  schemaVersion: z.literal(AGENT_RUNTIME_SCHEMA_VERSION),
  id: agentRuntimeIdSchema,
  engine: z.string().trim().min(1).max(128),
  label: z.string().trim().min(1).max(256),
  description: z.string().max(2_000).optional(),
  isDefault: z.boolean(),
  capabilities: agentRuntimeCapabilitiesSchema,
  health: agentRuntimeHealthSchema,
  models: z.array(agentRuntimeModelSchema).max(256),
  limitations: z.array(z.object({
    capability: agentRuntimeCapabilitySchema,
    code: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(2_000),
  }).strict()).max(64).optional(),
}).strict().superRefine((descriptor, ctx) => {
  const modelIds = new Set<string>()
  let defaultModels = 0
  descriptor.models.forEach((model, index) => {
    const key = `${model.providerId}\0${model.id}`
    if (modelIds.has(key)) {
      ctx.addIssue({ code: "custom", path: ["models", index, "id"], message: "model identifiers must be unique" })
    }
    modelIds.add(key)
    if (model.isDefault) defaultModels += 1
  })
  if (defaultModels > 1) {
    ctx.addIssue({ code: "custom", path: ["models"], message: "at most one model may be the default" })
  }
  if (!descriptor.capabilities.models && descriptor.models.length > 0) {
    ctx.addIssue({ code: "custom", path: ["models"], message: "models require the models capability" })
  }
})
export type AgentRuntimeDescriptor = z.infer<typeof agentRuntimeDescriptorSchema>

export const agentRuntimeCatalogSchema = z.object({
  schemaVersion: z.literal(AGENT_RUNTIME_SCHEMA_VERSION),
  runtimes: z.array(agentRuntimeDescriptorSchema).max(64),
}).strict().superRefine((catalog, ctx) => {
  const runtimeIds = new Set<string>()
  let defaults = 0
  catalog.runtimes.forEach((runtime, index) => {
    if (runtimeIds.has(runtime.id)) {
      ctx.addIssue({ code: "custom", path: ["runtimes", index, "id"], message: "runtime identifiers must be unique" })
    }
    runtimeIds.add(runtime.id)
    if (runtime.isDefault) defaults += 1
  })
  if (defaults !== 1) {
    ctx.addIssue({ code: "custom", path: ["runtimes"], message: "exactly one runtime must be the default" })
  }
})
export type AgentRuntimeCatalog = z.infer<typeof agentRuntimeCatalogSchema>

export function hasAgentRuntimeCapability(
  descriptor: AgentRuntimeDescriptor,
  capability: AgentRuntimeCapability,
): boolean {
  return descriptor.capabilities[capability]
}

import { z } from "zod"

export const JUGGLEWORK_AFFORDANCE_SCHEMA_VERSION = 1

export const juggleworkAffordanceKindSchema = z.enum(["query", "command", "guidance"])
export type JuggleWorkAffordanceKind = z.infer<typeof juggleworkAffordanceKindSchema>

export const juggleworkProviderKindSchema = z.enum(["builtin", "extension", "mcp", "connect"])
export type JuggleWorkProviderKind = z.infer<typeof juggleworkProviderKindSchema>

export const juggleworkProviderRefSchema = z.object({
  id: z.string().trim().min(1),
  kind: juggleworkProviderKindSchema,
})
export type JuggleWorkProviderRef = z.infer<typeof juggleworkProviderRefSchema>

export const juggleworkAffordanceArgumentSchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(["string", "number", "boolean", "object", "array", "unknown"]),
  required: z.boolean(),
  description: z.string().trim().min(1).optional(),
})
export type JuggleWorkAffordanceArgument = z.infer<typeof juggleworkAffordanceArgumentSchema>

export const juggleworkAffordanceEffectsSchema = z.object({
  data: z.enum(["none", "read", "write"]),
  ui: z.enum(["none", "focus", "navigate", "layout", "dialog"]),
  external: z.boolean(),
})
export type JuggleWorkAffordanceEffects = z.infer<typeof juggleworkAffordanceEffectsSchema>

export const juggleworkAffordanceAvailabilitySchema = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().min(1).optional(),
})
export type JuggleWorkAffordanceAvailability = z.infer<typeof juggleworkAffordanceAvailabilitySchema>

export const juggleworkAffordanceExecutorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("jugglework") }),
  z.object({
    kind: z.literal("tool"),
    tool: z.string().trim().min(1),
  }),
])
export type JuggleWorkAffordanceExecutor = z.infer<typeof juggleworkAffordanceExecutorSchema>

export const juggleworkAffordanceDescriptorSchema = z.object({
  id: z.string().trim().min(1),
  kind: juggleworkAffordanceKindSchema,
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  provider: juggleworkProviderRefSchema,
  arguments: z.array(juggleworkAffordanceArgumentSchema),
  effects: juggleworkAffordanceEffectsSchema,
  confirmation: z.enum(["never", "destructive", "always"]),
  availability: juggleworkAffordanceAvailabilitySchema,
  executor: juggleworkAffordanceExecutorSchema,
})
export type JuggleWorkAffordanceDescriptor = z.infer<typeof juggleworkAffordanceDescriptorSchema>

export const juggleworkAffordanceRequestSchema = z.object({
  id: z.string().trim().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  actor: z.string().trim().min(1).optional(),
})
export type JuggleWorkAffordanceRequest = z.infer<typeof juggleworkAffordanceRequestSchema>

const juggleworkAffordanceSuccessSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
  result: z.unknown().optional(),
  revision: z.number().int().nonnegative().optional(),
  effects: juggleworkAffordanceEffectsSchema,
})

const juggleworkAffordanceFailureSchema = z.object({
  ok: z.literal(false),
  id: z.string(),
  error: z.string(),
  code: z.enum(["unavailable", "invalid-args", "conflict", "failed"]),
  revision: z.number().int().nonnegative().optional(),
})

export const juggleworkAffordanceResultSchema = z.discriminatedUnion("ok", [
  juggleworkAffordanceSuccessSchema,
  juggleworkAffordanceFailureSchema,
])
export type JuggleWorkAffordanceResult = z.infer<typeof juggleworkAffordanceResultSchema>

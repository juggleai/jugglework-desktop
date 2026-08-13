import { z } from "zod"

export const AGENT_RUNTIME_SCHEMA_VERSION = 1 as const

export const agentRuntimeIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/)
export const agentEntityIdSchema = z.string().trim().min(1).max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value))
export const agentTimestampSchema = z.number().int().nonnegative()
export const agentSequenceSchema = z.number().int().positive()
export const agentJsonObjectSchema = z.record(z.string().max(128), z.json())

export type AgentRuntimeId = z.infer<typeof agentRuntimeIdSchema>
export type AgentJsonObject = z.infer<typeof agentJsonObjectSchema>

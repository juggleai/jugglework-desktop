import { z } from "zod"

import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  agentEntityIdSchema,
  agentJsonObjectSchema,
  agentRuntimeIdSchema,
  agentSequenceSchema,
  agentTimestampSchema,
} from "./common.js"
import { canonicalAgentMessageSchema, canonicalAgentPartSchema, canonicalAgentTodoSchema } from "./content.js"
import { canonicalInteractionSchema } from "./interaction.js"
import { canonicalAgentSessionSchema, canonicalSessionStatusSchema } from "./session.js"
import { agentRuntimeCurrentTurnConfigurationSchema } from "./configuration.js"

export const canonicalAgentUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  turns: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  apiDurationMs: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
  estimateOnly: z.boolean(),
  modelUsage: z.record(z.string().max(256), agentJsonObjectSchema).optional(),
}).strict()
export type CanonicalAgentUsage = z.infer<typeof canonicalAgentUsageSchema>

const canonicalEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.created"), session: canonicalAgentSessionSchema }).strict(),
  z.object({ type: z.literal("session.updated"), session: canonicalAgentSessionSchema }).strict(),
  z.object({ type: z.literal("session.status"), status: canonicalSessionStatusSchema }).strict(),
  z.object({ type: z.literal("message.updated"), message: canonicalAgentMessageSchema }).strict(),
  z.object({ type: z.literal("message.part.updated"), messageId: agentEntityIdSchema, part: canonicalAgentPartSchema }).strict(),
  z.object({ type: z.literal("message.part.delta"), messageId: agentEntityIdSchema, partId: agentEntityIdSchema, field: z.enum(["text", "reasoning"]), delta: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal("interaction.requested"), interaction: canonicalInteractionSchema }).strict(),
  z.object({ type: z.literal("interaction.resolved"), interaction: canonicalInteractionSchema }).strict(),
  z.object({ type: z.literal("todo.updated"), todos: z.array(canonicalAgentTodoSchema).max(10_000) }).strict(),
  z.object({ type: z.literal("run.usage"), runId: agentEntityIdSchema, usage: canonicalAgentUsageSchema }).strict(),
  z.object({ type: z.literal("run.completed"), runId: agentEntityIdSchema, usage: canonicalAgentUsageSchema.optional() }).strict(),
  z.object({ type: z.literal("run.failed"), runId: agentEntityIdSchema, code: z.string().trim().min(1).max(128), message: z.string().max(20_000), retryable: z.boolean() }).strict(),
  z.object({ type: z.literal("run.aborted"), runId: agentEntityIdSchema }).strict(),
  z.object({
    type: z.literal("run.configuration"),
    runId: agentEntityIdSchema,
    semantics: z.literal("current-turn"),
    actor: z.enum(["local-renderer", "remote-control", "runtime"]),
    configuration: agentRuntimeCurrentTurnConfigurationSchema,
  }).strict(),
])
export type CanonicalAgentEventData = z.infer<typeof canonicalEventDataSchema>

export const canonicalAgentEventSchema = z.object({
  schemaVersion: z.literal(AGENT_RUNTIME_SCHEMA_VERSION),
  id: agentEntityIdSchema,
  workspaceId: agentEntityIdSchema,
  sessionId: agentEntityIdSchema,
  runtimeId: agentRuntimeIdSchema,
  sequence: agentSequenceSchema,
  occurredAt: agentTimestampSchema,
  data: canonicalEventDataSchema,
}).strict().superRefine((event, ctx) => {
  let owned: string | null = null
  switch (event.data.type) {
    case "session.created":
    case "session.updated":
      owned = event.data.session.id
      break
    case "message.updated":
      owned = event.data.message.sessionId
      break
    case "message.part.updated":
      owned = event.data.part.sessionId
      break
    case "interaction.requested":
    case "interaction.resolved":
      owned = event.data.interaction.sessionId
      break
  }
  if (owned !== null && owned !== event.sessionId) {
    ctx.addIssue({ code: "custom", path: ["data"], message: "event payload belongs to another session" })
  }
})
export type CanonicalAgentEvent = z.infer<typeof canonicalAgentEventSchema>

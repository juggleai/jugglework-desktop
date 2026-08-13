import { z } from "zod"

import {
  AGENT_RUNTIME_SCHEMA_VERSION,
  agentEntityIdSchema,
  agentJsonObjectSchema,
  agentRuntimeIdSchema,
  agentTimestampSchema,
} from "./common.js"
import { canonicalAgentMessageSchema, canonicalAgentTodoSchema } from "./content.js"
import { canonicalInteractionSchema } from "./interaction.js"

export const canonicalSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }).strict(),
  z.object({ type: z.literal("starting") }).strict(),
  z.object({ type: z.literal("running") }).strict(),
  z.object({ type: z.literal("waiting") }).strict(),
  z.object({ type: z.literal("retrying"), attempt: z.number().int().positive(), message: z.string().max(4_000), nextAt: agentTimestampSchema }).strict(),
  z.object({ type: z.literal("aborting") }).strict(),
  z.object({ type: z.literal("unavailable"), reasonCode: z.string().trim().min(1).max(128), message: z.string().max(4_000) }).strict(),
  z.object({ type: z.literal("interrupted"), ambiguous: z.boolean(), message: z.string().max(4_000) }).strict(),
])
export type CanonicalSessionStatus = z.infer<typeof canonicalSessionStatusSchema>

export const canonicalAgentSessionSchema = z.object({
  id: agentEntityIdSchema,
  workspaceId: agentEntityIdSchema,
  runtimeId: agentRuntimeIdSchema,
  backendSessionId: agentEntityIdSchema.nullable(),
  title: z.string().trim().min(1).max(512),
  canonicalCwd: z.string().trim().min(1).max(8_192),
  status: canonicalSessionStatusSchema,
  configuration: agentJsonObjectSchema,
  createdAt: agentTimestampSchema,
  updatedAt: agentTimestampSchema,
  lastError: z.object({ code: z.string().trim().min(1).max(128), message: z.string().max(20_000) }).strict().nullable(),
}).strict()
export type CanonicalAgentSession = z.infer<typeof canonicalAgentSessionSchema>

export const canonicalSessionLinkSchema = z.object({
  sourceSessionId: agentEntityIdSchema,
  targetSessionId: agentEntityIdSchema,
  type: z.enum(["fork", "migration"]),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: agentTimestampSchema,
}).strict().refine((link) => link.sourceSessionId !== link.targetSessionId, {
  message: "a session cannot link to itself",
})
export type CanonicalSessionLink = z.infer<typeof canonicalSessionLinkSchema>

export const agentContinuationTranscriptEntrySchema = z.object({
  sourceMessageId: agentEntityIdSchema.optional(),
  role: z.enum(["user", "assistant"]),
  text: z.string().trim().min(1).max(40_000),
}).strict()
export type AgentContinuationTranscriptEntry = z.infer<typeof agentContinuationTranscriptEntrySchema>

export const agentContinuationContextSchema = z.object({
  summary: z.string().trim().min(1).max(8_000),
  transcript: z.array(agentContinuationTranscriptEntrySchema).max(64),
}).strict()
export type AgentContinuationContext = z.infer<typeof agentContinuationContextSchema>

export const agentContinuationOmissionsSchema = z.object({
  secretBearingText: z.number().int().nonnegative(),
  oversizedText: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  tools: z.number().int().nonnegative(),
  hiddenOrReasoning: z.number().int().nonnegative(),
  pendingInteractions: z.number().int().nonnegative(),
}).strict()
export type AgentContinuationOmissions = z.infer<typeof agentContinuationOmissionsSchema>

export const agentContinuationPreviewSchema = z.object({
  sourceSessionId: agentEntityIdSchema,
  sourceTitle: z.string().trim().min(1).max(512),
  sourceRuntimeId: agentRuntimeIdSchema,
  targetRuntimeId: agentRuntimeIdSchema,
  context: agentContinuationContextSchema,
  omissions: agentContinuationOmissionsSchema,
  selectedCharacters: z.number().int().nonnegative().max(120_000),
  maxCharacters: z.literal(120_000),
}).strict()
export type AgentContinuationPreview = z.infer<typeof agentContinuationPreviewSchema>

export const agentContinuationResultSchema = z.object({
  session: canonicalAgentSessionSchema,
  link: canonicalSessionLinkSchema,
  context: agentContinuationContextSchema,
}).strict()
export type AgentContinuationResult = z.infer<typeof agentContinuationResultSchema>

export const canonicalSessionSnapshotSchema = z.object({
  schemaVersion: z.literal(AGENT_RUNTIME_SCHEMA_VERSION),
  session: canonicalAgentSessionSchema,
  messages: z.array(canonicalAgentMessageSchema).max(100_000),
  todos: z.array(canonicalAgentTodoSchema).max(10_000),
  interactions: z.array(canonicalInteractionSchema).max(10_000),
  latestSequence: z.number().int().nonnegative(),
}).strict().superRefine((snapshot, ctx) => {
  const messageIds = new Set<string>()
  snapshot.messages.forEach((message, index) => {
    if (message.sessionId !== snapshot.session.id) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "sessionId"], message: "message belongs to another session" })
    }
    if (messageIds.has(message.id)) {
      ctx.addIssue({ code: "custom", path: ["messages", index, "id"], message: "message identifiers must be unique" })
    }
    messageIds.add(message.id)
  })
  snapshot.interactions.forEach((interaction, index) => {
    if (interaction.sessionId !== snapshot.session.id) {
      ctx.addIssue({ code: "custom", path: ["interactions", index, "sessionId"], message: "interaction belongs to another session" })
    }
  })
})
export type CanonicalSessionSnapshot = z.infer<typeof canonicalSessionSnapshotSchema>

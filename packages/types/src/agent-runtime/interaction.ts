import { z } from "zod"

import { agentEntityIdSchema, agentJsonObjectSchema, agentTimestampSchema } from "./common.js"

export const canonicalInteractionResolutionSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("allow"), updatedInput: z.json().optional() }).strict(),
  z.object({ outcome: z.literal("deny"), reason: z.string().trim().min(1).max(4_000) }).strict(),
  z.object({ outcome: z.literal("answer"), values: z.array(z.string().max(20_000)).max(100) }).strict(),
  z.object({ outcome: z.literal("reject"), reason: z.string().max(4_000).optional() }).strict(),
  z.object({ outcome: z.literal("timeout") }).strict(),
  z.object({ outcome: z.literal("cancelled") }).strict(),
])
export type CanonicalInteractionResolution = z.infer<typeof canonicalInteractionResolutionSchema>

export const canonicalInteractionSchema = z.object({
  id: agentEntityIdSchema,
  sessionId: agentEntityIdSchema,
  runId: agentEntityIdSchema,
  kind: z.enum(["permission", "question", "input"]),
  state: z.enum(["pending", "resolved", "timed_out", "cancelled"]),
  title: z.string().trim().min(1).max(512),
  description: z.string().max(20_000).optional(),
  toolName: z.string().trim().min(1).max(256).optional(),
  input: z.json().optional(),
  questions: z.array(z.object({
    id: agentEntityIdSchema,
    prompt: z.string().trim().min(1).max(20_000),
    options: z.array(z.string().max(4_000)).max(100).optional(),
    multiple: z.boolean(),
  }).strict()).max(100).optional(),
  requestedAt: agentTimestampSchema,
  deadlineAt: agentTimestampSchema.nullable(),
  resolvedAt: agentTimestampSchema.nullable(),
  resolution: canonicalInteractionResolutionSchema.nullable(),
  metadata: agentJsonObjectSchema.optional(),
}).strict().superRefine((interaction, ctx) => {
  const terminal = interaction.state !== "pending"
  if (terminal !== (interaction.resolution !== null && interaction.resolvedAt !== null)) {
    ctx.addIssue({ code: "custom", path: ["resolution"], message: "terminal interactions require resolution and resolvedAt" })
  }
  if (interaction.kind === "question" && !interaction.questions?.length) {
    ctx.addIssue({ code: "custom", path: ["questions"], message: "question interactions require questions" })
  }
})
export type CanonicalInteraction = z.infer<typeof canonicalInteractionSchema>

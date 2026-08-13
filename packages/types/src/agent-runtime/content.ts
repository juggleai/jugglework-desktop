import { z } from "zod"

import {
  agentEntityIdSchema,
  agentJsonObjectSchema,
  agentTimestampSchema,
} from "./common.js"

const canonicalPartBaseShape = {
  id: agentEntityIdSchema,
  messageId: agentEntityIdSchema,
  sessionId: agentEntityIdSchema,
  ordinal: z.number().int().nonnegative(),
  createdAt: agentTimestampSchema,
  updatedAt: agentTimestampSchema,
  metadata: agentJsonObjectSchema.optional(),
}

export const canonicalTextPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("text"),
  text: z.string().max(2_000_000),
  state: z.enum(["streaming", "complete"]),
}).strict()

export const canonicalReasoningPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("reasoning"),
  text: z.string().max(2_000_000),
  visibility: z.enum(["visible", "summary", "hidden"]),
  state: z.enum(["streaming", "complete"]),
}).strict()

export const canonicalToolPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("tool"),
  toolCallId: agentEntityIdSchema,
  toolName: z.string().trim().min(1).max(256),
  state: z.enum(["pending", "running", "waiting", "completed", "error", "cancelled"]),
  input: z.json().optional(),
  output: z.json().optional(),
  error: z.string().max(20_000).optional(),
}).strict().superRefine((part, ctx) => {
  if (part.state === "error" && !part.error) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "error state requires an error message" })
  }
})

export const canonicalFilePartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("file"),
  name: z.string().trim().min(1).max(512),
  mime: z.string().trim().min(1).max(256).optional(),
  uri: z.string().trim().min(1).max(8_192).optional(),
  workspacePath: z.string().trim().min(1).max(8_192).optional(),
}).strict().refine((part) => part.uri !== undefined || part.workspacePath !== undefined, {
  message: "file part requires a uri or workspacePath",
})

export const canonicalSubagentPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("agent"),
  agentId: agentEntityIdSchema,
  parentToolCallId: agentEntityIdSchema.optional(),
  label: z.string().trim().min(1).max(256).optional(),
  state: z.enum(["pending", "running", "completed", "error", "cancelled"]),
}).strict()

export const canonicalStructuredPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("structured"),
  value: z.json(),
  schemaName: z.string().trim().min(1).max(256).optional(),
}).strict()

export const canonicalErrorPartSchema = z.object({
  ...canonicalPartBaseShape,
  type: z.literal("error"),
  code: z.string().trim().min(1).max(128),
  message: z.string().trim().min(1).max(20_000),
  retryable: z.boolean(),
}).strict()

export const canonicalAgentPartSchema = z.discriminatedUnion("type", [
  canonicalTextPartSchema,
  canonicalReasoningPartSchema,
  canonicalToolPartSchema,
  canonicalFilePartSchema,
  canonicalSubagentPartSchema,
  canonicalStructuredPartSchema,
  canonicalErrorPartSchema,
])
export type CanonicalAgentPart = z.infer<typeof canonicalAgentPartSchema>

export const canonicalAgentMessageSchema = z.object({
  id: agentEntityIdSchema,
  sessionId: agentEntityIdSchema,
  role: z.enum(["user", "assistant", "system"]),
  parentId: agentEntityIdSchema.nullable(),
  createdAt: agentTimestampSchema,
  completedAt: agentTimestampSchema.nullable(),
  parts: z.array(canonicalAgentPartSchema).max(10_000),
  metadata: agentJsonObjectSchema.optional(),
}).strict().superRefine((message, ctx) => {
  const partIds = new Set<string>()
  message.parts.forEach((part, index) => {
    if (part.sessionId !== message.sessionId || part.messageId !== message.id) {
      ctx.addIssue({ code: "custom", path: ["parts", index], message: "part ownership must match its message" })
    }
    if (partIds.has(part.id)) {
      ctx.addIssue({ code: "custom", path: ["parts", index, "id"], message: "part identifiers must be unique" })
    }
    partIds.add(part.id)
  })
})
export type CanonicalAgentMessage = z.infer<typeof canonicalAgentMessageSchema>

export const canonicalAgentTodoSchema = z.object({
  id: agentEntityIdSchema,
  content: z.string().trim().min(1).max(20_000),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  priority: z.enum(["high", "medium", "low"]),
}).strict()
export type CanonicalAgentTodo = z.infer<typeof canonicalAgentTodoSchema>

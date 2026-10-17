import { z } from "zod"
import { toonIdentifierSchema, toonModelReferenceSchema, toonRevisionSchema } from "./toon-factory.js"
import { toonExpectedRevisionsSchema, toonPortableReferenceSchema, toonWorkspaceCommandSchema, toonWorkspaceOperationOutcomeSchema } from "./toon-workspace.js"

const text = (max: number) => z.string().trim().min(1).max(max)
const timestamp = z.string().datetime()

export const toonSessionVisibilitySchema = z.enum([
  "normal",
  "toon_transient_generation",
  "toon_project_assistant",
  "toon_project_subagent",
])

export const toonAssistantAttachmentSchema = z.object({
  id: toonIdentifierSchema,
  kind: z.enum(["document", "asset"]),
  targetId: toonIdentifierSchema,
  revision: toonRevisionSchema,
  label: text(500),
  mimeType: text(200),
}).strict()

export const toonAssistantMentionSchema = z.object({
  kind: z.enum(["node", "asset", "document"]),
  id: toonIdentifierSchema,
  revision: toonRevisionSchema.optional(),
}).strict()

export const toonAssistantContextDiagnosticSchema = z.object({
  reference: toonAssistantMentionSchema,
  status: z.enum(["included", "truncated", "stale", "missing", "incompatible", "unauthorized"]),
  label: text(500).optional(),
  contentType: text(200).optional(),
  observedRevision: toonRevisionSchema.optional(),
  includedBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative(),
  message: text(2_000),
}).strict()

export const toonAssistantConversationSchema = z.object({
  id: toonIdentifierSchema,
  projectId: toonIdentifierSchema,
  title: text(120),
  model: toonModelReferenceSchema.refine((model) => model.kind === "text", "Project assistant conversations require a text model"),
  visibility: z.literal("toon_project_assistant"),
  archived: z.boolean(),
  state: z.enum(["active", "deleting"]).default("active"),
  cleanup: z.object({
    pending: z.literal(true),
    totalSessions: z.number().int().nonnegative(),
    completedSessions: z.number().int().nonnegative(),
    lastError: text(2_000).nullable(),
    updatedAt: timestamp,
  }).strict().nullable().default(null),
  createdAt: timestamp,
  updatedAt: timestamp,
}).strict()

export const toonAssistantPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(500_000) }).strict(),
  z.object({ type: z.literal("reasoning"), text: z.string().max(500_000) }).strict(),
  z.object({
    type: z.literal("tool"), id: toonIdentifierSchema, name: text(200),
    risk: z.enum(["read-only", "reversible-mutation", "destructive-mutation", "external-paid"]),
    state: z.enum(["proposed", "pending-permission", "running", "completed", "failed", "denied"]),
    input: z.unknown().optional(), result: z.unknown().optional(), error: text(2_000).optional(),
  }).strict(),
  z.object({ type: z.literal("subagent"), sessionId: text(256), parentSessionId: text(256), title: text(500), state: z.enum(["running", "completed", "failed", "detached", "stopped"]) }).strict(),
  z.object({ type: z.literal("canvas-call"), proposalId: toonIdentifierSchema, state: z.enum(["proposed", "approved", "denied", "committed", "failed"]), summary: text(2_000), affected: z.array(toonPortableReferenceSchema).max(1_000) }).strict(),
])

export const toonAssistantMessageSchema = z.object({
  id: text(256),
  conversationId: toonIdentifierSchema,
  turnId: toonIdentifierSchema,
  branchId: toonIdentifierSchema,
  parentMessageId: text(256).optional(),
  role: z.enum(["user", "assistant"]),
  status: z.enum(["streaming", "completed", "failed", "stopped"]),
  parts: z.array(toonAssistantPartSchema).max(10_000),
  attachments: z.array(toonAssistantAttachmentSchema).max(32),
  mentions: z.array(toonAssistantMentionSchema).max(64),
  contextDiagnostics: z.array(toonAssistantContextDiagnosticSchema).max(128),
  createdAt: timestamp,
  completedAt: timestamp.optional(),
}).strict()

export const toonAssistantInteractionSchema = z.object({
  id: text(256),
  conversationId: toonIdentifierSchema,
  turnId: toonIdentifierSchema,
  sessionId: text(256),
  kind: z.enum(["permission", "question", "content-approval", "skip", "compute-authorization", "adoption", "delivery"]),
  state: z.enum(["pending", "resolved", "denied", "expired"]),
  payload: z.unknown(),
  answer: z.unknown().optional(),
  createdAt: timestamp,
  resolvedAt: timestamp.optional(),
}).strict()

export const toonAssistantCanvasProposalSchema = z.object({
  id: toonIdentifierSchema,
  conversationId: toonIdentifierSchema,
  turnId: toonIdentifierSchema,
  toolCallId: toonIdentifierSchema,
  risk: z.enum(["reversible-mutation", "destructive-mutation"]),
  summary: text(2_000),
  affected: z.array(toonPortableReferenceSchema).min(1).max(1_000),
  command: toonWorkspaceCommandSchema,
  requiresConfirmation: z.boolean(),
}).strict()

export const toonAssistantCanvasProposalRecordSchema = z.object({
  proposal: toonAssistantCanvasProposalSchema,
  state: z.enum(["proposed", "committed", "denied", "failed"]),
  outcome: z.unknown().optional(),
  error: z.object({ code: text(200), message: text(2_000) }).strict().optional(),
}).strict()

export const toonAssistantGenerationProposalSchema = z.object({
  id: toonIdentifierSchema,
  conversationId: toonIdentifierSchema,
  turnId: toonIdentifierSchema,
  state: z.literal("awaiting-human-authorization"),
  requestId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  nodeId: toonIdentifierSchema,
  expectedRevisions: toonExpectedRevisionsSchema,
  plan: z.object({
    kind: z.enum(["image", "video"]),
    model: toonModelReferenceSchema,
    object: text(500),
    quantity: z.number().int().positive().max(100),
    prompt: text(100_000),
    references: z.array(toonPortableReferenceSchema).max(32),
    parameters: z.record(z.string(), z.unknown()),
    executionCount: z.number().int().positive().max(100),
    knownCost: z.object({ amount: z.number().nonnegative(), currency: text(20) }).strict().nullable(),
  }).strict(),
}).strict()

export const toonAssistantBridgeCallSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("project.read") }).strict(),
  z.object({ action: z.literal("canvas.read"), canvasId: toonIdentifierSchema }).strict(),
  z.object({ action: z.literal("canvas.propose"), proposal: toonAssistantCanvasProposalSchema }).strict(),
  z.object({ action: z.literal("generation.prepare"), proposal: toonAssistantGenerationProposalSchema }).strict(),
])

export const toonAssistantCreateRequestSchema = z.object({ title: text(120).optional(), model: toonModelReferenceSchema }).strict()
export const toonAssistantUpdateRequestSchema = z.object({ title: text(120).optional(), archived: z.boolean().optional() }).strict().refine((value) => value.title !== undefined || value.archived !== undefined)
export const toonAssistantSendRequestSchema = z.object({
  turnId: toonIdentifierSchema,
  messageId: text(256),
  text: z.string().trim().min(1).max(200_000),
  model: toonModelReferenceSchema,
  attachments: z.array(toonAssistantAttachmentSchema).max(32).default([]),
  mentions: z.array(toonAssistantMentionSchema).max(64).default([]),
}).strict()
export const toonAssistantStopRequestSchema = z.object({ turnId: toonIdentifierSchema }).strict()
export const toonAssistantEditResendRequestSchema = toonAssistantSendRequestSchema.extend({ sourceMessageId: text(256), detachActiveDescendants: z.boolean().default(false) }).strict()
export const toonAssistantInteractionReplySchema = z.object({ answer: z.unknown() }).strict()

export const toonAssistantEventTypeSchema = z.enum([
  "conversation.updated", "message.created", "message.part", "message.finalized", "turn.status",
  "tool.updated", "question.updated", "permission.updated", "subagent.updated", "canvas.proposal",
  "generation.proposal", "generation.progress", "context.resolved",
])
export const toonAssistantStreamEventSchema = z.object({
  version: z.literal(1),
  id: text(256),
  sequence: z.number().int().positive(),
  workspaceId: text(256),
  projectId: toonIdentifierSchema,
  conversationId: toonIdentifierSchema,
  turnId: toonIdentifierSchema.optional(),
  sessionId: text(256).optional(),
  type: toonAssistantEventTypeSchema,
  data: z.unknown(),
  createdAt: timestamp,
}).strict()

export const toonAssistantEventPageSchema = z.object({
  items: z.array(toonAssistantStreamEventSchema).max(1_000),
  cursor: z.string().max(256).nullable(),
  hasMore: z.boolean(),
}).strict()

export const toonAssistantConversationListSchema = z.object({ items: z.array(toonAssistantConversationSchema).max(100_000) }).strict()
export const toonAssistantConversationResponseSchema = z.object({ item: toonAssistantConversationSchema }).strict()

export const toonAssistantSnapshotSchema = z.object({
  conversation: toonAssistantConversationSchema,
  messages: z.array(toonAssistantMessageSchema).max(100_000),
  interactions: z.array(toonAssistantInteractionSchema).max(10_000),
  canvasProposals: z.array(toonAssistantCanvasProposalRecordSchema).max(10_000),
  subagents: z.array(z.object({ sessionId: text(256), parentSessionId: text(256), state: z.enum(["running", "completed", "failed", "detached", "stopped"]) }).strict()).max(10_000),
  branches: z.array(z.object({
    id: toonIdentifierSchema,
    fromMessageId: text(256).nullable(),
    turnIds: z.array(toonIdentifierSchema).max(100_000),
    remoteMayContinue: z.boolean(),
    active: z.boolean(),
    createdAt: timestamp,
  }).strict()).max(10_000),
  remoteContinueWarnings: z.array(z.object({
    turnId: toonIdentifierSchema,
    branchId: toonIdentifierSchema,
    status: z.enum(["detached", "interrupted"]),
    remoteMayContinue: z.literal(true),
    createdAt: timestamp,
  }).strict()).max(10_000),
  activeTurnId: toonIdentifierSchema.nullable(),
  activeBranchId: toonIdentifierSchema.nullable(),
  cursor: z.string().max(256).nullable(),
}).strict()
export const toonAssistantSnapshotResponseSchema = z.object({ item: toonAssistantSnapshotSchema }).strict()
export const toonAssistantCanvasProposalResponseSchema = z.object({ item: toonAssistantCanvasProposalSchema }).strict()
export const toonAssistantCanvasDecisionRequestSchema = z.object({
  proposalId: toonIdentifierSchema,
  decision: z.enum(["approve", "deny"]),
  leaseToken: text(256).optional(),
  leaseGeneration: z.number().int().positive().optional(),
}).strict()
export const toonAssistantCanvasExecutionResponseSchema = z.object({
  item: z.discriminatedUnion("decision", [
    z.object({ decision: z.literal("approve"), proposal: toonAssistantCanvasProposalSchema, outcome: toonWorkspaceOperationOutcomeSchema }).strict(),
    z.object({ decision: z.literal("deny"), proposal: toonAssistantCanvasProposalSchema }).strict(),
  ]),
}).strict()
export const toonAssistantSendResponseSchema = z.object({
  accepted: z.literal(true), turnId: toonIdentifierSchema, branchId: toonIdentifierSchema,
  cursor: z.string().max(256).nullable(), contextDiagnostics: z.array(toonAssistantContextDiagnosticSchema).max(128), pending: z.boolean().optional(),
}).strict()
export const toonAssistantWarningAcknowledgeRequestSchema = z.object({ turnId: toonIdentifierSchema }).strict()
export const toonAssistantCompletionResponseSchema = z.object({
  items: z.array(z.object({ kind: z.enum(["node", "asset", "document"]), id: toonIdentifierSchema, label: text(500), revision: toonRevisionSchema.optional(), mimeType: text(200).optional() }).strict()).max(50),
  limit: z.literal(50), truncated: z.boolean(),
}).strict()

export function decodeToonAssistantEvent(value: unknown): z.infer<typeof toonAssistantStreamEventSchema> {
  const candidate = value && typeof value === "object" && !Array.isArray(value) && "event" in value
    ? (value as { event: unknown }).event
    : value
  const record = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : {}
  return toonAssistantStreamEventSchema.parse({ version: record.version ?? 1, ...record })
}

export type ToonSessionVisibility = z.infer<typeof toonSessionVisibilitySchema>
export type ToonAssistantConversation = z.infer<typeof toonAssistantConversationSchema>
export type ToonAssistantAttachment = z.infer<typeof toonAssistantAttachmentSchema>
export type ToonAssistantMessage = z.infer<typeof toonAssistantMessageSchema>
export type ToonAssistantInteraction = z.infer<typeof toonAssistantInteractionSchema>
export type ToonAssistantStreamEvent = z.infer<typeof toonAssistantStreamEventSchema>
export type ToonAssistantEventPage = z.infer<typeof toonAssistantEventPageSchema>
export type ToonAssistantSnapshot = z.infer<typeof toonAssistantSnapshotSchema>
export type ToonAssistantCreateRequest = z.infer<typeof toonAssistantCreateRequestSchema>
export type ToonAssistantUpdateRequest = z.infer<typeof toonAssistantUpdateRequestSchema>
export type ToonAssistantSendRequest = z.infer<typeof toonAssistantSendRequestSchema>
export type ToonAssistantStopRequest = z.infer<typeof toonAssistantStopRequestSchema>
export type ToonAssistantEditResendRequest = z.infer<typeof toonAssistantEditResendRequestSchema>
export type ToonAssistantCanvasProposal = z.infer<typeof toonAssistantCanvasProposalSchema>
export type ToonAssistantCanvasProposalRecord = z.infer<typeof toonAssistantCanvasProposalRecordSchema>
export type ToonAssistantGenerationProposal = z.infer<typeof toonAssistantGenerationProposalSchema>

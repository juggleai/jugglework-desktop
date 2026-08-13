import { z } from "zod"

const idSchema = z.string().trim().min(1).max(256)
const pathSchema = z.string().trim().min(1).max(4096)
const boundedTextSchema = z.string().max(1_048_576)
const metadataSchema = z.record(z.string().max(128), z.unknown())

export const runtimeKindSchema = z.enum(["opencode", "codex"])
export type RuntimeKind = z.infer<typeof runtimeKindSchema>

export const runtimeCapabilitiesSchema = z.object({
  images: z.boolean(),
  mcp: z.boolean(),
  skills: z.boolean(),
  approvals: z.boolean(),
  steering: z.boolean(),
  reasoningStream: z.boolean(),
  planMode: z.boolean(),
  reviewMode: z.boolean(),
  sessionFork: z.boolean(),
}).strict()
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>

export const runtimeErrorCodeSchema = z.enum([
  "runtime_start_failed",
  "protocol_error",
  "gateway_auth_required",
  "gateway_auth_expired",
  "gateway_unavailable",
  "model_unavailable",
  "model_input_unsupported",
  "workspace_access_denied",
  "turn_interrupted",
  "runtime_crashed",
  "invalid_request",
  "rate_limited",
  "internal",
])
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCodeSchema>

export const runtimeErrorSchema = z.object({
  code: runtimeErrorCodeSchema,
  message: z.string().trim().min(1).max(2_000),
  retryable: z.boolean(),
  status: z.number().int().min(100).max(599).nullable().default(null),
  metadata: metadataSchema.default({}),
}).strict()
export type RuntimeError = z.infer<typeof runtimeErrorSchema>

export const runtimeAttachmentPointerSchema = z.object({
  attachmentId: idSchema,
  kind: z.enum(["image", "file"]),
  name: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  objectRef: z.string().trim().min(1).max(4096),
}).strict()
export type RuntimeAttachmentPointer = z.infer<typeof runtimeAttachmentPointerSchema>

export const runtimeContentPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: boundedTextSchema }).strict(),
  z.object({ type: z.literal("attachment"), attachment: runtimeAttachmentPointerSchema }).strict(),
])
export type RuntimeContentPart = z.infer<typeof runtimeContentPartSchema>

export const runtimeWorkspaceSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  runtimeKind: runtimeKindSchema,
  cwd: pathSchema,
  capabilities: runtimeCapabilitiesSchema,
}).strict()
export type RuntimeWorkspace = z.infer<typeof runtimeWorkspaceSchema>

export const runtimeThreadSchema = z.object({
  id: idSchema,
  orgId: idSchema,
  sessionId: idSchema,
  workspaceId: idSchema,
  backendThreadId: idSchema,
  runtimeKind: runtimeKindSchema,
  modelProviderId: idSchema,
  modelId: idSchema,
  createdAt: z.number().int().nonnegative(),
}).strict()
export type RuntimeThread = z.infer<typeof runtimeThreadSchema>

export const runtimeThreadPatchSchema = z.object({
  title: z.string().max(512).optional(),
  archivedAt: z.number().int().nonnegative().nullable().optional(),
  modelProviderId: idSchema.optional(),
  modelId: idSchema.optional(),
}).strict()
export type RuntimeThreadPatch = z.infer<typeof runtimeThreadPatchSchema>

const eventBase = {
  schemaVersion: z.literal(1),
  eventId: idSchema,
  occurredAt: z.number().int().nonnegative(),
  workspaceId: idSchema,
  orgId: idSchema,
  runtimeKind: runtimeKindSchema,
}

const threadEventBase = {
  ...eventBase,
  sessionId: idSchema,
  threadId: idSchema,
}

const turnEventBase = {
  ...threadEventBase,
  turnId: idSchema,
}

export const runtimeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
}).strict()
export type RuntimeUsage = z.infer<typeof runtimeUsageSchema>

export const runtimeApprovalRequestSchema = z.object({
  id: idSchema,
  kind: z.enum(["command", "file", "network", "tool"]),
  title: z.string().trim().min(1).max(512),
  description: z.string().max(4_096),
  choices: z.array(z.enum(["allow_once", "allow_session", "deny"])).min(1).max(3),
  metadata: metadataSchema.default({}),
}).strict()
export type RuntimeApprovalRequest = z.infer<typeof runtimeApprovalRequestSchema>

const runtimeKnownEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("thread.created"), thread: runtimeThreadSchema }).strict(),
  z.object({ ...threadEventBase, type: z.literal("thread.updated"), patch: runtimeThreadPatchSchema }).strict(),
  z.object({ ...turnEventBase, type: z.literal("turn.started") }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("user.message"),
    content: z.array(runtimeContentPartSchema).min(1).max(64),
  }).strict(),
  z.object({ ...turnEventBase, type: z.literal("assistant.delta"), text: boundedTextSchema }).strict(),
  z.object({ ...turnEventBase, type: z.literal("reasoning.delta"), text: boundedTextSchema }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("tool.started"),
    toolCallId: idSchema,
    name: z.string().trim().min(1).max(256),
    arguments: z.unknown(),
  }).strict(),
  z.object({ ...turnEventBase, type: z.literal("tool.output"), toolCallId: idSchema, chunk: boundedTextSchema }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("tool.completed"),
    toolCallId: idSchema,
    success: z.boolean(),
    output: z.unknown().optional(),
  }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("command.started"),
    commandId: idSchema,
    command: z.string().trim().min(1).max(8_192),
    cwd: pathSchema,
  }).strict(),
  z.object({ ...turnEventBase, type: z.literal("command.output"), commandId: idSchema, chunk: boundedTextSchema }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("command.completed"),
    commandId: idSchema,
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("file.changed"),
    path: pathSchema,
    change: z.enum(["created", "modified", "deleted", "renamed"]),
    previousPath: pathSchema.optional(),
  }).strict(),
  z.object({
    ...turnEventBase,
    type: z.literal("approval.requested"),
    request: runtimeApprovalRequestSchema,
  }).strict(),
  z.object({ ...turnEventBase, type: z.literal("usage.updated"), usage: runtimeUsageSchema }).strict(),
  z.object({ ...turnEventBase, type: z.literal("turn.completed"), usage: runtimeUsageSchema.optional() }).strict(),
  z.object({ ...turnEventBase, type: z.literal("turn.interrupted") }).strict(),
  z.object({ ...turnEventBase, type: z.literal("turn.failed"), error: runtimeErrorSchema }).strict(),
])

export const runtimeUnknownEventSchema = z.object({
  ...eventBase,
  type: z.literal("unknown"),
  originalType: z.string().trim().min(1).max(256),
  diagnostic: z.object({ reason: z.enum(["unsupported_type", "invalid_payload"]) }).strict(),
}).strict()
export type RuntimeUnknownEvent = z.infer<typeof runtimeUnknownEventSchema>

export const runtimeEventSchema = z.union([runtimeKnownEventSchema, runtimeUnknownEventSchema])
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>

const runtimeEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: idSchema,
  occurredAt: z.number().int().nonnegative(),
  workspaceId: idSchema,
  orgId: idSchema,
  runtimeKind: runtimeKindSchema,
  type: z.string().trim().min(1).max(256),
}).passthrough()

export function parseRuntimeEvent(value: unknown): RuntimeEvent {
  const known = runtimeKnownEventSchema.safeParse(value)
  if (known.success) return known.data
  const unknown = runtimeUnknownEventSchema.safeParse(value)
  if (unknown.success) return unknown.data
  const envelope = runtimeEventEnvelopeSchema.parse(value)
  const knownType = runtimeKnownEventSchema.options.some(
    (schema) => schema.shape.type.value === envelope.type,
  )
  return {
    schemaVersion: 1,
    eventId: envelope.eventId,
    occurredAt: envelope.occurredAt,
    workspaceId: envelope.workspaceId,
    orgId: envelope.orgId,
    runtimeKind: envelope.runtimeKind,
    type: "unknown",
    originalType: envelope.type,
    diagnostic: { reason: knownType ? "invalid_payload" : "unsupported_type" },
  }
}

export type StartWorkspaceInput = {
  orgId: string
  workspaceId: string
  cwd: string
}

export type CreateThreadInput = {
  orgId: string
  sessionId: string
  workspaceId: string
  cwd: string
  modelProviderId: string
  modelId: string
  reasoningEffort?: string | null
}

export type ResumeThreadInput = {
  orgId: string
  sessionId: string
  workspaceId: string
  backendThreadId: string
  modelProviderId: string
  modelId: string
  reasoningEffort?: string | null
}

export type SendTurnInput = {
  orgId: string
  workspaceId: string
  sessionId: string
  threadId: string
  content: RuntimeContentPart[]
}

export type SteerTurnInput = SendTurnInput & { turnId: string }
export type InterruptTurnInput = {
  orgId: string
  workspaceId: string
  sessionId: string
  threadId: string
  turnId: string
}
export type ApprovalDecisionInput = {
  orgId: string
  workspaceId: string
  sessionId: string
  threadId: string
  requestId: string
  decision: "allow_once" | "allow_session" | "deny"
}

export type StopWorkspaceInput = { orgId: string; workspaceId: string }
export type ArchiveThreadInput = { orgId: string; workspaceId: string; sessionId: string; threadId: string }

export interface AgentRuntimeContract {
  readonly kind: RuntimeKind
  startWorkspace(input: StartWorkspaceInput): Promise<RuntimeWorkspace>
  stopWorkspace(input: StopWorkspaceInput): Promise<void>
  createThread(input: CreateThreadInput): Promise<RuntimeThread>
  resumeThread(input: ResumeThreadInput): Promise<RuntimeThread>
  archiveThread(input: ArchiveThreadInput): Promise<void>
  sendTurn(input: SendTurnInput): Promise<void>
  steerTurn(input: SteerTurnInput): Promise<void>
  interruptTurn(input: InterruptTurnInput): Promise<void>
  respondToApproval(input: ApprovalDecisionInput): Promise<void>
  subscribe(listener: (event: RuntimeEvent) => void): () => void
}

import { z } from "zod"

import type { RuntimeKind } from "./agent-runtime.js"

const idSchema = z.string().trim().min(1).max(256)
const pathSchema = z.string().trim().min(1).max(4096)
const sessionRuntimeKindSchema: z.ZodType<RuntimeKind> = z.enum(["opencode", "codex"])

export const runtimeAttachmentRefSchema = z.object({
  id: idSchema,
  kind: z.enum(["image", "file"]),
  source: z.enum(["local_file", "upload", "artifact"]),
  name: z.string().trim().min(1).max(512),
  mimeType: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  objectRef: z.string().trim().min(1).max(4096),
  previewRef: z.string().trim().min(1).max(4096).nullable().default(null),
}).strict()
export type RuntimeAttachmentRef = z.infer<typeof runtimeAttachmentRefSchema>

export const runtimeSessionRecordSchema = z.object({
  schemaVersion: z.literal(1),
  id: idSchema,
  orgId: idSchema,
  workspaceId: idSchema,
  runtimeKind: sessionRuntimeKindSchema,
  backendThreadId: idSchema.nullable(),
  agentProfileId: idSchema.nullable(),
  modelProviderId: idSchema,
  modelId: idSchema,
  reasoningEffort: z.string().trim().min(1).max(64).nullable(),
  cwd: pathSchema,
  title: z.string().max(512),
  runtimeLocked: z.boolean(),
  configSnapshot: z.record(z.string().max(128), z.unknown()),
  attachments: z.array(runtimeAttachmentRefSchema).max(64),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  archivedAt: z.number().int().nonnegative().nullable(),
}).strict().superRefine((record, context) => {
  if (record.updatedAt < record.createdAt) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "updatedAt must not precede createdAt" })
  }
  if (record.archivedAt !== null && record.archivedAt < record.createdAt) {
    context.addIssue({ code: "custom", path: ["archivedAt"], message: "archivedAt must not precede createdAt" })
  }
  if (record.runtimeLocked && record.backendThreadId === null) {
    context.addIssue({ code: "custom", path: ["backendThreadId"], message: "a locked runtime requires a backend thread" })
  }
})
export type RuntimeSessionRecord = z.infer<typeof runtimeSessionRecordSchema>

const legacyOpenCodeSessionSchema = z.object({
  id: idSchema,
  directory: pathSchema,
  title: z.string().max(512).optional(),
  time: z.object({
    created: z.number().int().nonnegative(),
    updated: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative().optional(),
  }).strict(),
}).passthrough()

export type LegacyOpenCodeSessionMigrationContext = {
  orgId: string
  workspaceId: string
  modelProviderId: string
  modelId: string
  agentProfileId?: string | null
  reasoningEffort?: string | null
  configSnapshot?: Record<string, unknown>
}

function stableSessionHash(value: string): string {
  let hash = 0xcbf29ce484222325n
  for (const character of new TextEncoder().encode(value)) {
    hash ^= BigInt(character)
    hash = BigInt.asUintN(64, hash * 0x100000001b3n)
  }
  return hash.toString(16).padStart(16, "0")
}

export function stableLegacyOpenCodeSessionId(input: {
  orgId: string
  workspaceId: string
  backendThreadId: string
}): string {
  const orgId = idSchema.parse(input.orgId)
  const workspaceId = idSchema.parse(input.workspaceId)
  const backendThreadId = idSchema.parse(input.backendThreadId)
  return `jws_${stableSessionHash(`${orgId}\u0000${workspaceId}\u0000opencode\u0000${backendThreadId}`)}`
}

export function migrateLegacyOpenCodeSession(
  value: unknown,
  context: LegacyOpenCodeSessionMigrationContext,
): RuntimeSessionRecord {
  const legacy = legacyOpenCodeSessionSchema.parse(value)
  return runtimeSessionRecordSchema.parse({
    schemaVersion: 1,
    id: stableLegacyOpenCodeSessionId({
      orgId: context.orgId,
      workspaceId: context.workspaceId,
      backendThreadId: legacy.id,
    }),
    orgId: context.orgId,
    workspaceId: context.workspaceId,
    runtimeKind: "opencode",
    backendThreadId: legacy.id,
    agentProfileId: context.agentProfileId ?? null,
    modelProviderId: context.modelProviderId,
    modelId: context.modelId,
    reasoningEffort: context.reasoningEffort ?? null,
    cwd: legacy.directory,
    title: legacy.title ?? "",
    runtimeLocked: true,
    configSnapshot: context.configSnapshot ?? {},
    attachments: [],
    createdAt: legacy.time.created,
    updatedAt: legacy.time.updated,
    archivedAt: legacy.time.archived ?? null,
  })
}

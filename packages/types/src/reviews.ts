import { z } from "zod"
import { juggleworkCloudMcpConnectionActionSchema } from "./den/mcp-connection-action.js"

export const REVIEW_SCHEMA_VERSION = 1 as const

const boundedText = (max: number) => z.string().max(max)
const optionalUrl = z.string().url().max(2_048).optional()

export const reviewRelationshipSchema = z.enum([
  "all",
  "review_requested",
  "team_review_requested",
  "authored",
  "reviewed",
])

export const reviewConnectionStateSchema = z.enum([
  "ready",
  "not_connected",
  "member_authorization_required",
  "organization_admin_action_required",
  "provider_admin_action_required",
  "disabled_in_workspace",
  "unavailable",
])

export const reviewConnectionStatusSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  provider: z.literal("github"),
  state: reviewConnectionStateSchema,
  connectionId: boundedText(256).optional(),
  connectionName: boundedText(256).optional(),
  accountLogin: boundedText(256).optional(),
  accountAvatarUrl: optionalUrl,
  hint: boundedText(1_000).optional(),
  action: juggleworkCloudMcpConnectionActionSchema.optional(),
})

export const reviewAuthorSchema = z.object({
  login: boundedText(256),
  displayName: boundedText(256).optional(),
  avatarUrl: optionalUrl,
})

export const reviewLabelSchema = z.object({
  name: boundedText(128),
  color: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
})

export const reviewCheckStateSchema = z.enum(["queued", "running", "success", "failure", "cancelled", "unknown"])
export const reviewDecisionSchema = z.enum(["approved", "changes_requested", "review_required", "none"])

export const reviewRepositorySchema = z.object({
  id: boundedText(256),
  owner: boundedText(256),
  name: boundedText(256),
  fullName: boundedText(512),
})

export const reviewListItemSchema = z.object({
  id: boundedText(2_048),
  provider: z.literal("github"),
  hostname: boundedText(512),
  repository: reviewRepositorySchema,
  number: z.number().int().positive(),
  title: boundedText(1_000),
  url: z.string().url().max(2_048),
  author: reviewAuthorSchema,
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  relationships: z.array(reviewRelationshipSchema.exclude(["all"])).max(5),
  reviewDecision: reviewDecisionSchema,
  headRevision: boundedText(128),
  updatedAt: z.string().datetime(),
  changedFiles: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  commentCount: z.number().int().nonnegative().optional(),
  labels: z.array(reviewLabelSchema).max(100),
  checks: z.object({
    state: reviewCheckStateSchema,
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  }).optional(),
})

export const reviewCacheMetadataSchema = z.object({
  source: z.enum(["provider", "memory"]),
  fetchedAt: z.string().datetime(),
  stale: z.boolean(),
})

export const reviewPageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: boundedText(4_096).nullable(),
})

export function reviewPageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
    items: z.array(itemSchema).max(100),
    nextCursor: boundedText(4_096).nullable(),
    snapshotAt: z.string().datetime(),
    source: z.object({
      provider: z.literal("github"),
      connectionId: boundedText(256),
      connectionName: boundedText(256),
    }),
    cache: reviewCacheMetadataSchema,
  })
}

export const reviewListResponseSchema = reviewPageSchema(reviewListItemSchema)

export const reviewDetailSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  item: reviewListItemSchema.extend({
    body: boundedText(100_000),
    baseBranch: boundedText(512),
    headBranch: boundedText(512),
    mergeable: z.enum(["mergeable", "conflicting", "unknown"]),
    viewerPermission: z.enum(["read", "triage", "write", "maintain", "admin", "unknown"]),
  }),
  cache: reviewCacheMetadataSchema,
})

export const reviewPatchLineSchema = z.object({
  kind: z.enum(["context", "addition", "deletion", "meta"]),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  text: boundedText(20_000),
})

export const reviewFileSchema = z.object({
  id: boundedText(2_048),
  path: boundedText(4_096),
  previousPath: boundedText(4_096).optional(),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unknown"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.array(reviewPatchLineSchema).max(5_000).optional(),
  patchTruncated: z.boolean(),
  binary: z.boolean(),
})

export const reviewFilesResponseSchema = reviewPageSchema(reviewFileSchema).extend({
  headRevision: boundedText(128),
  truncated: z.boolean(),
})

export const reviewCheckSchema = z.object({
  id: boundedText(512),
  name: boundedText(512),
  detail: boundedText(4_000).optional(),
  state: reviewCheckStateSchema,
  url: optionalUrl,
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
})

export const reviewChecksResponseSchema = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  headRevision: boundedText(128),
  items: z.array(reviewCheckSchema).max(500),
  cache: reviewCacheMetadataSchema,
})

export const reviewThreadCommentSchema = z.object({
  id: boundedText(512),
  author: reviewAuthorSchema,
  body: boundedText(50_000),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime().optional(),
  url: optionalUrl,
})

export const reviewThreadSchema = z.object({
  id: boundedText(512),
  path: boundedText(4_096).optional(),
  line: z.number().int().positive().optional(),
  startLine: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).optional(),
  outdated: z.boolean(),
  resolved: z.boolean(),
  comments: z.array(reviewThreadCommentSchema).max(100),
})

export const reviewThreadsResponseSchema = reviewPageSchema(reviewThreadSchema).extend({
  headRevision: boundedText(128),
  truncated: z.boolean(),
})

export const reviewErrorCodeSchema = z.enum([
  "github_connection_missing",
  "github_connection_disabled_in_workspace",
  "github_member_authorization_required",
  "github_organization_admin_action_required",
  "github_provider_admin_action_required",
  "github_scope_missing",
  "github_repository_forbidden",
  "github_review_not_found",
  "github_rate_limited",
  "github_provider_unavailable",
  "github_provider_timeout",
  "github_invalid_response",
  "github_response_too_large",
  "review_contract_unsupported",
  "review_workspace_not_owned",
])

export const reviewErrorDetailsSchema = z.object({
  retryable: z.boolean(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  rateLimitResetAt: z.string().datetime().optional(),
  connectionId: boundedText(256).optional(),
  requestId: boundedText(512).optional(),
  referenceId: boundedText(512).optional(),
  action: juggleworkCloudMcpConnectionActionSchema.optional(),
}).strict()

export type ReviewRelationship = z.infer<typeof reviewRelationshipSchema>
export type ReviewConnectionStatus = z.infer<typeof reviewConnectionStatusSchema>
export type ReviewListItem = z.infer<typeof reviewListItemSchema>
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>
export type ReviewDetail = z.infer<typeof reviewDetailSchema>
export type ReviewFile = z.infer<typeof reviewFileSchema>
export type ReviewFilesResponse = z.infer<typeof reviewFilesResponseSchema>
export type ReviewCheck = z.infer<typeof reviewCheckSchema>
export type ReviewChecksResponse = z.infer<typeof reviewChecksResponseSchema>
export type ReviewThread = z.infer<typeof reviewThreadSchema>
export type ReviewThreadsResponse = z.infer<typeof reviewThreadsResponseSchema>
export type ReviewErrorCode = z.infer<typeof reviewErrorCodeSchema>
export type ReviewErrorDetails = z.infer<typeof reviewErrorDetailsSchema>

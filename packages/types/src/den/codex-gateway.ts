import { z } from "zod"

export const CODEX_GATEWAY_TOKEN_PATH = "/v1/codex/gateway-token" as const
export const CODEX_MODEL_CATALOG_PATH = "/v1/codex/models" as const
export const CODEX_RESPONSES_PATH = "/v1/responses" as const
export const CODEX_GATEWAY_AUDIENCE = "jugglework-codex-gateway" as const
export const CODEX_GATEWAY_SCOPE = "responses:create models:read" as const

const opaqueIdSchema = z.string().trim().min(1).max(256)

export const codexGatewayTokenRequestSchema = z.object({
  organizationId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  providerId: opaqueIdSchema,
}).strict()
export type CodexGatewayTokenRequest = z.infer<typeof codexGatewayTokenRequestSchema>

export const codexGatewayTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresAt: z.string().datetime({ offset: true }),
  organizationId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  audience: z.literal(CODEX_GATEWAY_AUDIENCE),
  scopes: z.array(z.enum(["responses:create", "models:read"])).min(1),
  gatewayBaseUrl: z.string().url().refine((url) => url.startsWith("https://") || url.startsWith("http://127.0.0.1"), {
    message: "gatewayBaseUrl must use HTTPS (or loopback HTTP in development)",
  }),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.expiresAt) <= Date.now()) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "gateway token is already expired" })
  }
})
export type CodexGatewayTokenResponse = z.infer<typeof codexGatewayTokenResponseSchema>

export const codexReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"])
export type CodexReasoningEffort = z.infer<typeof codexReasoningEffortSchema>

export const codexGatewayModelSchema = z.object({
  id: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(256),
  enabled: z.boolean(),
  capabilities: z.object({
    images: z.boolean(),
    tools: z.boolean(),
    reasoning: z.boolean(),
    reasoningEfforts: z.array(codexReasoningEffortSchema),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (!value.capabilities.reasoning && value.capabilities.reasoningEfforts.length > 0) {
    context.addIssue({
      code: "custom",
      path: ["capabilities", "reasoningEfforts"],
      message: "non-reasoning models cannot advertise reasoning efforts",
    })
  }
})
export type CodexGatewayModel = z.infer<typeof codexGatewayModelSchema>

export const codexModelCatalogResponseSchema = z.object({
  organizationId: opaqueIdSchema,
  models: z.array(codexGatewayModelSchema),
  fetchedAt: z.string().datetime({ offset: true }),
}).strict()
export type CodexModelCatalogResponse = z.infer<typeof codexModelCatalogResponseSchema>

export const CODEX_GATEWAY_ERROR_CODES = [
  "AUTH_REQUIRED",
  "INVALID_REQUEST",
  "TOKEN_EXPIRED",
  "ORGANIZATION_MISMATCH",
  "DEVICE_MISMATCH",
  "AUDIENCE_MISMATCH",
  "SCOPE_MISSING",
  "MODEL_NOT_ALLOWED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "INVALID_RESPONSE",
] as const

export const codexGatewayErrorSchema = z.object({
  error: z.object({
    code: z.enum(CODEX_GATEWAY_ERROR_CODES),
    message: z.string().trim().min(1).max(512),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().nonnegative().nullable().default(null),
    requestId: opaqueIdSchema.nullable().default(null),
  }).strict(),
}).strict()
export type CodexGatewayError = z.infer<typeof codexGatewayErrorSchema>

/** Safe diagnostic projection. Never pass an access token or model payload here. */
export const codexGatewayAuditEventSchema = z.object({
  organizationId: opaqueIdSchema,
  deviceId: opaqueIdSchema,
  operation: z.enum(["token.exchange", "models.list", "responses.create"]),
  outcome: z.enum(["allowed", "denied", "rate_limited", "upstream_error"]),
  errorCode: z.enum(CODEX_GATEWAY_ERROR_CODES).nullable(),
  requestId: opaqueIdSchema.nullable(),
  occurredAt: z.string().datetime({ offset: true }),
}).strict()
export type CodexGatewayAuditEvent = z.infer<typeof codexGatewayAuditEventSchema>

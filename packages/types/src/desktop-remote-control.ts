import { z } from "zod"

export const DESKTOP_REMOTE_SCHEMA_VERSION = 1 as const
export const DESKTOP_REMOTE_PROTOCOL_VERSION = 1 as const
export const DESKTOP_REMOTE_PAYLOAD_VERSION = 1 as const

export const DESKTOP_REMOTE_SUPPORTED_PROTOCOL_VERSIONS = [
  DESKTOP_REMOTE_PROTOCOL_VERSION,
] as const
export const DESKTOP_REMOTE_SUPPORTED_PAYLOAD_VERSIONS = [
  DESKTOP_REMOTE_PAYLOAD_VERSION,
] as const

const dateTimeSchema = z.iso.datetime({ offset: true })
const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "identifier cannot contain control characters")
const displayTextSchema = z.string().trim().min(1).max(500)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const semverSchema = z
  .string()
  .trim()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)

export const desktopRemoteOperationValues = [
  "workspace.list",
  "session.list",
  "session.snapshot",
  "session.prompt",
  "session.abort",
  "interaction.permission.reply",
  "interaction.question.reply",
] as const

export const desktopRemoteOperationSchema = z.enum(desktopRemoteOperationValues)
export type DesktopRemoteOperation = z.infer<typeof desktopRemoteOperationSchema>

export const desktopRemoteReadOperationValues = [
  "workspace.list",
  "session.list",
  "session.snapshot",
] as const satisfies readonly DesktopRemoteOperation[]

export const desktopRemoteMutationOperationValues = [
  "session.prompt",
  "session.abort",
  "interaction.permission.reply",
  "interaction.question.reply",
] as const satisfies readonly DesktopRemoteOperation[]

export const desktopRemoteFeatureCapabilityValues = [
  "controller.event-resume",
  "payload.e2ee-v1",
  "background.lifecycle",
  "session.steer",
  "session.enqueue",
  "native-mobile",
] as const

export const desktopRemoteFeatureCapabilitySchema = z.enum(
  desktopRemoteFeatureCapabilityValues,
)
export type DesktopRemoteFeatureCapability = z.infer<
  typeof desktopRemoteFeatureCapabilitySchema
>

export const desktopRemoteOperationCapabilitySchema = z
  .object({
    operation: desktopRemoteOperationSchema,
    payloadVersions: z
      .array(z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION))
      .min(1)
      .max(DESKTOP_REMOTE_SUPPORTED_PAYLOAD_VERSIONS.length)
      .refine((versions) => new Set(versions).size === versions.length, "payload versions must be unique"),
  })
  .strict()
export type DesktopRemoteOperationCapability = z.infer<
  typeof desktopRemoteOperationCapabilitySchema
>

export const desktopRemoteCapabilityAdvertisementSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    operations: z
      .array(desktopRemoteOperationCapabilitySchema)
      .max(desktopRemoteOperationValues.length)
      .refine(
        (capabilities) =>
          new Set(capabilities.map((capability) => capability.operation)).size ===
          capabilities.length,
        "operations must be advertised at most once",
      ),
    features: z
      .array(desktopRemoteFeatureCapabilitySchema)
      .max(desktopRemoteFeatureCapabilityValues.length)
      .refine((features) => new Set(features).size === features.length, "features must be unique"),
  })
  .strict()
export type DesktopRemoteCapabilityAdvertisement = z.infer<
  typeof desktopRemoteCapabilityAdvertisementSchema
>

export const desktopRemoteFeatureGatesSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    enrollment: z.boolean(),
    readOnlyControl: z.boolean(),
    sessionMutation: z.boolean(),
    interactions: z.boolean(),
    backgroundLifecycle: z.boolean(),
    eventCompaction: z.boolean(),
    multiInstanceRouting: z.boolean(),
    payloadEncryption: z.boolean(),
    busySessionSteer: z.boolean(),
    busySessionEnqueue: z.boolean(),
    nativeMobile: z.boolean(),
  })
  .strict()
export type DesktopRemoteFeatureGates = z.infer<
  typeof desktopRemoteFeatureGatesSchema
>

export const desktopRemoteDisabledFeatureGates: DesktopRemoteFeatureGates = {
  schemaVersion: DESKTOP_REMOTE_SCHEMA_VERSION,
  enrollment: false,
  readOnlyControl: false,
  sessionMutation: false,
  interactions: false,
  backgroundLifecycle: false,
  eventCompaction: false,
  multiInstanceRouting: false,
  payloadEncryption: false,
  busySessionSteer: false,
  busySessionEnqueue: false,
  nativeMobile: false,
}

/**
 * Parse an untrusted Cloud or local feature-gate document without ever
 * inheriting an enabled value. Remote control is a sensitive boundary, so a
 * missing, partial, malformed, future-version, or expanded document disables
 * every phase rather than falling back to ordinary Desktop policy defaults.
 */
export function parseDesktopRemoteFeatureGatesOrDisabled(
  input: unknown,
): DesktopRemoteFeatureGates {
  const parsed = desktopRemoteFeatureGatesSchema.safeParse(input)
  return parsed.success
    ? parsed.data
    : { ...desktopRemoteDisabledFeatureGates }
}

export const desktopRemoteRequiredFeatureGatesByOperation = {
  "workspace.list": ["enrollment", "readOnlyControl"],
  "session.list": ["enrollment", "readOnlyControl"],
  "session.snapshot": ["enrollment", "readOnlyControl"],
  "session.prompt": ["enrollment", "readOnlyControl", "sessionMutation"],
  "session.abort": ["enrollment", "readOnlyControl", "sessionMutation"],
  "interaction.permission.reply": [
    "enrollment",
    "readOnlyControl",
    "sessionMutation",
    "interactions",
  ],
  "interaction.question.reply": [
    "enrollment",
    "readOnlyControl",
    "sessionMutation",
    "interactions",
  ],
} as const satisfies Record<
  DesktopRemoteOperation,
  readonly (keyof Omit<DesktopRemoteFeatureGates, "schemaVersion">)[]
>

export function isDesktopRemoteOperationEnabled(
  operation: DesktopRemoteOperation,
  input: unknown,
): boolean {
  const gates = parseDesktopRemoteFeatureGatesOrDisabled(input)
  return desktopRemoteRequiredFeatureGatesByOperation[operation].every(
    (gate) => gates[gate] === true,
  )
}

/**
 * Build the only capability advertisement a Desktop may publish from feature
 * gates. Callers cannot smuggle arbitrary operation names or let a later-phase
 * gate bypass enrollment and the preceding operation phase.
 */
export function createDesktopRemoteCapabilityAdvertisement(
  input: unknown,
): DesktopRemoteCapabilityAdvertisement {
  const gates = parseDesktopRemoteFeatureGatesOrDisabled(input)
  const operations = desktopRemoteOperationValues
    .filter((operation) => isDesktopRemoteOperationEnabled(operation, gates))
    .map((operation) => ({
      operation,
      payloadVersions: [...DESKTOP_REMOTE_SUPPORTED_PAYLOAD_VERSIONS],
    }))

  const features: DesktopRemoteFeatureCapability[] = []
  const readEnabled = gates.enrollment && gates.readOnlyControl
  const mutationEnabled = readEnabled && gates.sessionMutation
  if (readEnabled) features.push("controller.event-resume")
  if (readEnabled && gates.payloadEncryption) features.push("payload.e2ee-v1")
  if (readEnabled && gates.backgroundLifecycle) features.push("background.lifecycle")
  if (mutationEnabled && gates.busySessionSteer) features.push("session.steer")
  if (mutationEnabled && gates.busySessionEnqueue) features.push("session.enqueue")
  if (readEnabled && gates.nativeMobile) features.push("native-mobile")

  return desktopRemoteCapabilityAdvertisementSchema.parse({
    schemaVersion: DESKTOP_REMOTE_SCHEMA_VERSION,
    operations,
    features,
  })
}

export const desktopRemoteErrorCodeValues = [
  "invalid_request",
  "unauthorized",
  "forbidden",
  "feature_disabled",
  "policy_unavailable",
  "secure_storage_unavailable",
  "device_not_found",
  "device_revoked",
  "device_offline",
  "device_stale",
  "protocol_version_unsupported",
  "payload_version_unsupported",
  "operation_unsupported",
  "capability_not_advertised",
  "control_session_not_found",
  "control_session_expired",
  "workspace_not_found",
  "session_not_found",
  "session_busy",
  "run_mismatch",
  "interaction_not_found",
  "interaction_expired",
  "already_resolved",
  "persistent_permission_unsupported",
  "idempotency_conflict",
  "command_expired",
  "command_cancelled",
  "delivery_failed",
  "snapshot_required",
  "rate_limited",
  "internal_error",
] as const

export const desktopRemoteErrorCodeSchema = z.enum(desktopRemoteErrorCodeValues)
export type DesktopRemoteErrorCode = z.infer<
  typeof desktopRemoteErrorCodeSchema
>

export const desktopRemoteErrorSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    code: desktopRemoteErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
    correlationId: identifierSchema.nullable(),
    currentRunId: identifierSchema.nullable().optional(),
  })
  .strict()
export type DesktopRemoteError = z.infer<typeof desktopRemoteErrorSchema>

export const desktopRemoteActorSchema = z
  .object({
    userId: identifierSchema,
    displayName: displayTextSchema,
  })
  .strict()
export type DesktopRemoteActor = z.infer<typeof desktopRemoteActorSchema>

export const desktopRemoteRunStatusSchema = z.enum([
  "started",
  "running",
  "waiting",
  "retrying",
  "aborting",
  "completed",
  "failed",
  "aborted",
])
export type DesktopRemoteRunStatus = z.infer<
  typeof desktopRemoteRunStatusSchema
>

export const desktopRemoteActiveRunSchema = z
  .object({
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    runId: identifierSchema,
    status: desktopRemoteRunStatusSchema,
  })
  .strict()
export type DesktopRemoteActiveRun = z.infer<
  typeof desktopRemoteActiveRunSchema
>

export const desktopRemoteDeviceSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    id: z.string().uuid(),
    ownerUserId: identifierSchema,
    organizationId: identifierSchema,
    displayName: displayTextSchema,
    platform: z.enum(["darwin", "windows", "linux"]),
    appVersion: semverSchema,
    protocolVersion: z.literal(DESKTOP_REMOTE_PROTOCOL_VERSION),
    enrollmentStatus: z.enum(["enrolled", "revoked"]),
    presence: z.enum(["online", "stale", "offline"]),
    localControlEnabled: z.boolean(),
    capabilities: desktopRemoteCapabilityAdvertisementSchema,
    activeRuns: z.array(desktopRemoteActiveRunSchema).max(100),
    enrolledAt: dateTimeSchema,
    lastSeenAt: dateTimeSchema.nullable(),
    revokedAt: dateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((device, context) => {
    if (device.enrollmentStatus === "revoked" && device.revokedAt === null) {
      context.addIssue({
        code: "custom",
        message: "revoked devices require revokedAt",
        path: ["revokedAt"],
      })
    }
    if (device.enrollmentStatus === "enrolled" && device.revokedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "enrolled devices cannot have revokedAt",
        path: ["revokedAt"],
      })
    }
    if (device.presence === "offline" && device.activeRuns.length > 0) {
      context.addIssue({
        code: "custom",
        message: "offline devices cannot advertise active runs",
        path: ["activeRuns"],
      })
    }
  })
export type DesktopRemoteDevice = z.infer<typeof desktopRemoteDeviceSchema>

export const desktopRemoteControlSessionSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    id: z.string().uuid(),
    actor: desktopRemoteActorSchema,
    deviceId: z.string().uuid(),
    workspaceId: identifierSchema,
    sessionId: identifierSchema.nullable(),
    mode: z.enum(["view", "control"]),
    status: z.enum(["active", "closed", "expired", "revoked"]),
    createdAt: dateTimeSchema,
    lastActiveAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
    closedAt: dateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    if (session.status === "active" && session.closedAt !== null) {
      context.addIssue({
        code: "custom",
        message: "active control sessions cannot have closedAt",
        path: ["closedAt"],
      })
    }
    if (session.status !== "active" && session.closedAt === null) {
      context.addIssue({
        code: "custom",
        message: "terminal control sessions require closedAt",
        path: ["closedAt"],
      })
    }
  })
export type DesktopRemoteControlSession = z.infer<
  typeof desktopRemoteControlSessionSchema
>

export const desktopRemoteSessionStatusSchema = z.enum([
  "idle",
  "running",
  "waiting",
  "retrying",
  "aborting",
  "completed",
  "failed",
])
export type DesktopRemoteSessionStatus = z.infer<
  typeof desktopRemoteSessionStatusSchema
>

export const desktopRemoteWorkspaceSummarySchema = z
  .object({
    id: identifierSchema,
    name: displayTextSchema,
  })
  .strict()
export type DesktopRemoteWorkspaceSummary = z.infer<
  typeof desktopRemoteWorkspaceSummarySchema
>

export const desktopRemoteSessionSummarySchema = z
  .object({
    id: identifierSchema,
    workspaceId: identifierSchema,
    title: z.string().trim().min(1).max(1_000),
    status: desktopRemoteSessionStatusSchema,
    createdAt: dateTimeSchema,
    updatedAt: dateTimeSchema,
    activeRunId: identifierSchema.nullable(),
  })
  .strict()
export type DesktopRemoteSessionSummary = z.infer<
  typeof desktopRemoteSessionSummarySchema
>

export const desktopRemoteMessagePartSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("text"),
      id: identifierSchema,
      text: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("reasoning"),
      id: identifierSchema,
      text: z.string().max(2_000_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      id: identifierSchema,
      name: identifierSchema,
      title: z.string().trim().max(500).nullable(),
      status: z.enum(["pending", "running", "completed", "failed"]),
      input: z.json().nullable(),
      output: z.json().nullable(),
    })
    .strict(),
])
export type DesktopRemoteMessagePart = z.infer<
  typeof desktopRemoteMessagePartSchema
>

export const desktopRemoteMessageSchema = z
  .object({
    id: identifierSchema,
    role: z.enum(["user", "assistant", "system", "tool"]),
    createdAt: dateTimeSchema,
    completedAt: dateTimeSchema.nullable(),
    parts: z.array(desktopRemoteMessagePartSchema).max(10_000),
  })
  .strict()
export type DesktopRemoteMessage = z.infer<typeof desktopRemoteMessageSchema>

export const desktopRemoteTodoSchema = z
  .object({
    id: identifierSchema,
    content: z.string().trim().min(1).max(10_000),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
    priority: z.enum(["low", "medium", "high"]),
  })
  .strict()
export type DesktopRemoteTodo = z.infer<typeof desktopRemoteTodoSchema>

const interactionBaseShape = {
  id: identifierSchema,
  sessionId: identifierSchema,
  runId: identifierSchema.nullable(),
  status: z.enum(["pending", "resolved", "expired"]),
  title: z.string().trim().min(1).max(500),
  createdAt: dateTimeSchema,
  expiresAt: dateTimeSchema.nullable(),
} as const

export const desktopRemotePermissionInteractionSchema = z
  .object({
    ...interactionBaseShape,
    type: z.literal("permission"),
    description: z.string().trim().max(2_000),
    permittedResponses: z
      .array(z.enum(["allow_once", "reject"]))
      .min(1)
      .max(2)
      .refine((responses) => new Set(responses).size === responses.length, "responses must be unique"),
    resolution: z.enum(["allow_once", "reject"]).nullable(),
  })
  .strict()

export const desktopRemoteQuestionInteractionSchema = z
  .object({
    ...interactionBaseShape,
    type: z.literal("question"),
    questions: z
      .array(
        z
          .object({
            id: identifierSchema,
            prompt: z.string().trim().min(1).max(5_000),
            multiple: z.boolean(),
            options: z.array(z.string().trim().min(1).max(1_000)).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    resolution: z
      .array(
        z
          .object({
            questionId: identifierSchema,
            values: z.array(z.string().max(10_000)).min(1).max(100),
          })
          .strict(),
      )
      .max(100)
      .nullable(),
  })
  .strict()

export const desktopRemoteInteractionSchema = z.discriminatedUnion("type", [
  desktopRemotePermissionInteractionSchema,
  desktopRemoteQuestionInteractionSchema,
])
export type DesktopRemoteInteraction = z.infer<
  typeof desktopRemoteInteractionSchema
>

export const desktopRemoteSessionSnapshotSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    workspace: desktopRemoteWorkspaceSummarySchema,
    session: desktopRemoteSessionSummarySchema,
    messages: z.array(desktopRemoteMessageSchema).max(100_000),
    todos: z.array(desktopRemoteTodoSchema).max(10_000),
    interactions: z.array(desktopRemoteInteractionSchema).max(1_000),
    capturedAt: dateTimeSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.session.workspaceId !== snapshot.workspace.id) {
      context.addIssue({
        code: "custom",
        message: "session must belong to the snapshot workspace",
        path: ["session", "workspaceId"],
      })
    }
  })
export type DesktopRemoteSessionSnapshot = z.infer<
  typeof desktopRemoteSessionSnapshotSchema
>

const workspaceListRequestSchema = z
  .object({
    operation: z.literal("workspace.list"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z.object({}).strict(),
  })
  .strict()
const sessionListRequestSchema = z
  .object({
    operation: z.literal("session.list"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z.object({ workspaceId: identifierSchema }).strict(),
  })
  .strict()
const sessionSnapshotRequestSchema = z
  .object({
    operation: z.literal("session.snapshot"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z
      .object({ workspaceId: identifierSchema, sessionId: identifierSchema })
      .strict(),
  })
  .strict()
const sessionPromptRequestSchema = z
  .object({
    operation: z.literal("session.prompt"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z
      .object({
        workspaceId: identifierSchema,
        sessionId: identifierSchema,
        prompt: z.string().trim().min(1).max(200_000),
      })
      .strict(),
  })
  .strict()
const sessionAbortRequestSchema = z
  .object({
    operation: z.literal("session.abort"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z
      .object({
        workspaceId: identifierSchema,
        sessionId: identifierSchema,
        expectedRunId: identifierSchema,
      })
      .strict(),
  })
  .strict()
const permissionReplyRequestSchema = z
  .object({
    operation: z.literal("interaction.permission.reply"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z
      .object({
        workspaceId: identifierSchema,
        sessionId: identifierSchema,
        interactionId: identifierSchema,
        response: z.enum(["allow_once", "reject"]),
      })
      .strict(),
  })
  .strict()
const questionReplyRequestSchema = z
  .object({
    operation: z.literal("interaction.question.reply"),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    arguments: z
      .object({
        workspaceId: identifierSchema,
        sessionId: identifierSchema,
        interactionId: identifierSchema,
        answers: z
          .array(
            z
              .object({
                questionId: identifierSchema,
                values: z.array(z.string().max(10_000)).min(1).max(100),
              })
              .strict(),
          )
          .min(1)
          .max(100)
          .refine(
            (answers) => new Set(answers.map((answer) => answer.questionId)).size === answers.length,
            "questions must be answered at most once",
          ),
      })
      .strict(),
  })
  .strict()

export const desktopRemoteOperationRequestSchema = z.discriminatedUnion(
  "operation",
  [
    workspaceListRequestSchema,
    sessionListRequestSchema,
    sessionSnapshotRequestSchema,
    sessionPromptRequestSchema,
    sessionAbortRequestSchema,
    permissionReplyRequestSchema,
    questionReplyRequestSchema,
  ],
)
export type DesktopRemoteOperationRequest = z.infer<
  typeof desktopRemoteOperationRequestSchema
>

const interactionResolutionResultSchema = z
  .object({
    interactionId: identifierSchema,
    status: z.enum(["resolved", "already_resolved", "expired", "not_found"]),
  })
  .strict()

export const desktopRemoteOperationResultSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("workspace.list"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: z.object({ workspaces: z.array(desktopRemoteWorkspaceSummarySchema).max(10_000) }).strict(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("session.list"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: z.object({ sessions: z.array(desktopRemoteSessionSummarySchema).max(100_000) }).strict(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("session.snapshot"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: desktopRemoteSessionSnapshotSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("session.prompt"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: z.object({ runId: identifierSchema, generation: z.number().int().positive() }).strict(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("session.abort"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: z.object({ runId: identifierSchema, abortRequested: z.literal(true) }).strict(),
      })
      .strict(),
    z
      .object({
        operation: z.literal("interaction.permission.reply"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: interactionResolutionResultSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("interaction.question.reply"),
        payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
        result: interactionResolutionResultSchema,
      })
      .strict(),
  ],
)
export type DesktopRemoteOperationResult = z.infer<
  typeof desktopRemoteOperationResultSchema
>

export function isDesktopRemoteOperationAdvertised(
  request: DesktopRemoteOperationRequest,
  capabilities: DesktopRemoteCapabilityAdvertisement,
): boolean {
  return capabilities.operations.some(
    (capability) =>
      capability.operation === request.operation &&
      capability.payloadVersions.includes(request.payloadVersion),
  )
}

export function createDesktopRemoteOperationRequestSchema(
  capabilities: DesktopRemoteCapabilityAdvertisement,
) {
  const parsedCapabilities = desktopRemoteCapabilityAdvertisementSchema.parse(capabilities)
  return desktopRemoteOperationRequestSchema.superRefine((request, context) => {
    if (!isDesktopRemoteOperationAdvertised(request, parsedCapabilities)) {
      context.addIssue({
        code: "custom",
        message: "operation and payload version must be advertised by the target device",
        path: ["operation"],
        params: { errorCode: "capability_not_advertised" satisfies DesktopRemoteErrorCode },
      })
    }
  })
}

export function parseDesktopRemoteOperationRequest(
  input: unknown,
  capabilities: DesktopRemoteCapabilityAdvertisement,
): DesktopRemoteOperationRequest {
  return createDesktopRemoteOperationRequestSchema(capabilities).parse(input)
}

export const desktopRemoteCommandStatusSchema = z.enum([
  "pending",
  "leased",
  "delivered",
  "accepted",
  "running",
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
])
export type DesktopRemoteCommandStatus = z.infer<
  typeof desktopRemoteCommandStatusSchema
>

function isDesktopRemoteMutationOperation(
  operation: DesktopRemoteOperation,
): operation is (typeof desktopRemoteMutationOperationValues)[number] {
  return desktopRemoteMutationOperationValues.some(
    (mutationOperation) => mutationOperation === operation,
  )
}

export const desktopRemoteCommandDeliverySchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    commandId: z.string().uuid(),
    controlSessionId: z.string().uuid(),
    deviceId: z.string().uuid(),
    actor: desktopRemoteActorSchema,
    request: desktopRemoteOperationRequestSchema,
    idempotencyKey: identifierSchema.nullable(),
    payloadHash: sha256Schema,
    createdAt: dateTimeSchema,
    expiresAt: dateTimeSchema,
  })
  .strict()
  .superRefine((command, context) => {
    if (isDesktopRemoteMutationOperation(command.request.operation) && command.idempotencyKey === null) {
      context.addIssue({
        code: "custom",
        message: "mutating operations require an idempotency key",
        path: ["idempotencyKey"],
      })
    }
  })
export type DesktopRemoteCommandDelivery = z.infer<
  typeof desktopRemoteCommandDeliverySchema
>

const terminalCommandStatuses = new Set<DesktopRemoteCommandStatus>([
  "succeeded",
  "failed",
  "rejected",
  "expired",
  "cancelled",
])

export const desktopRemoteCommandLifecycleSchema = z
  .object({
    ...desktopRemoteCommandDeliverySchema.shape,
    status: desktopRemoteCommandStatusSchema,
    deliveryAttempt: z.number().int().nonnegative(),
    leaseId: identifierSchema.nullable(),
    leaseExpiresAt: dateTimeSchema.nullable(),
    acceptedAt: dateTimeSchema.nullable(),
    runningAt: dateTimeSchema.nullable(),
    completedAt: dateTimeSchema.nullable(),
    result: desktopRemoteOperationResultSchema.nullable(),
    error: desktopRemoteErrorSchema.nullable(),
  })
  .strict()
  .superRefine((command, context) => {
    if (isDesktopRemoteMutationOperation(command.request.operation) && command.idempotencyKey === null) {
      context.addIssue({
        code: "custom",
        message: "mutating operations require an idempotency key",
        path: ["idempotencyKey"],
      })
    }
    const terminal = terminalCommandStatuses.has(command.status)
    if (terminal !== (command.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        message: "completedAt must be present exactly for terminal commands",
        path: ["completedAt"],
      })
    }
    if (command.status === "succeeded") {
      if (command.result === null || command.error !== null) {
        context.addIssue({
          code: "custom",
          message: "succeeded commands require a result and cannot contain an error",
          path: ["result"],
        })
      }
    } else if (terminal && (command.error === null || command.result !== null)) {
      context.addIssue({
        code: "custom",
        message: "unsuccessful terminal commands require an error and cannot contain a result",
        path: ["error"],
      })
    } else if (!terminal && (command.result !== null || command.error !== null)) {
      context.addIssue({
        code: "custom",
        message: "non-terminal commands cannot contain a result or error",
        path: ["status"],
      })
    }
    if (command.result !== null && command.result.operation !== command.request.operation) {
      context.addIssue({
        code: "custom",
        message: "command result operation must match the request operation",
        path: ["result", "operation"],
      })
    }
  })
export type DesktopRemoteCommandLifecycle = z.infer<
  typeof desktopRemoteCommandLifecycleSchema
>

const normalizedSessionEventDataSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: desktopRemoteSessionSnapshotSchema }).strict(),
  z.object({ type: z.literal("message.upsert"), message: desktopRemoteMessageSchema }).strict(),
  z.object({ type: z.literal("message.remove"), messageId: identifierSchema }).strict(),
  z
    .object({
      type: z.literal("message.part.upsert"),
      messageId: identifierSchema,
      part: desktopRemoteMessagePartSchema,
    })
    .strict(),
  z.object({ type: z.literal("todos.replace"), todos: z.array(desktopRemoteTodoSchema).max(10_000) }).strict(),
  z.object({ type: z.literal("interaction.upsert"), interaction: desktopRemoteInteractionSchema }).strict(),
  z.object({ type: z.literal("interaction.remove"), interactionId: identifierSchema }).strict(),
  z
    .object({
      type: z.literal("session.status"),
      status: desktopRemoteSessionStatusSchema,
      run: desktopRemoteActiveRunSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("run.status"),
      runId: identifierSchema,
      status: desktopRemoteRunStatusSchema,
      error: desktopRemoteErrorSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("snapshot_required"),
      reason: z.enum(["cursor_missing", "cursor_expired", "sequence_gap"]),
    })
    .strict(),
])

export const desktopRemoteSessionEventSchema = z
  .object({
    schemaVersion: z.literal(DESKTOP_REMOTE_SCHEMA_VERSION),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    eventId: z.string().uuid(),
    controlSessionId: z.string().uuid(),
    deviceId: z.string().uuid(),
    workspaceId: identifierSchema,
    sessionId: identifierSchema,
    sequence: z.number().int().positive(),
    occurredAt: dateTimeSchema,
    data: normalizedSessionEventDataSchema,
  })
  .strict()
export type DesktopRemoteSessionEvent = z.infer<
  typeof desktopRemoteSessionEventSchema
>

const noEncryptionSchema = z
  .object({ mode: z.literal("none"), keyId: z.null() })
  .strict()
const e2eeEncryptionSchema = z
  .object({ mode: z.literal("e2ee-v1"), keyId: identifierSchema })
  .strict()
export const desktopRemoteEncryptionSchema = z.discriminatedUnion("mode", [
  noEncryptionSchema,
  e2eeEncryptionSchema,
])
export type DesktopRemoteEncryption = z.infer<
  typeof desktopRemoteEncryptionSchema
>

const envelopeBaseShape = {
  protocolVersion: z.literal(DESKTOP_REMOTE_PROTOCOL_VERSION),
  payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
  messageId: z.string().uuid(),
  sentAt: dateTimeSchema,
  encryption: noEncryptionSchema,
} as const

const desktopHelloEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("device.hello"),
    payload: z
      .object({
        deviceId: z.string().uuid(),
        connectionGeneration: z.number().int().positive(),
        appVersion: semverSchema,
        capabilities: desktopRemoteCapabilityAdvertisementSchema,
        activeRuns: z.array(desktopRemoteActiveRunSchema).max(100),
        policyVersion: identifierSchema.nullable(),
        localControlEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict()

const desktopHeartbeatEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("device.heartbeat"),
    payload: z
      .object({
        deviceId: z.string().uuid(),
        connectionGeneration: z.number().int().positive(),
        appVersion: semverSchema,
        capabilities: desktopRemoteCapabilityAdvertisementSchema,
        activeRuns: z.array(desktopRemoteActiveRunSchema).max(100),
        policyVersion: identifierSchema.nullable(),
        localControlEnabled: z.boolean(),
      })
      .strict(),
  })
  .strict()

const cloudWelcomeEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("connection.welcome"),
    payload: z
      .object({
        deviceId: z.string().uuid(),
        connectionGeneration: z.number().int().positive(),
        heartbeatSeconds: z.number().int().positive(),
        staleSeconds: z.number().int().positive(),
        offlineSeconds: z.number().int().positive(),
      })
      .strict(),
  })
  .strict()

const cloudPingEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("cloud.ping"),
    payload: z.object({ nonce: identifierSchema }).strict(),
  })
  .strict()

const desktopPongEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("device.pong"),
    payload: z.object({ nonce: identifierSchema }).strict(),
  })
  .strict()

const commandDeliverEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("command.deliver"),
    payload: desktopRemoteCommandDeliverySchema,
  })
  .strict()

const commandLifecycleEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("command.lifecycle"),
    payload: z
      .object({
        commandId: z.string().uuid(),
        status: desktopRemoteCommandStatusSchema,
        occurredAt: dateTimeSchema,
        result: desktopRemoteOperationResultSchema.nullable(),
        error: desktopRemoteErrorSchema.nullable(),
      })
      .strict(),
  })
  .strict()

const sessionEventEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("session.event"),
    payload: desktopRemoteSessionEventSchema,
  })
  .strict()

const deviceRevokedEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("device.revoked"),
    payload: z.object({ deviceId: z.string().uuid(), reason: displayTextSchema }).strict(),
  })
  .strict()

const protocolErrorEnvelopeSchema = z
  .object({
    ...envelopeBaseShape,
    type: z.literal("protocol.error"),
    payload: desktopRemoteErrorSchema,
  })
  .strict()

const encryptedPayloadEnvelopeSchema = z
  .object({
    protocolVersion: z.literal(DESKTOP_REMOTE_PROTOCOL_VERSION),
    payloadVersion: z.literal(DESKTOP_REMOTE_PAYLOAD_VERSION),
    messageId: z.string().uuid(),
    sentAt: dateTimeSchema,
    encryption: e2eeEncryptionSchema,
    type: z.literal("encrypted.payload"),
    routing: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("command"),
          deviceId: z.string().uuid(),
          controlSessionId: z.string().uuid(),
          commandId: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("event"),
          deviceId: z.string().uuid(),
          controlSessionId: z.string().uuid(),
          eventId: z.string().uuid(),
          sequence: z.number().int().positive(),
        })
        .strict(),
    ]),
    payload: z
      .object({
        nonce: z.string().base64url().min(16).max(256),
        ciphertext: z.string().base64url().min(1).max(16_000_000),
      })
      .strict(),
  })
  .strict()

export const desktopRemoteWssEnvelopeSchema = z.discriminatedUnion("type", [
  desktopHelloEnvelopeSchema,
  desktopHeartbeatEnvelopeSchema,
  cloudWelcomeEnvelopeSchema,
  cloudPingEnvelopeSchema,
  desktopPongEnvelopeSchema,
  commandDeliverEnvelopeSchema,
  commandLifecycleEnvelopeSchema,
  sessionEventEnvelopeSchema,
  deviceRevokedEnvelopeSchema,
  protocolErrorEnvelopeSchema,
  encryptedPayloadEnvelopeSchema,
])
export type DesktopRemoteWssEnvelope = z.infer<
  typeof desktopRemoteWssEnvelopeSchema
>

export function createDesktopRemoteWssEnvelopeSchema(
  capabilities: DesktopRemoteCapabilityAdvertisement,
) {
  const requestSchema = createDesktopRemoteOperationRequestSchema(capabilities)
  return desktopRemoteWssEnvelopeSchema.superRefine((envelope, context) => {
    if (envelope.type !== "command.deliver") return
    const parsed = requestSchema.safeParse(envelope.payload.request)
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "delivered command is not advertised by the target device",
        path: ["payload", "request", "operation"],
        params: { errorCode: "capability_not_advertised" satisfies DesktopRemoteErrorCode },
      })
    }
  })
}

export function parseDesktopRemoteWssEnvelope(
  input: unknown,
  capabilities?: DesktopRemoteCapabilityAdvertisement,
): DesktopRemoteWssEnvelope {
  return capabilities === undefined
    ? desktopRemoteWssEnvelopeSchema.parse(input)
    : createDesktopRemoteWssEnvelopeSchema(capabilities).parse(input)
}

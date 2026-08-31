import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  createDesktopRemoteCapabilityAdvertisement,
  createDesktopRemoteOperationRequestSchema,
  createDesktopRemoteWssEnvelopeSchema,
  desktopRemoteCapabilityAdvertisementSchema,
  desktopRemoteDisabledFeatureGates,
  desktopRemoteDescendantOperationValues,
  desktopRemoteOperationRequestSchema,
  desktopRemoteOperationResultSchema,
  desktopRemoteInteractionSchema,
  desktopRemoteInteractionV1Schema,
  desktopRemoteInteractionV2Schema,
  desktopRemoteCommandDeliverySchema,
  desktopRemoteControlSessionSchema,
  desktopRemoteDeviceSchema,
  desktopRemoteMutationOperationValues,
  desktopRemoteWssEnvelopeSchema,
  isDesktopRemoteOperationEnabled,
  parseDesktopRemoteFeatureGatesOrDisabled,
  type DesktopRemoteCapabilityAdvertisement,
} from "../src/desktop-remote-control.ts"

const capabilities: DesktopRemoteCapabilityAdvertisement = {
  schemaVersion: 1,
  operations: [
    { operation: "workspace.list", payloadVersions: [1] },
    { operation: "session.list", payloadVersions: [1] },
  ],
  features: ["controller.event-resume"],
}

const workspaceListRequest = {
  operation: "workspace.list",
  payloadVersion: 1,
  arguments: {},
} as const

const commandEnvelope = {
  protocolVersion: 1,
  payloadVersion: 1,
  messageId: "7398fb8c-7b8c-4ec0-a822-2d52aa621275",
  sentAt: "2026-08-08T12:00:00.000Z",
  encryption: { mode: "none", keyId: null },
  type: "command.deliver",
  payload: {
    schemaVersion: 1,
    commandId: "d75f8dfa-e73b-491f-95bc-e5316cdbdd41",
    controlSessionId: "476bf830-e98b-408f-9517-503de904fe01",
    deviceId: "abf98cef-fac7-486d-af73-f81c2bfa070d",
    actor: { userId: "user-1", displayName: "Test User" },
    request: workspaceListRequest,
    idempotencyKey: null,
    payloadHash: "a".repeat(64),
    createdAt: "2026-08-08T12:00:00.000Z",
    expiresAt: "2026-08-08T12:00:30.000Z",
  },
} as const

describe("desktop remote-control contracts", () => {
  test("feature gates fail closed for missing, partial, malformed, and future documents", () => {
    const invalidDocuments = [
      undefined,
      {},
      { schemaVersion: 1, enrollment: true },
      { ...desktopRemoteDisabledFeatureGates, schemaVersion: 2 },
      { ...desktopRemoteDisabledFeatureGates, enrollment: "true" },
      { ...desktopRemoteDisabledFeatureGates, unknownGate: true },
    ]

    for (const document of invalidDocuments) {
      assert.deepEqual(
        parseDesktopRemoteFeatureGatesOrDisabled(document),
        desktopRemoteDisabledFeatureGates,
      )
    }
  })

  test("derives operation capabilities only from all prerequisite gates", () => {
    const readOnly = {
      ...desktopRemoteDisabledFeatureGates,
      enrollment: true,
      readOnlyControl: true,
    }
    assert.deepEqual(
      createDesktopRemoteCapabilityAdvertisement(readOnly).operations.map(
        ({ operation }) => operation,
      ),
      ["workspace.list", "session.list", "session.snapshot"],
    )
    assert.equal(isDesktopRemoteOperationEnabled("session.prompt", readOnly), false)

    const mutation = { ...readOnly, sessionMutation: true }
    assert.equal(isDesktopRemoteOperationEnabled("session.prompt", mutation), true)
    assert.equal(isDesktopRemoteOperationEnabled("session.create", mutation), true)
    assert.equal(
      createDesktopRemoteCapabilityAdvertisement(mutation).operations.some(
        ({ operation }) => operation === "session.create",
      ),
      true,
    )
    assert.equal(
      isDesktopRemoteOperationEnabled("interaction.permission.reply", mutation),
      false,
    )

    const interactions = { ...mutation, interactions: true }
    assert.equal(
      isDesktopRemoteOperationEnabled("interaction.permission.reply", interactions),
      true,
    )
  })

  test("later feature gates cannot bypass enrollment or their phase prerequisites", () => {
    const laterOnly = {
      ...desktopRemoteDisabledFeatureGates,
      backgroundLifecycle: true,
      payloadEncryption: true,
      busySessionSteer: true,
      busySessionEnqueue: true,
      nativeMobile: true,
    }
    assert.deepEqual(createDesktopRemoteCapabilityAdvertisement(laterOnly), {
      schemaVersion: 1,
      operations: [],
      features: [],
    })

    const readWithQueue = {
      ...laterOnly,
      enrollment: true,
      readOnlyControl: true,
    }
    const advertised = createDesktopRemoteCapabilityAdvertisement(readWithQueue)
    assert.equal(advertised.features.includes("session.steer"), false)
    assert.equal(advertised.features.includes("session.enqueue"), false)
    assert.equal(advertised.features.includes("payload.e2ee-v1"), true)
  })

  test("accepts a supported advertised operation", () => {
    assert.equal(desktopRemoteCapabilityAdvertisementSchema.safeParse(capabilities).success, true)
    assert.equal(
      createDesktopRemoteOperationRequestSchema(capabilities).safeParse(workspaceListRequest).success,
      true,
    )
    assert.equal(createDesktopRemoteWssEnvelopeSchema(capabilities).safeParse(commandEnvelope).success, true)
  })

  test("rejects unknown operations before dispatch", () => {
    const result = desktopRemoteOperationRequestSchema.safeParse({
      operation: "desktop.http.proxy",
      payloadVersion: 1,
      arguments: { path: "/owner-token" },
    })

    assert.equal(result.success, false)
  })

  test("rejects unsupported payload versions in requests and advertisements", () => {
    assert.equal(
      desktopRemoteOperationRequestSchema.safeParse({
        ...workspaceListRequest,
        payloadVersion: 2,
      }).success,
      false,
    )
    assert.equal(
      desktopRemoteCapabilityAdvertisementSchema.safeParse({
        ...capabilities,
        operations: [{ operation: "workspace.list", payloadVersions: [2] }],
      }).success,
      false,
    )
    assert.equal(
      desktopRemoteWssEnvelopeSchema.safeParse({
        ...commandEnvelope,
        payloadVersion: 2,
      }).success,
      false,
    )
  })

  test("negotiates descendant v2 only for snapshot and interaction replies", () => {
    const gates = {
      ...desktopRemoteDisabledFeatureGates,
      enrollment: true,
      readOnlyControl: true,
      sessionMutation: true,
      interactions: true,
    }
    const advertised = createDesktopRemoteCapabilityAdvertisement(gates)
    assert.deepEqual(
      advertised.operations.find(({ operation }) => operation === "session.snapshot")?.payloadVersions,
      [1, 2],
    )
    assert.deepEqual(
      advertised.operations.find(({ operation }) => operation === "workspace.list")?.payloadVersions,
      [1],
    )
    assert.equal(desktopRemoteOperationRequestSchema.safeParse({
      operation: "session.snapshot",
      payloadVersion: 2,
      arguments: { workspaceId: "workspace-1", rootSessionId: "session-root" },
    }).success, true)
    assert.equal(desktopRemoteOperationRequestSchema.safeParse({
      operation: "session.snapshot",
      payloadVersion: 2,
      arguments: { workspaceId: "workspace-1", sessionId: "session-root" },
    }).success, false)
    assert.deepEqual(desktopRemoteDescendantOperationValues, [
      "session.snapshot",
      "interaction.permission.reply",
      "interaction.question.reply",
    ])
    for (const operation of ["workspace.list", "session.list", "session.prompt"] as const) {
      assert.equal(desktopRemoteCapabilityAdvertisementSchema.safeParse({
        schemaVersion: 1,
        operations: [{ operation, payloadVersions: [1, 2] }],
        features: [],
      }).success, false)
    }
  })

  test("rejects unsupported WSS protocol versions", () => {
    assert.equal(
      desktopRemoteWssEnvelopeSchema.safeParse({
        ...commandEnvelope,
        protocolVersion: 2,
      }).success,
      false,
    )
  })

  test("accepts only strict session.unbound controller rejections", () => {
    const envelope = {
      protocolVersion: 1,
      payloadVersion: 1,
      messageId: "7398fb8c-7b8c-4ec0-a822-2d52aa621275",
      sentAt: "2026-08-08T12:00:00.000Z",
      encryption: { mode: "none", keyId: null },
      type: "session.unbound",
      payload: { controlSessionId: "476bf830-e98b-408f-9517-503de904fe01", reason: "snapshot_required" },
    }
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse(envelope).success, true)
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...envelope, payload: { ...envelope.payload, reason: "unknown" } }).success, false)
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...envelope, payload: { ...envelope.payload, extra: true } }).success, false)
  })

  test("accepts exact encrypted command, result, and source-sequenced event routing", () => {
    const desktopKeyId = `p256:${"A".repeat(43)}`
    const controllerKeyId = `p256:${"B".repeat(42)}A`
    const desktopStatementHash = "a".repeat(64)
    const base = {
      protocolVersion: 1,
      payloadVersion: 1,
      messageId: "7398fb8c-7b8c-4ec0-a822-2d52aa621275",
      sentAt: "2026-08-08T12:00:00.000Z",
      encryption: { mode: "e2ee-v1", keyId: desktopKeyId },
      type: "encrypted.payload",
      payload: { nonce: "AAECAwQFBgcICQoL", ciphertext: "AAAAAAAAAAAAAAAAAAAAAAA" },
    } as const
    const commandRouting = {
      kind: "command", commandId: "d75f8dfa-e73b-491f-95bc-e5316cdbdd41",
      controlSessionId: "476bf830-e98b-408f-9517-503de904fe01", deviceId: "abf98cef-fac7-486d-af73-f81c2bfa070d",
      actor: { userId: "user-1", displayName: "Test User" }, operation: "session.create",
      workspaceId: "workspace-1", sessionId: null, idempotencyKey: "create-1", payloadHash: "b".repeat(64),
      createdAt: "2026-08-08T12:00:00.000Z", expiresAt: "2026-08-08T12:00:30.000Z",
      desktopKeyId, desktopStatementHash, controllerKeyId, controllerPublicKey: `BA${"A".repeat(85)}`,
    } as const
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...base, routing: commandRouting }).success, true)
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...base, routing: {
      kind: "command-result", commandId: commandRouting.commandId, controlSessionId: commandRouting.controlSessionId,
      deviceId: commandRouting.deviceId, operation: "session.create", status: "succeeded",
      desktopKeyId, desktopStatementHash, controllerKeyId,
    } }).success, true)
    const event = { ...base, routing: {
      kind: "session-event", eventId: "dcaa5db8-3c66-4d04-bbc1-fb685c208049", controlSessionId: commandRouting.controlSessionId,
      deviceId: commandRouting.deviceId, workspaceId: "workspace-1", sessionId: "session-1", sourceSequence: 7,
      eventType: "todos.replace", occurredAt: "2026-08-08T12:00:00.123Z", desktopKeyId, desktopStatementHash, controllerKeyId,
    } }
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse(event).success, true)
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...event, routing: { ...event.routing, sequence: 7 } }).success, false)
    assert.equal(desktopRemoteWssEnvelopeSchema.safeParse({ ...base, encryption: { mode: "e2ee-v1", keyId: controllerKeyId }, routing: commandRouting }).success, false)
  })

  test("shares one strict signed Desktop key statement shape across device and control-session contracts", () => {
    const signedStatement = "jugglework.desktop-remote.e2ee-key-advertisement.v1\nstatement"
    const signingIdentity = {
      algorithm: "Ed25519", keyId: "11111111-1111-4111-8111-111111111111",
      publicKey: "A".repeat(43), fingerprint: "a".repeat(64),
    } as const
    const payloadEncryption = {
      mode: "e2ee-v1", keyId: `p256:${"A".repeat(43)}`, publicKey: `BA${"A".repeat(85)}`,
      algorithm: "P-256/HKDF-SHA-256/AES-256-GCM", createdAt: "2026-08-08T12:00:00.000Z",
      signedStatement, statementHash: "b".repeat(64), signature: "A".repeat(86), signingIdentity,
    } as const
    const device = {
      schemaVersion: 1, id: "abf98cef-fac7-486d-af73-f81c2bfa070d", ownerUserId: "user-1", organizationId: "org-1",
      displayName: "Desktop", platform: "darwin", appVersion: "1.2.0", protocolVersion: 1,
      enrollmentStatus: "enrolled", presence: "online", localControlEnabled: true,
      capabilities: { schemaVersion: 1, operations: [], features: ["payload.e2ee-v1"] }, activeRuns: [], connectionGeneration: 7,
      payloadEncryption, enrolledAt: "2026-08-08T12:00:00.000Z", lastSeenAt: "2026-08-08T12:00:00.000Z", revokedAt: null,
    } as const
    assert.equal(desktopRemoteDeviceSchema.safeParse(device).success, true)
    assert.equal(desktopRemoteControlSessionSchema.safeParse({
      schemaVersion: 1, id: "476bf830-e98b-408f-9517-503de904fe01", actor: { userId: "user-1", displayName: "Test User" },
      deviceId: device.id, workspaceId: "workspace-1", sessionId: null, mode: "view", status: "active",
      createdAt: device.enrolledAt, lastActiveAt: device.enrolledAt, expiresAt: "2026-08-08T12:02:00.000Z", closedAt: null,
      payloadEncryption: {
        mode: "e2ee-v1", desktopKeyId: payloadEncryption.keyId, desktopPublicKey: payloadEncryption.publicKey,
        desktopStatementHash: payloadEncryption.statementHash, desktopSignedStatement: payloadEncryption.signedStatement,
        desktopSignature: payloadEncryption.signature, desktopSigningIdentity: payloadEncryption.signingIdentity,
        controllerKeyId: `p256:${"B".repeat(42)}A`,
      },
    }).success, true)
  })

  test("rejects operations not advertised by the target device", () => {
    const unadvertisedRequest = {
      operation: "session.snapshot",
      payloadVersion: 1,
      arguments: { workspaceId: "workspace-1", sessionId: "session-1" },
    } as const

    assert.equal(desktopRemoteOperationRequestSchema.safeParse(unadvertisedRequest).success, true)
    assert.equal(
      createDesktopRemoteOperationRequestSchema(capabilities).safeParse(unadvertisedRequest).success,
      false,
    )
    assert.equal(
      createDesktopRemoteWssEnvelopeSchema(capabilities).safeParse({
        ...commandEnvelope,
        payload: { ...commandEnvelope.payload, request: unadvertisedRequest },
      }).success,
      false,
    )
  })

  test("rejects persistent permission and unsupported busy-session expansion", () => {
    assert.equal(
      desktopRemoteOperationRequestSchema.safeParse({
        operation: "interaction.permission.reply",
        payloadVersion: 1,
        arguments: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          interactionId: "permission-1",
          response: "always",
        },
      }).success,
      false,
    )
    assert.equal(
      desktopRemoteOperationRequestSchema.safeParse({
        operation: "session.prompt",
        payloadVersion: 1,
        arguments: {
          workspaceId: "workspace-1",
          sessionId: "session-1",
          prompt: "Continue",
          whenBusy: "later",
        },
      }).success,
      false,
    )
    for (const whenBusy of ["reject", "steer", "enqueue"] as const) {
      assert.equal(desktopRemoteOperationRequestSchema.safeParse({
        operation: "session.prompt",
        payloadVersion: 1,
        arguments: { workspaceId: "workspace-1", sessionId: "session-1", prompt: "Continue", whenBusy },
      }).success, true)
    }
    assert.equal(desktopRemoteOperationRequestSchema.safeParse({
      operation: "session.prompt",
      payloadVersion: 1,
      arguments: { workspaceId: "workspace-1", sessionId: "session-1", prompt: "界".repeat(66_667), whenBusy: "reject" },
    }).success, false)
  })

  test("retains root ownership and exact target ownership for remote interactions", () => {
    const interaction = {
      id: "permission-1",
      type: "permission",
      rootSessionId: "session-root",
      targetSessionId: "session-child",
      parentSessionId: "session-root",
      sessionId: "session-child",
      runId: null,
      status: "pending",
      title: "External directory",
      description: "/outside",
      permittedResponses: ["allow_once", "reject"],
      resolution: null,
      createdAt: "2026-08-08T12:00:00.000Z",
      expiresAt: null,
    } as const
    assert.equal(desktopRemoteInteractionSchema.safeParse(interaction).success, true)
    assert.equal(desktopRemoteInteractionV2Schema.safeParse(interaction).success, true)
    assert.equal(desktopRemoteInteractionV1Schema.safeParse(interaction).success, false)
    const v1 = Object.fromEntries(Object.entries(interaction).filter(([key]) =>
      !["rootSessionId", "targetSessionId", "parentSessionId"].includes(key)))
    assert.equal(desktopRemoteInteractionV1Schema.safeParse(v1).success, true)
    assert.equal(desktopRemoteInteractionSchema.safeParse({
      ...interaction,
      sessionId: "session-root",
    }).success, false)
  })

  test("accepts only strict bounded session.create requests and results", () => {
    const request = {
      operation: "session.create",
      payloadVersion: 1,
      arguments: { workspaceId: "workspace-1", title: "😀".repeat(120) },
    }
    assert.equal(desktopRemoteOperationRequestSchema.safeParse(request).success, true)
    assert.equal(desktopRemoteOperationRequestSchema.safeParse({
      ...request,
      arguments: { workspaceId: "workspace-1", title: "join\u200dthis" },
    }).success, true)
    for (const argumentsValue of [
      { workspaceId: "workspace-1", title: "" },
      { workspaceId: "workspace-1", title: " New " },
      { workspaceId: "workspace-1", title: "embedded\u0000nul" },
      { workspaceId: "workspace-1", title: "next\u0085line" },
      { workspaceId: "workspace-1", title: "high\ud800surrogate" },
      { workspaceId: "workspace-1", title: "low\udc00surrogate" },
      { workspaceId: "workspace-1", title: "😀".repeat(121) },
      { workspaceId: "workspace-1", title: "New", prompt: "Start" },
      { workspaceId: "workspace-1", title: "New", path: "/tmp" },
      { workspaceId: "workspace-1", title: "New", parentId: "session-1" },
      { workspaceId: "workspace-1", title: "New", model: "model-1" },
      { workspaceId: "workspace-1", title: "New", agent: "agent-1" },
      { workspaceId: "workspace-1", title: "New", tools: {} },
      { workspaceId: "workspace-1", title: "New", sessionId: "session-1" },
    ]) {
      assert.equal(desktopRemoteOperationRequestSchema.safeParse({ ...request, arguments: argumentsValue }).success, false)
    }

    const result = { operation: "session.create", payloadVersion: 1, result: { sessionId: "session-new" } }
    assert.equal(desktopRemoteOperationResultSchema.safeParse(result).success, true)
    assert.equal(desktopRemoteOperationResultSchema.safeParse({ ...result, result: {} }).success, false)
    assert.equal(desktopRemoteOperationResultSchema.safeParse({ ...result, result: { sessionId: "", title: "New" } }).success, false)
  })

  test("classifies session.create as a mutation requiring idempotency", () => {
    assert.equal(desktopRemoteMutationOperationValues.includes("session.create"), true)
    const request = {
      operation: "session.create",
      payloadVersion: 1,
      arguments: { workspaceId: "workspace-1", title: "New session" },
    } as const
    assert.equal(desktopRemoteCommandDeliverySchema.safeParse({
      ...commandEnvelope.payload,
      request,
      idempotencyKey: null,
    }).success, false)
    assert.equal(desktopRemoteCommandDeliverySchema.safeParse({
      ...commandEnvelope.payload,
      request,
      idempotencyKey: "create-1",
    }).success, true)
  })
})

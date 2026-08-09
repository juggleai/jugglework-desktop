import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  createDesktopRemoteCapabilityAdvertisement,
  createDesktopRemoteOperationRequestSchema,
  createDesktopRemoteWssEnvelopeSchema,
  desktopRemoteCapabilityAdvertisementSchema,
  desktopRemoteDisabledFeatureGates,
  desktopRemoteOperationRequestSchema,
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

  test("rejects unsupported WSS protocol versions", () => {
    assert.equal(
      desktopRemoteWssEnvelopeSchema.safeParse({
        ...commandEnvelope,
        protocolVersion: 2,
      }).success,
      false,
    )
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

  test("rejects persistent permission and queue-like argument expansion", () => {
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
          whenBusy: "enqueue",
        },
      }).success,
      false,
    )
  })
})

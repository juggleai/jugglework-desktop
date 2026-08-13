import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  migrateLegacyOpenCodeSession,
  runtimeAttachmentRefSchema,
  runtimeSessionRecordSchema,
  stableLegacyOpenCodeSessionId,
} from "../src/runtime-session.ts"

describe("runtime session contracts", () => {
  test("migrates a legacy OpenCode session to a stable JuggleWork identity", () => {
    const legacy = {
      id: "ses_opencode_1",
      directory: "/workspace/project",
      title: "Existing conversation",
      time: { created: 100, updated: 200 },
      backendOnlyField: "ignored",
    }
    const context = {
      orgId: "org_1",
      workspaceId: "ws_1",
      modelProviderId: "jugglework",
      modelId: "gpt-5.6-terra",
      agentProfileId: "jugglework",
      configSnapshot: { source: "legacy-opencode" },
    }
    const first = migrateLegacyOpenCodeSession(legacy, context)
    const second = migrateLegacyOpenCodeSession(legacy, context)
    assert.deepEqual(first, second)
    assert.equal(first.id, stableLegacyOpenCodeSessionId({
      orgId: "org_1",
      workspaceId: "ws_1",
      backendThreadId: "ses_opencode_1",
    }))
    assert.equal(first.runtimeKind, "opencode")
    assert.equal(first.backendThreadId, "ses_opencode_1")
    assert.equal(first.runtimeLocked, true)
    assert.equal(JSON.stringify(first).includes("backendOnlyField"), false)
  })

  test("binds session identity to organization and workspace", () => {
    const shared = { backendThreadId: "ses_1" }
    const first = stableLegacyOpenCodeSessionId({ ...shared, orgId: "org_a", workspaceId: "ws_a" })
    assert.notEqual(first, stableLegacyOpenCodeSessionId({ ...shared, orgId: "org_b", workspaceId: "ws_a" }))
    assert.notEqual(first, stableLegacyOpenCodeSessionId({ ...shared, orgId: "org_a", workspaceId: "ws_b" }))
  })

  test("stores attachment references and metadata but rejects inline payload expansion", () => {
    const attachment = runtimeAttachmentRefSchema.parse({
      id: "att_1",
      kind: "image",
      source: "upload",
      name: "error.png",
      mimeType: "image/png",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      objectRef: "objects/att_1",
    })
    assert.equal(attachment.previewRef, null)
    assert.equal(runtimeAttachmentRefSchema.safeParse({
      ...attachment,
      base64: "aGVsbG8=",
    }).success, false)
  })

  test("rejects invalid session chronology and locked sessions without a backend thread", () => {
    const base = {
      schemaVersion: 1,
      id: "jws_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      runtimeKind: "codex",
      backendThreadId: null,
      agentProfileId: null,
      modelProviderId: "jugglework",
      modelId: "gpt-5.6-terra",
      reasoningEffort: "medium",
      cwd: "/workspace",
      title: "",
      runtimeLocked: true,
      configSnapshot: {},
      attachments: [],
      createdAt: 200,
      updatedAt: 100,
      archivedAt: null,
    }
    const result = runtimeSessionRecordSchema.safeParse(base)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.deepEqual(result.error.issues.map((issue) => issue.path.join(".")), ["updatedAt", "backendThreadId"])
    }
  })
})

import assert from "node:assert/strict"
import test from "node:test"
import {
  decodeToonAssistantEvent,
  toonAssistantCanvasDecisionRequestSchema,
  toonAssistantCanvasExecutionResponseSchema,
  toonAssistantConversationSchema,
  toonAssistantBridgeCallSchema,
  toonAssistantGenerationProposalSchema,
  toonAssistantMessageSchema,
  toonSessionVisibilitySchema,
  toonAssistantSendRequestSchema,
  toonAssistantSendResponseSchema,
  toonAssistantSnapshotSchema,
} from "../dist/toon-assistant.js"

const now = "2026-01-01T00:00:00.000Z"

test("assistant contracts cover the closed visibility family and terminal messages", () => {
  assert.deepEqual(toonSessionVisibilitySchema.options, ["normal", "toon_transient_generation", "toon_project_assistant", "toon_project_subagent"])
  assert.equal(toonAssistantMessageSchema.parse({
    id: "message-1", conversationId: "conversation-1", turnId: "turn-1", branchId: "branch-1",
    role: "assistant", status: "completed", parts: [{ type: "text", text: "Ready" }], attachments: [], mentions: [], contextDiagnostics: [],
    createdAt: now, completedAt: now,
  }).status, "completed")
})

test("conversation responses carry their immutable model and bridge calls name exact executors", () => {
  const conversation = toonAssistantConversationSchema.parse({
    id: "conversation-1", projectId: "project-1", title: "Assistant",
    model: { kind: "text", providerID: "provider", modelID: "model" },
    visibility: "toon_project_assistant", archived: false, createdAt: now, updatedAt: now,
  })
  assert.equal(conversation.model.modelID, "model")
  assert.deepEqual(toonAssistantBridgeCallSchema.parse({ action: "project.read" }), { action: "project.read" })
  assert.deepEqual(toonAssistantBridgeCallSchema.parse({ action: "canvas.read", canvasId: "main" }), { action: "canvas.read", canvasId: "main" })
})

test("event decoder accepts the legacy envelope and normalizes version one", () => {
  const event = { id: "event-1", sequence: 1, workspaceId: "workspace-1", projectId: "project-1", conversationId: "conversation-1", type: "turn.status", data: { status: "completed" }, createdAt: now }
  assert.deepEqual(decodeToonAssistantEvent({ event }), { version: 1, ...event })
})

test("paid generation proposals cannot claim authorization or submission", () => {
  const parsed = toonAssistantGenerationProposalSchema.parse({
    id: "proposal-1", conversationId: "conversation-1", turnId: "turn-1", state: "awaiting-human-authorization", requestId: "request-1",
    episodeId: "episode-1", workflowRecordId: "image-candidates", canvasId: "main", nodeId: "image-node",
    expectedRevisions: { "toon-project.json": "a".repeat(64), "catalogs/canvases.json": "b".repeat(64), "canvases/main.json": "c".repeat(64) },
    plan: { kind: "image", model: { kind: "image", providerID: "provider", modelID: "model" }, object: "frame", quantity: 1, prompt: "draw", references: [], parameters: {}, executionCount: 1, knownCost: null },
  })
  assert.equal(parsed.state, "awaiting-human-authorization")
  assert.equal(toonAssistantGenerationProposalSchema.safeParse({ ...parsed, expectedRevisions: undefined }).success, false)
  assert.equal(toonAssistantGenerationProposalSchema.safeParse({ ...parsed, state: "submitted" }).success, false)
})

test("assistant requests reject provider-private and Toonflow runtime fields", () => {
  const base = { turnId: "turn-1", messageId: "message-1", text: "hello", model: { kind: "text", providerID: "provider", modelID: "model" }, attachments: [], mentions: [] }
  for (const field of ["apiKey", "balance", "marketplace", "tfRouter", "providerConfig", "umd"] as const) {
    assert.equal(toonAssistantSendRequestSchema.safeParse({ ...base, [field]: "forbidden" }).success, false)
  }
})

test("edit-and-resend responses can explicitly report a pending replacement", () => {
  const parsed = toonAssistantSendResponseSchema.parse({ accepted: true, pending: true, turnId: "turn-2", branchId: "branch-2", cursor: "2", contextDiagnostics: [] })
  assert.equal(parsed.pending, true)
})

test("assistant snapshots expose active and archived branches plus durable remote continuation warnings", () => {
  const snapshot = toonAssistantSnapshotSchema.parse({
    conversation: { id: "conversation-1", projectId: "project-1", title: "Assistant", model: { kind: "text", providerID: "provider", modelID: "model" }, visibility: "toon_project_assistant", archived: false, createdAt: now, updatedAt: now },
    messages: [], interactions: [], canvasProposals: [], subagents: [], activeTurnId: null, activeBranchId: "branch-new", cursor: null,
    branches: [
      { id: "branch-old", fromMessageId: null, turnIds: ["turn-old"], remoteMayContinue: true, active: false, createdAt: now },
      { id: "branch-new", fromMessageId: "message-old", turnIds: ["turn-new"], remoteMayContinue: false, active: true, createdAt: now },
    ],
    remoteContinueWarnings: [{ turnId: "turn-old", branchId: "branch-old", status: "interrupted", remoteMayContinue: true, createdAt: now }],
  })
  assert.equal(snapshot.branches.find((branch) => branch.active)?.id, "branch-new")
  assert.equal(snapshot.remoteContinueWarnings[0]?.turnId, "turn-old")
})

test("canvas proposal decisions are explicit and denial has no executable outcome", () => {
  const proposal = {
    id: "proposal-1", conversationId: "conversation-1", turnId: "turn-1", toolCallId: "tool-1", risk: "reversible-mutation", summary: "Move node", affected: [{ kind: "canvas", id: "main" }], requiresConfirmation: true,
    command: { operationId: "operation-1", actor: { kind: "assistant", id: "tool-1" }, origin: "assistant-tool", expectedRevisions: {}, kind: "canvas.write", canvasId: "main", body: { schemaVersion: 2, id: "main", nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } } },
  }
  const denied = toonAssistantCanvasExecutionResponseSchema.parse({ item: { decision: "deny", proposal } })
  assert.equal(denied.item.decision, "deny")
  assert.equal("outcome" in denied.item, false)
  assert.equal(toonAssistantCanvasExecutionResponseSchema.safeParse({ item: { decision: "deny", proposal, outcome: {} } }).success, false)
  assert.deepEqual(toonAssistantCanvasDecisionRequestSchema.parse({ proposalId: "proposal-1", decision: "approve" }), { proposalId: "proposal-1", decision: "approve" })
  assert.equal(toonAssistantCanvasDecisionRequestSchema.safeParse({ confirmed: true }).success, false)
})

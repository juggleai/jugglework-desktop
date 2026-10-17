import assert from "node:assert/strict"
import test from "node:test"
import {
  completeToonWorkspaceClientCommand,
  toonCanvasLeaseResponseSchema,
  toonWorkspaceClientCommandSchema,
  toonWorkspaceCommandSchema,
  validateToonPortableProject,
  type ToonPortableProjectBundle,
} from "../dist/toon-workspace.js"
import { toonMediaJobSubmitRequestSchema } from "../dist/toon-factory.js"

const hash = "a".repeat(64)
const now = "2026-01-01T00:00:00.000Z"

function bundle(): ToonPortableProjectBundle {
  return {
    project: {
      schemaVersion: 2,
      metadata: { id: "project-1", name: "Portable", createdAt: now, updatedAt: now },
      catalogs: { canvases: "catalogs/canvases.json", documents: "catalogs/documents.json", assets: "catalogs/assets.json" },
      activeCanvasId: "main",
      workflow: { episodes: [] },
    },
    canvases: {
      schemaVersion: 2,
      projectId: "project-1",
      folders: [{ id: "folder-1", title: "Scenes", order: 0, state: "active" }],
      canvases: [{ id: "main", title: "Main", kind: "freeform", folderId: "folder-1", order: 0, file: "canvases/main.json", revision: hash, state: "active" }],
    },
    documents: { schemaVersion: 2, projectId: "project-1", documents: [{ id: "doc-1", title: "Script", path: "documents/script.md", kind: "markdown", mimeType: "text/markdown", revision: hash, state: "active", updatedAt: now }] },
    assets: { schemaVersion: 2, projectId: "project-1", assets: [{ id: "asset-1", title: "Frame", path: "assets/frame.png", mimeType: "image/png", bytes: 4, checksum: hash, origin: "imported", state: "active", references: [{ kind: "node", id: "node-1" }], createdAt: now, updatedAt: now }] },
    canvasFiles: {
      "canvases/main.json": { schemaVersion: 2, id: "main", nodes: [{ id: "node-1", kind: "image-asset", position: { x: 0, y: 0 }, handles: [], config: { content: { kind: "document", id: "doc-1" }, asset: { kind: "asset", id: "asset-1" } } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    },
  }
}

test("portable v2 validator accepts a complete project and rejects forbidden state", () => {
  assert.deepEqual(validateToonPortableProject(bundle()), { valid: true, diagnostics: [] })
  for (const patch of [
    { sessionId: "ses_local" },
    { apiKey: "secret" },
    { outputPath: "/Users/private/project" },
  ]) {
    const invalid = structuredClone(bundle()) as ToonPortableProjectBundle & Record<string, unknown>
    Object.assign(invalid.project, patch)
    assert.equal(validateToonPortableProject(invalid).valid, false)
  }
  const dangling = bundle()
  dangling.canvasFiles["canvases/main.json"]!.nodes[0]!.config.asset = { kind: "asset", id: "missing" }
  assert.match(validateToonPortableProject(dangling).diagnostics[0]!.message, /Dangling asset reference/)
})

test("portable v2 validator rejects project-wide node and group id collisions", () => {
  const invalid = bundle()
  invalid.canvases.canvases.push({ id: "second", title: "Second", kind: "freeform", order: 1, file: "canvases/second.json", revision: hash, state: "active" })
  invalid.canvasFiles["canvases/second.json"] = { schemaVersion: 2, id: "second", nodes: [], groups: [{ id: "node-1", title: "Collision", position: { x: 0, y: 0 } }], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }
  const validation = validateToonPortableProject(invalid)
  assert.equal(validation.valid, false)
  assert.match(validation.diagnostics.find((item) => item.message.includes("Project-wide"))?.message ?? "", /node\/group id collision/)
})

test("semantic command schemas round trip actor, origin, operation and revisions", () => {
  const command = {
    kind: "document.write",
    operationId: "operation-1",
    actor: { kind: "human", id: "member-1" },
    origin: "autosave",
    expectedRevisions: { "documents/script.md": hash },
    documentId: "doc-1",
    content: "next",
  } as const
  assert.deepEqual(toonWorkspaceCommandSchema.parse(JSON.parse(JSON.stringify(command))), command)
})

test("client commands reject server-owned identity and dedicated mutations", () => {
  const base = {
    operationId: "operation-client",
    expectedRevisions: {},
  }
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "project.update", name: "Next", actor: { kind: "human" } }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "workflow.authorize" }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "workflow.configure", episodes: [] }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "workflow.invalidate", targets: [{ kind: "canvas", id: "main" }], reason: "forged" }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "generation.project", generationId: "generation-1", status: "adopted", candidates: [] }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "asset.register" }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "asset.import" }).success, false)
  assert.equal(toonWorkspaceClientCommandSchema.safeParse({ ...base, kind: "project.update", name: "Next" }).success, true)
})

test("client command builder covers every portable path touched by public writes", () => {
  const portable = bundle()
  const snapshot = {
    kind: "catalogs.read" as const,
    canvases: portable.canvases,
    documents: portable.documents,
    assets: portable.assets,
    revisions: {
      "toon-project.json": "1".repeat(64),
      "catalogs/canvases.json": "2".repeat(64),
      "catalogs/documents.json": "3".repeat(64),
      "catalogs/assets.json": "4".repeat(64),
      "canvases/main.json": "5".repeat(64),
      "documents/script.md": "6".repeat(64),
      "assets/frame.png": hash,
    },
  }
  const envelope = { operationId: "complete-cas", expectedRevisions: {} }
  const nextCanvas = { ...portable.canvasFiles["canvases/main.json"]!, nodes: [] }
  const canvasWrite = completeToonWorkspaceClientCommand({ ...envelope, kind: "canvas.write", canvasId: "main", body: nextCanvas }, snapshot, { canvases: portable.canvasFiles })
  assert.deepEqual(canvasWrite.expectedRevisions, {
    "toon-project.json": snapshot.revisions["toon-project.json"],
    "catalogs/canvases.json": snapshot.revisions["catalogs/canvases.json"],
    "catalogs/assets.json": snapshot.revisions["catalogs/assets.json"],
    "canvases/main.json": snapshot.revisions["canvases/main.json"],
  })
  const documentWrite = completeToonWorkspaceClientCommand({ ...envelope, kind: "document.write", documentId: "doc-1", content: "next" }, snapshot)
  assert.deepEqual(documentWrite.expectedRevisions, {
    "toon-project.json": snapshot.revisions["toon-project.json"],
    "catalogs/documents.json": snapshot.revisions["catalogs/documents.json"],
    "documents/script.md": snapshot.revisions["documents/script.md"],
  })
  const assetDelete = completeToonWorkspaceClientCommand({ ...envelope, kind: "asset.delete", assetId: "asset-1", destructive: true }, snapshot)
  assert.deepEqual(assetDelete.expectedRevisions, {
    "toon-project.json": snapshot.revisions["toon-project.json"],
    "catalogs/assets.json": snapshot.revisions["catalogs/assets.json"],
    "assets/frame.png": hash,
    ".toon-trash/assets/asset-1/frame.png": null,
  })
  const staleDocument = completeToonWorkspaceClientCommand({ ...envelope, expectedRevisions: { "documents/script.md": "f".repeat(64) }, kind: "document.write", documentId: "doc-1", content: "next" }, snapshot)
  assert.equal(staleDocument.expectedRevisions["documents/script.md"], "f".repeat(64))
})

test("media submission accepts only a server-issued authorization ID bound to the displayed plan", () => {
  assert.deepEqual(toonMediaJobSubmitRequestSchema.parse({ authorizationId: "authorization-1", expectedPlanFingerprint: hash }), { authorizationId: "authorization-1", expectedPlanFingerprint: hash })
  assert.equal(toonMediaJobSubmitRequestSchema.safeParse({ authorizationId: "authorization-1", authorization: { id: "forged", scopeHash: hash, authorizedAt: now } }).success, false)
  assert.equal(toonMediaJobSubmitRequestSchema.safeParse({ requestId: "client-plan", authorization: { id: "forged", scopeHash: hash, authorizedAt: now } }).success, false)
})

test("canvas autosave commands and lease responses carry server-issued fencing values", () => {
  const command = toonWorkspaceCommandSchema.parse({
    kind: "canvas.write",
    operationId: "operation-lease",
    actor: { kind: "human" },
    origin: "autosave",
    expectedRevisions: { "canvases/main.json": hash },
    canvasId: "main",
    body: bundle().canvasFiles["canvases/main.json"],
    leaseToken: "lease-token",
    leaseGeneration: 2,
  })
  assert.equal(command.kind === "canvas.write" && command.leaseToken, "lease-token")
  assert.deepEqual(toonCanvasLeaseResponseSchema.parse({ leaseId: "editor-1", canvasId: "main", leaseToken: "lease-token", generation: 2, expiresAt: 10 }), {
    leaseId: "editor-1", canvasId: "main", leaseToken: "lease-token", generation: 2, expiresAt: 10,
  })
})

import { z } from "zod"
import {
  toonEdgeSchema,
  toonHandleSchema,
  toonIdentifierSchema,
  toonModelReferenceSchema,
  toonMediaGenerationPlanSchema,
  toonNodeKindSchema,
  toonProjectRelativePathSchema,
  toonRevisionSchema,
  toonViewportSchema,
  toonWorkflowGeneratedResultSchema,
  toonWorkflowStageRecordSchema,
  toonWorkflowStageSchema,
  toonWorkflowStatusSchema,
  toonContentApprovalSchema,
  toonComputeAuthorizationSchema,
  toonResultAdoptionSchema,
  toonWorkflowVersionSchema,
} from "./toon-factory.js"

export const TOON_WORKSPACE_SCHEMA_VERSION = 2 as const

export const TOON_CANONICAL_WORKFLOW_STAGES = [
  "content-script",
  "assets",
  "directing-storyboard",
  "images",
  "videos",
  "adoption-delivery",
] as const

export const TOON_CANONICAL_WORKFLOW_STEPS = [
  { id: "source-material", stage: "content-script", title: "Source material", dependencies: [] },
  { id: "episode-script", stage: "content-script", title: "Episode script", dependencies: ["source-material"] },
  { id: "asset-plan", stage: "assets", title: "Asset plan", dependencies: ["episode-script"] },
  { id: "direction", stage: "directing-storyboard", title: "Direction", dependencies: ["episode-script", "asset-plan"] },
  { id: "storyboard", stage: "directing-storyboard", title: "Storyboard", dependencies: ["direction"] },
  { id: "image-candidates", stage: "images", title: "Image candidates", dependencies: ["storyboard", "asset-plan"] },
  { id: "video-clips", stage: "videos", title: "Video clips", dependencies: ["image-candidates", "storyboard"] },
  { id: "adopt-clips", stage: "adoption-delivery", title: "Adopt clips", dependencies: ["video-clips"] },
  { id: "delivery-manifest", stage: "adoption-delivery", title: "Delivery manifest", dependencies: ["adopt-clips"] },
] as const satisfies ReadonlyArray<{
  id: string
  stage: z.infer<typeof toonWorkflowStageSchema>
  title: string
  dependencies: readonly string[]
}>

const boundedString = (max: number) => z.string().trim().min(1).max(max)
const timestampSchema = z.string().datetime()
const mimeTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i)

const forbiddenPortableKey = /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|session[_-]?id|runtime[_-]?id|sqlite[_-]?id|database[_-]?id|row[_-]?id|lease[_-]?id|provider[_-]?(?:config|options))$/i
const absolutePortablePath = /^(?:\/|[A-Za-z]:[\\/]|file:\/\/)/

function inspectPortableValue(value: unknown, ctx: z.RefinementCtx, path: PropertyKey[] = []): void {
  if (typeof value === "string" && absolutePortablePath.test(value)) {
    ctx.addIssue({ code: "custom", path, message: "Portable data cannot contain an absolute path" })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => inspectPortableValue(child, ctx, [...path, index]))
    return
  }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbiddenPortableKey.test(key)) {
      ctx.addIssue({ code: "custom", path: [...path, key], message: "Runtime identity and credentials are not portable" })
    } else {
      inspectPortableValue(child, ctx, [...path, key])
    }
  }
}

export const toonPortableEntityKindSchema = z.enum([
  "project",
  "canvas-folder",
  "canvas",
  "node",
  "document",
  "asset",
  "workflow",
  "generation",
  "adoption",
])

export const toonPortableReferenceSchema = z.object({
  kind: toonPortableEntityKindSchema,
  id: toonIdentifierSchema,
  revision: toonRevisionSchema.optional(),
}).strict()

export const toonWorkflowDependencyLinkSchema = z.object({
  target: toonPortableReferenceSchema.refine(
    (reference) => ["canvas", "node", "document", "asset", "workflow", "generation", "adoption"].includes(reference.kind),
    "Expected a revisioned workflow dependency",
  ),
  revision: toonRevisionSchema,
}).strict()

const toonWorkspaceGenerationPlanSchema = z.object({
  kind: z.enum(["image", "video"]),
  model: toonModelReferenceSchema,
  object: boundedString(500),
  quantity: z.number().int().positive().max(100),
  prompt: boundedString(100_000),
  references: z.array(toonPortableReferenceSchema.refine((reference) => reference.kind === "asset", "Generation references must be assets")).max(16),
  parameters: z.record(z.string(), z.unknown()),
  executionCount: z.number().int().positive().max(16),
  knownCost: z.object({ amount: z.number().nonnegative(), currency: boundedString(20) }).strict().nullable(),
}).strict().superRefine((plan, ctx) => {
  inspectPortableValue(plan, ctx)
  if (plan.model.kind !== plan.kind) ctx.addIssue({ code: "custom", path: ["model", "kind"], message: `Expected a ${plan.kind} model reference` })
  if (plan.quantity !== plan.executionCount) ctx.addIssue({ code: "custom", path: ["quantity"], message: "Quantity must equal executionCount" })
})

export const toonWorkspaceGenerationCandidateSchema = z.object({
  id: toonIdentifierSchema,
  ordinal: z.number().int().positive(),
  status: z.enum(["queued", "submitting", "running", "awaiting-review", "adopted", "rejected", "failed", "cancelled", "submission_unknown"]),
  progress: z.number().min(0).max(100).optional(),
  assetId: toonIdentifierSchema.optional(),
  mimeType: mimeTypeSchema.optional(),
  bytes: z.number().int().positive().optional(),
  checksum: toonRevisionSchema.optional(),
  error: z.object({ code: boundedString(200), message: boundedString(4_000), retryable: z.boolean() }).strict().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonWorkspaceGenerationRecordSchema = z.object({
  id: toonIdentifierSchema,
  requestId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  nodeId: toonIdentifierSchema,
  source: z.enum(["canvas", "assistant"]),
  plan: toonWorkspaceGenerationPlanSchema,
  requestHash: toonRevisionSchema,
  revision: toonRevisionSchema,
  status: z.enum(["awaiting-human-authorization", "queued", "submitting", "running", "awaiting-review", "adopted", "failed", "cancelled", "submission_unknown"]),
  dependencyLinks: z.array(toonWorkflowDependencyLinkSchema).max(10_000),
  authorization: z.object({
    id: toonIdentifierSchema,
    scopeHash: toonRevisionSchema,
    authorizedAt: timestampSchema,
    invalidatedAt: timestampSchema.optional(),
  }).strict().optional(),
  candidates: z.array(toonWorkspaceGenerationCandidateSchema).max(16),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonWorkspaceAdoptionRecordSchema = z.object({
  id: toonIdentifierSchema,
  generationId: toonIdentifierSchema,
  candidateId: toonIdentifierSchema,
  assetId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  nodeId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  revision: toonRevisionSchema,
  adoptedAt: timestampSchema,
  supersededAt: timestampSchema.optional(),
}).strict()

export const toonProjectMetadataV2Schema = z.object({
  id: toonIdentifierSchema,
  name: boundedString(500),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonWorkspaceGeneratedResultSchema = toonWorkflowGeneratedResultSchema.omit({ jobId: true }).strict()
export const toonWorkspaceWorkflowStepSchema = z.object({
  id: toonIdentifierSchema,
  stage: toonWorkflowStageSchema,
  title: boundedString(500),
  status: toonWorkflowStatusSchema,
  dependencies: z.array(toonIdentifierSchema).max(100),
  dependencyLinks: z.array(toonWorkflowDependencyLinkSchema).max(10_000).default([]),
  inputRevision: toonRevisionSchema.optional(),
  outputRevision: toonRevisionSchema.optional(),
  skipReason: boundedString(2_000).optional(),
  staleReason: boundedString(2_000).optional(),
  contentApprovals: z.array(toonContentApprovalSchema).max(1_000),
  computeAuthorizations: z.array(toonComputeAuthorizationSchema).max(1_000),
  resultAdoptions: z.array(toonResultAdoptionSchema).max(10_000),
  history: z.array(toonWorkflowVersionSchema).max(10_000),
  generationRefs: z.array(toonPortableReferenceSchema.refine((ref) => ref.kind === "generation", "Expected a generation reference")).max(10_000).optional(),
  generatedResults: z.array(toonWorkspaceGeneratedResultSchema).max(10_000).optional(),
  updatedAt: timestampSchema,
}).strict()
export const toonWorkspaceEpisodeSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  ordinal: z.number().int().nonnegative(),
  canvasId: toonIdentifierSchema,
  stages: z.array(toonWorkflowStageRecordSchema).max(100),
  steps: z.array(toonWorkspaceWorkflowStepSchema).max(1_000).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonCatalogReferencesSchema = z.object({
  canvases: toonProjectRelativePathSchema.refine((path) => path === "catalogs/canvases.json"),
  documents: toonProjectRelativePathSchema.refine((path) => path === "catalogs/documents.json"),
  assets: toonProjectRelativePathSchema.refine((path) => path === "catalogs/assets.json"),
}).strict()

export const toonWorkspaceProjectSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  metadata: toonProjectMetadataV2Schema,
  catalogs: toonCatalogReferencesSchema,
  activeCanvasId: toonIdentifierSchema.optional(),
  modelDefaults: z.object({
    text: toonModelReferenceSchema.optional(),
    image: toonModelReferenceSchema.optional(),
    video: toonModelReferenceSchema.optional(),
  }).strict().optional(),
  workflow: z.object({
    episodes: z.array(toonWorkspaceEpisodeSchema).max(10_000),
    generations: z.array(toonWorkspaceGenerationRecordSchema).max(100_000).default([]),
    adoptions: z.array(toonWorkspaceAdoptionRecordSchema).max(100_000).default([]),
  }).strict(),
  migration: z.object({
    sourceVersion: z.literal(1),
    migratedAt: timestampSchema,
    backupManifestRef: toonProjectRelativePathSchema,
    v2EditedAt: timestampSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((project, ctx) => {
  inspectPortableValue(project, ctx)
  for (const kind of ["text", "image", "video"] as const) {
    const model = project.modelDefaults?.[kind]
    if (model && model.kind !== kind) ctx.addIssue({ code: "custom", path: ["modelDefaults", kind, "kind"], message: `Expected a ${kind} model reference` })
  }
})

export const toonCanvasFolderDescriptorSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  order: z.number().int().nonnegative(),
  state: z.enum(["active", "trashed"]),
}).strict()

export const toonCanvasDescriptorSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  kind: z.enum(["freeform", "episode", "storyboard"]),
  folderId: toonIdentifierSchema.optional(),
  order: z.number().int().nonnegative(),
  file: toonProjectRelativePathSchema.refine((path) => path.startsWith("canvases/") && path.endsWith(".json")),
  revision: toonRevisionSchema,
  state: z.enum(["active", "trashed"]),
}).strict()

export const toonCanvasCatalogSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  projectId: toonIdentifierSchema,
  folders: z.array(toonCanvasFolderDescriptorSchema).max(10_000),
  canvases: z.array(toonCanvasDescriptorSchema).max(10_000),
}).strict().superRefine((catalog, ctx) => {
  inspectPortableValue(catalog, ctx)
  const folders = new Set<string>()
  catalog.folders.forEach((folder, index) => {
    if (folders.has(folder.id)) ctx.addIssue({ code: "custom", path: ["folders", index, "id"], message: `Duplicate canvas folder id: ${folder.id}` })
    folders.add(folder.id)
  })
  const canvases = new Set<string>()
  const paths = new Set<string>()
  catalog.canvases.forEach((canvas, index) => {
    if (canvases.has(canvas.id)) ctx.addIssue({ code: "custom", path: ["canvases", index, "id"], message: `Duplicate canvas id: ${canvas.id}` })
    if (paths.has(canvas.file)) ctx.addIssue({ code: "custom", path: ["canvases", index, "file"], message: `Duplicate canvas path: ${canvas.file}` })
    if (canvas.folderId && !folders.has(canvas.folderId)) ctx.addIssue({ code: "custom", path: ["canvases", index, "folderId"], message: `Missing canvas folder: ${canvas.folderId}` })
    canvases.add(canvas.id)
    paths.add(canvas.file)
  })
})

export const toonDocumentKindSchema = z.enum(["markdown", "text", "json", "preview"])
const blockedDocumentPathSegment = /^(?:generated|node_modules|\.git|\.toon-history|\.toon-journal|\.toon-trash|\.toon-backups|secrets)$/i
const unsafeDocumentFilename = /^(?:\.env|id_rsa|id_ed25519|credentials?)(?:\.|$)/i
const safeDocumentPath = (path: string) => path.startsWith("documents/")
  && !path.split("/").some((part) => blockedDocumentPathSegment.test(part) || unsafeDocumentFilename.test(part))
export const toonDocumentFolderDescriptorSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  path: toonProjectRelativePathSchema.refine(safeDocumentPath, "Document folders must use a safe project document path"),
  state: z.enum(["active", "trashed"]),
}).strict()
export const toonDocumentDescriptorSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  path: toonProjectRelativePathSchema.refine(safeDocumentPath, "Documents must use a safe project document path"),
  kind: toonDocumentKindSchema,
  mimeType: mimeTypeSchema,
  revision: toonRevisionSchema,
  state: z.enum(["active", "trashed"]),
  updatedAt: timestampSchema,
}).strict()

export const toonDocumentCatalogSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  projectId: toonIdentifierSchema,
  folders: z.array(toonDocumentFolderDescriptorSchema).max(10_000).optional(),
  documents: z.array(toonDocumentDescriptorSchema).max(100_000),
}).strict().superRefine((catalog, ctx) => {
  inspectPortableValue(catalog, ctx)
  validateUniqueEntities(catalog.folders ?? [], ctx, "folders")
  validateUniqueEntities(catalog.documents, ctx, "documents")
})

export const toonAssetOriginSchema = z.enum(["imported", "generated", "document", "migration"])
export const toonAssetDescriptorSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  path: toonProjectRelativePathSchema.refine((path) => path.startsWith("assets/")),
  mimeType: mimeTypeSchema,
  bytes: z.number().int().nonnegative(),
  checksum: toonRevisionSchema,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationSeconds: z.number().positive().optional(),
  origin: toonAssetOriginSchema,
  state: z.enum(["active", "trashed", "tombstone"]),
  trashPath: toonProjectRelativePathSchema.refine((path) => path.startsWith(".toon-trash/assets/")).optional(),
  trashedAt: timestampSchema.optional(),
  tombstonedAt: timestampSchema.optional(),
  references: z.array(toonPortableReferenceSchema).max(100_000),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonAssetCatalogSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  projectId: toonIdentifierSchema,
  assets: z.array(toonAssetDescriptorSchema).max(100_000),
}).strict().superRefine((catalog, ctx) => {
  inspectPortableValue(catalog, ctx)
  validateUniqueEntities(catalog.assets, ctx, "assets")
})

const portableParametersSchema = z.record(z.string(), z.unknown()).superRefine((parameters, ctx) => inspectPortableValue(parameters, ctx))

export const toonNodeConfigurationSchema = z.object({
  label: boundedString(500).optional(),
  content: toonPortableReferenceSchema.refine((ref) => ref.kind === "document", "Expected a document reference").optional(),
  asset: toonPortableReferenceSchema.refine((ref) => ref.kind === "asset", "Expected an asset reference").optional(),
  model: toonModelReferenceSchema.optional(),
  generation: toonPortableReferenceSchema.refine((ref) => ref.kind === "generation", "Expected a generation reference").optional(),
  references: z.array(toonPortableReferenceSchema).max(10_000).optional(),
  parameters: portableParametersSchema.optional(),
}).strict().superRefine((config, ctx) => inspectPortableValue(config, ctx))

export const toonWorkspaceNodeSchema = z.object({
  id: toonIdentifierSchema,
  kind: toonNodeKindSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  parentGroupId: toonIdentifierSchema.optional(),
  zIndex: z.number().int().min(-10_000).max(10_000).optional(),
  handles: z.array(toonHandleSchema).max(100),
  config: toonNodeConfigurationSchema,
}).strict()

export const toonCanvasGroupSchema = z.object({
  id: toonIdentifierSchema,
  title: boundedString(500),
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  parentGroupId: toonIdentifierSchema.optional(),
  zIndex: z.number().int().min(-10_000).max(10_000).optional(),
}).strict()

export const toonWorkspaceCanvasSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  id: toonIdentifierSchema,
  revisionId: toonIdentifierSchema.optional(),
  nodes: z.array(toonWorkspaceNodeSchema).max(10_000),
  edges: z.array(toonEdgeSchema).max(50_000),
  groups: z.array(toonCanvasGroupSchema).max(10_000).optional(),
  viewport: toonViewportSchema,
}).strict().superRefine((canvas, ctx) => {
  inspectPortableValue(canvas, ctx)
  const nodeIds = new Set<string>()
  canvas.nodes.forEach((node, nodeIndex) => {
    if (nodeIds.has(node.id)) ctx.addIssue({ code: "custom", path: ["nodes", nodeIndex, "id"], message: `Duplicate node id: ${node.id}` })
    nodeIds.add(node.id)
  })
  const nodes = new Map(canvas.nodes.map((node) => [node.id, node]))
  const groupIds = new Set<string>()
  ;(canvas.groups ?? []).forEach((group, groupIndex) => {
    if (groupIds.has(group.id)) ctx.addIssue({ code: "custom", path: ["groups", groupIndex, "id"], message: `Duplicate group id: ${group.id}` })
    groupIds.add(group.id)
  })
  const groups = new Map((canvas.groups ?? []).map((group) => [group.id, group]))
  ;(canvas.groups ?? []).forEach((group, groupIndex) => {
    if (group.parentGroupId && !groups.has(group.parentGroupId)) ctx.addIssue({ code: "custom", path: ["groups", groupIndex, "parentGroupId"], message: `Missing parent group: ${group.parentGroupId}` })
    if (group.parentGroupId === group.id) ctx.addIssue({ code: "custom", path: ["groups", groupIndex, "parentGroupId"], message: "A group cannot contain itself" })
  })
  canvas.nodes.forEach((node, nodeIndex) => {
    if (node.parentGroupId && !groups.has(node.parentGroupId)) ctx.addIssue({ code: "custom", path: ["nodes", nodeIndex, "parentGroupId"], message: `Missing parent group: ${node.parentGroupId}` })
  })
  for (const group of groups.values()) {
    const ancestors = new Set([group.id])
    let parent = group.parentGroupId
    while (parent) {
      if (ancestors.has(parent)) {
        ctx.addIssue({ code: "custom", path: ["groups"], message: `Cyclic group nesting: ${group.id}` })
        break
      }
      ancestors.add(parent)
      parent = groups.get(parent)?.parentGroupId
    }
  }
  canvas.edges.forEach((edge, edgeIndex) => {
    const source = nodes.get(edge.sourceNodeId)
    const target = nodes.get(edge.targetNodeId)
    const sourceHandle = source?.handles.find((handle) => handle.id === edge.sourceHandleId && handle.direction === "source")
    const targetHandle = target?.handles.find((handle) => handle.id === edge.targetHandleId && handle.direction === "target")
    if (!sourceHandle) ctx.addIssue({ code: "custom", path: ["edges", edgeIndex, "sourceHandleId"], message: "Missing source node or handle" })
    if (!targetHandle) ctx.addIssue({ code: "custom", path: ["edges", edgeIndex, "targetHandleId"], message: "Missing target node or handle" })
    if (sourceHandle && targetHandle && sourceHandle.dataType !== "any" && targetHandle.dataType !== "any" && sourceHandle.dataType !== targetHandle.dataType) {
      ctx.addIssue({ code: "custom", path: ["edges", edgeIndex], message: `Incompatible handle types: ${sourceHandle.dataType} -> ${targetHandle.dataType}` })
    }
  })
})

export const toonPortableProjectBundleSchema = z.object({
  project: toonWorkspaceProjectSchema,
  canvases: toonCanvasCatalogSchema,
  documents: toonDocumentCatalogSchema,
  assets: toonAssetCatalogSchema,
  canvasFiles: z.record(toonProjectRelativePathSchema, toonWorkspaceCanvasSchema),
}).strict().superRefine((bundle, ctx) => {
  inspectPortableValue(bundle, ctx)
  const projectId = bundle.project.metadata.id
  for (const [catalogName, catalog] of [["canvases", bundle.canvases], ["documents", bundle.documents], ["assets", bundle.assets]] as const) {
    if (catalog.projectId !== projectId) ctx.addIssue({ code: "custom", path: [catalogName, "projectId"], message: "Catalog project ID does not match root metadata" })
  }
  const ids = new Map<string, Set<string>>([
    ["project", new Set([projectId])],
    ["canvas-folder", new Set(bundle.canvases.folders.map((item) => item.id))],
    ["canvas", new Set(bundle.canvases.canvases.map((item) => item.id))],
    ["document", new Set(bundle.documents.documents.map((item) => item.id))],
    ["asset", new Set(bundle.assets.assets.map((item) => item.id))],
    ["workflow", new Set(bundle.project.workflow.episodes.flatMap((episode) => episode.steps?.flatMap((step) => [step.id, `${episode.id}.${step.id}`]) ?? []))],
    ["generation", new Set([...bundle.project.workflow.generations.map((record) => record.id), ...bundle.project.workflow.episodes.flatMap((episode) => episode.steps?.flatMap((step) => [...(step.generationRefs?.map((ref) => ref.id) ?? []), ...(step.generatedResults?.map((result) => result.id) ?? [])]) ?? [])])],
    ["adoption", new Set([...bundle.project.workflow.adoptions.map((record) => record.id), ...bundle.project.workflow.episodes.flatMap((episode) => episode.steps?.flatMap((step) => step.resultAdoptions.map((item) => item.id)) ?? [])])],
  ])
  const workflowTuples = new Set(bundle.project.workflow.episodes.flatMap((episode) => episode.steps?.map((step) => `${episode.id}.${step.id}`) ?? []))
  ids.set("node", new Set(Object.values(bundle.canvasFiles).flatMap((canvas) => canvas.nodes.map((node) => node.id))))
  const spatialIds = new Set<string>()
  const spatialLocations = new Map<string, string>()
  Object.entries(bundle.canvasFiles).forEach(([path, canvas]) => {
    canvas.nodes.forEach((node, index) => {
      if (spatialIds.has(node.id)) ctx.addIssue({ code: "custom", path: ["canvasFiles", path, "nodes", index, "id"], message: `Project-wide node/group id collision: ${node.id} (already used at ${spatialLocations.get(node.id)})` })
      else {
        spatialIds.add(node.id)
        spatialLocations.set(node.id, `${path}:node`)
      }
    })
    ;(canvas.groups ?? []).forEach((group, index) => {
      if (spatialIds.has(group.id)) ctx.addIssue({ code: "custom", path: ["canvasFiles", path, "groups", index, "id"], message: `Project-wide node/group id collision: ${group.id} (already used at ${spatialLocations.get(group.id)})` })
      else {
        spatialIds.add(group.id)
        spatialLocations.set(group.id, `${path}:group`)
      }
    })
  })
  const references: Array<{ reference: z.infer<typeof toonPortableReferenceSchema>; path: PropertyKey[] }> = []
  bundle.canvases.canvases.forEach((descriptor, index) => {
    const canvas = bundle.canvasFiles[descriptor.file]
    if (!canvas) ctx.addIssue({ code: "custom", path: ["canvases", "canvases", index, "file"], message: `Missing canvas file: ${descriptor.file}` })
    else if (canvas.id !== descriptor.id) ctx.addIssue({ code: "custom", path: ["canvasFiles", descriptor.file, "id"], message: "Canvas ID does not match its descriptor" })
  })
  Object.entries(bundle.canvasFiles).forEach(([path, canvas]) => canvas.nodes.forEach((node, nodeIndex) => {
    const nodeReferences = [node.config.content, node.config.asset, node.config.generation, ...(node.config.references ?? [])].filter((item): item is z.infer<typeof toonPortableReferenceSchema> => Boolean(item))
    nodeReferences.forEach((reference, refIndex) => references.push({ reference, path: ["canvasFiles", path, "nodes", nodeIndex, "config", "references", refIndex] }))
  }))
  bundle.assets.assets.forEach((asset, assetIndex) => asset.references.forEach((reference, refIndex) => references.push({ reference, path: ["assets", "assets", assetIndex, "references", refIndex] })))
  if (bundle.project.activeCanvasId && !ids.get("canvas")!.has(bundle.project.activeCanvasId)) ctx.addIssue({ code: "custom", path: ["project", "activeCanvasId"], message: "Active canvas does not exist" })
  bundle.project.workflow.episodes.forEach((episode, index) => {
    if (!ids.get("canvas")!.has(episode.canvasId)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "episodes", index, "canvasId"], message: `Dangling canvas reference: ${episode.canvasId}` })
    const stepIds = new Set<string>()
    episode.steps?.forEach((step, stepIndex) => {
      if (stepIds.has(step.id)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "episodes", index, "steps", stepIndex, "id"], message: `Duplicate workflow tuple: ${episode.id}:${step.id}` })
      stepIds.add(step.id)
    })
    episode.steps?.forEach((step, stepIndex) => step.dependencyLinks.forEach((link, linkIndex) => references.push({ reference: link.target, path: ["project", "workflow", "episodes", index, "steps", stepIndex, "dependencyLinks", linkIndex] })))
  })
  const episodeIds = new Set<string>()
  bundle.project.workflow.episodes.forEach((episode, index) => {
    if (episodeIds.has(episode.id)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "episodes", index, "id"], message: `Duplicate workflow episode id: ${episode.id}` })
    episodeIds.add(episode.id)
  })
  bundle.project.workflow.generations.forEach((generation, index) => {
    if (!ids.get("canvas")!.has(generation.canvasId)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "generations", index, "canvasId"], message: `Dangling canvas reference: ${generation.canvasId}` })
    if (!ids.get("node")!.has(generation.nodeId)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "generations", index, "nodeId"], message: `Dangling node reference: ${generation.nodeId}` })
    if (!workflowTuples.has(`${generation.episodeId}.${generation.workflowRecordId}`)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "generations", index, "workflowRecordId"], message: `Dangling workflow reference: ${generation.episodeId}:${generation.workflowRecordId}` })
    generation.plan.references.forEach((reference, refIndex) => references.push({ reference, path: ["project", "workflow", "generations", index, "plan", "references", refIndex] }))
    generation.dependencyLinks.forEach((link, linkIndex) => references.push({ reference: link.target, path: ["project", "workflow", "generations", index, "dependencyLinks", linkIndex] }))
    generation.candidates.forEach((candidate, candidateIndex) => {
      if (candidate.assetId && !ids.get("asset")!.has(candidate.assetId)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "generations", index, "candidates", candidateIndex, "assetId"], message: `Dangling asset reference: ${candidate.assetId}` })
    })
  })
  bundle.project.workflow.adoptions.forEach((adoption, index) => {
    for (const [kind, id] of [["generation", adoption.generationId], ["asset", adoption.assetId], ["canvas", adoption.canvasId], ["node", adoption.nodeId]] as const) {
      if (!ids.get(kind)!.has(id)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "adoptions", index, `${kind}Id`], message: `Dangling ${kind} reference: ${id}` })
    }
    if (!workflowTuples.has(`${adoption.episodeId}.${adoption.workflowRecordId}`)) ctx.addIssue({ code: "custom", path: ["project", "workflow", "adoptions", index, "workflowRecordId"], message: `Dangling workflow reference: ${adoption.episodeId}:${adoption.workflowRecordId}` })
  })
  references.forEach(({ reference, path }) => {
    const known = ids.get(reference.kind)
    if (known && !known.has(reference.id)) ctx.addIssue({ code: "custom", path, message: `Dangling ${reference.kind} reference: ${reference.id}` })
  })
})

function validateUniqueEntities(items: readonly { id: string; path: string }[], ctx: z.RefinementCtx, key: string): void {
  const ids = new Set<string>()
  const paths = new Set<string>()
  items.forEach((item, index) => {
    if (ids.has(item.id)) ctx.addIssue({ code: "custom", path: [key, index, "id"], message: `Duplicate id: ${item.id}` })
    if (paths.has(item.path)) ctx.addIssue({ code: "custom", path: [key, index, "path"], message: `Duplicate path: ${item.path}` })
    ids.add(item.id)
    paths.add(item.path)
  })
}

export const toonSchemaDiagnosticSchema = z.object({
  code: boundedString(200),
  path: z.array(z.union([z.string(), z.number()])),
  message: boundedString(4_000),
}).strict()

export const toonPortableValidationResponseSchema = z.object({
  valid: z.boolean(),
  diagnostics: z.array(toonSchemaDiagnosticSchema),
}).strict()

export function validateToonPortableProject(value: unknown): z.infer<typeof toonPortableValidationResponseSchema> {
  const parsed = toonPortableProjectBundleSchema.safeParse(value)
  if (parsed.success) return { valid: true, diagnostics: [] }
  return {
    valid: false,
    diagnostics: parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part), message: issue.message })),
  }
}

export const toonMigrationJournalStateSchema = z.enum(["prepared", "committing", "committed", "rolled_back", "failed"])
export const toonMigrationBackupEntrySchema = z.object({
  path: toonProjectRelativePathSchema,
  backupPath: toonProjectRelativePathSchema,
  revision: toonRevisionSchema,
  bytes: z.number().int().nonnegative(),
}).strict()
export const toonMigrationBackupManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectId: toonIdentifierSchema,
  operationId: toonIdentifierSchema,
  createdAt: timestampSchema,
  entries: z.array(toonMigrationBackupEntrySchema),
  rollbackEligible: z.boolean(),
}).strict()
export const toonMigrationPreflightSchema = z.object({
  sourceVersion: z.literal(1),
  targetVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  projectId: toonIdentifierSchema,
  projectRevision: toonRevisionSchema,
  changedFiles: z.array(toonProjectRelativePathSchema),
  unsupportedContent: z.array(z.object({ path: toonProjectRelativePathSchema, reason: boundedString(2_000) }).strict()),
  requiredBytes: z.number().int().nonnegative(),
  backupLocation: toonProjectRelativePathSchema,
  rollbackEligible: z.boolean(),
  rollbackLimits: z.array(boundedString(2_000)),
}).strict()
export const toonMigrationApplyRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  confirmed: z.literal(true),
  actor: z.object({ kind: z.enum(["human", "assistant", "system"]), id: boundedString(512).optional() }).strict(),
}).strict()

export const toonCommandActorSchema = z.object({
  kind: z.enum(["human", "assistant", "system"]),
  id: boundedString(512).optional(),
}).strict()
export const toonCommandOriginSchema = z.enum(["human-ui", "autosave", "migration", "assistant-tool", "recovery"])
export const toonExpectedRevisionsSchema = z.record(toonProjectRelativePathSchema, toonRevisionSchema.nullable())
const commandEnvelope = {
  operationId: toonIdentifierSchema,
  actor: toonCommandActorSchema,
  origin: toonCommandOriginSchema,
  expectedRevisions: toonExpectedRevisionsSchema,
}

const command = <const K extends string, T extends z.ZodRawShape>(kind: K, payload: T) => z.object({ ...commandEnvelope, kind: z.literal(kind), ...payload }).strict()
export const toonWorkspaceCommandSchema = z.discriminatedUnion("kind", [
  command("project.update", { name: boundedString(500).optional(), activeCanvasId: toonIdentifierSchema.optional(), modelDefaults: toonWorkspaceProjectSchema.shape.modelDefaults.optional() }),
  command("folder.create", { folder: toonCanvasFolderDescriptorSchema }),
  command("folder.rename", { folderId: toonIdentifierSchema, title: boundedString(500) }),
  command("folder.reorder", { folderIds: z.array(toonIdentifierSchema) }),
  command("folder.delete", { folderId: toonIdentifierSchema, recursive: z.boolean().default(false) }),
  command("folder.restore", { folderId: toonIdentifierSchema }),
  command("canvas.create", { canvas: toonCanvasDescriptorSchema.omit({ revision: true }), body: toonWorkspaceCanvasSchema }),
  command("canvas.rename", { canvasId: toonIdentifierSchema, title: boundedString(500) }),
  command("canvas.reorder", { canvasIds: z.array(toonIdentifierSchema), folderId: toonIdentifierSchema.optional() }),
  command("canvas.move", { canvasId: toonIdentifierSchema, folderId: toonIdentifierSchema.nullable(), order: z.number().int().nonnegative() }),
  command("canvas.duplicate", { canvasId: toonIdentifierSchema, newCanvasId: toonIdentifierSchema, title: boundedString(500) }),
  command("canvas.delete", { canvasId: toonIdentifierSchema }),
  command("canvas.restore", { canvasId: toonIdentifierSchema }),
  command("canvas.write", {
    canvasId: toonIdentifierSchema,
    body: toonWorkspaceCanvasSchema,
    leaseToken: boundedString(256).optional(),
    leaseGeneration: z.number().int().positive().optional(),
  }),
  command("document.create", { document: toonDocumentDescriptorSchema.omit({ revision: true, updatedAt: true }), content: z.string().max(20_000_000) }),
  command("document.write", { documentId: toonIdentifierSchema, content: z.string().max(20_000_000) }),
  command("document.rename", { documentId: toonIdentifierSchema, title: boundedString(500), path: toonProjectRelativePathSchema.optional() }),
  command("document.copy", { documentId: toonIdentifierSchema, newDocumentId: toonIdentifierSchema, title: boundedString(500), path: toonProjectRelativePathSchema }),
  command("document.delete", { documentId: toonIdentifierSchema }),
  command("document.restore", { documentId: toonIdentifierSchema }),
  command("document.folder.create", { folder: toonDocumentFolderDescriptorSchema }),
  command("document.folder.rename", { folderId: toonIdentifierSchema, title: boundedString(500), path: toonProjectRelativePathSchema }),
  command("document.folder.delete", { folderId: toonIdentifierSchema, recursive: z.boolean().default(false) }),
  command("document.folder.restore", { folderId: toonIdentifierSchema }),
  command("asset.register", { asset: toonAssetDescriptorSchema, contentBase64: z.string().max(180_000_000) }),
  command("asset.import", {
    assetId: toonIdentifierSchema,
    filename: z.string().trim().min(1).max(255),
    declaredMimeType: mimeTypeSchema.optional(),
    assetOrigin: toonAssetOriginSchema.default("imported"),
    contentBase64: z.string().max(180_000_000),
    canvas: z.object({ id: toonIdentifierSchema, position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict() }).strict().optional(),
  }),
  command("asset.update", { assetId: toonIdentifierSchema, title: boundedString(500).optional(), references: z.array(toonPortableReferenceSchema).optional() }),
  command("asset.delete", { assetId: toonIdentifierSchema, replacementAssetId: toonIdentifierSchema.optional(), destructive: z.boolean().default(false) }),
  command("asset.restore", { assetId: toonIdentifierSchema }),
  command("asset.cleanup", { before: timestampSchema, limit: z.number().int().positive().max(1_000).default(100) }),
  command("content.write", { path: toonProjectRelativePathSchema.refine((path) => path.startsWith("content/")), content: z.string().max(20_000_000) }),
  command("generation.prepare", {
    generation: toonWorkspaceGenerationRecordSchema.omit({ revision: true, authorization: true, candidates: true, createdAt: true, updatedAt: true, status: true, dependencyLinks: true }),
    dependencyLinks: z.array(toonWorkflowDependencyLinkSchema).max(10_000),
  }),
  command("generation.project", {
    generationId: toonIdentifierSchema,
    status: toonWorkspaceGenerationRecordSchema.shape.status.exclude(["awaiting-human-authorization"]),
    candidates: z.array(z.object({
      id: toonIdentifierSchema,
      ordinal: z.number().int().positive(),
      status: toonWorkspaceGenerationCandidateSchema.shape.status,
      progress: z.number().min(0).max(100).optional(),
      artifact: z.object({ path: toonProjectRelativePathSchema, scope: z.enum(["workspace", "project"]), mimeType: mimeTypeSchema, bytes: z.number().int().positive() }).strict().optional(),
      error: toonWorkspaceGenerationCandidateSchema.shape.error.optional(),
      createdAt: timestampSchema,
      updatedAt: timestampSchema,
    }).strict()).max(16),
  }),
  command("workflow.approve", { episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema, outputRevision: toonRevisionSchema, dependencyLinks: z.array(toonWorkflowDependencyLinkSchema).max(10_000) }),
  command("workflow.configure", { episodes: z.array(toonWorkspaceEpisodeSchema).max(10_000) }),
  command("workflow.skip", { episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema, reason: boundedString(2_000) }),
  command("workflow.authorize", { episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema, generationId: toonIdentifierSchema, authorization: toonWorkspaceGenerationRecordSchema.shape.authorization.unwrap() }),
  command("workflow.adopt", { episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema, generationId: toonIdentifierSchema, candidateId: toonIdentifierSchema, adoptionId: toonIdentifierSchema }),
  command("workflow.delivery", { episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema }),
  command("workflow.invalidate", { targets: z.array(toonPortableReferenceSchema).min(1).max(10_000), reason: boundedString(2_000) }),
]).superRefine((value, ctx) => inspectPortableValue(value, ctx))

export const toonProtectedWorkspaceCommandKinds = [
  "workflow.approve",
  "workflow.skip",
  "workflow.authorize",
  "workflow.adopt",
  "workflow.delivery",
] as const

export const toonInternalWorkspaceCommandKinds = [
  "asset.cleanup",
  "generation.project",
  "workflow.configure",
  "workflow.invalidate",
] as const

export const toonDedicatedWorkspaceCommandKinds = [
  ...toonProtectedWorkspaceCommandKinds,
  "asset.register",
  "asset.import",
] as const

export const toonWorkspacePublicCommandKinds = [
  "project.update",
  "folder.create",
  "folder.rename",
  "folder.reorder",
  "folder.delete",
  "folder.restore",
  "canvas.create",
  "canvas.rename",
  "canvas.reorder",
  "canvas.move",
  "canvas.duplicate",
  "canvas.delete",
  "canvas.restore",
  "canvas.write",
  "document.create",
  "document.write",
  "document.rename",
  "document.copy",
  "document.delete",
  "document.restore",
  "document.folder.create",
  "document.folder.rename",
  "document.folder.delete",
  "document.folder.restore",
  "asset.update",
  "asset.delete",
  "asset.restore",
  "content.write",
] as const

type ToonWorkspaceCommandValue = z.infer<typeof toonWorkspaceCommandSchema>
type ToonWorkspacePublicCommandKind = typeof toonWorkspacePublicCommandKinds[number]
type StripServerCommandIdentity<T> = T extends unknown ? Omit<T, "actor" | "origin"> : never
export type ToonWorkspaceClientCommand = StripServerCommandIdentity<Extract<ToonWorkspaceCommandValue, { kind: ToonWorkspacePublicCommandKind }>>

const publicWorkspaceCommandKinds = new Set<string>(toonWorkspacePublicCommandKinds)

export const toonWorkspaceClientCommandSchema = z.any().transform<ToonWorkspaceClientCommand>((value, ctx) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    ctx.addIssue({ code: "custom", message: "Expected a Toon workspace command" })
    return z.NEVER
  }
  const input = value as Record<string, unknown>
  if ("actor" in input || "origin" in input) {
    ctx.addIssue({ code: "custom", message: "Command actor and origin are server-owned" })
    return z.NEVER
  }
  if (!publicWorkspaceCommandKinds.has(String(input.kind))) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: "This command is not available through the public command endpoint" })
    return z.NEVER
  }
  const parsed = toonWorkspaceCommandSchema.safeParse({
    ...input,
    actor: { kind: "human", id: "server-authenticated-principal" },
    origin: input.kind === "canvas.write" ? "autosave" : "human-ui",
  })
  if (!parsed.success) {
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message })
    return z.NEVER
  }
  const { actor: _actor, origin: _origin, ...command } = parsed.data
  return command as ToonWorkspaceClientCommand
})

export const toonWorkflowApproveRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  outputRevision: toonRevisionSchema,
  dependencyLinks: z.array(toonWorkflowDependencyLinkSchema).max(10_000),
}).strict()
export const toonWorkflowSkipRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  reason: boundedString(2_000),
}).strict()
export const toonWorkflowDeliveryRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  episodeId: toonIdentifierSchema,
  workflowRecordId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
}).strict()
export const toonWorkflowEnsureRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  actor: toonCommandActorSchema,
  origin: z.literal("human-ui"),
}).strict()

export const toonGenerationAuthorizationSubmitSchema = z.object({
  authorizationId: toonIdentifierSchema,
  expectedPlanFingerprint: toonRevisionSchema,
}).strict()

export const toonGenerationAuthorizationStateSchema = z.object({
  authorizationId: toonIdentifierSchema,
  requestId: toonIdentifierSchema,
  planFingerprint: toonRevisionSchema,
  planSummary: toonMediaGenerationPlanSchema,
  expiresAt: timestampSchema,
  consumedAt: timestampSchema.nullable(),
  state: z.enum(["valid", "expired", "consumed"]),
}).strict()

export const toonWorkspaceQuerySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project.read") }).strict(),
  z.object({ kind: z.literal("catalogs.read") }).strict(),
  z.object({ kind: z.literal("canvas.read"), canvasId: toonIdentifierSchema }).strict(),
  z.object({ kind: z.literal("document.read"), documentId: toonIdentifierSchema }).strict(),
  z.object({ kind: z.literal("asset.read"), assetId: toonIdentifierSchema }).strict(),
  z.object({ kind: z.literal("asset.search"), query: z.string().trim().max(500).default(""), state: z.enum(["active", "trashed", "tombstone", "all"]).default("active"), mimeGroup: z.enum(["image", "video", "audio", "text", "other", "all"]).default("all") }).strict(),
  z.object({ kind: z.literal("asset.references"), assetId: toonIdentifierSchema }).strict(),
  z.object({ kind: z.literal("content.read"), path: toonProjectRelativePathSchema }).strict(),
  z.object({ kind: z.literal("references.read"), target: toonPortableReferenceSchema }).strict(),
  z.object({ kind: z.literal("generation.read"), generationId: toonIdentifierSchema }).strict(),
])

export const toonWorkspaceProjectReadResponseSchema = z.object({
  kind: z.literal("project.read"),
  project: toonWorkspaceProjectSchema,
  revision: toonRevisionSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
  directory: toonProjectRelativePathSchema,
}).strict()
export const toonWorkspaceCatalogsReadResponseSchema = z.object({
  kind: z.literal("catalogs.read"),
  canvases: toonCanvasCatalogSchema,
  documents: toonDocumentCatalogSchema,
  assets: toonAssetCatalogSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceCanvasReadResponseSchema = z.object({
  kind: z.literal("canvas.read"),
  canvas: toonWorkspaceCanvasSchema,
  descriptor: toonCanvasDescriptorSchema,
  revision: toonRevisionSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceDocumentReadResponseSchema = z.object({
  kind: z.literal("document.read"),
  document: toonDocumentDescriptorSchema,
  content: z.string().max(20_000_000),
  revision: toonRevisionSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceAssetReadResponseSchema = z.object({ kind: z.literal("asset.read"), asset: toonAssetDescriptorSchema, revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema) }).strict()
export const toonAssetReferenceImpactSchema = z.object({
  source: z.enum(["canvas", "document", "workflow", "assistant", "generation", "adoption", "catalog"]),
  id: z.string().trim().min(1).max(512),
  label: z.string().trim().min(1).max(1_000),
  historical: z.boolean(),
}).strict()
export const toonWorkspaceAssetSearchResponseSchema = z.object({ kind: z.literal("asset.search"), items: z.array(toonAssetDescriptorSchema).max(100_000), total: z.number().int().nonnegative(), revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema) }).strict()
export const toonWorkspaceAssetReferencesResponseSchema = z.object({ kind: z.literal("asset.references"), asset: toonAssetDescriptorSchema, impacts: z.array(toonAssetReferenceImpactSchema).max(100_000), revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema) }).strict()
export const toonWorkspaceContentReadResponseSchema = z.object({
  kind: z.literal("content.read"),
  path: toonProjectRelativePathSchema,
  content: z.string().max(20_000_000),
  revision: toonRevisionSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceReferencesReadResponseSchema = z.object({
  kind: z.literal("references.read"),
  target: toonPortableReferenceSchema,
  references: z.array(toonPortableReferenceSchema),
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceGenerationReadResponseSchema = z.object({
  kind: z.literal("generation.read"),
  generation: toonWorkspaceGenerationRecordSchema,
  projectRevision: toonRevisionSchema,
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
}).strict()
export const toonWorkspaceQueryResponseSchema = z.discriminatedUnion("kind", [
  toonWorkspaceProjectReadResponseSchema,
  toonWorkspaceCatalogsReadResponseSchema,
  toonWorkspaceCanvasReadResponseSchema,
  toonWorkspaceDocumentReadResponseSchema,
  toonWorkspaceAssetReadResponseSchema,
  toonWorkspaceAssetSearchResponseSchema,
  toonWorkspaceAssetReferencesResponseSchema,
  toonWorkspaceContentReadResponseSchema,
  toonWorkspaceReferencesReadResponseSchema,
  toonWorkspaceGenerationReadResponseSchema,
])

export const toonWorkspaceProjectSummarySchema = z.object({
  projectId: toonIdentifierSchema,
  name: boundedString(500),
  directory: toonProjectRelativePathSchema,
  revision: toonRevisionSchema,
  updatedAt: timestampSchema,
}).strict()
export const toonWorkspaceProjectListResponseSchema = z.object({
  schemaVersion: z.literal(TOON_WORKSPACE_SCHEMA_VERSION),
  items: z.array(toonWorkspaceProjectSummarySchema),
}).strict()

export const toonWorkspaceProjectOpenRequestSchema = z.object({
  directory: toonProjectRelativePathSchema,
}).strict()
export const toonWorkspaceProjectOpenResponseSchema = z.object({
  project: toonWorkspaceProjectSummarySchema,
  imported: z.literal(false),
}).strict()

export const toonWorkspaceOperationOutcomeSchema = z.object({
  operationId: toonIdentifierSchema,
  payloadHash: toonRevisionSchema,
  status: z.enum(["committed", "rejected", "recovered"]),
  origin: toonCommandOriginSchema,
  actor: toonCommandActorSchema,
  affected: z.array(toonPortableReferenceSchema),
  revisions: z.record(toonProjectRelativePathSchema, toonRevisionSchema),
  result: z.unknown().optional(),
  error: z.object({ code: boundedString(200), message: boundedString(2_000) }).strict().optional(),
  committedAt: timestampSchema,
}).strict().superRefine((outcome, ctx) => inspectPortableValue(outcome, ctx))

export const toonProjectInitializeRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  name: boundedString(500),
  directory: toonProjectRelativePathSchema,
  episodeId: toonIdentifierSchema.optional(),
  actor: toonCommandActorSchema,
  origin: toonCommandOriginSchema.default("human-ui"),
}).strict()

export const toonWorkspaceFeatureExposureSchema = z.object({
  advancedWorkspace: z.boolean(),
  v2Read: z.literal(true),
  v2Export: z.literal(true),
  automaticDowngrade: z.literal(false),
  toonflowImport: z.literal("disabled"),
}).strict()

export const TOON_ASSET_MAX_BYTES = 100 * 1024 * 1024
export const toonAssetImportMetadataSchema = z.object({
  operationId: toonIdentifierSchema,
  assetId: toonIdentifierSchema,
  filename: z.string().trim().min(1).max(255),
  declaredMimeType: mimeTypeSchema.optional(),
  origin: toonAssetOriginSchema.default("imported"),
  actor: toonCommandActorSchema,
  canvas: z.object({
    id: toonIdentifierSchema,
    expectedRevision: toonRevisionSchema,
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  }).strict().optional(),
}).strict()
export const toonAssetAuthorizedImportRequestSchema = toonAssetImportMetadataSchema.extend({ sourcePath: toonProjectRelativePathSchema }).strict()
export const toonAssetImportResultSchema = z.object({
  asset: toonAssetDescriptorSchema,
  reused: z.boolean(),
  nodeId: toonIdentifierSchema.optional(),
}).strict()

export const toonCanvasLeaseRequestSchema = z.object({
  leaseId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  holder: boundedString(512),
  ttlMs: z.number().int().min(5_000).max(120_000),
}).strict()
export const toonCanvasLeaseResponseSchema = z.object({
  leaseId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  leaseToken: boundedString(256),
  generation: z.number().int().positive(),
  expiresAt: z.number().int().nonnegative(),
}).strict()

export const toonCanvasCheckpointCreateRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  title: boundedString(500),
  actor: toonCommandActorSchema,
  origin: toonCommandOriginSchema,
}).strict()
export const toonCanvasCheckpointRestoreRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  checkpointId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  actor: toonCommandActorSchema,
  origin: toonCommandOriginSchema,
}).strict()
export const toonCanvasCheckpointSchema = z.object({
  id: toonIdentifierSchema,
  canvasId: toonIdentifierSchema,
  title: boundedString(500),
  canvasRevision: toonRevisionSchema,
  path: toonProjectRelativePathSchema.refine((path) => path.startsWith(".toon-history/")),
  origin: toonCommandOriginSchema,
  actor: toonCommandActorSchema,
  createdAt: timestampSchema,
}).strict()
export const toonCanvasCheckpointListResponseSchema = z.object({
  items: z.array(toonCanvasCheckpointSchema).max(10_000),
}).strict()

export const toonDocumentRevisionSchema = z.object({
  id: toonIdentifierSchema,
  documentId: toonIdentifierSchema,
  revision: toonRevisionSchema,
  path: toonProjectRelativePathSchema.refine((path) => path.startsWith(".toon-history/documents/")),
  origin: toonCommandOriginSchema,
  actor: toonCommandActorSchema,
  createdAt: timestampSchema,
}).strict()
export const toonDocumentRevisionListResponseSchema = z.object({
  items: z.array(toonDocumentRevisionSchema).max(10_000),
}).strict()
export const toonDocumentRevisionRestoreRequestSchema = z.object({
  operationId: toonIdentifierSchema,
  expectedRevision: toonRevisionSchema,
  actor: toonCommandActorSchema,
  origin: toonCommandOriginSchema,
}).strict()
export const toonDocumentSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(500),
  mode: z.enum(["filename", "content", "all"]).default("all"),
  limit: z.number().int().min(1).max(200).default(100),
  cursor: z.number().int().nonnegative().default(0),
}).strict()
export const toonDocumentSearchResultSchema = z.object({
  documentId: toonIdentifierSchema,
  title: boundedString(500),
  path: toonProjectRelativePathSchema,
  revision: toonRevisionSchema,
  match: z.enum(["filename", "content"]),
  line: z.number().int().positive().optional(),
  from: z.number().int().nonnegative().optional(),
  to: z.number().int().nonnegative().optional(),
  preview: z.string().max(1_000),
}).strict()
export const toonDocumentSearchResponseSchema = z.object({
  items: z.array(toonDocumentSearchResultSchema).max(200),
  scannedFiles: z.number().int().nonnegative(),
  scannedBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  nextCursor: z.number().int().nonnegative().nullable(),
}).strict()

export type ToonWorkspaceProject = z.infer<typeof toonWorkspaceProjectSchema>
export type ToonWorkspaceEpisode = z.infer<typeof toonWorkspaceEpisodeSchema>
export type ToonWorkspaceWorkflowStep = z.infer<typeof toonWorkspaceWorkflowStepSchema>
export type ToonCanvasCatalog = z.infer<typeof toonCanvasCatalogSchema>
export type ToonCanvasFolderDescriptor = z.infer<typeof toonCanvasFolderDescriptorSchema>
export type ToonCanvasDescriptor = z.infer<typeof toonCanvasDescriptorSchema>
export type ToonDocumentCatalog = z.infer<typeof toonDocumentCatalogSchema>
export type ToonDocumentDescriptor = z.infer<typeof toonDocumentDescriptorSchema>
export type ToonDocumentFolderDescriptor = z.infer<typeof toonDocumentFolderDescriptorSchema>
export type ToonAssetCatalog = z.infer<typeof toonAssetCatalogSchema>
export type ToonAssetDescriptor = z.infer<typeof toonAssetDescriptorSchema>
export type ToonAssetReferenceImpact = z.infer<typeof toonAssetReferenceImpactSchema>
export type ToonAssetImportMetadata = z.infer<typeof toonAssetImportMetadataSchema>
export type ToonAssetAuthorizedImportRequest = z.infer<typeof toonAssetAuthorizedImportRequestSchema>
export type ToonAssetImportResult = z.infer<typeof toonAssetImportResultSchema>
export type ToonWorkspaceCanvas = z.infer<typeof toonWorkspaceCanvasSchema>
export type ToonWorkspaceNode = z.infer<typeof toonWorkspaceNodeSchema>
export type ToonCanvasGroup = z.infer<typeof toonCanvasGroupSchema>
export type ToonPortableReference = z.infer<typeof toonPortableReferenceSchema>
export type ToonWorkflowDependencyLink = z.infer<typeof toonWorkflowDependencyLinkSchema>
export type ToonWorkspaceGenerationRecord = z.infer<typeof toonWorkspaceGenerationRecordSchema>
export type ToonWorkspaceGenerationCandidate = z.infer<typeof toonWorkspaceGenerationCandidateSchema>
export type ToonGenerationAuthorizationState = z.infer<typeof toonGenerationAuthorizationStateSchema>
export type ToonWorkspaceAdoptionRecord = z.infer<typeof toonWorkspaceAdoptionRecordSchema>
export type ToonPortableProjectBundle = z.infer<typeof toonPortableProjectBundleSchema>
export type ToonMigrationBackupManifest = z.infer<typeof toonMigrationBackupManifestSchema>
export type ToonMigrationPreflight = z.infer<typeof toonMigrationPreflightSchema>
export type ToonMigrationApplyRequest = z.infer<typeof toonMigrationApplyRequestSchema>
export type ToonWorkspaceCommand = z.infer<typeof toonWorkspaceCommandSchema>
export type ToonWorkspaceQuery = z.infer<typeof toonWorkspaceQuerySchema>
export type ToonWorkspaceQueryResponse = z.infer<typeof toonWorkspaceQueryResponseSchema>
export type ToonWorkspaceProjectReadResponse = z.infer<typeof toonWorkspaceProjectReadResponseSchema>
export type ToonWorkspaceCatalogsReadResponse = z.infer<typeof toonWorkspaceCatalogsReadResponseSchema>
export type ToonWorkspaceCanvasReadResponse = z.infer<typeof toonWorkspaceCanvasReadResponseSchema>

export function completeToonWorkspaceClientCommand(
  command: ToonWorkspaceClientCommand,
  snapshot: ToonWorkspaceCatalogsReadResponse,
  context: { canvases?: Record<string, ToonWorkspaceCanvas> } = {},
): ToonWorkspaceClientCommand {
  const expectedRevisions: Record<string, string | null> = { ...command.expectedRevisions }
  const requirePath = (path: string) => {
    if (!Object.prototype.hasOwnProperty.call(expectedRevisions, path)) expectedRevisions[path] = snapshot.revisions[path] ?? null
  }
  const canvas = (id: string) => snapshot.canvases.canvases.find((item) => item.id === id)
  const document = (id: string) => snapshot.documents.documents.find((item) => item.id === id)
  const asset = (id: string) => snapshot.assets.assets.find((item) => item.id === id)

  requirePath("toon-project.json")
  if (command.kind.startsWith("folder.") || command.kind.startsWith("canvas.")) requirePath("catalogs/canvases.json")
  if (command.kind.startsWith("document.")) requirePath("catalogs/documents.json")
  if (command.kind.startsWith("asset.")) requirePath("catalogs/assets.json")

  switch (command.kind) {
    case "canvas.create":
      requirePath(command.canvas.file)
      break
    case "canvas.duplicate": {
      const source = canvas(command.canvasId)
      if (source) requirePath(source.file)
      requirePath(`canvases/${command.newCanvasId}.json`)
      break
    }
    case "canvas.write": {
      const target = canvas(command.canvasId)
      if (target) requirePath(target.file)
      const previous = target ? context.canvases?.[target.file] : undefined
      const assetReferences = (body: ToonWorkspaceCanvas | undefined) => new Map(body?.nodes.filter((node) => node.config.asset).map((node) => [node.id, node.config.asset!.id]) ?? [])
      const before = assetReferences(previous)
      const after = assetReferences(command.body)
      if (before.size !== after.size || [...before].some(([nodeId, assetId]) => after.get(nodeId) !== assetId)) requirePath("catalogs/assets.json")
      break
    }
    case "document.create":
      requirePath(command.document.path)
      break
    case "document.write": {
      const target = document(command.documentId)
      if (target) requirePath(target.path)
      break
    }
    case "document.rename": {
      const target = document(command.documentId)
      if (target) requirePath(target.path)
      if (command.path) requirePath(command.path)
      break
    }
    case "document.copy": {
      const source = document(command.documentId)
      if (source) requirePath(source.path)
      requirePath(command.path)
      break
    }
    case "document.folder.rename": {
      const folder = (snapshot.documents.folders ?? []).find((item) => item.id === command.folderId)
      if (folder) {
        for (const child of snapshot.documents.documents.filter((item) => item.path.startsWith(`${folder.path}/`))) {
          requirePath(child.path)
          requirePath(`${command.path}${child.path.slice(folder.path.length)}`)
        }
      }
      break
    }
    case "asset.delete": {
      const target = asset(command.assetId)
      if (target) {
        requirePath(target.path)
        requirePath(`.toon-trash/assets/${target.id}/${target.path.slice(target.path.lastIndexOf("/") + 1)}`)
      }
      if (command.replacementAssetId) {
        requirePath("catalogs/canvases.json")
        for (const descriptor of snapshot.canvases.canvases) {
          if (context.canvases?.[descriptor.file]?.nodes.some((node) => node.config.asset?.id === command.assetId)) requirePath(descriptor.file)
        }
      }
      break
    }
    case "asset.restore": {
      const target = asset(command.assetId)
      if (target) {
        requirePath(target.path)
        if (target.trashPath) requirePath(target.trashPath)
      }
      break
    }
    case "content.write":
      requirePath(command.path)
      break
  }
  return { ...command, expectedRevisions } as ToonWorkspaceClientCommand
}
export type ToonWorkspaceProjectListResponse = z.infer<typeof toonWorkspaceProjectListResponseSchema>
export type ToonWorkspaceProjectOpenRequest = z.infer<typeof toonWorkspaceProjectOpenRequestSchema>
export type ToonWorkspaceProjectOpenResponse = z.infer<typeof toonWorkspaceProjectOpenResponseSchema>
export type ToonWorkspaceOperationOutcome = z.infer<typeof toonWorkspaceOperationOutcomeSchema>
export type ToonProjectInitializeRequest = z.infer<typeof toonProjectInitializeRequestSchema>
export type ToonWorkflowEnsureRequest = z.infer<typeof toonWorkflowEnsureRequestSchema>
export type ToonWorkflowApproveRequest = z.infer<typeof toonWorkflowApproveRequestSchema>
export type ToonWorkflowSkipRequest = z.infer<typeof toonWorkflowSkipRequestSchema>
export type ToonWorkflowDeliveryRequest = z.infer<typeof toonWorkflowDeliveryRequestSchema>
export type ToonWorkspaceFeatureExposure = z.infer<typeof toonWorkspaceFeatureExposureSchema>
export type ToonCanvasLeaseRequest = z.infer<typeof toonCanvasLeaseRequestSchema>
export type ToonCanvasLeaseResponse = z.infer<typeof toonCanvasLeaseResponseSchema>
export type ToonCanvasCheckpointCreateRequest = z.infer<typeof toonCanvasCheckpointCreateRequestSchema>
export type ToonCanvasCheckpointRestoreRequest = z.infer<typeof toonCanvasCheckpointRestoreRequestSchema>
export type ToonCanvasCheckpoint = z.infer<typeof toonCanvasCheckpointSchema>
export type ToonCanvasCheckpointListResponse = z.infer<typeof toonCanvasCheckpointListResponseSchema>
export type ToonDocumentRevision = z.infer<typeof toonDocumentRevisionSchema>
export type ToonDocumentRevisionListResponse = z.infer<typeof toonDocumentRevisionListResponseSchema>
export type ToonDocumentRevisionRestoreRequest = z.infer<typeof toonDocumentRevisionRestoreRequestSchema>
export type ToonDocumentSearchRequest = z.infer<typeof toonDocumentSearchRequestSchema>
export type ToonDocumentSearchResponse = z.infer<typeof toonDocumentSearchResponseSchema>

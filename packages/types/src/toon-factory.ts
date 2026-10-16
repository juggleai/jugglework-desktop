import { z } from "zod"
import {
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
} from "./media-generation.js"

export const TOON_FACTORY_SCHEMA_VERSION = 1 as const

const boundedString = (max: number) => z.string().trim().min(1).max(max)
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const timestampSchema = z.string().datetime()

function isProjectRelativePath(value: string): boolean {
  if (
    !value
    || value.length > 4_096
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.startsWith("/")
    || /^[A-Za-z]:\//.test(value)
  ) return false
  const parts = value.split("/")
  return parts.every((part) => Boolean(part) && part !== "." && part !== "..")
}

export const toonProjectRelativePathSchema = z.string().refine(isProjectRelativePath, "Expected a normalized project-relative path")
export const toonContentReferenceSchema = toonProjectRelativePathSchema.refine(
  (value) => value.startsWith("content/nodes/"),
  "Expected a path under content/nodes",
)
export const toonAssetReferenceSchema = toonProjectRelativePathSchema.refine(
  (value) => value.startsWith("assets/"),
  "Expected a path under assets",
)
export const toonReferenceScopeSchema = z.enum(["workspace", "project"])
export const toonFileReferenceSchema = z.object({
  scope: toonReferenceScopeSchema,
  path: toonProjectRelativePathSchema,
}).strict()
export const toonIdentifierSchema = identifierSchema
export const toonRevisionSchema = revisionSchema

export const toonWorkflowStageSchema = z.enum([
  "content-script",
  "assets",
  "directing-storyboard",
  "images",
  "videos",
  "adoption-delivery",
])

export const toonWorkflowStatusSchema = z.enum([
  "draft",
  "pending-confirmation",
  "approved",
  "queued",
  "running",
  "awaiting-review",
  "adopted",
  "failed",
  "cancelled",
  "stale",
  "skipped",
])

export const toonWorkflowStageRecordSchema = z.object({
  stage: toonWorkflowStageSchema,
  status: toonWorkflowStatusSchema,
  inputRevision: revisionSchema.optional(),
  outputRevision: revisionSchema.optional(),
  skipReason: boundedString(2_000).optional(),
  updatedAt: timestampSchema,
}).strict().superRefine((record, ctx) => {
  if (record.status === "skipped" && !record.skipReason) {
    ctx.addIssue({ code: "custom", path: ["skipReason"], message: "A skipped stage requires a reason" })
  }
})

export const toonWorkflowVersionSchema = z.object({
  id: identifierSchema,
  status: toonWorkflowStatusSchema,
  inputRevision: revisionSchema.optional(),
  outputRevision: revisionSchema.optional(),
  recordedAt: timestampSchema,
}).strict()

export const toonTextGenerationActionSchema = z.enum(["script", "asset-plan", "storyboard"])

export const TOON_TEXT_OUTPUT_SCHEMAS = {
  script: {
    type: "object",
    additionalProperties: false,
    required: ["title", "logline", "scenes"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 500 },
      logline: { type: "string", minLength: 1, maxLength: 2_000 },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: 1_000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "heading", "summary", "dialogue"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            heading: { type: "string", minLength: 1, maxLength: 500 },
            summary: { type: "string", minLength: 1, maxLength: 10_000 },
            dialogue: {
              type: "array",
              maxItems: 10_000,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["speaker", "line"],
                properties: {
                  speaker: { type: "string", minLength: 1, maxLength: 500 },
                  line: { type: "string", minLength: 1, maxLength: 10_000 },
                },
              },
            },
          },
        },
      },
    },
  },
  "asset-plan": {
    type: "object",
    additionalProperties: false,
    required: ["assets"],
    properties: {
      assets: {
        type: "array",
        minItems: 1,
        maxItems: 10_000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "category", "description"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            name: { type: "string", minLength: 1, maxLength: 500 },
            category: { type: "string", enum: ["character", "location", "prop", "wardrobe", "effect"] },
            description: { type: "string", minLength: 1, maxLength: 10_000 },
          },
        },
      },
    },
  },
  storyboard: {
    type: "object",
    additionalProperties: false,
    required: ["shots"],
    properties: {
      shots: {
        type: "array",
        minItems: 1,
        maxItems: 10_000,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "sceneId", "shot", "description", "imagePrompt"],
          properties: {
            id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            sceneId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
            shot: { type: "string", minLength: 1, maxLength: 500 },
            description: { type: "string", minLength: 1, maxLength: 10_000 },
            dialogue: { type: "string", maxLength: 10_000 },
            imagePrompt: { type: "string", minLength: 1, maxLength: 20_000 },
          },
        },
      },
    },
  },
} as const satisfies Record<z.infer<typeof toonTextGenerationActionSchema>, Record<string, unknown>>

const toonScriptOutputSchema = z.object({
  title: boundedString(500),
  logline: boundedString(2_000),
  scenes: z.array(z.object({
    id: identifierSchema,
    heading: boundedString(500),
    summary: boundedString(10_000),
    dialogue: z.array(z.object({ speaker: boundedString(500), line: boundedString(10_000) }).strict()).max(10_000),
  }).strict()).min(1).max(1_000),
}).strict()

const toonAssetPlanOutputSchema = z.object({
  assets: z.array(z.object({
    id: identifierSchema,
    name: boundedString(500),
    category: z.enum(["character", "location", "prop", "wardrobe", "effect"]),
    description: boundedString(10_000),
  }).strict()).min(1).max(10_000),
}).strict()

const toonStoryboardOutputSchema = z.object({
  shots: z.array(z.object({
    id: identifierSchema,
    sceneId: identifierSchema,
    shot: boundedString(500),
    description: boundedString(10_000),
    dialogue: z.string().max(10_000).optional(),
    imagePrompt: boundedString(20_000),
  }).strict()).min(1).max(10_000),
}).strict()

export const toonTextActionOutputSchemas = {
  script: toonScriptOutputSchema,
  "asset-plan": toonAssetPlanOutputSchema,
  storyboard: toonStoryboardOutputSchema,
} as const

export const toonWorkflowGeneratedResultSchema = z.object({
  id: identifierSchema,
  jobId: identifierSchema,
  action: toonTextGenerationActionSchema,
  status: z.literal("awaiting-review"),
  nodeId: identifierSchema,
  resultRef: toonProjectRelativePathSchema,
  contentRef: toonProjectRelativePathSchema,
  outputRevision: revisionSchema,
  recordedAt: timestampSchema,
}).strict()

export const toonContentApprovalSchema = z.object({
  id: identifierSchema,
  outputRevision: revisionSchema,
  approvedAt: timestampSchema,
}).strict()

export const toonComputeAuthorizationSchema = z.object({
  id: identifierSchema,
  scopeRevision: revisionSchema,
  authorizedAt: timestampSchema,
  revokedAt: timestampSchema.optional(),
}).strict()

export const toonResultAdoptionSchema = z.object({
  id: identifierSchema,
  resultId: identifierSchema,
  artifactPath: toonProjectRelativePathSchema.optional(),
  artifactScope: toonReferenceScopeSchema.optional(),
  adoptedAt: timestampSchema,
  supersededAt: timestampSchema.optional(),
}).strict().superRefine((adoption, ctx) => {
  if (Boolean(adoption.artifactPath) !== Boolean(adoption.artifactScope)) {
    ctx.addIssue({ code: "custom", path: ["artifactScope"], message: "Artifact path and scope must be stored together" })
  }
})

export const toonWorkflowStepSchema = z.object({
  id: identifierSchema,
  stage: toonWorkflowStageSchema,
  title: boundedString(500),
  status: toonWorkflowStatusSchema,
  dependencies: z.array(identifierSchema).max(100),
  inputRevision: revisionSchema.optional(),
  outputRevision: revisionSchema.optional(),
  skipReason: boundedString(2_000).optional(),
  staleReason: boundedString(2_000).optional(),
  contentApprovals: z.array(toonContentApprovalSchema).max(1_000),
  computeAuthorizations: z.array(toonComputeAuthorizationSchema).max(1_000),
  resultAdoptions: z.array(toonResultAdoptionSchema).max(10_000),
  history: z.array(toonWorkflowVersionSchema).max(10_000),
  generationJobId: identifierSchema.optional(),
  generatedResults: z.array(toonWorkflowGeneratedResultSchema).max(10_000).optional(),
  updatedAt: timestampSchema,
}).strict().superRefine((step, ctx) => {
  if (step.status === "skipped" && !step.skipReason) {
    ctx.addIssue({ code: "custom", path: ["skipReason"], message: "A skipped step requires a reason" })
  }
  if (step.status === "stale" && !step.staleReason) {
    ctx.addIssue({ code: "custom", path: ["staleReason"], message: "A stale step requires a reason" })
  }
})

export const toonEpisodeSchema = z.object({
  id: identifierSchema,
  title: boundedString(500),
  ordinal: z.number().int().nonnegative(),
  canvasId: identifierSchema,
  stages: z.array(toonWorkflowStageRecordSchema).max(100),
  steps: z.array(toonWorkflowStepSchema).max(1_000).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((episode, ctx) => {
  const stepIds = new Set<string>()
  for (let index = 0; index < (episode.steps ?? []).length; index += 1) {
    const step = episode.steps![index]!
    if (stepIds.has(step.id)) {
      ctx.addIssue({ code: "custom", path: ["steps", index, "id"], message: `Duplicate workflow step: ${step.id}` })
    }
    stepIds.add(step.id)
  }
  for (let index = 0; index < (episode.steps ?? []).length; index += 1) {
    const step = episode.steps![index]!
    for (let dependencyIndex = 0; dependencyIndex < step.dependencies.length; dependencyIndex += 1) {
      const dependency = step.dependencies[dependencyIndex]!
      if (dependency === step.id || !stepIds.has(dependency)) {
        ctx.addIssue({ code: "custom", path: ["steps", index, "dependencies", dependencyIndex], message: `Invalid workflow dependency: ${dependency}` })
      }
    }
  }
})

export const toonModelKindSchema = z.enum(["text", "image", "video"])
export const toonModelReferenceSchema = z.object({
  kind: toonModelKindSchema,
  providerID: boundedString(256),
  modelID: boundedString(512),
}).strict()

export const toonProjectSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  id: identifierSchema,
  name: boundedString(500),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  episodes: z.array(toonEpisodeSchema).max(10_000),
  selectedModels: z.object({
    text: toonModelReferenceSchema.optional(),
    image: toonModelReferenceSchema.optional(),
    video: toonModelReferenceSchema.optional(),
  }).strict().optional(),
}).strict().superRefine((project, ctx) => {
  for (const kind of ["text", "image", "video"] as const) {
    const model = project.selectedModels?.[kind]
    if (model && model.kind !== kind) {
      ctx.addIssue({ code: "custom", path: ["selectedModels", kind, "kind"], message: `Expected a ${kind} model reference` })
    }
  }
  const episodeIds = new Set<string>()
  for (let index = 0; index < project.episodes.length; index += 1) {
    const episode = project.episodes[index]!
    if (episodeIds.has(episode.id)) {
      ctx.addIssue({ code: "custom", path: ["episodes", index, "id"], message: `Duplicate episode id: ${episode.id}` })
    }
    episodeIds.add(episode.id)
    const stages = new Set<string>()
    for (let stageIndex = 0; stageIndex < episode.stages.length; stageIndex += 1) {
      const stage = episode.stages[stageIndex]!
      if (stages.has(stage.stage)) {
        ctx.addIssue({ code: "custom", path: ["episodes", index, "stages", stageIndex, "stage"], message: `Duplicate workflow stage: ${stage.stage}` })
      }
      stages.add(stage.stage)
    }
  }
})

export const toonHandleDataTypeSchema = z.enum(["text", "storyboard", "asset", "image", "video", "any"])
export const toonHandleSchema = z.object({
  id: identifierSchema,
  direction: z.enum(["source", "target"]),
  dataType: toonHandleDataTypeSchema,
  label: boundedString(200).optional(),
}).strict()

export const toonNodeKindSchema = z.enum([
  "text",
  "asset",
  "storyboard",
  "image-asset",
  "video-asset",
  "image-generation",
  "video-generation",
])

export const toonNodeSchema = z.object({
  id: identifierSchema,
  kind: toonNodeKindSchema,
  position: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  handles: z.array(toonHandleSchema).max(100),
  data: z.object({
    label: boundedString(500).optional(),
    contentRef: toonContentReferenceSchema.optional(),
    assetRef: toonAssetReferenceSchema.optional(),
    modelRef: toonModelReferenceSchema.optional(),
    generationRecordId: identifierSchema.optional(),
  }).strict(),
}).strict().superRefine((node, ctx) => {
  const handles = new Set<string>()
  for (let index = 0; index < node.handles.length; index += 1) {
    const handle = node.handles[index]!
    if (handles.has(handle.id)) {
      ctx.addIssue({ code: "custom", path: ["handles", index, "id"], message: `Duplicate handle id: ${handle.id}` })
    }
    handles.add(handle.id)
  }
  if (node.data.contentRef && node.data.contentRef !== `content/nodes/${node.id}.md`) {
    ctx.addIssue({
      code: "custom",
      path: ["data", "contentRef"],
      message: `Expected content/nodes/${node.id}.md`,
    })
  }
})

export const toonEdgeSchema = z.object({
  id: identifierSchema,
  sourceNodeId: identifierSchema,
  sourceHandleId: identifierSchema,
  targetNodeId: identifierSchema,
  targetHandleId: identifierSchema,
}).strict()

export const toonViewportSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  zoom: z.number().finite().positive().max(10),
}).strict()

export const toonCanvasSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  id: identifierSchema,
  name: boundedString(500),
  nodes: z.array(toonNodeSchema).max(10_000),
  edges: z.array(toonEdgeSchema).max(50_000),
  viewport: toonViewportSchema,
  selectedNodeId: identifierSchema.optional(),
}).strict().superRefine((canvas, ctx) => {
  const nodes = new Map<string, z.infer<typeof toonNodeSchema>>()
  for (let index = 0; index < canvas.nodes.length; index += 1) {
    const node = canvas.nodes[index]!
    if (nodes.has(node.id)) {
      ctx.addIssue({ code: "custom", path: ["nodes", index, "id"], message: `Duplicate node id: ${node.id}` })
    }
    nodes.set(node.id, node)
  }

  const edgeIds = new Set<string>()
  for (let index = 0; index < canvas.edges.length; index += 1) {
    const edge = canvas.edges[index]!
    if (edgeIds.has(edge.id)) {
      ctx.addIssue({ code: "custom", path: ["edges", index, "id"], message: `Duplicate edge id: ${edge.id}` })
    }
    edgeIds.add(edge.id)

    const sourceNode = nodes.get(edge.sourceNodeId)
    const targetNode = nodes.get(edge.targetNodeId)
    if (!sourceNode) ctx.addIssue({ code: "custom", path: ["edges", index, "sourceNodeId"], message: `Missing source node: ${edge.sourceNodeId}` })
    if (!targetNode) ctx.addIssue({ code: "custom", path: ["edges", index, "targetNodeId"], message: `Missing target node: ${edge.targetNodeId}` })
    const sourceHandle = sourceNode?.handles.find((handle) => handle.id === edge.sourceHandleId && handle.direction === "source")
    const targetHandle = targetNode?.handles.find((handle) => handle.id === edge.targetHandleId && handle.direction === "target")
    if (sourceNode && !sourceHandle) ctx.addIssue({ code: "custom", path: ["edges", index, "sourceHandleId"], message: `Missing source handle: ${edge.sourceHandleId}` })
    if (targetNode && !targetHandle) ctx.addIssue({ code: "custom", path: ["edges", index, "targetHandleId"], message: `Missing target handle: ${edge.targetHandleId}` })
    if (sourceHandle && targetHandle && sourceHandle.dataType !== "any" && targetHandle.dataType !== "any" && sourceHandle.dataType !== targetHandle.dataType) {
      ctx.addIssue({
        code: "custom",
        path: ["edges", index],
        message: `Incompatible handle types: ${sourceHandle.dataType} -> ${targetHandle.dataType}`,
      })
    }
  }
  if (canvas.selectedNodeId && !nodes.has(canvas.selectedNodeId)) {
    ctx.addIssue({ code: "custom", path: ["selectedNodeId"], message: `Missing selected node: ${canvas.selectedNodeId}` })
  }
})

export const toonGenerationStatusSchema = z.enum([
  ...toonWorkflowStatusSchema.options,
  "submitting",
  "cancel_requested",
  "submission_unknown",
])

export const toonMediaKindSchema = z.enum(["image", "video"])

const toonGenerationCostSchema = z.object({
  amount: z.number().nonnegative(),
  currency: boundedString(20),
}).strict()

const toonMediaPlanBaseSchema = z.object({
  model: toonModelReferenceSchema,
  object: boundedString(500),
  quantity: z.number().int().positive().max(1_000),
  prompt: boundedString(20_000),
  referencePaths: z.array(toonProjectRelativePathSchema).max(16),
  referenceScope: toonReferenceScopeSchema,
  executionCount: z.number().int().positive().max(16),
  knownCost: toonGenerationCostSchema.nullable(),
})

export const toonImageGenerationPlanSchema = toonMediaPlanBaseSchema.extend({
  kind: z.literal("image"),
  model: toonModelReferenceSchema.refine((model) => model.kind === "image", "Expected an image model"),
  mode: z.enum(IMAGE_GENERATION_MODES),
  size: z.string().regex(/^(?:auto|\d{2,5}x\d{2,5})$/).optional(),
}).strict().superRefine((plan, ctx) => {
  if (plan.quantity !== plan.executionCount) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "Quantity must equal executionCount" })
  }
  if (plan.mode === "text-to-image" && plan.referencePaths.length !== 0) {
    ctx.addIssue({ code: "custom", path: ["referencePaths"], message: "Text-to-image does not accept references" })
  }
  if (plan.mode === "image-to-image" && plan.referencePaths.length !== 1) {
    ctx.addIssue({ code: "custom", path: ["referencePaths"], message: "Image-to-image requires one reference" })
  }
  if (plan.mode === "multi-image-to-image" && (plan.referencePaths.length < 2 || plan.referencePaths.length > 16)) {
    ctx.addIssue({ code: "custom", path: ["referencePaths"], message: "Multi-image-to-image requires 2 to 16 references" })
  }
})

export const toonVideoGenerationPlanSchema = toonMediaPlanBaseSchema.extend({
  kind: z.literal("video"),
  model: toonModelReferenceSchema.refine((model) => model.kind === "video", "Expected a video model"),
  mode: z.enum(VIDEO_GENERATION_MODES),
  durationSeconds: z.number().int().positive().max(20),
  resolution: z.union([
    z.enum(["480p", "720p", "1080p", "4k"]),
    z.string().regex(/^\d{2,5}x\d{2,5}$/),
  ]),
}).strict().superRefine((plan, ctx) => {
  if (plan.quantity !== plan.executionCount) {
    ctx.addIssue({ code: "custom", path: ["quantity"], message: "Quantity must equal executionCount" })
  }
  const expected = plan.mode === "image-to-video" ? 1 : 0
  if (plan.referencePaths.length !== expected) {
    ctx.addIssue({ code: "custom", path: ["referencePaths"], message: plan.mode === "image-to-video" ? "Image-to-video requires one reference" : "Text-to-video does not accept references" })
  }
})

export const toonMediaGenerationPlanSchema = z.discriminatedUnion("kind", [
  toonImageGenerationPlanSchema,
  toonVideoGenerationPlanSchema,
])

export const toonMediaAuthorizationSchema = z.object({
  id: identifierSchema,
  scopeHash: revisionSchema,
  authorizedAt: timestampSchema,
}).strict()

export const toonMediaJobCreateRequestSchema = z.object({
  requestId: identifierSchema,
  episodeId: identifierSchema,
  canvasId: identifierSchema,
  nodeId: identifierSchema,
  stepId: identifierSchema,
  plan: toonMediaGenerationPlanSchema,
  authorization: toonMediaAuthorizationSchema,
  retryOf: identifierSchema.optional(),
}).strict()

export const toonMediaAuthorizationRequestSchema = toonMediaJobCreateRequestSchema.omit({ authorization: true }).strict()

export const toonMediaJobRequestSnapshotSchema = toonMediaJobCreateRequestSchema.omit({ authorization: true }).extend({
  projectId: identifierSchema,
}).strict()

export const toonMediaCandidateStatusSchema = z.enum([
  "queued",
  "submitting",
  "running",
  "awaiting-review",
  "adopted",
  "rejected",
  "failed",
  "cancelled",
  "submission_unknown",
])

export const toonMediaArtifactSchema = z.object({
  path: toonProjectRelativePathSchema,
  scope: toonReferenceScopeSchema,
  mimeType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
  bytes: z.number().int().positive(),
  sha256: revisionSchema.optional(),
  durationSeconds: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).strict()

export const toonMediaCandidateSchema = z.object({
  id: identifierSchema,
  ordinal: z.number().int().positive(),
  status: toonMediaCandidateStatusSchema,
  progress: z.number().min(0).max(100).optional(),
  runtime: z.enum(["openai-image-generation", "media-generation"]),
  runtimeJobId: identifierSchema.optional(),
  clientRequestId: identifierSchema.optional(),
  artifact: toonMediaArtifactSchema.optional(),
  provenance: z.object({
    model: toonModelReferenceSchema,
    prompt: z.string().max(200_000),
    mode: z.string().max(100),
    referencePaths: z.array(toonProjectRelativePathSchema).max(16),
    referenceScope: toonReferenceScopeSchema,
    parameters: z.record(z.string(), z.unknown()),
  }).strict(),
  review: z.object({
    decision: z.enum(["pending", "adopted", "rejected"]),
    reviewedAt: timestampSchema.optional(),
  }).strict(),
  error: z.object({ code: boundedString(200), message: boundedString(4_000), retryable: z.boolean() }).strict().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict()

export const toonMediaJobSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  id: identifierSchema,
  workspaceId: boundedString(512),
  projectId: identifierSchema,
  episodeId: identifierSchema,
  canvasId: identifierSchema,
  nodeId: identifierSchema,
  stepId: identifierSchema,
  kind: toonMediaKindSchema,
  requestSnapshot: toonMediaJobRequestSnapshotSchema,
  requestHash: revisionSchema,
  authorization: toonMediaAuthorizationSchema,
  status: toonGenerationStatusSchema,
  candidates: z.array(toonMediaCandidateSchema).max(16),
  cancellation: z.object({
    requestedAt: timestampSchema,
    remoteMayContinue: z.boolean(),
    message: boundedString(2_000),
  }).strict().optional(),
  error: z.object({ code: boundedString(200), message: boundedString(4_000) }).strict().optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  completedAt: timestampSchema.optional(),
  projectionPending: z.boolean().optional(),
}).strict()

export const toonMediaJobResponseSchema = z.object({ job: toonMediaJobSchema }).strict()
export const toonMediaJobListResponseSchema = z.object({ items: z.array(toonMediaJobSchema) }).strict()
export const toonMediaJobReviewRequestSchema = z.object({ candidateId: identifierSchema }).strict()
export const toonMediaJobRetryRequestSchema = toonMediaJobCreateRequestSchema

export const toonGenerationRecordSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  id: identifierSchema,
  projectId: identifierSchema,
  episodeId: identifierSchema.optional(),
  canvasId: identifierSchema.optional(),
  nodeId: identifierSchema,
  kind: z.enum(["text", "image", "video"]),
  model: toonModelReferenceSchema,
  prompt: z.string().max(1_000_000),
  parameters: z.record(z.string(), z.unknown()),
  referencePaths: z.array(toonProjectRelativePathSchema).max(100),
  referenceScope: toonReferenceScopeSchema,
  status: toonGenerationStatusSchema,
  artifactPath: toonProjectRelativePathSchema.optional(),
  artifactScope: toonReferenceScopeSchema.optional(),
  mimeType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i).optional(),
  error: boundedString(4_000).optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((record, ctx) => {
  if (record.model.kind !== record.kind) {
    ctx.addIssue({
      code: "custom",
      path: ["model", "kind"],
      message: `Expected a ${record.kind} model reference`,
    })
  }
  if (Boolean(record.artifactPath) !== Boolean(record.artifactScope)) {
    ctx.addIssue({ code: "custom", path: ["artifactScope"], message: "Artifact path and scope must be stored together" })
  }
})

export const toonDeliveryManifestSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  manifestVersion: z.literal(1),
  id: identifierSchema,
  projectId: identifierSchema,
  episodeId: identifierSchema,
  createdAt: timestampSchema,
  artifacts: z.array(z.object({
    id: identifierSchema,
    kind: toonMediaKindSchema,
    path: toonProjectRelativePathSchema,
    scope: toonReferenceScopeSchema,
    mimeType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    bytes: z.number().int().positive(),
    sha256: revisionSchema,
    adoptionId: identifierSchema,
    generationRecordId: identifierSchema,
    candidateId: identifierSchema,
    provenance: z.object({
      model: toonModelReferenceSchema,
      prompt: z.string().max(200_000),
      mode: z.string().max(100),
      referencePaths: z.array(toonProjectRelativePathSchema).max(16),
      referenceScope: toonReferenceScopeSchema,
      parameters: z.record(z.string(), z.unknown()),
    }).strict(),
  }).strict()).max(10_000),
  omissions: z.array(z.object({
    kind: toonMediaKindSchema,
    code: z.enum([
      "no_adopted_output",
      "explicitly_skipped",
      "provenance_missing",
      "artifact_path_mismatch",
      "artifact_missing",
      "artifact_unsafe",
      "artifact_type_mismatch",
      "artifact_invalid_signature",
    ]),
    reason: boundedString(2_000),
    adoptionId: identifierSchema.optional(),
    resultId: identifierSchema.optional(),
    path: toonProjectRelativePathSchema.optional(),
  }).strict()).max(10_000),
  deliveryType: z.literal("adopted-media-and-manifest"),
  composition: z.object({
    status: z.literal("not-produced"),
    excludedCapabilities: z.tuple([
      z.literal("timeline"),
      z.literal("composition"),
      z.literal("subtitles"),
      z.literal("audio-mixing"),
    ]),
  }).strict(),
}).strict()

export const toonDeliveryManifestCreateRequestSchema = z.object({
  expectedRevision: revisionSchema.nullable().optional(),
}).strict()

export const toonDeliveryManifestResponseSchema = z.object({
  manifest: toonDeliveryManifestSchema.nullable(),
  path: toonProjectRelativePathSchema.nullable(),
  revision: revisionSchema.nullable(),
}).strict()

export const toonDeliveryManifestListResponseSchema = z.object({
  items: z.array(toonDeliveryManifestResponseSchema.extend({
    manifest: toonDeliveryManifestSchema,
    path: toonProjectRelativePathSchema,
    revision: revisionSchema,
  }).strict()),
}).strict()

export const toonProjectSummarySchema = z.object({
  id: identifierSchema,
  name: boundedString(500),
  directory: toonProjectRelativePathSchema,
  updatedAt: timestampSchema,
  episodeCount: z.number().int().nonnegative(),
  revision: revisionSchema,
}).strict()

export const toonProjectListResponseSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  items: z.array(toonProjectSummarySchema),
}).strict()

export const toonProjectResponseSchema = z.object({
  project: toonProjectSchema,
  directory: toonProjectRelativePathSchema,
  revision: revisionSchema,
}).strict()

export const toonProjectCreateRequestSchema = z.object({
  name: boundedString(500),
  directory: toonProjectRelativePathSchema,
}).strict()

export const toonProjectUpdateRequestSchema = z.object({
  project: toonProjectSchema,
  expectedRevision: revisionSchema.optional(),
}).strict()

export const toonImageGenerationModeSchema = z.enum(IMAGE_GENERATION_MODES)
export const toonVideoGenerationModeSchema = z.enum(VIDEO_GENERATION_MODES)

const toonPublicModelReferenceSchema = z.object({
  providerID: boundedString(256),
  modelID: boundedString(512),
}).strict()

export const toonImageModelDescriptorSchema = z.object({
  ref: toonPublicModelReferenceSchema,
  providerName: boundedString(500),
  modelName: boundedString(500),
  capabilities: z.object({
    protocol: z.literal("openai").optional(),
    textToImage: z.boolean().optional(),
    imageToImage: z.boolean().optional(),
    multiImageToImage: z.boolean().optional(),
    inputImage: z.object({
      mimeTypes: z.array(z.string()),
      maxBytes: z.number().positive().optional(),
      maxCount: z.number().positive().optional(),
    }).strict().optional(),
    outputImage: z.object({ mimeTypes: z.array(z.string()) }).strict().optional(),
  }).strict(),
}).strict()

export const toonVideoModelDescriptorSchema = z.object({
  ref: toonPublicModelReferenceSchema,
  providerName: boundedString(500),
  modelName: boundedString(500),
  capabilities: z.object({
    protocol: z.enum(["openai", "volcengine-ark-v3"]).optional(),
    textToVideo: z.boolean().optional(),
    imageToVideo: z.boolean().optional(),
    asyncJob: z.boolean().optional(),
    inputImage: z.object({
      mimeTypes: z.array(z.string()),
      maxBytes: z.number().positive().optional(),
      maxCount: z.number().positive().optional(),
    }).strict().optional(),
    outputVideo: z.object({
      mimeTypes: z.array(z.string()),
      maxDurationSeconds: z.number().positive().optional(),
      resolutions: z.array(z.enum(["480p", "720p", "1080p", "4k"])).optional(),
    }).strict().optional(),
  }).strict(),
}).strict()

export const toonModelCatalogResponseSchema = z.object({
  image: z.object({
    mode: toonImageGenerationModeSchema,
    models: z.array(toonImageModelDescriptorSchema),
  }).strict(),
  video: z.object({
    mode: toonVideoGenerationModeSchema,
    submissionEnabled: z.boolean(),
    blockingReason: z.enum(["no_video_model_available", "video_submission_disabled"]).nullable(),
    models: z.array(toonVideoModelDescriptorSchema),
  }).strict(),
}).strict()

export const toonCanvasResponseSchema = z.object({
  canvas: toonCanvasSchema,
  revision: revisionSchema,
}).strict()

export const toonCanvasWriteRequestSchema = z.object({
  canvas: toonCanvasSchema,
  expectedRevision: revisionSchema.optional(),
}).strict()

export const toonTextResponseSchema = z.object({
  nodeId: identifierSchema,
  content: z.string(),
  revision: revisionSchema,
}).strict()

export const toonTextWriteRequestSchema = z.object({
  content: z.string().max(5_000_000),
  expectedRevision: revisionSchema.nullable().optional(),
}).strict()

export const toonTextJobStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
])

export const toonTextJobCreateRequestSchema = z.object({
  action: toonTextGenerationActionSchema,
  prompt: boundedString(200_000),
  episodeId: identifierSchema,
  canvasId: identifierSchema,
  nodeId: identifierSchema,
  stage: toonWorkflowStageSchema,
  selectedModel: toonModelReferenceSchema.refine((model) => model.kind === "text", "Expected a text model"),
  outputSchema: z.record(z.string(), z.unknown()),
  contentApproved: z.literal(true),
}).strict()

export const toonTextJobRequestSnapshotSchema = toonTextJobCreateRequestSchema.extend({
  projectId: identifierSchema,
}).strict()

export const toonTextJobResultSchema = z.object({
  workflowRecordId: identifierSchema,
  resultRef: toonProjectRelativePathSchema,
  contentRef: toonProjectRelativePathSchema,
  outputRevision: revisionSchema,
  output: z.unknown(),
}).strict()

export const toonTextJobSchema = z.object({
  schemaVersion: z.literal(TOON_FACTORY_SCHEMA_VERSION),
  id: identifierSchema,
  workspaceId: boundedString(512),
  projectId: identifierSchema,
  episodeId: identifierSchema,
  canvasId: identifierSchema,
  nodeId: identifierSchema,
  stage: toonWorkflowStageSchema,
  action: toonTextGenerationActionSchema,
  selectedModel: toonModelReferenceSchema,
  outputSchema: z.record(z.string(), z.unknown()),
  requestSnapshot: toonTextJobRequestSnapshotSchema,
  status: toonTextJobStatusSchema,
  transientSessionId: boundedString(512).optional(),
  error: z.object({ code: boundedString(200), message: boundedString(4_000) }).strict().optional(),
  result: toonTextJobResultSchema.optional(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  startedAt: timestampSchema.optional(),
  completedAt: timestampSchema.optional(),
  cancelledAt: timestampSchema.optional(),
  projectionPending: z.boolean().optional(),
}).strict().superRefine((job, ctx) => {
  if (job.selectedModel.kind !== "text") {
    ctx.addIssue({ code: "custom", path: ["selectedModel", "kind"], message: "Expected a text model" })
  }
  if (job.status === "completed" && !job.result) {
    ctx.addIssue({ code: "custom", path: ["result"], message: "A completed job requires a result" })
  }
})

export const toonTextJobResponseSchema = z.object({ job: toonTextJobSchema }).strict()

export type ToonWorkflowStage = z.infer<typeof toonWorkflowStageSchema>
export type ToonWorkflowStageRecord = z.infer<typeof toonWorkflowStageRecordSchema>
export type ToonWorkflowVersion = z.infer<typeof toonWorkflowVersionSchema>
export type ToonTextGenerationAction = z.infer<typeof toonTextGenerationActionSchema>
export type ToonWorkflowGeneratedResult = z.infer<typeof toonWorkflowGeneratedResultSchema>
export type ToonContentApproval = z.infer<typeof toonContentApprovalSchema>
export type ToonComputeAuthorization = z.infer<typeof toonComputeAuthorizationSchema>
export type ToonResultAdoption = z.infer<typeof toonResultAdoptionSchema>
export type ToonReferenceScope = z.infer<typeof toonReferenceScopeSchema>
export type ToonFileReference = z.infer<typeof toonFileReferenceSchema>
export type ToonWorkflowStep = z.infer<typeof toonWorkflowStepSchema>
export type ToonEpisode = z.infer<typeof toonEpisodeSchema>
export type ToonModelReference = z.infer<typeof toonModelReferenceSchema>
export type ToonHandle = z.infer<typeof toonHandleSchema>
export type ToonNodeKind = z.infer<typeof toonNodeKindSchema>
export type ToonNode = z.infer<typeof toonNodeSchema>
export type ToonEdge = z.infer<typeof toonEdgeSchema>
export type ToonViewport = z.infer<typeof toonViewportSchema>
export type ToonCanvas = z.infer<typeof toonCanvasSchema>
export type ToonProject = z.infer<typeof toonProjectSchema>
export type ToonGenerationStatus = z.infer<typeof toonGenerationStatusSchema>
export type ToonGenerationRecord = z.infer<typeof toonGenerationRecordSchema>
export type ToonMediaKind = z.infer<typeof toonMediaKindSchema>
export type ToonImageGenerationPlan = z.infer<typeof toonImageGenerationPlanSchema>
export type ToonVideoGenerationPlan = z.infer<typeof toonVideoGenerationPlanSchema>
export type ToonMediaGenerationPlan = z.infer<typeof toonMediaGenerationPlanSchema>
export type ToonMediaAuthorization = z.infer<typeof toonMediaAuthorizationSchema>
export type ToonMediaJobCreateRequest = z.infer<typeof toonMediaJobCreateRequestSchema>
export type ToonMediaAuthorizationRequest = z.infer<typeof toonMediaAuthorizationRequestSchema>
export type ToonMediaJobRequestSnapshot = z.infer<typeof toonMediaJobRequestSnapshotSchema>
export type ToonMediaCandidateStatus = z.infer<typeof toonMediaCandidateStatusSchema>
export type ToonMediaArtifact = z.infer<typeof toonMediaArtifactSchema>
export type ToonMediaCandidate = z.infer<typeof toonMediaCandidateSchema>
export type ToonMediaJob = z.infer<typeof toonMediaJobSchema>
export type ToonMediaJobResponse = z.infer<typeof toonMediaJobResponseSchema>
export type ToonMediaJobListResponse = z.infer<typeof toonMediaJobListResponseSchema>
export type ToonMediaJobReviewRequest = z.infer<typeof toonMediaJobReviewRequestSchema>
export type ToonMediaJobRetryRequest = z.infer<typeof toonMediaJobRetryRequestSchema>
export type ToonDeliveryManifest = z.infer<typeof toonDeliveryManifestSchema>
export type ToonDeliveryManifestCreateRequest = z.infer<typeof toonDeliveryManifestCreateRequestSchema>
export type ToonDeliveryManifestResponse = z.infer<typeof toonDeliveryManifestResponseSchema>
export type ToonDeliveryManifestListResponse = z.infer<typeof toonDeliveryManifestListResponseSchema>
export type ToonProjectSummary = z.infer<typeof toonProjectSummarySchema>
export type ToonProjectListResponse = z.infer<typeof toonProjectListResponseSchema>
export type ToonProjectResponse = z.infer<typeof toonProjectResponseSchema>
export type ToonProjectCreateRequest = z.infer<typeof toonProjectCreateRequestSchema>
export type ToonProjectUpdateRequest = z.infer<typeof toonProjectUpdateRequestSchema>
export type ToonImageGenerationMode = z.infer<typeof toonImageGenerationModeSchema>
export type ToonVideoGenerationMode = z.infer<typeof toonVideoGenerationModeSchema>
export type ToonImageModelDescriptor = z.infer<typeof toonImageModelDescriptorSchema>
export type ToonVideoModelDescriptor = z.infer<typeof toonVideoModelDescriptorSchema>
export type ToonModelCatalogResponse = z.infer<typeof toonModelCatalogResponseSchema>
export type ToonCanvasResponse = z.infer<typeof toonCanvasResponseSchema>
export type ToonCanvasWriteRequest = z.infer<typeof toonCanvasWriteRequestSchema>
export type ToonTextResponse = z.infer<typeof toonTextResponseSchema>
export type ToonTextWriteRequest = z.infer<typeof toonTextWriteRequestSchema>
export type ToonTextJobStatus = z.infer<typeof toonTextJobStatusSchema>
export type ToonTextJobCreateRequest = z.infer<typeof toonTextJobCreateRequestSchema>
export type ToonTextJobRequestSnapshot = z.infer<typeof toonTextJobRequestSnapshotSchema>
export type ToonTextJobResult = z.infer<typeof toonTextJobResultSchema>
export type ToonTextJob = z.infer<typeof toonTextJobSchema>
export type ToonTextJobResponse = z.infer<typeof toonTextJobResponseSchema>

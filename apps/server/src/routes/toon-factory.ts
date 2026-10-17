import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import {
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
  type ImageGenerationMode,
  type VideoGenerationMode,
} from "@jugglework/types/media-generation";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  toonMediaAuthorizationRequestSchema,
  toonMediaJobSubmitRequestSchema,
  toonMediaJobReviewRequestSchema,
  toonIdentifierSchema,
  toonTextJobCreateRequestSchema,
  type ToonMediaAuthorizationRequest,
  type ToonMediaJobCreateRequest,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import { TOON_ASSET_MAX_BYTES, toonAssetAuthorizedImportRequestSchema, toonAssetImportMetadataSchema, toonGenerationAuthorizationSubmitSchema, toonWorkspaceClientCommandSchema, toonWorkspaceProjectOpenRequestSchema, toonWorkspacePublicCommandKinds, toonWorkflowApproveRequestSchema, toonWorkflowDeliveryRequestSchema, toonWorkflowEnsureRequestSchema, toonWorkflowSkipRequestSchema, type ToonWorkspaceGenerationRecord } from "@jugglework/types/toon-workspace";
import { ApiError } from "../errors.js";
import { resolveWithinRoot } from "../paths.js";
import type { EnvService } from "../env-file.js";
import type { MediaGenerationExtensionRuntime } from "../extensions/media-generation.js";
import { callOpenAiImageGenerationExtensionAction } from "../extensions/openai-image-generation.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { buildToonFactoryModelCatalog } from "../toon-factory/model-facade.js";
import { ToonFactoryRepository } from "../toon-factory/repository.js";
import type { ToonTextJobRepository } from "../toon-factory/text-job-repository.js";
import type { ToonTextJobService } from "../toon-factory/text-job-service.js";
import { toonMediaRequestHash, type ToonMediaJobRepository } from "../toon-factory/media-job-repository.js";
import type { ToonModelPolicyStore } from "../toon-factory/model-policy-store.js";
import type { ToonMediaJobService } from "../toon-factory/media-job-service.js";
import { ToonWorkspaceCoordinator, toonWorkspaceFeatureExposure } from "../toon-factory/workspace-coordinator.js";
import type { ToonWorkspaceRuntimeStore } from "../toon-factory/workspace-runtime-store.js";
import type { ToonWorkspaceMediaProjector } from "../toon-factory/workspace-media-projector.js";
import type { ToonProjectAssistantService } from "../toon-factory/project-assistant-service.js";
import { isSafeAssetPreviewMime } from "../toon-factory/workspace-assets.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;

export interface RegisterToonFactoryRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  env: EnvService;
  mediaGeneration: MediaGenerationExtensionRuntime;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  createWorkspaceOpencodeClient: (config: ServerConfig, workspace: WorkspaceInfo) => WorkspaceOpencodeClient;
  textJobs: ToonTextJobRepository;
  textJobService: ToonTextJobService;
  mediaJobs: ToonMediaJobRepository;
  mediaJobService: ToonMediaJobService;
  workspaceRuntime: ToonWorkspaceRuntimeStore;
  workspaceProjector: ToonWorkspaceMediaProjector;
  projectAssistant: ToonProjectAssistantService;
  modelPolicy: ToonModelPolicyStore;
}

export function registerToonFactoryRoutes(options: RegisterToonFactoryRoutesOptions): void {
  const { routes, config, env, mediaGeneration, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;
  const repository = async (workspaceId: string) => new ToonFactoryRepository((await resolveWorkspace(config, workspaceId)).path);
  const workspaceCoordinator = async (workspaceId: string) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    return new ToonWorkspaceCoordinator(workspace.id, workspace.path, options.workspaceRuntime);
  };
  const requireWrite = (ctx: RequestContext) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
  };
  const principalId = (ctx: RequestContext) => {
    const id = ctx.actor?.tokenHash ?? ctx.actor?.clientId;
    if (!id) throw new ApiError(401, "unauthorized", "Authenticated principal identity is unavailable");
    return id;
  };
  const humanActor = (ctx: RequestContext) => ({ kind: "human" as const, id: principalId(ctx) });
  const scopedGenerationAuthorization = (ctx: RequestContext, projectId: string, generation: ToonWorkspaceGenerationRecord) => generation.authorization && !generation.authorization.invalidatedAt
    ? options.workspaceRuntime.scopedGenerationAuthorization({
      authorizationId: generation.authorization.id,
      principalId: principalId(ctx),
      workspaceScope: ctx.params.id,
      projectId,
      generationId: generation.id,
      requestHash: generation.requestHash,
    })
    : null;
  const publicGeneration = (ctx: RequestContext, projectId: string, generation: ToonWorkspaceGenerationRecord) => {
    if (!generation.authorization || scopedGenerationAuthorization(ctx, projectId, generation)) return generation;
    const { authorization: _authorization, ...safe } = generation;
    return safe;
  };
  const publicWorkflow = <T extends { generations: ToonWorkspaceGenerationRecord[]; episodes: Array<{ steps?: Array<{ computeAuthorizations: Array<{ id: string }> }> }> }>(ctx: RequestContext, projectId: string, workflow: T): T => {
    const visibleAuthorizationIds = new Set(workflow.generations.flatMap((generation) => generation.authorization && scopedGenerationAuthorization(ctx, projectId, generation) ? [generation.authorization.id] : []));
    const generations = workflow.generations.map((generation) => publicGeneration(ctx, projectId, generation));
    return {
      ...workflow,
      generations,
      episodes: workflow.episodes.map((episode) => ({
        ...episode,
        ...(episode.steps ? { steps: episode.steps.map((step) => ({ ...step, computeAuthorizations: step.computeAuthorizations.filter((authorization) => visibleAuthorizationIds.has(authorization.id)) })) } : {}),
      })),
    };
  };
  const requireScopedMediaJob = (workspaceId: string, projectId: string, jobId: string) => {
    const job = options.mediaJobs.require(jobId);
    if (job.workspaceId !== workspaceId || job.projectId !== projectId) {
      throw new ApiError(404, "toon_media_job_not_found", "Toon Factory media job not found");
    }
    return job;
  };
  const publicTextJob = (job: ReturnType<ToonTextJobRepository["require"]>) => {
    const { transientSessionId: _transientSessionId, ...publicJob } = job;
    return publicJob;
  };
  const requestSnapshot = (projectId: string, request: ToonMediaAuthorizationRequest) => ({
    requestId: request.requestId,
    projectId,
    episodeId: request.episodeId,
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    stepId: request.stepId,
    plan: request.plan,
    ...(request.retryOf ? { retryOf: request.retryOf } : {}),
  });
  const issueMediaAuthorization = (ctx: RequestContext, projectId: string, generationId: string, snapshot: ReturnType<typeof requestSnapshot>, authorizationId = `authorization-${randomUUID()}`) => {
    const requestHash = toonMediaRequestHash(snapshot);
    const ledger = options.workspaceRuntime.issueAuthorization({
      authorizationId,
      principalId: principalId(ctx),
      workspaceScope: ctx.params.id,
      projectId,
      generationId,
      requestHash,
      requestSnapshot: snapshot,
      expiresAt: Date.now() + 5 * 60_000,
    });
    return { ledger, requestHash };
  };
  const authorizedMediaRequest = (ctx: RequestContext, projectId: string, authorizationId: string) => {
    const ledger = options.workspaceRuntime.requireAuthorization(authorizationId);
    if (ledger.principalId !== principalId(ctx) || ledger.workspaceScope !== ctx.params.id || ledger.projectId !== projectId) {
      throw new ApiError(403, "toon_compute_authorization_scope_changed", "Compute authorization does not match this principal or project");
    }
    const { projectId: _projectId, ...snapshot } = ledger.requestSnapshot;
    return {
      ledger,
      request: {
        ...snapshot,
        authorization: { id: authorizationId, scopeHash: ledger.requestHash, authorizedAt: new Date(ledger.issuedAt).toISOString() },
      } as ToonMediaJobCreateRequest,
    };
  };
  const validateMediaModel = async (workspaceId: string, request: ToonMediaJobCreateRequest) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    const context = { workspaceId: workspace.id, directory: workspace.path };
    const providers = await options.createWorkspaceOpencodeClient(config, workspace).provider.list();
    const provider = providers.data?.all?.find((candidate) => candidate.id === request.plan.model.providerID);
    options.modelPolicy.assertAllowed(workspaceId, request.plan.model, provider?.source);
    if (request.plan.kind === "image") {
      const listed = await callOpenAiImageGenerationExtensionAction(config, env, "image_models_list", { mode: request.plan.mode }, context) as { result?: { models?: Array<{ ref?: { providerID?: string; modelID?: string } }> } } | null;
      const available = listed?.result?.models?.some((model) => model.ref?.providerID === request.plan.model.providerID && model.ref.modelID === request.plan.model.modelID);
      if (!available) throw new ApiError(409, "selected_model_unavailable", "The selected Toon Factory image model is unavailable");
      return;
    }
    const listed = await mediaGeneration.listModels(request.plan.mode, context) as { models?: Array<{ ref?: { providerID?: string; modelID?: string } }> };
    const available = listed.models?.some((model) => model.ref?.providerID === request.plan.model.providerID && model.ref.modelID === request.plan.model.modelID);
    if (!available) throw new ApiError(409, "selected_model_unavailable", "The selected Toon Factory video model is unavailable");
  };

  addRoute(routes, "PUT", "/experimental/toon-factory/model-policy", "host", async (ctx) => {
    const result = options.modelPolicy.update(await readJsonBody(ctx.request));
    return jsonResponse({ ok: true, ...result });
  });
  addRoute(routes, "POST", "/experimental/toon-factory/assistant-bridge", "host-or-toon-bridge", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    if (typeof body.workspaceId !== "string" || typeof body.sessionId !== "string" || typeof body.toolCallId !== "string") throw new ApiError(400, "toon_assistant_bridge_invalid", "Toon assistant bridge scope is invalid");
    if (ctx.actor?.type === "toon-bridge") {
      const workspace = config.workspaces.find((candidate) => candidate.id === body.workspaceId);
      if (!workspace || workspace.workspaceType !== "local" || !workspace.path.trim()) {
        throw new ApiError(403, "toon_assistant_bridge_scope_mismatch", "Toon assistant bridge requires a configured local workspace on this managed engine");
      }
    }
    const action = body.call && typeof body.call === "object" && !Array.isArray(body.call) ? (body.call as { action?: unknown }).action : undefined;
    if (action === "canvas.propose" || action === "generation.prepare") ensureWritable(config);
    return jsonResponse({ item: await options.projectAssistant.bridge(body.workspaceId, body.sessionId, body.toolCallId, body.call) });
  });
  const requireAdvanced = () => {
    if (!toonWorkspaceFeatureExposure().advancedWorkspace) {
      throw new ApiError(404, "toon_workspace_advanced_hidden", "Advanced Toon workspace routes are disabled");
    }
  };

  addRoute(routes, "GET", "/workspace/:id/toon-factory/workspace-features", "client", async () => {
    return jsonResponse(toonWorkspaceFeatureExposure());
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/initialize", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const body = await readJsonBody(ctx.request);
    const { actor: _actor, origin: _origin, ...intent } = body;
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).initialize({ ...intent, actor: humanActor(ctx), origin: "human-ui" }), 201);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects", "client", async (ctx) => {
    return jsonResponse({ schemaVersion: 2, items: await (await workspaceCoordinator(ctx.params.id)).listProjects() });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/open", "client", async (ctx) => {
    const parsed = toonWorkspaceProjectOpenRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_project_open", "The JuggleWork v2 project directory is invalid", { issues: parsed.error.issues });
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).openProjectDirectory(parsed.data.directory));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/query", "client", async (ctx) => {
    const response = await (await workspaceCoordinator(ctx.params.id)).query(ctx.params.projectId, await readJsonBody(ctx.request));
    if (response.kind === "generation.read") return jsonResponse({ ...response, generation: publicGeneration(ctx, ctx.params.projectId, response.generation) });
    if (response.kind === "project.read") return jsonResponse({ ...response, project: { ...response.project, workflow: publicWorkflow(ctx, ctx.params.projectId, response.project.workflow) } });
    return jsonResponse(response);
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/commands", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const body = await readJsonBody(ctx.request);
    if (typeof body.kind === "string" && !(toonWorkspacePublicCommandKinds as readonly string[]).includes(body.kind)) {
      throw new ApiError(403, "toon_dedicated_or_internal_command_required", "This command is not available through the public command endpoint");
    }
    const parsed = toonWorkspaceClientCommandSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(400, "invalid_toon_workspace_command", "Invalid Toon workspace command", { issues: parsed.error.issues });
    const origin = parsed.data.kind === "canvas.write" ? "autosave" : "human-ui";
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).execute(ctx.params.projectId, { ...parsed.data, actor: humanActor(ctx), origin }, { requireCompleteExpected: true, requireCanvasLease: true }));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/workflow/ensure", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const body = await readJsonBody(ctx.request);
    const parsed = toonWorkflowEnsureRequestSchema.safeParse({ ...body, actor: humanActor(ctx), origin: "human-ui" });
    if (!parsed.success) throw new ApiError(422, "invalid_toon_workflow_ensure", "Invalid workflow ensure request", { issues: parsed.error.issues });
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).ensureWorkflow(ctx.params.projectId, parsed.data));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/workflow/:workflowRecordId/approve", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = toonWorkflowApproveRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(422, "invalid_toon_workflow_approval", "Invalid workflow approval request", { issues: parsed.error.issues });
    if (parsed.data.workflowRecordId !== ctx.params.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Workflow record identity does not match the route");
    const principal = principalId(ctx);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).executeHumanInteraction(ctx.params.projectId, {
      operationId: parsed.data.operationId, actor: { kind: "human", id: principal }, origin: "human-ui",
      expectedRevisions: { "toon-project.json": parsed.data.expectedRevision }, kind: "workflow.approve",
      episodeId: parsed.data.episodeId, workflowRecordId: parsed.data.workflowRecordId, outputRevision: parsed.data.outputRevision, dependencyLinks: parsed.data.dependencyLinks,
    }, principal));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/workflow/:workflowRecordId/skip", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = toonWorkflowSkipRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(422, "invalid_toon_workflow_skip", "Invalid workflow skip request", { issues: parsed.error.issues });
    if (parsed.data.workflowRecordId !== ctx.params.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Workflow record identity does not match the route");
    const principal = principalId(ctx);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).executeHumanInteraction(ctx.params.projectId, {
      operationId: parsed.data.operationId, actor: { kind: "human", id: principal }, origin: "human-ui",
      expectedRevisions: { "toon-project.json": parsed.data.expectedRevision }, kind: "workflow.skip",
      episodeId: parsed.data.episodeId, workflowRecordId: parsed.data.workflowRecordId, reason: parsed.data.reason,
    }, principal));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/workflow/:workflowRecordId/delivery", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = toonWorkflowDeliveryRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(422, "invalid_toon_workflow_delivery", "Invalid workflow delivery request", { issues: parsed.error.issues });
    if (parsed.data.workflowRecordId !== ctx.params.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Workflow record identity does not match the route");
    const principal = principalId(ctx);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).executeHumanInteraction(ctx.params.projectId, {
      operationId: parsed.data.operationId, actor: { kind: "human", id: principal }, origin: "human-ui",
      expectedRevisions: { "toon-project.json": parsed.data.expectedRevision }, kind: "workflow.delivery",
      episodeId: parsed.data.episodeId, workflowRecordId: parsed.data.workflowRecordId,
    }, principal));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assets/upload", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const declaredLength = Number(ctx.request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > TOON_ASSET_MAX_BYTES + 1024 * 1024) throw new ApiError(413, "toon_asset_too_large", "Asset exceeds the 100 MB project limit");
    const contentType = ctx.request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (contentType !== "application/octet-stream") throw new ApiError(400, "invalid_payload", "Expected application/octet-stream");
    const encodedMetadata = ctx.request.headers.get("x-jugglework-toon-asset");
    if (!encodedMetadata || encodedMetadata.length > 16_384) throw new ApiError(400, "invalid_toon_asset_import", "Asset import metadata is missing or too large");
    let rawMetadata: unknown;
    try { rawMetadata = JSON.parse(decodeURIComponent(encodedMetadata)); } catch { throw new ApiError(400, "invalid_toon_asset_import", "Asset import metadata is invalid"); }
    const source = rawMetadata && typeof rawMetadata === "object" && !Array.isArray(rawMetadata) ? rawMetadata as Record<string, unknown> : {};
    const parsed = toonAssetImportMetadataSchema.safeParse({ ...source, actor: humanActor(ctx) });
    if (!parsed.success) throw new ApiError(400, "invalid_toon_asset_import", "Asset import metadata is invalid", { issues: parsed.error.issues });
    if (!ctx.request.body) throw new ApiError(400, "file_required", "Asset request body is required");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const stagingRoot = await resolveWithinRoot(workspace.path, ".toon-upload-staging");
    const rootMetadata = await lstat(stagingRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!rootMetadata) await mkdir(stagingRoot, { mode: 0o700 });
    else if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) throw new ApiError(400, "path_escape", "Upload staging root is unsafe");
    if (await realpath(stagingRoot) !== stagingRoot) throw new ApiError(400, "path_escape", "Upload staging root is unsafe");
    const stagingRootSnapshot = await lstat(stagingRoot);
    const uploadId = randomUUID();
    const stagingDirectory = join(stagingRoot, uploadId);
    await mkdir(stagingDirectory, { mode: 0o700 });
    const stagingRootCurrent = await lstat(stagingRoot);
    if (Number(stagingRootCurrent.dev) !== Number(stagingRootSnapshot.dev) || Number(stagingRootCurrent.ino) !== Number(stagingRootSnapshot.ino) || stagingRootCurrent.isSymbolicLink()) throw new ApiError(409, "toon_upload_staging_changed", "Upload staging root changed while creating the upload directory");
    const parentMetadata = await lstat(stagingDirectory);
    if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory() || await realpath(stagingDirectory) !== stagingDirectory) throw new ApiError(400, "path_escape", "Upload staging directory is unsafe");
    const stagingName = "payload.upload";
    const stagingPath = join(stagingDirectory, stagingName);
    let bytes = 0;
    const handle = await open(stagingPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW), 0o600);
    try {
      const [opened, canonicalStagingPath, currentParent] = await Promise.all([handle.stat(), realpath(stagingPath), lstat(stagingDirectory)]);
      if (!opened.isFile() || canonicalStagingPath !== stagingPath || Number(currentParent.dev) !== Number(parentMetadata.dev) || Number(currentParent.ino) !== Number(parentMetadata.ino) || currentParent.isSymbolicLink()) {
        throw new ApiError(409, "toon_upload_staging_changed", "Upload staging directory changed before streaming");
      }
      for await (const chunk of Readable.fromWeb(ctx.request.body as never)) {
        bytes += chunk.byteLength;
        if (bytes > TOON_ASSET_MAX_BYTES) throw new ApiError(413, "toon_asset_too_large", "Asset exceeds the 100 MB project limit", { maxBytes: TOON_ASSET_MAX_BYTES });
        const currentParent = await lstat(stagingDirectory);
        if (Number(currentParent.dev) !== Number(parentMetadata.dev) || Number(currentParent.ino) !== Number(parentMetadata.ino) || currentParent.isSymbolicLink()) throw new ApiError(409, "toon_upload_staging_changed", "Upload staging directory changed while streaming");
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const outcome = await (await workspaceCoordinator(ctx.params.id)).importAuthorizedAsset(ctx.params.projectId, { ...parsed.data, sourcePath: `.toon-upload-staging/${uploadId}/${stagingName}` });
      return jsonResponse(outcome, 201);
    } finally {
      await handle.close().catch(() => undefined);
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assets/import", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const body = await readJsonBody(ctx.request);
    const parsed = toonAssetAuthorizedImportRequestSchema.safeParse({ ...body, actor: humanActor(ctx) });
    if (!parsed.success) throw new ApiError(400, "invalid_toon_asset_import", "Authorized asset import request is invalid", { issues: parsed.error.issues });
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).importAuthorizedAsset(ctx.params.projectId, parsed.data), 201);
  });

  for (const disposition of ["preview", "download"] as const) {
    addRoute(routes, "GET", `/workspace/:id/toon-factory/v2/projects/:projectId/assets/:assetId/${disposition}`, "client", async (ctx) => {
      const resolved = await (await workspaceCoordinator(ctx.params.id)).readAssetContent(ctx.params.projectId, ctx.params.assetId);
      if (disposition === "preview" && !isSafeAssetPreviewMime(resolved.asset.mimeType)) throw new ApiError(415, "toon_asset_preview_unsupported", "Active or unsupported asset content cannot be previewed");
      const headers = new Headers({
        "Content-Type": resolved.asset.mimeType,
        "Content-Length": String(resolved.asset.bytes),
        "Content-Disposition": `${disposition === "download" ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(resolved.asset.path))}`,
        "Content-Security-Policy": "default-src 'none'; media-src 'self' blob:; img-src 'self' blob:; sandbox",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      return new Response(new Uint8Array(resolved.bytes), { status: 200, headers });
    });
  }

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/documents/search", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).searchDocuments(ctx.params.projectId, await readJsonBody(ctx.request), ctx.request.signal));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/documents/:documentId/revisions", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).listDocumentRevisions(ctx.params.projectId, ctx.params.documentId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/documents/:documentId/revisions/:revisionId/restore", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const { actor: _actor, origin: _origin, ...input } = await readJsonBody(ctx.request);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).restoreDocumentRevision(ctx.params.projectId, ctx.params.documentId, ctx.params.revisionId, { ...input, actor: humanActor(ctx), origin: "human-ui" }));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/canvases/:canvasId/lease", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const input = await readJsonBody(ctx.request) as Record<string, unknown>;
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).acquireCanvasLease(ctx.params.projectId, { ...input, canvasId: ctx.params.canvasId }));
  });

  addRoute(routes, "DELETE", "/workspace/:id/toon-factory/v2/projects/:projectId/canvases/:canvasId/lease/:leaseId", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    (await workspaceCoordinator(ctx.params.id)).releaseCanvasLease(ctx.params.projectId, ctx.params.canvasId, ctx.params.leaseId);
    return jsonResponse({ released: true });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/canvases/:canvasId/checkpoints", "client", async (ctx) => {
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).listCanvasCheckpoints(ctx.params.projectId, ctx.params.canvasId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/canvases/:canvasId/checkpoints", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const { actor: _actor, origin: _origin, ...input } = await readJsonBody(ctx.request);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).createCanvasCheckpoint(ctx.params.projectId, { ...input, canvasId: ctx.params.canvasId, actor: humanActor(ctx), origin: "human-ui" }), 201);
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/canvases/:canvasId/checkpoints/:checkpointId/restore", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const { actor: _actor, origin: _origin, ...input } = await readJsonBody(ctx.request);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).restoreCanvasCheckpoint(ctx.params.projectId, ctx.params.canvasId, { ...input, checkpointId: ctx.params.checkpointId, actor: humanActor(ctx), origin: "human-ui" }));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/export", "client", async (ctx) => {
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).exportProject(ctx.params.projectId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse({ item: await options.projectAssistant.create(ctx.params.id, ctx.params.projectId, await readJsonBody(ctx.request)) }, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse({ items: await options.projectAssistant.list(ctx.params.id, ctx.params.projectId, ctx.url.searchParams.get("archived") === "true") });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse({ item: await options.projectAssistant.snapshot(ctx.params.id, ctx.params.projectId, ctx.params.conversationId) });
  });

  addRoute(routes, "PATCH", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse({ item: await options.projectAssistant.update(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)) });
  });

  addRoute(routes, "DELETE", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse(await options.projectAssistant.delete(ctx.params.id, ctx.params.projectId, ctx.params.conversationId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/messages", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse(await options.projectAssistant.send(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)), 202);
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/stop", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse(await options.projectAssistant.stop(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)), 202);
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/remote-warning/acknowledge", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse(await options.projectAssistant.acknowledgeRemoteContinueWarning(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/edit-resend", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse(await options.projectAssistant.editAndResend(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)), 202);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/events", "client", async (ctx) => {
    requireAdvanced();
    const limit = Number(ctx.url.searchParams.get("limit") ?? "200");
    return jsonResponse(await options.projectAssistant.events(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, ctx.url.searchParams.get("cursor"), limit));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/completions", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse(await options.projectAssistant.completions(ctx.params.id, ctx.params.projectId, ctx.url.searchParams.get("query") ?? ""));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/interactions/:interactionId/reply", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse({ item: await options.projectAssistant.replyInteraction(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, ctx.params.interactionId, await readJsonBody(ctx.request)) });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/tools", "client", async () => {
    requireAdvanced();
    return jsonResponse(options.projectAssistant.tools());
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/canvas-proposals/:proposalId/decision", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse({ item: await options.projectAssistant.executeCanvasCall(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, ctx.params.proposalId, await readJsonBody(ctx.request)) });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/assistant/conversations/:conversationId/protected-interactions", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    return jsonResponse({ item: await options.projectAssistant.proposeProtectedInteraction(ctx.params.id, ctx.params.projectId, ctx.params.conversationId, await readJsonBody(ctx.request)) }, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/migration-preflight", "client", async (ctx) => {
    requireAdvanced();
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).migrationPreflight(ctx.params.projectId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/migrate-v2", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const { actor: _actor, ...input } = await readJsonBody(ctx.request);
    return jsonResponse(await (await workspaceCoordinator(ctx.params.id)).migrate(ctx.params.projectId, { ...input, actor: humanActor(ctx) }));
  });
  const v2AuthorizationSchema = toonMediaAuthorizationRequestSchema.extend({ operationId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema }).strict();
  const v2AdoptionSchema = toonMediaJobReviewRequestSchema.extend({ operationId: toonIdentifierSchema, adoptionId: toonIdentifierSchema, episodeId: toonIdentifierSchema, workflowRecordId: toonIdentifierSchema }).strict();

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/generations/:generationId/authorize", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = v2AuthorizationSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_authorization", "Invalid v2 Toon media authorization request", { issues: parsed.error.issues });
    const coordinator = await workspaceCoordinator(ctx.params.id);
    const generationRead = await coordinator.query(ctx.params.projectId, { kind: "generation.read", generationId: ctx.params.generationId });
    if (generationRead.kind !== "generation.read") throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
    await coordinator.assertGenerationPrerequisites(ctx.params.projectId, ctx.params.generationId);
    if (parsed.data.episodeId !== generationRead.generation.episodeId || parsed.data.workflowRecordId !== generationRead.generation.workflowRecordId || parsed.data.stepId !== parsed.data.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Generation workflow scope changed before authorization");
    const snapshot = requestSnapshot(ctx.params.projectId, parsed.data);
    const scopeHash = toonMediaRequestHash(snapshot);
    if (scopeHash !== generationRead.generation.requestHash || parsed.data.requestId !== generationRead.generation.requestId) throw new ApiError(409, "toon_compute_authorization_scope_changed", "The exact generation plan changed before authorization");
    const authorizationId = `authorization-${createHash("sha256").update(`${principalId(ctx)}\0${ctx.params.id}\0${ctx.params.projectId}\0${ctx.params.generationId}\0${parsed.data.operationId}`).digest("hex").slice(0, 32)}`;
    const { ledger } = issueMediaAuthorization(ctx, ctx.params.projectId, ctx.params.generationId, snapshot, authorizationId);
    const authorization = { id: ledger.authorizationId, scopeHash, authorizedAt: new Date(ledger.issuedAt).toISOString() };
    if (generationRead.generation.authorization?.id !== authorization.id || generationRead.generation.authorization.invalidatedAt) {
      const principal = principalId(ctx);
      try {
        await coordinator.executeHumanInteraction(ctx.params.projectId, { operationId: parsed.data.operationId, actor: { kind: "human", id: principal }, origin: "human-ui", expectedRevisions: { "toon-project.json": generationRead.projectRevision }, kind: "workflow.authorize", episodeId: generationRead.generation.episodeId, workflowRecordId: generationRead.generation.workflowRecordId, generationId: ctx.params.generationId, authorization }, principal);
      } catch (error) {
        options.workspaceRuntime.invalidateAuthorization(authorization.id);
        throw error;
      }
      await options.projectAssistant.completeGenerationAuthorization(ctx.params.id, ctx.params.projectId, ctx.params.generationId, authorization.id);
    }
    return jsonResponse({ requestSnapshot: snapshot, requestHash: scopeHash, planFingerprint: scopeHash, planSummary: snapshot.plan, authorizationId: authorization.id, expiresAt: new Date(ledger.expiresAt).toISOString() });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/generations/:generationId/submit", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = toonGenerationAuthorizationSubmitSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_job", "Invalid v2 Toon media job request", { issues: parsed.error.issues });
    const coordinator = await workspaceCoordinator(ctx.params.id);
    const generationRead = await coordinator.query(ctx.params.projectId, { kind: "generation.read", generationId: ctx.params.generationId });
    if (generationRead.kind !== "generation.read") throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
    const generation = generationRead.generation;
    await coordinator.assertGenerationPrerequisites(ctx.params.projectId, ctx.params.generationId);
    const generationAuthorization = generation.authorization;
    if (!generationAuthorization || generationAuthorization.id !== parsed.data.authorizationId || generationAuthorization.invalidatedAt || parsed.data.expectedPlanFingerprint !== generation.requestHash) throw new ApiError(409, "toon_compute_authorization_scope_changed", "The exact generation authorization is missing, invalidated, or no longer matches the displayed plan");
    const ledger = options.workspaceRuntime.requireAuthorization(parsed.data.authorizationId);
    if (ledger.principalId !== principalId(ctx) || ledger.workspaceScope !== ctx.params.id || ledger.projectId !== ctx.params.projectId || ledger.generationId !== ctx.params.generationId || ledger.requestHash !== generation.requestHash) {
      throw new ApiError(403, "toon_compute_authorization_scope_changed", "Compute authorization does not match this principal or generation");
    }
    const existingLink = options.workspaceRuntime.generationLinkByGeneration(ctx.params.id, ctx.params.projectId, ctx.params.generationId);
    if (existingLink) {
      if (ledger.runtimeJobId !== existingLink.runtimeJobId) throw new ApiError(409, "toon_compute_authorization_consumed", "Compute authorization was already consumed by another job");
      return jsonResponse({ job: options.mediaJobs.require(existingLink.runtimeJobId) }, 200);
    }
    const { request } = authorizedMediaRequest(ctx, ctx.params.projectId, parsed.data.authorizationId);
    await validateMediaModel(ctx.params.id, request);
    await coordinator.assertGenerationPrerequisites(ctx.params.projectId, ctx.params.generationId);
    const created = options.mediaJobs.consumeAuthorizationAndCreate({ authorizationId: parsed.data.authorizationId, principalId: principalId(ctx), workspaceId: ctx.params.id, projectId: ctx.params.projectId, generationId: ctx.params.generationId });
    await options.workspaceProjector.link(created.job, ctx.params.generationId);
    await options.workspaceProjector.project(created.job);
    if (created.created) options.mediaJobService.dispatch(created.job.id);
    return jsonResponse({ job: created.job }, created.created ? 202 : 200);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/v2/projects/:projectId/generations/:generationId", "client", async (ctx) => {
    const generation = await options.workspaceProjector.generation(ctx.params.id, ctx.params.projectId, ctx.params.generationId);
    const link = options.workspaceRuntime.generationLinkByGeneration(ctx.params.id, ctx.params.projectId, ctx.params.generationId);
    const authorization = scopedGenerationAuthorization(ctx, ctx.params.projectId, generation);
    const ledgerJobId = authorization
      ? options.workspaceRuntime.requireAuthorization(authorization.authorizationId).runtimeJobId
      : null;
    return jsonResponse({
      generation: publicGeneration(ctx, ctx.params.projectId, generation),
      job: link ? options.mediaJobs.require(link.runtimeJobId) : ledgerJobId ? options.mediaJobs.require(ledgerJobId) : null,
      authorization,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/v2/projects/:projectId/media-jobs/:jobId/adopt", "client", async (ctx) => {
    requireAdvanced(); requireWrite(ctx);
    const parsed = v2AdoptionSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_review", "Invalid v2 Toon media adoption request", { issues: parsed.error.issues });
    requireScopedMediaJob(ctx.params.id, ctx.params.projectId, ctx.params.jobId);
    return jsonResponse({ job: await options.mediaJobService.review(ctx.params.jobId, parsed.data.candidateId, "adopted", { operationId: parsed.data.operationId, adoptionId: parsed.data.adoptionId, principalId: principalId(ctx), episodeId: parsed.data.episodeId, workflowRecordId: parsed.data.workflowRecordId }) });
  });
  const validateProjectMediaModel = async (workspaceId: string, projectId: string, request: ToonMediaJobCreateRequest) => {
    await validateMediaModel(workspaceId, request);
    const projectRepository = await repository(workspaceId);
    const project = await projectRepository.getProject(projectId);
    const selected = project.project.selectedModels?.[request.plan.kind];
    if (!selected || selected.providerID !== request.plan.model.providerID || selected.modelID !== request.plan.model.modelID) {
      throw new ApiError(409, "selected_model_unavailable", "The selected Toon Factory media model is unavailable");
    }
    return projectRepository;
  };
  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).listProjects());
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects", "client", async (ctx) => {
    requireWrite(ctx);
    return jsonResponse(await (await repository(ctx.params.id)).createProject(await readJsonBody(ctx.request)), 201);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).getProject(ctx.params.projectId));
  });

  addRoute(routes, "PUT", "/workspace/:id/toon-factory/projects/:projectId", "client", async (ctx) => {
    requireWrite(ctx);
    return jsonResponse(await (await repository(ctx.params.id)).updateProject(ctx.params.projectId, await readJsonBody(ctx.request)));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/canvases/:canvasId", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).readCanvas(ctx.params.projectId, ctx.params.canvasId));
  });

  addRoute(routes, "PUT", "/workspace/:id/toon-factory/projects/:projectId/canvases/:canvasId", "client", async (ctx) => {
    requireWrite(ctx);
    return jsonResponse(await (await repository(ctx.params.id)).writeCanvas(ctx.params.projectId, ctx.params.canvasId, await readJsonBody(ctx.request)));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/content/nodes/:nodeId", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).readText(ctx.params.projectId, ctx.params.nodeId));
  });

  addRoute(routes, "PUT", "/workspace/:id/toon-factory/projects/:projectId/content/nodes/:nodeId", "client", async (ctx) => {
    requireWrite(ctx);
    return jsonResponse(await (await repository(ctx.params.id)).writeText(ctx.params.projectId, ctx.params.nodeId, await readJsonBody(ctx.request)));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/delivery-manifests", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).listDeliveryManifests(ctx.params.projectId));
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/episodes/:episodeId/delivery-manifest", "client", async (ctx) => {
    return jsonResponse(await (await repository(ctx.params.id)).getDeliveryManifest(ctx.params.projectId, ctx.params.episodeId));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/episodes/:episodeId/delivery-manifest", "client", async (ctx) => {
    requireWrite(ctx);
    const projectRepository = await repository(ctx.params.id);
    const jobs = options.mediaJobs.list(ctx.params.id, ctx.params.projectId);
    return jsonResponse(await projectRepository.createDeliveryManifest(ctx.params.projectId, ctx.params.episodeId, jobs, await readJsonBody(ctx.request)), 201);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/episodes/:episodeId/delivery-manifest/download", "client", async (ctx) => {
    const response = await (await repository(ctx.params.id)).getDeliveryManifest(ctx.params.projectId, ctx.params.episodeId);
    if (!response.manifest) throw new ApiError(404, "toon_delivery_manifest_not_found", "Toon Factory delivery manifest not found");
    const content = `${JSON.stringify(response.manifest, null, 2)}\n`;
    return new Response(content, { headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ctx.params.episodeId}-delivery-manifest.json"`,
    } });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/episodes/:episodeId/delivery-artifacts/:artifactId", "client", async (ctx) => {
    const jobs = options.mediaJobs.list(ctx.params.id, ctx.params.projectId);
    const artifact = await (await repository(ctx.params.id)).resolveDeliveryArtifact(ctx.params.projectId, ctx.params.episodeId, ctx.params.artifactId, jobs);
    const headers = new Headers({
      "Content-Type": artifact.mimeType,
      "Content-Length": String(artifact.bytes),
      "Content-Disposition": `attachment; filename="${basename(artifact.path)}"`,
    });
    const stream = Readable.toWeb(artifact.stream as Readable) as unknown as ReadableStream;
    return new Response(stream, { status: 200, headers });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/models", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const imageModeValue = ctx.url.searchParams.get("imageMode") ?? "text-to-image";
    const videoModeValue = ctx.url.searchParams.get("videoMode") ?? "text-to-video";
    if (!IMAGE_GENERATION_MODES.includes(imageModeValue as ImageGenerationMode)) {
      throw new ApiError(400, "invalid_toon_image_mode", "Unsupported Toon Factory image generation mode");
    }
    if (!VIDEO_GENERATION_MODES.includes(videoModeValue as VideoGenerationMode)) {
      throw new ApiError(400, "invalid_toon_video_mode", "Unsupported Toon Factory video generation mode");
    }
    const imageMode = imageModeValue as ImageGenerationMode;
    const videoMode = videoModeValue as VideoGenerationMode;
    const context = { workspaceId: workspace.id, directory: workspace.path };
    const [imageResponse, videoStatus, videoList] = await Promise.all([
      callOpenAiImageGenerationExtensionAction(config, env, "image_models_list", { mode: imageMode }, context),
      mediaGeneration.status(context),
      mediaGeneration.listModels(videoMode, context),
    ]);
    const imageResult = imageResponse && typeof imageResponse === "object" && "result" in imageResponse
      ? imageResponse.result
      : null;
    return jsonResponse(buildToonFactoryModelCatalog({
      imageMode,
      videoMode,
      imageListResult: imageResult,
      videoStatusResult: videoStatus,
      videoListResult: videoList,
    }));
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/text-jobs", "client", async (ctx) => {
    requireWrite(ctx);
    const parsed = toonTextJobCreateRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_text_job", "Invalid Toon Factory text job request", { issues: parsed.error.issues });
    const request = parsed.data as ToonTextJobCreateRequest;
    if (JSON.stringify(request.outputSchema) !== JSON.stringify(TOON_TEXT_OUTPUT_SCHEMAS[request.action])) {
      throw new ApiError(400, "toon_text_schema_mismatch", "The requested output schema is not the canonical Toon Factory schema");
    }
    const projectRepository = await repository(ctx.params.id);
    const project = await projectRepository.getProject(ctx.params.projectId);
    const selected = project.project.selectedModels?.text;
    if (!selected || selected.providerID !== request.selectedModel.providerID || selected.modelID !== request.selectedModel.modelID) {
      throw new ApiError(409, "selected_model_unavailable", "The selected Toon Factory text model is unavailable");
    }
    await projectRepository.assertTextJobPrerequisites(ctx.params.projectId, {
      episodeId: request.episodeId,
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      stage: request.stage,
      action: request.action,
    });
    const job = options.textJobs.create(ctx.params.id, ctx.params.projectId, request);
    try {
      await projectRepository.queueTextJob(job);
    } catch (error) {
      options.textJobs.fail(job.id, { code: "toon_text_job_target_changed", message: "The Toon Factory workflow target is unavailable" });
      throw error;
    }
    options.textJobService.dispatch(job.id);
    return jsonResponse({ job: publicTextJob(job) }, 202);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/text-jobs/:jobId", "client", async (ctx) => {
    const job = options.textJobs.require(ctx.params.jobId);
    if (job.workspaceId !== ctx.params.id || job.projectId !== ctx.params.projectId) {
      throw new ApiError(404, "toon_text_job_not_found", "Toon Factory text job not found");
    }
    return jsonResponse({ job: publicTextJob(job) });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/text-jobs/:jobId/cancel", "client", async (ctx) => {
    requireWrite(ctx);
    const job = options.textJobs.require(ctx.params.jobId);
    if (job.workspaceId !== ctx.params.id || job.projectId !== ctx.params.projectId) {
      throw new ApiError(404, "toon_text_job_not_found", "Toon Factory text job not found");
    }
    return jsonResponse({ job: publicTextJob(await options.textJobService.cancel(job.id)) }, 202);
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/media-jobs/authorize", "client", async (ctx) => {
    requireWrite(ctx);
    const parsed = toonMediaAuthorizationRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_authorization", "Invalid Toon Factory media authorization request", { issues: parsed.error.issues });
    await (await repository(ctx.params.id)).assertMediaJobPrerequisites(ctx.params.projectId, {
      episodeId: parsed.data.episodeId,
      canvasId: parsed.data.canvasId,
      nodeId: parsed.data.nodeId,
      stepId: parsed.data.stepId,
      kind: parsed.data.plan.kind,
    });
    const snapshot = requestSnapshot(ctx.params.projectId, parsed.data);
    const { ledger, requestHash } = issueMediaAuthorization(ctx, ctx.params.projectId, `legacy-${parsed.data.requestId}`, snapshot);
    return jsonResponse({ requestSnapshot: snapshot, requestHash, planFingerprint: requestHash, planSummary: snapshot.plan, authorizationId: ledger.authorizationId, expiresAt: new Date(ledger.expiresAt).toISOString() });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/media-jobs", "client", async (ctx) => {
    requireWrite(ctx);
    const parsed = toonMediaJobSubmitRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_job", "Invalid Toon Factory media job request", { issues: parsed.error.issues });
    const { ledger, request } = authorizedMediaRequest(ctx, ctx.params.projectId, parsed.data.authorizationId);
    if (parsed.data.expectedPlanFingerprint !== ledger.requestHash) throw new ApiError(409, "toon_compute_authorization_scope_changed", "The displayed generation plan no longer matches this authorization");
    if (request.retryOf) throw new ApiError(400, "invalid_toon_media_job", "Retry authorization must use the retry endpoint");
    await (await repository(ctx.params.id)).assertMediaJobPrerequisites(ctx.params.projectId, {
      episodeId: request.episodeId,
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      stepId: request.stepId,
      kind: request.plan.kind,
    });
    const projectRepository = await validateProjectMediaModel(ctx.params.id, ctx.params.projectId, request);
    const created = options.mediaJobs.consumeAuthorizationAndCreate({ authorizationId: parsed.data.authorizationId, principalId: principalId(ctx), workspaceId: ctx.params.id, projectId: ctx.params.projectId, generationId: ledger.generationId });
    const job = created.job;
    if (!created.created) return jsonResponse({ job }, 200);
    try {
      await projectRepository.queueMediaJob(job);
    } catch (error) {
      options.mediaJobs.update(job.id, (current, now) => ({
        ...current,
        status: "failed",
        candidates: current.candidates.map((candidate) => ({ ...candidate, status: "failed", error: { code: "toon_media_job_target_changed", message: "The Toon Factory workflow target is unavailable", retryable: false }, updatedAt: now })),
        error: { code: "toon_media_job_target_changed", message: "The Toon Factory workflow target is unavailable" },
      }));
      throw error;
    }
    await projectRepository.writeMediaJobManifest(job);
    options.mediaJobService.dispatch(job.id);
    return jsonResponse({ job }, 202);
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/media-jobs", "client", async (ctx) => {
    return jsonResponse({ items: options.mediaJobs.list(ctx.params.id, ctx.params.projectId) });
  });

  addRoute(routes, "GET", "/workspace/:id/toon-factory/projects/:projectId/media-jobs/:jobId", "client", async (ctx) => {
    requireScopedMediaJob(ctx.params.id, ctx.params.projectId, ctx.params.jobId);
    return jsonResponse({ job: options.mediaJobs.require(ctx.params.jobId) });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/media-jobs/:jobId/cancel", "client", async (ctx) => {
    requireWrite(ctx);
    requireScopedMediaJob(ctx.params.id, ctx.params.projectId, ctx.params.jobId);
    return jsonResponse({ job: await options.mediaJobService.cancel(ctx.params.jobId) }, 202);
  });

  for (const decision of ["adopt", "reject"] as const) {
    addRoute(routes, "POST", `/workspace/:id/toon-factory/projects/:projectId/media-jobs/:jobId/${decision}`, "client", async (ctx) => {
      requireWrite(ctx);
      requireScopedMediaJob(ctx.params.id, ctx.params.projectId, ctx.params.jobId);
      const parsed = toonMediaJobReviewRequestSchema.safeParse(await readJsonBody(ctx.request));
      if (!parsed.success) throw new ApiError(400, "invalid_toon_media_review", "Invalid Toon Factory media review request", { issues: parsed.error.issues });
      return jsonResponse({ job: await options.mediaJobService.review(ctx.params.jobId, parsed.data.candidateId, decision === "adopt" ? "adopted" : "rejected") });
    });
  }

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/media-jobs/:jobId/retry", "client", async (ctx) => {
    requireWrite(ctx);
    const prior = requireScopedMediaJob(ctx.params.id, ctx.params.projectId, ctx.params.jobId);
    if (prior.status === "submission_unknown") {
      throw new ApiError(409, "toon_media_reconciliation_required", "The prior submission outcome is uncertain and must be reconciled before retry");
    }
    const parsed = toonMediaJobSubmitRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) {
      throw new ApiError(400, "invalid_toon_media_retry", "Retry must reference the prior Toon Factory media job and carry a fresh scoped authorization");
    }
    const { ledger, request } = authorizedMediaRequest(ctx, ctx.params.projectId, parsed.data.authorizationId);
    if (parsed.data.expectedPlanFingerprint !== ledger.requestHash) throw new ApiError(409, "toon_compute_authorization_scope_changed", "The displayed generation plan no longer matches this authorization");
    if (request.retryOf !== ctx.params.jobId) throw new ApiError(400, "invalid_toon_media_retry", "Retry authorization does not reference this prior Toon Factory media job");
    await (await repository(ctx.params.id)).assertMediaJobPrerequisites(ctx.params.projectId, {
      episodeId: request.episodeId,
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      stepId: request.stepId,
      kind: request.plan.kind,
    });
    const projectRepository = await validateProjectMediaModel(ctx.params.id, ctx.params.projectId, request);
    const created = options.mediaJobs.consumeAuthorizationAndCreate({ authorizationId: parsed.data.authorizationId, principalId: principalId(ctx), workspaceId: ctx.params.id, projectId: ctx.params.projectId, generationId: ledger.generationId });
    const job = created.job;
    if (!created.created) return jsonResponse({ job }, 200);
    try {
      await projectRepository.queueMediaJob(job);
    } catch (error) {
      options.mediaJobs.update(job.id, (current, now) => ({
        ...current,
        status: "failed",
        candidates: current.candidates.map((candidate) => ({ ...candidate, status: "failed", error: { code: "toon_media_job_target_changed", message: "The Toon Factory workflow target is unavailable", retryable: false }, updatedAt: now })),
        error: { code: "toon_media_job_target_changed", message: "The Toon Factory workflow target is unavailable" },
      }));
      throw error;
    }
    await projectRepository.writeMediaJobManifest(job);
    options.mediaJobService.dispatch(job.id);
    return jsonResponse({ job }, 202);
  });
}

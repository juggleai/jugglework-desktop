import { basename } from "node:path";
import { Readable } from "node:stream";
import {
  IMAGE_GENERATION_MODES,
  VIDEO_GENERATION_MODES,
  type ImageGenerationMode,
  type VideoGenerationMode,
} from "@jugglework/types/media-generation";
import {
  TOON_TEXT_OUTPUT_SCHEMAS,
  toonMediaAuthorizationRequestSchema,
  toonMediaJobCreateRequestSchema,
  toonMediaJobRetryRequestSchema,
  toonMediaJobReviewRequestSchema,
  toonTextJobCreateRequestSchema,
  type ToonMediaAuthorizationRequest,
  type ToonMediaJobCreateRequest,
  type ToonTextJobCreateRequest,
} from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import type { MediaGenerationExtensionRuntime } from "../extensions/media-generation.js";
import { callOpenAiImageGenerationExtensionAction } from "../extensions/openai-image-generation.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { buildToonFactoryModelCatalog } from "../toon-factory/model-facade.js";
import { ToonFactoryRepository } from "../toon-factory/repository.js";
import type { ToonTextJobRepository } from "../toon-factory/text-job-repository.js";
import type { ToonTextJobService } from "../toon-factory/text-job-service.js";
import { createToonMediaAuthorization, toonMediaRequestHash, type ToonMediaJobRepository } from "../toon-factory/media-job-repository.js";
import type { ToonMediaJobService } from "../toon-factory/media-job-service.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

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
  textJobs: ToonTextJobRepository;
  textJobService: ToonTextJobService;
  mediaJobs: ToonMediaJobRepository;
  mediaJobService: ToonMediaJobService;
}

export function registerToonFactoryRoutes(options: RegisterToonFactoryRoutesOptions): void {
  const { routes, config, env, mediaGeneration, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;
  const repository = async (workspaceId: string) => new ToonFactoryRepository((await resolveWorkspace(config, workspaceId)).path);
  const requireWrite = (ctx: RequestContext) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
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
  const validateMediaModel = async (workspaceId: string, request: ToonMediaJobCreateRequest) => {
    const workspace = await resolveWorkspace(config, workspaceId);
    const context = { workspaceId: workspace.id, directory: workspace.path };
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
  const existingMediaJob = (workspaceId: string, projectId: string, request: ToonMediaJobCreateRequest) => {
    if (!options.mediaJobs.getByRequest(workspaceId, projectId, request.requestId)) return null;
    return options.mediaJobs.createOrGet(workspaceId, projectId, request).job;
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
    const scopeHash = toonMediaRequestHash(snapshot);
    return jsonResponse({ requestSnapshot: snapshot, requestHash: scopeHash, authorization: createToonMediaAuthorization(scopeHash) });
  });

  addRoute(routes, "POST", "/workspace/:id/toon-factory/projects/:projectId/media-jobs", "client", async (ctx) => {
    requireWrite(ctx);
    const parsed = toonMediaJobCreateRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_toon_media_job", "Invalid Toon Factory media job request", { issues: parsed.error.issues });
    await (await repository(ctx.params.id)).assertMediaJobPrerequisites(ctx.params.projectId, {
      episodeId: parsed.data.episodeId,
      canvasId: parsed.data.canvasId,
      nodeId: parsed.data.nodeId,
      stepId: parsed.data.stepId,
      kind: parsed.data.plan.kind,
    });
    const existing = existingMediaJob(ctx.params.id, ctx.params.projectId, parsed.data);
    if (existing) return jsonResponse({ job: existing }, 200);
    const projectRepository = await validateProjectMediaModel(ctx.params.id, ctx.params.projectId, parsed.data);
    const created = options.mediaJobs.createOrGet(ctx.params.id, ctx.params.projectId, parsed.data);
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
    const parsed = toonMediaJobRetryRequestSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success || parsed.data.retryOf !== ctx.params.jobId) {
      throw new ApiError(400, "invalid_toon_media_retry", "Retry must reference the prior Toon Factory media job and carry a fresh scoped authorization");
    }
    await (await repository(ctx.params.id)).assertMediaJobPrerequisites(ctx.params.projectId, {
      episodeId: parsed.data.episodeId,
      canvasId: parsed.data.canvasId,
      nodeId: parsed.data.nodeId,
      stepId: parsed.data.stepId,
      kind: parsed.data.plan.kind,
    });
    const existing = existingMediaJob(ctx.params.id, ctx.params.projectId, parsed.data);
    if (existing) return jsonResponse({ job: existing }, 200);
    const projectRepository = await validateProjectMediaModel(ctx.params.id, ctx.params.projectId, parsed.data);
    const created = options.mediaJobs.createOrGet(ctx.params.id, ctx.params.projectId, parsed.data);
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

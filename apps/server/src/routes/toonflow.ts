import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { parseMediaGenerationCapabilities, VIDEO_RESOLUTION_PRESETS, type ImageGenerationMode } from "@jugglework/types/media-generation";
import { ApiError } from "../errors.js";
import { readEffectiveWorkspaceOpencodeConfig } from "../effective-workspace-opencode-config.js";
import type { EnvService } from "../env-file.js";
import type { MediaGenerationExtensionRuntime } from "../extensions/media-generation.js";
import { readValidatedImageArtifact } from "../extensions/openai-image-generation.js";
import type { ToonflowImageRuntime } from "../media-generation/image-runtime.js";
import { readValidatedVideoArtifact, safeWorkspaceChild } from "../media-generation/artifact-publisher.js";
import { createWorkspaceProviderCredentialResolver } from "../provider-credential-resolver.js";
import { externalFetch } from "../server-fetch.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type Route } from "./registry.js";

const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const modelRefSchema = z.object({ providerID: z.string().trim().min(1).max(256), modelID: z.string().trim().min(1).max(256) }).strict();
const mediaInputSchema = z.object({ type: z.literal("base64").optional(), data: z.string().max(35_000_000), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]) }).strict();
const jsonObjectSchema = z.record(z.string(), z.json());
const textInputSchema = z.object({ modelId: z.string().trim().min(1).max(256), payload: jsonObjectSchema }).strict();
const messageArraySchema = z.array(jsonObjectSchema).min(1).max(4_000);
const toolArraySchema = z.array(jsonObjectSchema).max(128);
const openAiChatPayloadSchema = z.object({
  model: z.string().max(512), messages: messageArraySchema, stream: z.boolean(),
  stream_options: jsonObjectSchema.optional(), store: z.boolean().optional(),
  max_tokens: z.number().int().positive().optional(), max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(), seed: z.number().int().optional(),
  stop: z.union([z.string(), z.array(z.string()).max(16)]).optional(),
  tools: toolArraySchema.optional(), tool_choice: z.json().optional(), parallel_tool_calls: z.boolean().optional(),
  response_format: jsonObjectSchema.optional(), modalities: z.array(z.string()).max(8).optional(),
  prompt_cache_key: z.string().max(512).optional(), prompt_cache_retention: z.string().max(32).optional(),
  reasoning_effort: z.string().max(32).optional(), reasoning: z.json().optional(), thinking: z.json().optional(),
  enable_thinking: z.boolean().optional(), thinking_token_budget: z.number().int().nonnegative().optional(),
  chat_template_kwargs: jsonObjectSchema.optional(), chat_template_args: jsonObjectSchema.optional(),
  tool_stream: z.boolean().optional(), priority: z.number().finite().optional(),
  provider: z.json().optional(), providerOptions: jsonObjectSchema.optional(),
}).strict();
const openAiResponsesPayloadSchema = z.object({
  model: z.string().max(512), input: z.union([z.string(), messageArraySchema]), stream: z.boolean(),
  store: z.boolean().optional(), max_output_tokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(),
  tools: toolArraySchema.optional(), tool_choice: z.json().optional(), parallel_tool_calls: z.boolean().optional(),
  reasoning: jsonObjectSchema.optional(), include: z.array(z.string()).max(32).optional(),
  prompt_cache_key: z.string().max(512).optional(), prompt_cache_retention: z.string().max(32).optional(),
  prompt_cache_options: jsonObjectSchema.optional(), service_tier: z.string().max(64).optional(),
  text: jsonObjectSchema.optional(), truncation: z.string().max(32).optional(),
}).strict();
const anthropicPayloadSchema = z.object({
  model: z.string().max(512), messages: messageArraySchema, max_tokens: z.number().int().positive(), stream: z.boolean(),
  system: z.union([z.string(), z.array(jsonObjectSchema).max(128)]).optional(),
  temperature: z.number().finite().optional(), top_p: z.number().finite().optional(), top_k: z.number().int().positive().optional(),
  stop_sequences: z.array(z.string()).max(16).optional(), tools: toolArraySchema.optional(), tool_choice: jsonObjectSchema.optional(),
  thinking: jsonObjectSchema.optional(), output_config: jsonObjectSchema.optional(), metadata: jsonObjectSchema.optional(),
  fallbacks: z.array(jsonObjectSchema).max(16).optional(),
  betas: z.array(z.enum([
    "fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14",
    "server-side-fallback-2026-07-01", "mid-conversation-output-config-2026-07-01",
    "thinking-binding-controls-2026-08-01",
  ])).max(5).optional(),
}).strict();
const textPayloadSchemas = { chat: openAiChatPayloadSchema, responses: openAiResponsesPayloadSchema, messages: anthropicPayloadSchema } as const;
const textProtocolOperations = { "openai-completions": "chat", "openai-responses": "responses", "anthropic-messages": "messages" } as const;
const maxModelRequestBytes = 140 * 1024 * 1024;
const sensitiveModelFields = new Set(["apikey", "authorization", "headers", "baseurl", "endpoint", "proxyurl"]);
const imagePayloadSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(32_000),
  mode: z.enum(["text-to-image", "image-to-image", "multi-image-to-image"]),
  model: modelRefSchema,
  references: z.array(mediaInputSchema).max(16),
  size: z.string().trim().min(1).max(64).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "text-to-image" && value.references.length) context.addIssue({ code: "custom", message: "references are not accepted for text-to-image" });
  if (value.mode === "image-to-image" && value.references.length !== 1) context.addIssue({ code: "custom", message: "image-to-image requires one reference" });
  if (value.mode === "multi-image-to-image" && (value.references.length < 2 || value.references.length > 16)) context.addIssue({ code: "custom", message: "multi-image-to-image requires 2 to 16 references" });
});
const imageSubmitSchema = z.object({
  providerId: z.string().trim().min(1).max(256), modelId: z.string().trim().min(1).max(256),
  operation: z.literal("image"), payload: imagePayloadSchema,
}).strict();
const imageContentSchema = z.object({
  providerId: z.string().trim().min(1).max(256), modelId: z.string().trim().min(1).max(256),
  operation: z.literal("image"), payload: z.object({}).strict(), jobId: z.string().uuid(),
}).strict();
const videoPayloadSchema = z.object({
  clientRequestId: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20_000),
  mode: z.enum(["text-to-video", "image-to-video"]),
  model: modelRefSchema,
  source: mediaInputSchema.optional(),
  durationSeconds: z.number().int().positive().max(20).optional(),
  resolution: z.union([z.enum(VIDEO_RESOLUTION_PRESETS), z.string().regex(/^\d{2,5}x\d{2,5}$/)]).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === "image-to-video" && !value.source) context.addIssue({ code: "custom", message: "source is required for image-to-video" });
  if (value.mode === "text-to-video" && value.source) context.addIssue({ code: "custom", message: "source is only accepted for image-to-video" });
});
const videoSubmitSchema = z.object({
  providerId: z.string().trim().min(1).max(256), modelId: z.string().trim().min(1).max(256), operation: z.literal("video"), payload: videoPayloadSchema,
}).strict();
const videoJobInputSchema = z.object({
  providerId: z.string().trim().min(1).max(256), modelId: z.string().trim().min(1).max(256),
  operation: z.enum(["videoStatus", "videoContent", "videoCancel"]), payload: z.object({}).strict(),
  jobId: z.string().uuid(),
}).strict();
const publicJobSchema = z.object({
  id: z.string().uuid(), workspaceId: z.string().min(1), sessionId: z.string().optional(), model: modelRefSchema,
  mode: z.enum(["text-to-video", "image-to-video"]),
  status: z.enum(["queued", "submitting", "submitted", "running", "cancel_requested", "downloading", "completed", "failed", "cancelled", "submission_unknown"]),
  progress: z.number().optional(), options: z.record(z.string(), z.unknown()), providerJobId: z.string().optional(), nextPollAt: z.number().optional(),
  pollAttempts: z.number().int().nonnegative(),
  artifact: z.object({ path: z.string().min(1), mimeType: z.enum(["video/mp4", "video/webm", "video/quicktime"]), bytes: z.number().int().positive(), durationSeconds: z.number().optional(), width: z.number().optional(), height: z.number().optional() }).strict().optional(),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().optional(),
  revision: z.number().int().positive(), createdAt: z.number(), updatedAt: z.number(),
});

type ToonflowMediaRuntime = Pick<MediaGenerationExtensionRuntime, "listModels" | "generate" | "getJob" | "cancelJob">;
type ToonflowImageBridgeRuntime = Pick<ToonflowImageRuntime, "listModels" | "generate" | "getJob">;

function invalidRequest(): never {
  throw new ApiError(400, "invalid_model_request", "模型请求参数无效");
}

function invalidSensitiveField(): never {
  throw new ApiError(400, "unsafe_model_request", "模型请求不能包含凭据、请求头或自定义服务地址");
}

function assertSafeModelPayload(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (sensitiveModelFields.has(key.replace(/[-_]/g, "").toLowerCase())) invalidSensitiveField();
  }
  for (const nested of [record(value.provider), record(value.providerOptions)]) {
    for (const key of Object.keys(nested)) {
      if (sensitiveModelFields.has(key.replace(/[-_]/g, "").toLowerCase())) invalidSensitiveField();
    }
  }
}

async function readModelRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") invalidRequest();
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0) invalidRequest();
    if (bytes > maxModelRequestBytes) throw new ApiError(413, "model_request_too_large", "模型请求不能超过 140 MB");
  }
  const reader = request.body?.getReader();
  if (!reader) invalidRequest();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxModelRequestBytes) throw new ApiError(413, "model_request_too_large", "模型请求不能超过 140 MB");
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (request.signal.aborted) throw new ApiError(499, "request_cancelled", "模型请求已取消");
    invalidRequest();
  } finally {
    reader.releaseLock();
  }
  try {
    const text = Buffer.concat(chunks, size).toString("utf8");
    if (!text) invalidRequest();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    invalidRequest();
  }
}

function runtimeJob(value: unknown, workspaceId: string) {
  const parsed = publicJobSchema.safeParse(record(value).job);
  if (!parsed.success || parsed.data.workspaceId !== workspaceId) throw new ApiError(502, "invalid_video_job", "视频任务状态无效");
  return parsed.data;
}

function assertJobModel(job: z.infer<typeof publicJobSchema>, providerId: string, modelId: string) {
  if (job.model.providerID !== providerId || job.model.modelID !== modelId) throw new ApiError(403, "unknown_video_job", "此视频任务不属于当前模块或模型");
}

function imageBytes(input: z.infer<typeof mediaInputSchema>): Uint8Array {
  const normalized = input.data.replace(/\s/g, "");
  if (!normalized || normalized.length % 4 === 1 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) invalidRequest();
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) throw new ApiError(413, "video_source_image_too_large", "视频参考图片不能超过 25 MB");
  const png = bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if ((input.mimeType === "image/png" && !png) || (input.mimeType === "image/jpeg" && !jpeg) || (input.mimeType === "image/webp" && !webp)) {
    throw new ApiError(400, "video_source_image_invalid", "视频参考图片内容与类型不匹配");
  }
  return bytes;
}

async function publishMediaSource(workspace: WorkspaceInfo, requestId: string, source: z.infer<typeof mediaInputSchema>, index = 0): Promise<string> {
  const bytes = imageBytes(source);
  const extension = source.mimeType === "image/png" ? "png" : source.mimeType === "image/webp" ? "webp" : "jpg";
  const hash = createHash("sha256").update(requestId).update("\0").update(String(index)).update("\0").update(bytes).digest("hex");
  const relativePath = `.jugglework/toonflow-media-inputs/${hash}.${extension}`;
  const root = await realpath(workspace.path);
  const directories = [safeWorkspaceChild(root, ".jugglework"), safeWorkspaceChild(root, ".jugglework/toonflow-media-inputs")];
  for (const directory of directories) {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(directory) !== directory) {
      throw new ApiError(400, "video_source_path_unsafe", "视频参考图片目录不安全");
    }
  }
  const target = safeWorkspaceChild(root, relativePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, target).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
      const metadata = await lstat(target);
      if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(target) !== target) throw error;
      const existing = await readFile(target);
      if (!existing.equals(bytes)) throw error;
    });
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return relativePath;
}

/** Only model inference and validated durable media artifacts cross this boundary. */
export function registerToonflowRoutes(options: {
  routes: Route[]; config: ServerConfig; env: EnvService; mediaGenerationRuntime: ToonflowMediaRuntime; imageGenerationRuntime: ToonflowImageBridgeRuntime;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  listProviders?: (workspace: WorkspaceInfo) => Promise<{ all: any[]; connected: string[] }>;
  jsonResponse: (value: unknown, status?: number) => Response;
}) {
  const { routes, config, env, mediaGenerationRuntime, imageGenerationRuntime, resolveWorkspace, jsonResponse } = options;
  const credentials = createWorkspaceProviderCredentialResolver({ config, env });

  async function models(workspaceId: string) {
    const workspace = await resolveWorkspace(config, workspaceId);
    const effective = await readEffectiveWorkspaceOpencodeConfig(config, workspace);
    const disabled = new Set((Array.isArray(effective.disabled_providers) ? effective.disabled_providers : []).map((id: unknown) => String(id).toLowerCase()));
    const enabled = Array.isArray(effective.enabled_providers) ? new Set(effective.enabled_providers) : null;
    const live = await options.listProviders?.(workspace);
    const configuredProviders = record(effective.provider);
    const readyImages = await imageGenerationRuntime.listModels(undefined, { workspaceId });
    const readyImageModels = new Map((Array.isArray(readyImages) ? readyImages : []).flatMap((item: unknown) => {
      const descriptor = record(item);
      const ref = record(descriptor.ref);
      return typeof ref.providerID === "string" && typeof ref.modelID === "string"
        ? [[`${ref.providerID}\0${ref.modelID}`, descriptor]] as const
        : [];
    }));
    const result = [];
    const readyVideoResult = record(await mediaGenerationRuntime.listModels(undefined, { workspaceId }));
    const readyVideoModels = new Set((Array.isArray(readyVideoResult.models) ? readyVideoResult.models : []).flatMap((item: unknown) => {
      const ref = record(record(item).ref);
      return typeof ref.providerID === "string" && typeof ref.modelID === "string" ? [`${ref.providerID}\0${ref.modelID}`] : [];
    }));
    for (const [providerId, configuredValue] of Object.entries(configuredProviders)) {
      if (disabled.has(providerId.toLowerCase()) || (enabled && !enabled.has(providerId))) continue;
      const providerConfig = record(configuredValue);
      const liveProvider = record(live?.all.find(item => item.id === providerId));
      const provider: Record<string, any> = {
        ...liveProvider, ...providerConfig,
        options: { ...record(liveProvider.options), ...record(providerConfig.options) },
        models: { ...record(liveProvider.models), ...record(providerConfig.models) },
      };
      const settings = record(provider.options);
      for (const [modelId, raw] of Object.entries(record(provider.models))) {
        if (Array.isArray(provider.blacklist) && provider.blacklist.includes(modelId)) continue;
        if (Array.isArray(provider.whitelist) && !provider.whitelist.includes(modelId)) continue;
        const model = record(raw);
        const image = readyImageModels.get(`${providerId}\0${modelId}`);
        if (image) {
          result.push({ providerId, providerLabel: String(image.providerName ?? provider.name ?? providerId), modelId,
            label: String(image.modelName ?? model.name ?? modelId), protocol: "openai-completions", type: "image", image: image.capabilities });
          continue;
        }
        if (model.imageGeneration !== undefined) continue;
        const liveModel = record(liveProvider.models?.[modelId]);
        const baseURL = String(settings.baseURL ?? record(model.api).url ?? record(liveModel.api).url ?? provider.api ?? "").replace(/\/+$/, "");
        if (!URL.canParse(baseURL)) continue;
        const url = new URL(baseURL);
        if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) continue;
        const npm = String(record(model.provider).npm ?? record(model.api).npm ?? provider.npm ?? record(liveModel.api).npm ?? "");
        const protocol = npm.includes("anthropic") ? "anthropic-messages" : npm.includes("openai-compatible") ? "openai-completions" : npm.includes("openai") ? "openai-responses" : null;
        if (!protocol) continue;
        const video = parseMediaGenerationCapabilities(model.mediaGeneration);
        if (video && !readyVideoModels.has(`${providerId}\0${modelId}`)) continue;
        const envKeys = Array.isArray(providerConfig.env) ? providerConfig.env.filter((key: unknown): key is string => typeof key === "string") : [];
        const key = await credentials.resolve({ workspaceId, providerID: providerId, modelID: modelId, declaredEnvKeys: envKeys, providerConfig });
        if (!key) continue;
        result.push({ providerId, providerLabel: String(provider.name ?? providerId), modelId, label: String(model.name ?? modelId),
          protocol, type: video ? "video" : "text", video,
          contextWindow: record(model.limit).context, maxOutputTokens: record(model.limit).output,
          baseURL, key });
      }
    }
    return result;
  }

  addRoute(routes, "GET", "/workspace/:id/toonflow/models", "client", async (ctx) =>
    jsonResponse({ models: (await models(ctx.params.id)).map(({ key, baseURL, ...publicModel }) => publicModel) }));

  addRoute(routes, "POST", "/workspace/:id/toonflow/proxy/:providerId/:operation", "client", async (ctx) => {
    if (config.readOnly) throw new ApiError(403, "read_only", "当前服务为只读模式");
    const operation = ctx.params.operation;
    const rawInput: unknown = await readModelRequest(ctx.request);
    const context = { workspaceId: ctx.params.id };

    if (operation === "image") {
      if (!record(rawInput).jobId) {
        const parsed = imageSubmitSchema.safeParse(rawInput);
        if (!parsed.success || parsed.data.providerId !== ctx.params.providerId ||
          parsed.data.payload.model.providerID !== parsed.data.providerId || parsed.data.payload.model.modelID !== parsed.data.modelId) invalidRequest();
        const workspace = await resolveWorkspace(config, ctx.params.id);
        const sourceImagePaths = await Promise.all(parsed.data.payload.references.map((reference, index) =>
          publishMediaSource(workspace, parsed.data.payload.clientRequestId, reference, index)));
        const result = await imageGenerationRuntime.generate({
          clientRequestId: parsed.data.payload.clientRequestId,
          prompt: parsed.data.payload.prompt,
          mode: parsed.data.payload.mode as ImageGenerationMode,
          model: parsed.data.payload.model,
          sourceImagePaths,
          ...(parsed.data.payload.size ? { size: parsed.data.payload.size } : {}),
        }, context);
        return jsonResponse(result);
      }
      const parsed = imageContentSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.providerId !== ctx.params.providerId) invalidRequest();
      const result = await imageGenerationRuntime.getJob(parsed.data.jobId, context) as { job?: unknown };
      const job = record(result.job);
      const model = record(job.model);
      const artifact = record(job.artifact);
      if (model.providerID !== parsed.data.providerId || model.modelID !== parsed.data.modelId) throw new ApiError(403, "unknown_image_job", "此图片任务不属于当前模块或模型");
      if (job.workspaceId !== ctx.params.id || job.status !== "completed" || typeof artifact.path !== "string" || typeof artifact.mimeType !== "string" || typeof artifact.bytes !== "number") {
        throw new ApiError(409, "image_artifact_unavailable", "图片任务尚未生成可用文件");
      }
      const workspace = await resolveWorkspace(config, ctx.params.id);
      const bytes = await readValidatedImageArtifact({ workspaceRoot: workspace.path, artifact: artifact as { path: string; mimeType: string; bytes: number } })
        .catch(() => { throw new ApiError(404, "image_artifact_not_found", "图片文件不可用"); });
      return new Response(new Blob([Uint8Array.from(bytes)]), { headers: {
        "Content-Type": artifact.mimeType, "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${basename(artifact.path)}"`, "Cache-Control": "no-store",
      } });
    }

    if (["video", "videoStatus", "videoContent", "videoCancel"].includes(operation)) {
      if (operation === "video") {
        const parsed = videoSubmitSchema.safeParse(rawInput);
        if (!parsed.success || parsed.data.providerId !== ctx.params.providerId || parsed.data.payload.model.providerID !== parsed.data.providerId || parsed.data.payload.model.modelID !== parsed.data.modelId) invalidRequest();
        const workspace = await resolveWorkspace(config, ctx.params.id);
        const sourceImagePath = parsed.data.payload.source
          ? await publishMediaSource(workspace, parsed.data.payload.clientRequestId, parsed.data.payload.source)
          : undefined;
        const result = await mediaGenerationRuntime.generate({
          prompt: parsed.data.payload.prompt, mode: parsed.data.payload.mode, model: parsed.data.payload.model,
          clientRequestId: parsed.data.payload.clientRequestId,
          ...(sourceImagePath ? { sourceImagePath } : {}),
          ...(parsed.data.payload.durationSeconds ? { durationSeconds: parsed.data.payload.durationSeconds } : {}),
          ...(parsed.data.payload.resolution ? { resolution: parsed.data.payload.resolution } : {}),
        }, context);
        const job = runtimeJob(result, ctx.params.id);
        assertJobModel(job, parsed.data.providerId, parsed.data.modelId);
        if (job.mode !== parsed.data.payload.mode) throw new ApiError(409, "video_request_conflict", "clientRequestId 已用于不同的视频请求");
        return jsonResponse({ job });
      }

      const parsed = videoJobInputSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.operation !== operation || parsed.data.providerId !== ctx.params.providerId) invalidRequest();
      const result = operation === "videoCancel"
        ? await mediaGenerationRuntime.cancelJob(parsed.data.jobId, context)
        : await mediaGenerationRuntime.getJob(parsed.data.jobId, context);
      const job = runtimeJob(result, ctx.params.id);
      assertJobModel(job, parsed.data.providerId, parsed.data.modelId);
      if (operation !== "videoContent") return jsonResponse({ job });
      if (job.status !== "completed" || !job.artifact) throw new ApiError(409, "video_artifact_unavailable", "视频任务尚未生成可用文件");
      const workspace = await resolveWorkspace(config, ctx.params.id);
      const bytes = await readValidatedVideoArtifact({ workspaceRoot: workspace.path, artifact: job.artifact, maxBytes: 512 * 1024 * 1024 })
        .catch(() => { throw new ApiError(404, "video_artifact_not_found", "视频文件不可用"); });
      return new Response(new Blob([Uint8Array.from(bytes)]), { headers: {
        "Content-Type": job.artifact.mimeType, "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${basename(job.artifact.path)}"`, "Cache-Control": "no-store",
      } });
    }

    const input = (() => {
      const parsed = textInputSchema.safeParse(rawInput);
      if (!parsed.success) invalidRequest();
      assertSafeModelPayload(parsed.data.payload);
      return parsed.data;
    })();
    const model = (await models(ctx.params.id)).find((item) => item.providerId === ctx.params.providerId && item.modelId === input.modelId);
    if (!model) throw new ApiError(403, "model_unavailable", "模型未配置、已禁用或凭据不可用，请在 JuggleWork 设置中检查");
    if (!(operation in textPayloadSchemas) || model.type !== "text") throw new ApiError(400, "unsupported_operation", "不支持此模型操作");
    const expectedOperation = textProtocolOperations[model.protocol as keyof typeof textProtocolOperations];
    if (operation !== expectedOperation) throw new ApiError(400, "protocol_mismatch", "模型协议不匹配");
    const payload = textPayloadSchemas[operation as keyof typeof textPayloadSchemas].safeParse(input.payload);
    if (!payload.success) invalidRequest();
    const endpoint = { chat: "chat/completions", responses: "responses", messages: "messages" }[operation]!;
    const requestBody: Record<string, unknown> = { ...payload.data, model: input.modelId };
    const headers: Record<string, string> = { Authorization: `Bearer ${model.key}`, "Content-Type": "application/json" };
    if (operation === "messages") {
      delete headers.Authorization;
      headers["x-api-key"] = String(model.key);
      headers["anthropic-version"] = "2023-06-01";
      const betas = Array.isArray(requestBody.betas) ? requestBody.betas as string[] : [];
      if (record(requestBody.thinking).type === "enabled" && !betas.includes("interleaved-thinking-2025-05-14")) {
        betas.push("interleaved-thinking-2025-05-14");
      }
      if (betas.length) headers["anthropic-beta"] = [...new Set(betas)].join(",");
      delete requestBody.betas;
    }
    const timeoutSignal = AbortSignal.timeout(180_000);
    let upstream: Response;
    try {
      upstream = await externalFetch(`${model.baseURL}/${endpoint}`, { method: "POST", headers, body: JSON.stringify(requestBody), redirect: "error", signal: AbortSignal.any([ctx.request.signal, timeoutSignal]) });
    } catch {
      if (ctx.request.signal.aborted) throw new ApiError(499, "request_cancelled", "模型请求已取消");
      if (timeoutSignal.aborted) throw new ApiError(504, "model_request_timeout", "模型请求超时");
      throw new ApiError(502, "model_transport_failed", "模型请求失败，请检查供应商连接");
    }
    if (!upstream.ok) { await upstream.body?.cancel(); throw new ApiError(upstream.status, "model_request_failed", `模型服务返回 HTTP ${upstream.status}`); }
    const contentType = upstream.headers.get("content-type") ?? "";
    const streaming = requestBody.stream === true;
    if ((streaming && !contentType.toLowerCase().startsWith("text/event-stream")) || (!streaming && !contentType.toLowerCase().startsWith("application/json"))) {
      await upstream.body?.cancel();
      throw new ApiError(502, "invalid_model_response", "模型服务返回了不匹配的响应协议");
    }
    const responseHeaders: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "no-store, no-transform" };
    if (streaming) responseHeaders["X-Accel-Buffering"] = "no";
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  });
}

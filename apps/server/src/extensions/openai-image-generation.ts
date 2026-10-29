import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import {
  IMAGE_GENERATION_MODES,
  parseImageGenerationCapabilities,
  supportsImageGenerationMode,
  type ImageGenerationMode,
  type ImageGenerationCapabilities,
} from "@jugglework/types/media-generation";
import { z } from "zod";

import { ApiError } from "../errors.js";
import type { EnvService } from "../env-file.js";
import { externalFetch } from "../server-fetch.js";
import { readEffectiveWorkspaceOpencodeConfig } from "../effective-workspace-opencode-config.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { createWorkspaceProviderCredentialResolver } from "../provider-credential-resolver.js";
import { redactProviderMessage } from "../media-generation/redaction.js";
import { protectedMediaFetch, type ProtectedMediaRequest, type ProtectedMediaResolver } from "../protected-media-fetch.js";
import { readWorkspaceArtifact } from "../media-generation/artifact-file.js";
import { managedMediaBillingReady, MANAGED_MEDIA_BILLING_DIAGNOSTIC } from "../media-generation/managed-media-billing.js";

export const OPENAI_IMAGE_GENERATION_EXTENSION_ID = "openai-image-generation";
const IMAGE_API_TIMEOUT_MS = 120_000;
const MAX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

export type ImageArtifact = { path: string; bytes: number; mimeType: string };

export const OPENAI_IMAGE_GENERATION_EXTENSION_ACTIONS = [
  { extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action: "status", title: "Configured image generation status", description: "List configured ready image-generation models.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action: "image_models_list", title: "List image-generation models", description: "List ready configured models for text-to-image, image-to-image, or multi-image-to-image.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: [...IMAGE_GENERATION_MODES] } }, additionalProperties: false } },
  { extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action: "image_generate", title: "Generate image artifact", description: "Generate one image artifact with a configured image model. Reference images are mandatory for image edit modes and are never ignored.", inputSchema: { type: "object", required: ["prompt"], properties: { prompt: { type: "string" }, mode: { type: "string", enum: [...IMAGE_GENERATION_MODES] }, model: { type: "object", required: ["providerID", "modelID"], properties: { providerID: { type: "string" }, modelID: { type: "string" } }, additionalProperties: false }, sourceImagePaths: { type: "array", items: { type: "string" }, maxItems: 16 }, size: { type: "string" }, filename: { type: "string" } }, additionalProperties: false } },
];

type ImageModelDescriptor = {
  ref: { providerID: string; modelID: string };
  providerName: string;
  modelName: string;
  capabilities: ImageGenerationCapabilities;
  baseURL: string;
  envKeys: string[];
  providerConfig: Record<string, unknown>;
  availability: "ready" | "missing_credentials" | "unsupported_adapter" | "managed_billing_unavailable";
};

function publicImageModelDescriptor(model: ImageModelDescriptor) {
  return {
    ref: model.ref,
    providerName: model.providerName,
    modelName: model.modelName,
    capabilities: model.capabilities,
    availability: model.availability,
    ...(model.availability === "managed_billing_unavailable" ? { diagnostic: MANAGED_MEDIA_BILLING_DIAGNOSTIC } : {}),
  };
}

const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  mode: z.enum(IMAGE_GENERATION_MODES).default("text-to-image"),
  model: z.object({ providerID: z.string().trim().min(1), modelID: z.string().trim().min(1) }).optional(),
  sourceImagePaths: z.array(z.string().trim().min(1)).max(16).default([]),
  size: z.string().trim().min(1).max(64).optional(),
  filename: z.string().trim().max(100).optional(),
}).strict();

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function workspaceForContext(config: ServerConfig, context: Record<string, unknown>): WorkspaceInfo {
  const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId.trim() : typeof context.workspaceID === "string" ? context.workspaceID.trim() : "";
  const directory = typeof context.directory === "string" ? resolve(context.directory) : typeof context.worktree === "string" ? resolve(context.worktree) : "";
  const matches = config.workspaces.filter((workspace) => workspaceId ? workspace.id === workspaceId : Boolean(directory) && (directory === resolve(workspace.path) || directory.startsWith(`${resolve(workspace.path)}${sep}`)));
  if (matches.length !== 1) throw new ApiError(400, "image_workspace_ambiguous", "Image generation requires one explicit active workspace.");
  return { ...matches[0], path: resolve(matches[0].path) };
}

function safeWorkspaceFile(workspaceRoot: string, relativePath: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${sep}`)) throw new ApiError(400, "invalid_path", "Image path must remain inside the active workspace.");
  return target;
}

function imageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

export async function downloadPublicImageResult(
  value: string,
  options: { resolver?: ProtectedMediaResolver; fetch?: ProtectedMediaRequest } = {},
): Promise<Uint8Array> {
  let response: Response;
  try { response = await protectedMediaFetch(value, { ...options, timeoutMs: IMAGE_API_TIMEOUT_MS }); }
  catch (error) {
    const code = error instanceof Error ? error.message : "external_media_unsafe_url";
    if (code === "external_media_insecure_url") throw new ApiError(502, "image_result_insecure_url", "Image result URL must be credential-free HTTPS.");
    if (code === "external_media_redirect_invalid") throw new ApiError(502, "image_result_redirect_invalid", "Image result redirect was rejected.");
    if (["external_media_invalid_url", "external_media_unsafe_url"].includes(code)) throw new ApiError(502, "image_result_unsafe_url", "Image result URL resolves to a non-public network.");
    throw new ApiError(502, "image_result_download_failed", "Image result download failed.");
  }
  if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ApiError(502, "image_result_download_failed", "Image result download failed."); }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_OUTPUT_IMAGE_BYTES) { await response.body?.cancel().catch(() => undefined); throw new ApiError(413, "image_result_too_large", "Generated image exceeds the 50 MB limit."); }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_OUTPUT_IMAGE_BYTES) { await reader.cancel(); throw new ApiError(413, "image_result_too_large", "Generated image exceeds the 50 MB limit."); }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function configuredImageModels(config: ServerConfig, env: EnvService, workspace: WorkspaceInfo): Promise<ImageModelDescriptor[]> {
  const effective = await readEffectiveWorkspaceOpencodeConfig(config, workspace);
  const credentials = createWorkspaceProviderCredentialResolver({ config, env });
  const result: ImageModelDescriptor[] = [];
  const providers = isRecord(effective.provider) ? effective.provider : {};
  const disabledProviders = new Set(
    (Array.isArray(effective.disabled_providers) ? effective.disabled_providers : [])
      .filter((providerID): providerID is string => typeof providerID === "string")
      .map((providerID) => providerID.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [providerID, rawProvider] of Object.entries(providers)) {
    if (disabledProviders.has(providerID.trim().toLowerCase())) continue;
    if (!isRecord(rawProvider)) continue;
    const options = isRecord(rawProvider.options) ? rawProvider.options : {};
    const baseURL = typeof options.baseURL === "string" ? options.baseURL.trim().replace(/\/+$/, "") : "";
    const envKeys = Array.isArray(rawProvider.env) ? rawProvider.env.filter((key): key is string => typeof key === "string") : [];
    const providerName = typeof rawProvider.name === "string" && rawProvider.name.trim() ? rawProvider.name.trim() : providerID;
    const parsedBaseURL = URL.canParse(baseURL) ? new URL(baseURL) : null;
    const adapterSupported = Boolean(parsedBaseURL && String(rawProvider.npm ?? "").includes("openai") && (
      parsedBaseURL.protocol === "https:" ||
      (parsedBaseURL.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsedBaseURL.hostname))
    ));
    const models = isRecord(rawProvider.models) ? rawProvider.models : {};
    for (const [modelID, rawModel] of Object.entries(models)) {
      if (!isRecord(rawModel)) continue;
      const capabilities = parseImageGenerationCapabilities(rawModel.imageGeneration);
      if (!capabilities) continue;
      const credentialReady = Boolean(await credentials.resolve({ workspaceId: workspace.id, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: rawProvider }));
      const organizationImported = await credentials.organizationProviderProvenance({ workspaceId: workspace.id, providerID, modelID, declaredEnvKeys: envKeys, providerConfig: rawProvider });
      result.push({
        ref: { providerID, modelID }, providerName,
        modelName: typeof rawModel.name === "string" && rawModel.name.trim() ? rawModel.name.trim() : modelID,
        capabilities, baseURL, envKeys, providerConfig: rawProvider,
        availability: !managedMediaBillingReady(rawModel) ? "managed_billing_unavailable" : !adapterSupported ? "unsupported_adapter" : !credentialReady || (envKeys.some((key) => /^JUGGLEWORK_GATEWAY_KEY_V2_/.test(key)) && !organizationImported) ? "missing_credentials" : "ready",
      });
    }
  }
  return result;
}

async function credential(model: ImageModelDescriptor, config: ServerConfig, env: EnvService, workspace: WorkspaceInfo): Promise<string> {
  const value = await createWorkspaceProviderCredentialResolver({ config, env }).resolve({
    workspaceId: workspace.id,
    providerID: model.ref.providerID,
    modelID: model.ref.modelID,
    declaredEnvKeys: model.envKeys,
    providerConfig: model.providerConfig,
  });
  if (value) return value;
  throw new ApiError(400, "image_credential_missing", "The configured image provider credential is unavailable.");
}

async function readReferences(workspace: WorkspaceInfo, paths: string[], mode: ImageGenerationMode) {
  if (mode === "text-to-image" && paths.length) throw new ApiError(400, "image_references_unexpected", "Text-to-image does not accept reference images.");
  if (mode === "image-to-image" && paths.length !== 1) throw new ApiError(400, "image_reference_count_invalid", "Image-to-image requires exactly one reference image.");
  if (mode === "multi-image-to-image" && (paths.length < 2 || paths.length > 16)) throw new ApiError(400, "image_reference_count_invalid", "Multi-image-to-image requires 2 to 16 reference images.");
  return Promise.all(paths.map(async (relativePath) => {
    const path = safeWorkspaceFile(workspace.path, relativePath);
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_INPUT_IMAGE_BYTES) throw new ApiError(413, "image_reference_too_large", "Reference image exceeds the 25 MB limit.");
    const mimeType = imageMime(bytes);
    if (!mimeType || !ALLOWED_IMAGE_MIME.has(mimeType)) throw new ApiError(400, "image_reference_invalid", "Reference image must be PNG, JPEG, or WebP.");
    return { bytes, mimeType, filename: basename(path) };
  }));
}

async function callImageProvider(model: ImageModelDescriptor, apiKey: string, input: z.infer<typeof generateSchema>, references: Awaited<ReturnType<typeof readReferences>>) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_API_TIMEOUT_MS);
  try {
    let response: Response;
    if (input.mode === "text-to-image") {
      response = await externalFetch(`${model.baseURL}/images/generations`, {
        method: "POST", signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model.ref.modelID, prompt: input.prompt,
          output_format: "png", response_format: "b64_json",
          ...(input.size ? { size: input.size } : {}),
        }),
      });
    } else {
      const form = new FormData();
      form.set("model", model.ref.modelID);
      form.set("prompt", input.prompt);
      form.set("output_format", "png");
      if (input.size) form.set("size", input.size);
      for (const reference of references) form.append("image[]", new Blob([reference.bytes], { type: reference.mimeType }), reference.filename);
      response = await externalFetch(`${model.baseURL}/images/edits`, { method: "POST", signal: controller.signal, headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const providerError = redactProviderMessage(isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message : "Image generation failed.", [apiKey]);
      throw new ApiError(response.status, "image_generation_failed", providerError);
    }
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "image_generation_failed", redactProviderMessage(error, [apiKey]));
  } finally { clearTimeout(timeout); }
}

async function resultBytes(payload: unknown): Promise<Uint8Array> {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const first = data.find(isRecord);
  const b64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
  if (b64) {
    const normalized = b64.replace(/\s/g, "");
    if (normalized.length > Math.ceil(MAX_OUTPUT_IMAGE_BYTES / 3) * 4 || normalized.length % 4 === 1 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(normalized)) {
      throw new ApiError(502, "image_invalid_response", "The provider returned invalid or oversized image data.");
    }
    const bytes = Buffer.from(normalized, "base64");
    if (bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) throw new ApiError(413, "image_result_too_large", "Generated image exceeds the 50 MB limit.");
    return bytes;
  }
  const url = typeof first?.url === "string" ? first.url.trim() : "";
  if (!url) throw new ApiError(502, "image_invalid_response", "The provider did not return image data.");
  return downloadPublicImageResult(url);
}

async function publishImage(workspace: WorkspaceInfo, bytes: Uint8Array, requestedName: string | undefined) {
  const mimeType = imageMime(bytes);
  if (!mimeType) throw new ApiError(502, "image_result_invalid_signature", "Generated image has an invalid file signature.");
  const extension = mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
  const stem = (requestedName || `jugglework-image-${Date.now()}`).replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "jugglework-image";
  const relativePath = `artifacts/${stem}${extension}`;
  const output = safeWorkspaceFile(workspace.path, relativePath);
  const temporary = `${output}.${randomUUID()}.tmp`;
  await mkdir(dirname(output), { recursive: true });
  try { await writeFile(temporary, bytes, { flag: "wx" }); await rename(temporary, output); } finally { await rm(temporary, { force: true }).catch(() => undefined); }
  return { path: relativePath, bytes: bytes.byteLength, mimeType };
}

export async function readValidatedImageArtifact(input: { workspaceRoot: string; artifact: ImageArtifact; maxBytes?: number }): Promise<Uint8Array> {
  if (isAbsolute(input.artifact.path) || !input.artifact.path.startsWith("artifacts/") || !ALLOWED_IMAGE_MIME.has(input.artifact.mimeType)) {
    throw new Error("invalid_image_artifact_path");
  }
  const bytes = await readWorkspaceArtifact({
    workspaceRoot: input.workspaceRoot,
    relativePath: input.artifact.path,
    expectedBytes: input.artifact.bytes,
    maxBytes: input.maxBytes ?? MAX_OUTPUT_IMAGE_BYTES,
    pathError: "invalid_image_artifact_path",
    artifactError: "invalid_image_artifact",
  });
  if (imageMime(bytes) !== input.artifact.mimeType) throw new Error("invalid_image_artifact_signature");
  return bytes;
}

export async function callOpenAiImageGenerationExtensionAction(config: ServerConfig, env: EnvService, action: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  let workspace: WorkspaceInfo;
  try {
    workspace = workspaceForContext(config, context);
  } catch (error) {
    if (action !== "status" || config.workspaces.length === 0) throw error;
    workspace = { ...config.workspaces[0], path: resolve(config.workspaces[0].path) };
  }
  const models = await configuredImageModels(config, env, workspace);
  if (action === "status") return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, result: { configured: models.length > 0, connected: models.some((model) => model.availability === "ready"), models: models.map(publicImageModelDescriptor) }, context };
  if (action === "image_models_list") {
    const mode = IMAGE_GENERATION_MODES.includes(args.mode as ImageGenerationMode) ? args.mode as ImageGenerationMode : undefined;
    const ready = models.filter((model) => model.availability === "ready" && (!mode || supportsImageGenerationMode(model.capabilities, mode)));
    return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, result: { models: ready.map(publicImageModelDescriptor) }, context };
  }
  if (action === "image_generate") {
    const parsed = generateSchema.safeParse(args);
    if (!parsed.success) throw new ApiError(400, "invalid_image_generation_payload", "Invalid image generation payload.", parsed.error.flatten());
    const ready = models.filter((model) => model.availability === "ready" && supportsImageGenerationMode(model.capabilities, parsed.data.mode));
    const selected = parsed.data.model ? ready.find((model) => model.ref.providerID === parsed.data.model?.providerID && model.ref.modelID === parsed.data.model?.modelID) : ready[0];
    if (!selected) return { ok: false, error: "no_image_model_available", mode: parsed.data.mode, message: "No configured ready image model supports the requested mode." };
    const references = await readReferences(workspace, parsed.data.sourceImagePaths, parsed.data.mode);
    const payload = await callImageProvider(selected, await credential(selected, config, env, workspace), parsed.data, references);
    const artifact = await publishImage(workspace, await resultBytes(payload), parsed.data.filename);
    return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, path: artifact.path, result: { artifact, model: selected.ref, mode: parsed.data.mode }, context };
  }
  return null;
}

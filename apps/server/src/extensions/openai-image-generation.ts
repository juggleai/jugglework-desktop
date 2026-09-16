import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve, sep } from "node:path";
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
import { readRuntimeOpencodeConfig } from "../runtime-opencode-config-store.js";
import { mergeOpencodeConfigs } from "../runtime-opencode-config-store.js";
import { readJsoncFile } from "../jsonc.js";
import { resolveGlobalOpenCodeConfigPath } from "../mcp.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";

export const OPENAI_IMAGE_GENERATION_EXTENSION_ID = "openai-image-generation";
const IMAGE_API_TIMEOUT_MS = 120_000;
const MAX_INPUT_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_OUTPUT_IMAGE_BYTES = 50 * 1024 * 1024;
const ALLOWED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp"]);

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
  availability: "ready" | "missing_credentials" | "unsupported_adapter";
};

const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(32_000),
  mode: z.enum(IMAGE_GENERATION_MODES).default("text-to-image"),
  model: z.object({ providerID: z.string().trim().min(1), modelID: z.string().trim().min(1) }).optional(),
  sourceImagePaths: z.array(z.string().trim().min(1)).max(16).default([]),
  size: z.string().regex(/^(?:auto|\d{2,5}x\d{2,5})$/).optional(),
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

async function configuredImageModels(config: ServerConfig, env: EnvService, workspace: WorkspaceInfo): Promise<ImageModelDescriptor[]> {
  const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
  const { data: globalConfig } = await readJsoncFile(
    resolveGlobalOpenCodeConfigPath(),
    {} as Record<string, unknown>,
    { allowInvalid: true, maxBytes: 1024 * 1024, regularFileOnly: true },
  );
  const effective = mergeOpencodeConfigs(globalConfig, runtime);
  const envRecords = await env.list();
  const envMap = new Map(envRecords.map((entry) => [entry.key, entry.value]));
  const result: ImageModelDescriptor[] = [];
  const providers = isRecord(effective.provider) ? effective.provider : {};
  for (const [providerID, rawProvider] of Object.entries(providers)) {
    if (!isRecord(rawProvider)) continue;
    const options = isRecord(rawProvider.options) ? rawProvider.options : {};
    const baseURL = typeof options.baseURL === "string" ? options.baseURL.trim().replace(/\/+$/, "") : "";
    const envKeys = Array.isArray(rawProvider.env) ? rawProvider.env.filter((key): key is string => typeof key === "string") : [];
    const providerName = typeof rawProvider.name === "string" && rawProvider.name.trim() ? rawProvider.name.trim() : providerID;
    const adapterSupported = /^https:\/\//i.test(baseURL) && String(rawProvider.npm ?? "").includes("openai");
    const credentialReady = envKeys.some((key) => Boolean(envMap.get(key)?.trim() || process.env[key]?.trim()));
    const models = isRecord(rawProvider.models) ? rawProvider.models : {};
    for (const [modelID, rawModel] of Object.entries(models)) {
      if (!isRecord(rawModel)) continue;
      const capabilities = parseImageGenerationCapabilities(rawModel.imageGeneration);
      if (!capabilities) continue;
      result.push({
        ref: { providerID, modelID }, providerName,
        modelName: typeof rawModel.name === "string" && rawModel.name.trim() ? rawModel.name.trim() : modelID,
        capabilities, baseURL, envKeys,
        availability: !adapterSupported ? "unsupported_adapter" : !credentialReady ? "missing_credentials" : "ready",
      });
    }
  }
  return result;
}

async function credential(model: ImageModelDescriptor, env: EnvService): Promise<string> {
  const records = await env.list();
  for (const key of model.envKeys) {
    const value = records.find((entry) => entry.key === key)?.value.trim() || process.env[key]?.trim();
    if (value) return value;
  }
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
        body: JSON.stringify({ model: model.ref.modelID, prompt: input.prompt, n: 1, output_format: "png", ...(input.size ? { size: input.size } : {}) }),
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
      const providerError = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string" ? payload.error.message.slice(0, 500) : "Image generation failed.";
      throw new ApiError(response.status, "image_generation_failed", providerError);
    }
    return payload;
  } finally { clearTimeout(timeout); }
}

async function resultBytes(payload: unknown): Promise<Uint8Array> {
  const data = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
  const first = data.find(isRecord);
  const b64 = typeof first?.b64_json === "string" ? first.b64_json.trim() : "";
  if (b64) return Buffer.from(b64, "base64");
  const url = typeof first?.url === "string" ? first.url.trim() : "";
  if (!url) throw new ApiError(502, "image_invalid_response", "The provider did not return image data.");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new ApiError(502, "image_result_insecure_url", "Image result URL must use HTTPS.");
  const response = await externalFetch(parsed.toString(), { redirect: "follow" });
  if (!response.ok) throw new ApiError(502, "image_result_download_failed", "Image result download failed.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_OUTPUT_IMAGE_BYTES) throw new ApiError(413, "image_result_too_large", "Generated image exceeds the 50 MB limit.");
  return bytes;
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

export async function callOpenAiImageGenerationExtensionAction(config: ServerConfig, env: EnvService, action: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  let workspace: WorkspaceInfo;
  try {
    workspace = workspaceForContext(config, context);
  } catch (error) {
    if (action !== "status" || config.workspaces.length === 0) throw error;
    workspace = { ...config.workspaces[0], path: resolve(config.workspaces[0].path) };
  }
  const models = await configuredImageModels(config, env, workspace);
  if (action === "status") return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, result: { configured: models.length > 0, connected: models.some((model) => model.availability === "ready"), models }, context };
  if (action === "image_models_list") {
    const mode = IMAGE_GENERATION_MODES.includes(args.mode as ImageGenerationMode) ? args.mode as ImageGenerationMode : undefined;
    const ready = models.filter((model) => model.availability === "ready" && (!mode || supportsImageGenerationMode(model.capabilities, mode)));
    return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, result: { models: ready }, context };
  }
  if (action === "image_generate") {
    const parsed = generateSchema.safeParse(args);
    if (!parsed.success) throw new ApiError(400, "invalid_image_generation_payload", "Invalid image generation payload.", parsed.error.flatten());
    const ready = models.filter((model) => model.availability === "ready" && supportsImageGenerationMode(model.capabilities, parsed.data.mode));
    const selected = parsed.data.model ? ready.find((model) => model.ref.providerID === parsed.data.model?.providerID && model.ref.modelID === parsed.data.model?.modelID) : ready[0];
    if (!selected) return { ok: false, error: "no_image_model_available", mode: parsed.data.mode, message: "No configured ready image model supports the requested mode." };
    const references = await readReferences(workspace, parsed.data.sourceImagePaths, parsed.data.mode);
    const payload = await callImageProvider(selected, await credential(selected, env), parsed.data, references);
    const artifact = await publishImage(workspace, await resultBytes(payload), parsed.data.filename);
    return { ok: true, extensionId: OPENAI_IMAGE_GENERATION_EXTENSION_ID, action, path: artifact.path, result: { artifact, model: selected.ref, mode: parsed.data.mode }, context };
  }
  return null;
}

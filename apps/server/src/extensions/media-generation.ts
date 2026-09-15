import { z } from "zod";
import type { VideoGenerationMode } from "@jugglework/types/media-generation";

export const MEDIA_GENERATION_EXTENSION_ID = "media-generation";

const modelSchema = z.object({ providerID: z.string().trim().min(1), modelID: z.string().trim().min(1) }).strict();
const modeSchema = z.enum(["text-to-video", "image-to-video"]);
const generateSchema = z.object({
  prompt: z.string().trim().min(1).max(20_000),
  mode: modeSchema,
  model: modelSchema.optional(),
  sourceImagePath: z.string().trim().min(1).optional(),
  sourceImageMimeType: z.enum(["image/jpeg", "image/png", "image/webp"]).optional(),
  durationSeconds: z.number().int().positive().max(20).optional(),
  resolution: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  filename: z.string().trim().min(1).max(100).optional(),
  clientRequestId: z.string().trim().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.mode === "image-to-video" && !value.sourceImagePath) context.addIssue({ code: "custom", message: "sourceImagePath is required for image-to-video" });
  if (value.mode === "text-to-video" && value.sourceImagePath) context.addIssue({ code: "custom", message: "sourceImagePath is only accepted for image-to-video" });
});

const jobSchema = z.object({ jobId: z.string().trim().min(1) }).strict();
const listSchema = z.object({ mode: modeSchema.optional() }).strict();

export const MEDIA_GENERATION_EXTENSION_ACTIONS = [
  { extensionId: MEDIA_GENERATION_EXTENSION_ID, action: "status", title: "Video generation status", description: "Check whether video submission is enabled and list non-secret readiness diagnostics. This action never generates a video.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { extensionId: MEDIA_GENERATION_EXTENSION_ID, action: "video_models_list", title: "List video generation models", description: "Call before generation. Lists only configured models with explicit text-to-video or image-to-video capability and reports whether they are executable. If none are ready, report no_video_model_available; never guess from a model name.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["text-to-video", "image-to-video"] } }, additionalProperties: false } },
  { extensionId: MEDIA_GENERATION_EXTENSION_ID, action: "video_generate", title: "Start asynchronous video generation", description: "Create one asynchronous video job and return immediately. A reference image requires image-to-video mode and must never be silently ignored. Poll video_job_get; never automatically resubmit a failed paid job.", inputSchema: { type: "object", required: ["prompt", "mode", "clientRequestId"], properties: { prompt: { type: "string" }, mode: { type: "string", enum: ["text-to-video", "image-to-video"] }, model: { type: "object", properties: { providerID: { type: "string" }, modelID: { type: "string" } }, required: ["providerID", "modelID"], additionalProperties: false }, sourceImagePath: { type: "string" }, sourceImageMimeType: { type: "string", enum: ["image/jpeg", "image/png", "image/webp"] }, durationSeconds: { type: "integer", minimum: 1, maximum: 20 }, resolution: { type: "string" }, filename: { type: "string" }, clientRequestId: { type: "string" } }, additionalProperties: false } },
  { extensionId: MEDIA_GENERATION_EXTENSION_ID, action: "video_job_get", title: "Get video job", description: "Read current progress and completed artifact metadata for an existing video job.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } }, additionalProperties: false } },
  { extensionId: MEDIA_GENERATION_EXTENSION_ID, action: "video_job_cancel", title: "Cancel video job", description: "Request cancellation. OpenAI-compatible video APIs may not support provider-side cancellation, so cancellation is best effort and never deletes completed output.", inputSchema: { type: "object", required: ["jobId"], properties: { jobId: { type: "string" } }, additionalProperties: false } },
] as const;

export type MediaGenerationExtensionRuntime = {
  status(context: Record<string, unknown>): Promise<unknown>;
  listModels(mode: VideoGenerationMode | undefined, context: Record<string, unknown>): Promise<unknown>;
  generate(input: z.infer<typeof generateSchema>, context: Record<string, unknown>): Promise<unknown>;
  getJob(jobId: string, context: Record<string, unknown>): Promise<unknown>;
  cancelJob(jobId: string, context: Record<string, unknown>): Promise<unknown>;
};

export async function callMediaGenerationExtensionAction(runtime: MediaGenerationExtensionRuntime, action: string, args: Record<string, unknown>, context: Record<string, unknown>) {
  const parse = <T>(schema: z.ZodType<T>): T => {
    const result = schema.safeParse(args);
    if (!result.success) throw new Error(`invalid_video_generation_payload:${result.error.issues.map((issue) => issue.message).join("; ")}`);
    return result.data;
  };
  if (action === "status") return { ok: true, extensionId: MEDIA_GENERATION_EXTENSION_ID, action, result: await runtime.status(context), context };
  if (action === "video_models_list") { const input = parse(listSchema); return { ok: true, extensionId: MEDIA_GENERATION_EXTENSION_ID, action, result: await runtime.listModels(input.mode, context), context }; }
  if (action === "video_generate") { const result = await runtime.generate(parse(generateSchema), context); return { ok: true, extensionId: MEDIA_GENERATION_EXTENSION_ID, action, result, context }; }
  if (action === "video_job_get") { const input = parse(jobSchema); return { ok: true, extensionId: MEDIA_GENERATION_EXTENSION_ID, action, result: await runtime.getJob(input.jobId, context), context }; }
  if (action === "video_job_cancel") { const input = parse(jobSchema); return { ok: true, extensionId: MEDIA_GENERATION_EXTENSION_ID, action, result: await runtime.cancelJob(input.jobId, context), context }; }
  return null;
}

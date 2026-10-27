import { createHash } from "node:crypto";
import type { ImageGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";
import type { EnvService } from "../env-file.js";
import { ApiError } from "../errors.js";
import { callOpenAiImageGenerationExtensionAction, type ImageArtifact } from "../extensions/openai-image-generation.js";
import type { ServerConfig } from "../types.js";
import { ImageGenerationRepository, publicImageGenerationJob } from "./repository.js";

type GenerateImageInput = {
  clientRequestId: string;
  prompt: string;
  mode: ImageGenerationMode;
  model: VideoModelRef;
  sourceImagePaths: string[];
  size?: string;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export class ToonflowImageRuntime {
  constructor(private readonly options: { config: ServerConfig; env: EnvService; repository: ImageGenerationRepository }) {}

  async listModels(mode: ImageGenerationMode | undefined, context: Record<string, unknown>) {
    const response = record(await callOpenAiImageGenerationExtensionAction(
      this.options.config, this.options.env, "image_models_list", mode ? { mode } : {}, context,
    ));
    return record(response.result).models;
  }

  async generate(input: GenerateImageInput, context: Record<string, unknown>) {
    const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId.trim() : "";
    if (!workspaceId) throw new ApiError(400, "image_workspace_ambiguous", "Image generation requires one explicit active workspace.");
    const requestHash = createHash("sha256").update(JSON.stringify({
      prompt: input.prompt, mode: input.mode, model: input.model, sourceImagePaths: input.sourceImagePaths, size: input.size ?? null,
    })).digest("hex");
    let claimed;
    try {
      claimed = this.options.repository.claim({ workspaceId, clientRequestId: input.clientRequestId, requestHash, model: input.model, mode: input.mode });
    } catch (error) {
      if (error instanceof Error && error.message === "image_request_conflict") {
        throw new ApiError(409, "image_request_conflict", "clientRequestId is already bound to a different image request.");
      }
      throw error;
    }
    if (!claimed.created) return { job: publicImageGenerationJob(claimed.job) };
    try {
      const response = record(await callOpenAiImageGenerationExtensionAction(this.options.config, this.options.env, "image_generate", {
        prompt: input.prompt, mode: input.mode, model: input.model, sourceImagePaths: input.sourceImagePaths,
        ...(input.size ? { size: input.size } : {}), filename: `toonflow-${claimed.job.id}`,
      }, context));
      if (response.ok !== true) {
        const failed = this.options.repository.finish(claimed.job.id, "failed", { error: { code: "no_image_model_available", message: "The selected image model is unavailable." } });
        return { job: publicImageGenerationJob(failed) };
      }
      const artifact = record(record(response.result).artifact);
      if (typeof artifact.path !== "string" || typeof artifact.mimeType !== "string" || typeof artifact.bytes !== "number" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
        throw new Error("invalid_image_artifact");
      }
      const completed = this.options.repository.finish(claimed.job.id, "completed", { artifact: artifact as ImageArtifact });
      return { job: publicImageGenerationJob(completed) };
    } catch (error) {
      const known = error instanceof ApiError;
      const failed = this.options.repository.finish(claimed.job.id, known && error.status < 500 ? "failed" : "submission_unknown", {
        error: known
          ? { code: error.code, message: error.message }
          : { code: "image_submission_outcome_unknown", message: "Image generation outcome is unknown and will not be resubmitted automatically." },
      });
      return { job: publicImageGenerationJob(failed) };
    }
  }

  getJob(jobId: string, context: Record<string, unknown>) {
    const workspaceId = typeof context.workspaceId === "string" ? context.workspaceId.trim() : "";
    const job = this.options.repository.get(jobId);
    if (!job || job.workspaceId !== workspaceId) throw new ApiError(404, "image_job_not_found", "Image job not found.");
    return { job: publicImageGenerationJob(job) };
  }
}

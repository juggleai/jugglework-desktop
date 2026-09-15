import { resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { VideoGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";
import type { WorkspaceInfo } from "../types.js";
import { MediaGenerationRepository } from "./repository.js";
import type { VideoGenerationAdapter, VideoGenerationJob } from "./types.js";

export type SubmitVideoRequest = {
  workspace: WorkspaceInfo;
  sessionId?: string;
  clientRequestId: string;
  prompt: string;
  mode: VideoGenerationMode;
  model: VideoModelRef;
  sourceImagePath?: string;
  options?: { durationSeconds?: number; resolution?: string };
};

export class MediaGenerationService {
  constructor(private readonly options: {
    repository: MediaGenerationRepository;
    adapters: VideoGenerationAdapter[];
    submissionEnabled: boolean;
    maxDurationSeconds?: number;
    maxConcurrentJobs?: number;
    audit?: (event: { action: string; jobId: string; workspaceId: string; sessionId?: string; providerID: string; modelID: string; mode: VideoGenerationMode; status: string }) => void;
  }) {}

  getJob(id: string, workspaceId: string): VideoGenerationJob | null {
    const job = this.options.repository.get(id);
    return job?.workspaceId === workspaceId ? job : null;
  }

  async submit(input: SubmitVideoRequest, signal = new AbortController().signal): Promise<VideoGenerationJob> {
    if (!this.options.submissionEnabled) throw new Error("video_submission_disabled");
    if (!input.prompt.trim()) throw new Error("video_prompt_required");
    if (!input.clientRequestId.trim()) throw new Error("video_client_request_id_required");
    if (this.options.repository.countActive(input.workspace.id) >= (this.options.maxConcurrentJobs ?? 2)) throw new Error("video_workspace_concurrency_limit");
    if (input.mode === "image-to-video" && !input.sourceImagePath) throw new Error("video_source_image_required");
    const duration = input.options?.durationSeconds;
    if (duration !== undefined && (!Number.isInteger(duration) || duration <= 0 || duration > (this.options.maxDurationSeconds ?? 20))) throw new Error("video_duration_invalid");
    const adapter = this.options.adapters.find((candidate) => candidate.matches(input.model));
    if (!adapter) throw new Error("no_video_model_available");
    const sourceImagePath = input.sourceImagePath ? await validateSourceImage(input.workspace, input.sourceImagePath) : undefined;
    let job = this.options.repository.createOrGet({
      workspaceId: input.workspace.id, sessionId: input.sessionId, clientRequestId: input.clientRequestId,
      model: input.model, mode: input.mode, options: input.options ?? {},
    });
    if (job.status !== "queued") return job;
    job = this.options.repository.transition(job.id, job.revision, "submitting");
    try {
      const submitted = await adapter.submit({
        jobId: job.id, clientRequestId: input.clientRequestId, model: input.model, mode: input.mode,
        prompt: input.prompt.trim(), ...(sourceImagePath ? { sourceImagePath } : {}), options: input.options ?? {},
      }, signal);
      const accepted = this.options.repository.transition(job.id, job.revision, "submitted", { providerJobId: submitted.providerJobId, nextPollAt: Date.now() });
      this.options.audit?.({ action: "video_generation_submitted", jobId: accepted.id, workspaceId: accepted.workspaceId, ...(accepted.sessionId ? { sessionId: accepted.sessionId } : {}), providerID: accepted.model.providerID, modelID: accepted.model.modelID, mode: accepted.mode, status: accepted.status });
      return accepted;
    } catch (error) {
      // Keep ambiguous network failures in submitting so the same paid request is never automatically resubmitted.
      if (error instanceof Error && error.message === "video_provider_invalid_response") throw error;
      return this.options.repository.transition(job.id, job.revision, "failed", { error: normalizeError(error) });
    }
  }

  cancel(id: string, workspaceId: string): VideoGenerationJob {
    const job = this.getJob(id, workspaceId);
    if (!job) throw new Error("video_job_not_found");
    return this.options.repository.requestCancellation(id);
  }
}

async function validateSourceImage(workspace: WorkspaceInfo, relativePath: string): Promise<string> {
  const root = resolve(workspace.path);
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("video_source_image_invalid_path");
  const file = await stat(target);
  if (!file.isFile() || file.size > 25 * 1024 * 1024) throw new Error("video_source_image_invalid");
  const signature = new Uint8Array(await readFile(target).then((bytes) => bytes.subarray(0, 12)));
  const jpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const png = signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
  const webp = signature.length >= 12 && String.fromCharCode(...signature.slice(0, 4)) === "RIFF" && String.fromCharCode(...signature.slice(8, 12)) === "WEBP";
  if (!jpeg && !png && !webp) throw new Error("video_source_image_invalid_signature");
  return target;
}

function normalizeError(error: unknown) {
  const message = error instanceof Error ? error.message.slice(0, 500) : "Video generation failed.";
  return { code: message.startsWith("video_") ? message : "video_provider_failed", message, retryable: /timeout|rate_limited/.test(message) };
}

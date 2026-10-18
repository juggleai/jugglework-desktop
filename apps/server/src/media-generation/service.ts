import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { VideoGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";
import type { WorkspaceInfo } from "../types.js";
import { MediaGenerationRepository } from "./repository.js";
import type { VideoGenerationAdapter, VideoGenerationJob } from "./types.js";
import { redactProviderMessage, VideoSubmissionError } from "./redaction.js";

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

export function videoSubmissionAllowed(input: {
  explicitFlagEnabled: boolean;
  organizationImportedModel: boolean;
}): boolean {
  return input.explicitFlagEnabled || input.organizationImportedModel;
}

export async function filterVideoSubmissionEligibleModels<T extends { ref: VideoModelRef }>(input: {
  models: T[];
  explicitFlagEnabled: boolean;
  isOrganizationImportedModel: (model: VideoModelRef) => Promise<boolean>;
}): Promise<T[]> {
  if (input.explicitFlagEnabled) return input.models;
  const eligibility = await Promise.all(input.models.map((model) => input.isOrganizationImportedModel(model.ref)));
  return input.models.filter((_, index) => eligibility[index]);
}

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
    if (!input.clientRequestId.trim()) throw new Error("video_client_request_id_required");
    if (!input.prompt.trim()) throw new Error("video_prompt_required");
    if (input.mode === "image-to-video" && !input.sourceImagePath) throw new Error("video_source_image_required");
    const duration = input.options?.durationSeconds;
    if (duration !== undefined && (!Number.isInteger(duration) || duration <= 0 || duration > (this.options.maxDurationSeconds ?? 20))) throw new Error("video_duration_invalid");
    const sourceImage = input.sourceImagePath ? await validateSourceImage(input.workspace, input.sourceImagePath) : undefined;
    const requestHash = hashVideoRequest(input, sourceImage?.sha256);
    const existing = this.options.repository.getByRequest(input.workspace.id, input.sessionId, input.clientRequestId);
    if (existing) return this.options.repository.createOrGet({
      workspaceId: input.workspace.id, sessionId: input.sessionId, clientRequestId: input.clientRequestId, requestHash,
      model: input.model, mode: input.mode, options: input.options ?? {},
    });
    if (!this.options.submissionEnabled) throw new Error("video_submission_disabled");
    if (this.options.repository.countActive(input.workspace.id) >= (this.options.maxConcurrentJobs ?? 2)) throw new Error("video_workspace_concurrency_limit");
    const adapter = this.options.adapters.find((candidate) => candidate.matches(input.model));
    if (!adapter) throw new Error("no_video_model_available");
    let job = this.options.repository.createOrGet({
      workspaceId: input.workspace.id, sessionId: input.sessionId, clientRequestId: input.clientRequestId,
      requestHash, model: input.model, mode: input.mode, options: input.options ?? {},
    });
    if (job.status !== "queued") return job;
    const claimed = this.options.repository.claimSubmission(job.id, job.revision, adapter.binding);
    if (!claimed.claimed) return claimed.job;
    job = claimed.job;
    try {
      const submitted = await adapter.submit({
        jobId: job.id, clientRequestId: input.clientRequestId, model: input.model, mode: input.mode,
        prompt: input.prompt.trim(), ...(sourceImage ? { sourceImagePath: sourceImage.path } : {}), options: input.options ?? {},
      }, signal);
      const accepted = this.options.repository.transition(job.id, job.revision, "submitted", { providerJobId: submitted.providerJobId, adapterBinding: adapter.binding, nextPollAt: Date.now() });
      this.options.audit?.({ action: "video_generation_submitted", jobId: accepted.id, workspaceId: accepted.workspaceId, ...(accepted.sessionId ? { sessionId: accepted.sessionId } : {}), providerID: accepted.model.providerID, modelID: accepted.model.modelID, mode: accepted.mode, status: accepted.status });
      return accepted;
    } catch (error) {
      if (error instanceof VideoSubmissionError && error.outcome === "rejected") {
        return this.options.repository.transition(job.id, job.revision, "failed", { error: normalizeError(error) });
      }
      if (!(error instanceof VideoSubmissionError) && error instanceof Error && error.message === "video_credential_missing") {
        return this.options.repository.transition(job.id, job.revision, "failed", { error: normalizeError(error) });
      }
      if (adapter.reconcileSubmission) {
        try {
          const reconciled = await adapter.reconcileSubmission(input.clientRequestId, signal);
          if (reconciled) return this.options.repository.transition(job.id, job.revision, "submitted", {
            providerJobId: reconciled.providerJobId, adapterBinding: adapter.binding, nextPollAt: Date.now(),
          });
        } catch {
          // The persisted unknown state is safer than guessing whether a paid request was accepted.
        }
      }
      return this.options.repository.transition(job.id, job.revision, "submission_unknown", {
        error: {
          code: error instanceof VideoSubmissionError ? error.code : "video_submission_outcome_unknown",
          message: redactProviderMessage(error),
          retryable: false,
        },
      });
    }
  }

  cancel(id: string, workspaceId: string): VideoGenerationJob {
    const job = this.getJob(id, workspaceId);
    if (!job) throw new Error("video_job_not_found");
    return this.options.repository.requestCancellation(id);
  }
}

async function validateSourceImage(workspace: WorkspaceInfo, relativePath: string): Promise<{ path: string; sha256: string }> {
  const root = resolve(workspace.path);
  const target = resolve(root, relativePath);
  if (!target.startsWith(`${root}${sep}`)) throw new Error("video_source_image_invalid_path");
  const file = await stat(target);
  if (!file.isFile() || file.size > 25 * 1024 * 1024) throw new Error("video_source_image_invalid");
  const bytes = await readFile(target);
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("video_source_image_invalid");
  const signature = new Uint8Array(bytes.subarray(0, 12));
  const jpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
  const png = signature.length >= 8 && signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e && signature[3] === 0x47;
  const webp = signature.length >= 12 && String.fromCharCode(...signature.slice(0, 4)) === "RIFF" && String.fromCharCode(...signature.slice(8, 12)) === "WEBP";
  if (!jpeg && !png && !webp) throw new Error("video_source_image_invalid_signature");
  return { path: target, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function hashVideoRequest(input: SubmitVideoRequest, sourceImageSha256?: string): string {
  return createHash("sha256").update(stableStringify({
    workspaceId: input.workspace.id,
    sessionId: input.sessionId ?? null,
    providerID: input.model.providerID,
    modelID: input.model.modelID,
    mode: input.mode,
    prompt: input.prompt.trim(),
    sourceImageSha256: sourceImageSha256 ?? null,
    options: input.options ?? {},
  })).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item) ?? "null").join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function normalizeError(error: unknown) {
  const message = redactProviderMessage(error);
  const code = error instanceof VideoSubmissionError ? error.code : message.startsWith("video_") ? message : "video_provider_failed";
  return { code, message, retryable: error instanceof VideoSubmissionError ? error.retryable : /timeout|rate_limited/.test(message) };
}

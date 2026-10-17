import type {
  ToonMediaCandidate,
  ToonMediaJob,
  ToonMediaJobCreateRequest,
} from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import type { MediaGenerationExtensionRuntime } from "../extensions/media-generation.js";
import type { ToonFactoryRepository } from "./repository.js";
import { ToonMediaJobRepository } from "./media-job-repository.js";
import type { ToonModelPolicyStore } from "./model-policy-store.js";
import type { ToonWorkspaceMediaProjector } from "./workspace-media-projector.js";

type ImageAction = (action: string, args: Record<string, unknown>, context: Record<string, unknown>) => Promise<unknown>;

const TERMINAL = new Set(["awaiting-review", "adopted", "rejected", "failed", "cancelled", "submission_unknown"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function runtimeJob(value: unknown): Record<string, unknown> | null {
  const outer = record(value);
  return record(outer?.job) ?? record(record(outer?.result)?.job);
}

function aggregateStatus(candidates: ToonMediaCandidate[]): ToonMediaJob["status"] {
  if (candidates.some((candidate) => candidate.status === "submission_unknown")) return "submission_unknown";
  if (candidates.some((candidate) => ["queued", "submitting", "running"].includes(candidate.status))) return candidates.some((candidate) => candidate.status === "submitting") ? "submitting" : "running";
  if (candidates.some((candidate) => ["awaiting-review", "adopted", "rejected"].includes(candidate.status))) return candidates.some((candidate) => candidate.status === "adopted") ? "adopted" : "awaiting-review";
  if (candidates.every((candidate) => candidate.status === "cancelled")) return "cancelled";
  return "failed";
}

export class ToonMediaJobService {
  private readonly active = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly unsubscribePolicy?: () => void;

  constructor(private readonly options: {
    jobs: ToonMediaJobRepository;
    repository: (workspaceId: string) => Promise<ToonFactoryRepository>;
    imageAction: ImageAction;
    mediaGeneration: MediaGenerationExtensionRuntime;
    modelPolicy?: ToonModelPolicyStore;
    providerSource?: (workspaceId: string, providerID: string) => Promise<unknown>;
    workspaceProjector?: ToonWorkspaceMediaProjector;
  }) {
    this.unsubscribePolicy = options.modelPolicy?.subscribe((workspaceId) => {
      for (const job of this.options.jobs.listActive().filter((candidate) => candidate.workspaceId === workspaceId)) this.dispatch(job.id);
    });
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const job of this.options.jobs.listActive()) this.dispatch(job.id);
    this.schedule(0);
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubscribePolicy?.();
    await Promise.allSettled(this.active.values());
  }

  dispatch(id: string): void {
    if (this.active.has(id)) return;
    const run = this.run(id).catch(() => undefined).finally(() => this.active.delete(id));
    this.active.set(id, run);
  }

  async refresh(id: string): Promise<ToonMediaJob> {
    const job = this.options.jobs.require(id);
    if (job.kind === "video" && !TERMINAL.has(job.status)) await this.reconcileVideo(id);
    return this.options.jobs.require(id);
  }

  async cancel(id: string): Promise<ToonMediaJob> {
    const now = new Date().toISOString();
    const current = this.options.jobs.require(id);
    if (current.kind !== "video") throw new ApiError(409, "toon_media_cancel_unsupported", "This image runtime does not support cancellation");
    let job = this.options.jobs.update(id, (stored) => {
      if (TERMINAL.has(stored.status) || stored.status === "cancel_requested") return stored;
      const candidates = stored.candidates.map((candidate) => {
        if (TERMINAL.has(candidate.status)) return candidate;
        if (candidate.runtimeJobId) return { ...candidate, status: "running" as const, updatedAt: now };
        if (candidate.status === "submitting") return {
          ...candidate,
          status: "submission_unknown" as const,
          error: { code: "toon_video_submission_unknown", message: "Cancellation raced with submission; the provider outcome is unknown.", retryable: false },
          updatedAt: now,
        };
        return { ...candidate, status: "cancelled" as const, updatedAt: now };
      });
      return {
        ...stored,
        status: candidates.some((candidate) => candidate.runtimeJobId && !TERMINAL.has(candidate.status)) ? "cancel_requested" : aggregateStatus(candidates),
        candidates,
        cancellation: {
          requestedAt: now,
          remoteMayContinue: candidates.some((candidate) => Boolean(candidate.runtimeJobId) || candidate.status === "submission_unknown"),
          message: "Cancellation is best effort; a submitted remote job may continue processing.",
        },
      };
    });
    const context = { workspaceId: job.workspaceId, sessionId: `toon-factory:${job.projectId}` };
    for (const candidate of job.candidates) {
      if (!candidate.runtimeJobId || TERMINAL.has(candidate.status)) continue;
      await this.options.mediaGeneration.cancelJob(candidate.runtimeJobId, context).catch(() => undefined);
    }
    await this.persist(job);
    return this.options.jobs.require(id);
  }

  async review(id: string, candidateId: string, decision: "adopted" | "rejected", humanOperation?: { operationId: string; adoptionId: string; principalId: string; episodeId: string; workflowRecordId: string }): Promise<ToonMediaJob> {
    const current = this.options.jobs.require(id);
    const selected = current.candidates.find((candidate) => candidate.id === candidateId);
    if (!selected) throw new ApiError(404, "toon_media_candidate_not_found", "Toon Factory media candidate not found");
    if (!selected.artifact || !["awaiting-review", "adopted", "rejected"].includes(selected.status) || decision === "rejected" && selected.status === "adopted") {
      throw new ApiError(409, "toon_media_candidate_not_reviewable", "The media candidate is not ready for review");
    }
    if (decision === "adopted" && this.runtimeGeneration(current)) {
      if (!humanOperation) throw new ApiError(403, "toon_human_action_required", "V2 candidate adoption requires an explicit human operation");
      // Portable truth commits first. If the process stops before the SQLite
      // review update, retrying the same human operation safely completes it.
      await this.options.workspaceProjector!.adopt(current, selected, humanOperation);
    }
    const now = new Date().toISOString();
    const job = this.options.jobs.update(id, (stored) => {
      const storedSelected = stored.candidates.find((candidate) => candidate.id === candidateId);
      if (!storedSelected?.artifact || !["awaiting-review", "adopted", "rejected"].includes(storedSelected.status)
        || decision === "rejected" && storedSelected.status === "adopted") {
        throw new ApiError(409, "toon_media_candidate_not_reviewable", "The media candidate is not ready for review");
      }
      const candidates = stored.candidates.map((candidate) => {
        if (candidate.id === candidateId) {
          return { ...candidate, status: decision, review: { decision, reviewedAt: now }, updatedAt: now };
        }
        if (decision === "adopted" && candidate.status === "adopted") {
          return { ...candidate, status: "awaiting-review" as const, review: { decision: "pending" as const }, updatedAt: now };
        }
        return candidate;
      });
      return { ...stored, status: aggregateStatus(candidates), candidates };
    });
    await this.persist(job);
    return this.options.jobs.require(id);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const job of this.options.jobs.listActive()) this.dispatch(job.id);
      for (const job of this.options.jobs.listProjectionDirty()) this.dispatch(job.id);
      this.schedule(2_000);
    }, delay);
  }

  private async run(id: string): Promise<void> {
    let job = this.options.jobs.require(id);
    const repository = await this.options.repository(job.workspaceId);
    const v2 = this.runtimeGeneration(job);
    if (job.projectionPending && TERMINAL.has(job.status)) {
      await this.persist(job);
      return;
    }
    if (!TERMINAL.has(job.status) && !(v2 ? await this.options.workspaceProjector!.owns(job) : await repository.ownsMediaJob(job))) {
      job = this.options.jobs.update(id, (current, now) => {
        const uncertain = current.candidates.some((candidate) => candidate.status === "submitting" && !candidate.runtimeJobId);
        const candidates = current.candidates.map((candidate) => {
          if (TERMINAL.has(candidate.status)) return candidate;
          if (candidate.runtimeJobId) return {
            ...candidate,
            status: "submission_unknown" as const,
            error: { code: "toon_media_job_superseded", message: "The provider job exists but a newer workflow job owns this step.", retryable: false },
            updatedAt: now,
          };
          return {
              ...candidate,
              status: uncertain ? "submission_unknown" as const : "failed" as const,
              error: uncertain
                ? { code: "toon_media_submission_unknown", message: "The workflow ownership changed before submission could be reconciled.", retryable: false }
                : { code: "toon_media_job_target_changed", message: "The Toon Factory workflow target is unavailable.", retryable: false },
              updatedAt: now,
            };
        });
        return { ...current, status: aggregateStatus(candidates), candidates };
      });
      await this.persist(job);
      return;
    }
    if (!TERMINAL.has(job.status) && job.kind === "video" && job.candidates.some((candidate) => candidate.runtimeJobId && !TERMINAL.has(candidate.status))) {
      await this.reconcileVideo(id);
      job = this.options.jobs.require(id);
    }
    const requiresSubmission = !TERMINAL.has(job.status) && (job.kind === "image"
      || job.candidates.some((candidate) => !candidate.runtimeJobId && ["queued", "submitting"].includes(candidate.status)));
    if (requiresSubmission) {
      try {
        if (v2) await this.options.workspaceProjector!.assertPrerequisites(job);
        else await repository.assertMediaJobPrerequisites(job.projectId, job);
        this.options.modelPolicy?.assertAllowed(job.workspaceId, job.requestSnapshot.plan.model, await this.options.providerSource?.(job.workspaceId, job.requestSnapshot.plan.model.providerID));
      } catch (error) {
        if (error instanceof ApiError && error.code === "model_policy_pending") return;
        if (!(error instanceof ApiError && ["workflow_prerequisite_incomplete", "selected_model_unavailable"].includes(error.code))) throw error;
        job = this.options.jobs.update(id, (current, now) => {
          const candidates = current.candidates.map((candidate) => TERMINAL.has(candidate.status) || candidate.runtimeJobId ? candidate : {
            ...candidate,
            status: "failed" as const,
            error: { code: error.code, message: error.message, retryable: false },
            updatedAt: now,
          });
          return {
            ...current,
            status: aggregateStatus(candidates),
            candidates,
            ...(current.candidates.some((candidate) => candidate.runtimeJobId && !TERMINAL.has(candidate.status)) ? {} : { error: { code: error.code, message: error.message } }),
          };
        });
        await this.persist(job);
        return;
      }
    }
    if (TERMINAL.has(job.status)) await this.persist(job);
    else if (job.kind === "image") await this.runImages(id);
    else if (job.candidates.some((candidate) => !candidate.runtimeJobId && (candidate.status === "queued" || candidate.status === "submitting"))) await this.submitVideos(id);
    else if (!job.candidates.some((candidate) => candidate.runtimeJobId && !TERMINAL.has(candidate.status))) await this.reconcileVideo(id);
  }

  private async runImages(id: string): Promise<void> {
    let job = this.options.jobs.require(id);
    const plan = job.requestSnapshot.plan;
    if (plan.kind !== "image") return;
    if (job.candidates.some((candidate) => candidate.status === "running" || candidate.status === "submitting")) {
      job = this.options.jobs.update(id, (current, now) => {
        const candidates = current.candidates.map((candidate) => candidate.status === "running" || candidate.status === "submitting" ? {
          ...candidate,
          status: "submission_unknown" as const,
          error: { code: "toon_image_submission_unknown", message: "Image generation was interrupted and cannot be reconciled safely.", retryable: false },
          updatedAt: now,
        } : candidate);
        return { ...current, status: aggregateStatus(candidates), candidates };
      });
      await this.persist(job);
      return;
    }
    const repository = await this.options.repository(job.workspaceId);
    if (this.runtimeGeneration(job)) await this.options.workspaceProjector!.assertPrerequisites(job);
    else await repository.assertMediaJobPrerequisites(job.projectId, job);
    const context = { workspaceId: job.workspaceId };
    const sourceImagePaths = await Promise.all(plan.referencePaths.map((path) => this.runtimeGeneration(job)
      ? this.options.workspaceProjector!.resolveReference(job.workspaceId, job.projectId, path)
      : repository.resolveMediaReference(job.projectId, { scope: plan.referenceScope, path })));
    for (const snapshot of job.candidates) {
      const claimed = this.options.jobs.updateIf(id, (current) => current.status !== "cancel_requested"
        && current.candidates.some((candidate) => candidate.id === snapshot.id && candidate.status === "queued"), (current, now) => ({
        ...current,
        status: "running",
        candidates: current.candidates.map((item) => item.id === snapshot.id ? { ...item, status: "running", updatedAt: now } : item),
      }));
      if (!claimed) continue;
      job = claimed;
      await this.persist(job);
      const live = this.options.jobs.require(id);
      if (TERMINAL.has(live.status) || live.status === "cancel_requested"
        || live.candidates.find((candidate) => candidate.id === snapshot.id)?.status !== "running") continue;
      try {
        const response = record(await this.options.imageAction("image_generate", {
          prompt: plan.prompt,
          mode: plan.mode,
          model: { providerID: plan.model.providerID, modelID: plan.model.modelID },
          sourceImagePaths,
          ...(plan.size ? { size: plan.size } : {}),
          filename: `toon-${job.requestSnapshot.requestId}-${snapshot.ordinal}`,
        }, context));
        const result = record(response?.result);
        const artifact = record(result?.artifact);
        if (response?.ok !== true || typeof artifact?.path !== "string" || typeof artifact.mimeType !== "string" || typeof artifact.bytes !== "number") {
          throw new Error(typeof response?.error === "string" ? response.error : "toon_image_generation_invalid_result");
        }
        job = this.options.jobs.update(id, (current, now) => {
          const candidates = current.candidates.map((item) => item.id === snapshot.id && item.status === "running" ? {
            ...item,
            status: "awaiting-review" as const,
            artifact: { scope: "workspace" as const, path: artifact.path as string, mimeType: artifact.mimeType as string, bytes: artifact.bytes as number },
            updatedAt: now,
          } : item);
          return { ...current, status: aggregateStatus(candidates), candidates };
        });
      } catch (error) {
        const rejected = error instanceof ApiError && error.code === "image_generation_failed"
          && error.status >= 400 && error.status < 500;
        job = this.options.jobs.update(id, (current, now) => {
          const candidates = current.candidates.map((item) => item.id === snapshot.id && item.status === "running" ? {
            ...item,
            status: rejected ? "failed" as const : "submission_unknown" as const,
            error: {
              code: rejected ? "toon_image_generation_rejected" : "toon_image_submission_unknown",
              message: error instanceof Error ? error.message.slice(0, 4_000) : "Image generation outcome is unknown",
              retryable: false,
            },
            updatedAt: now,
          } : item);
          return { ...current, status: aggregateStatus(candidates), candidates };
        });
      }
      await this.persist(job);
    }
  }

  private async submitVideos(id: string): Promise<void> {
    let job = this.options.jobs.require(id);
    const plan = job.requestSnapshot.plan;
    if (plan.kind !== "video") return;
    const repository = await this.options.repository(job.workspaceId);
    if (this.runtimeGeneration(job)) await this.options.workspaceProjector!.assertPrerequisites(job);
    else await repository.assertMediaJobPrerequisites(job.projectId, job);
    const sourceImagePath = plan.referencePaths[0]
      ? this.runtimeGeneration(job)
        ? await this.options.workspaceProjector!.resolveReference(job.workspaceId, job.projectId, plan.referencePaths[0])
        : await repository.resolveMediaReference(job.projectId, { scope: plan.referenceScope, path: plan.referencePaths[0] })
      : undefined;
    const context = { workspaceId: job.workspaceId, sessionId: `toon-factory:${job.projectId}` };
    for (const snapshot of job.candidates) {
      if (!snapshot.clientRequestId || snapshot.runtimeJobId || !["queued", "submitting"].includes(snapshot.status)) continue;
      const claimed = this.options.jobs.updateIf(id, (current) => current.status !== "cancel_requested"
        && current.candidates.some((candidate) => candidate.id === snapshot.id && !candidate.runtimeJobId && ["queued", "submitting"].includes(candidate.status)), (current, now) => ({
          ...current,
          status: "submitting",
          candidates: current.candidates.map((item) => item.id === snapshot.id ? { ...item, status: "submitting", updatedAt: now } : item),
        }));
      if (!claimed) continue;
      job = claimed;
      await this.persist(job);
      const live = this.options.jobs.require(id);
      if (TERMINAL.has(live.status) || live.status === "cancel_requested"
        || live.candidates.find((candidate) => candidate.id === snapshot.id)?.status !== "submitting") continue;
      try {
        const response = await this.options.mediaGeneration.generate({
          prompt: plan.prompt,
          mode: plan.mode,
          model: { providerID: plan.model.providerID, modelID: plan.model.modelID },
          ...(sourceImagePath ? { sourceImagePath } : {}),
          durationSeconds: plan.durationSeconds,
          resolution: plan.resolution,
          filename: `toon-${job.requestSnapshot.requestId}-${snapshot.ordinal}`,
          clientRequestId: snapshot.clientRequestId,
        }, context);
        const generated = runtimeJob(response);
        if (!generated || typeof generated.id !== "string") throw new Error("toon_video_generation_invalid_result");
        job = this.options.jobs.updateIf(id, (current) => current.status !== "cancel_requested"
          && current.candidates.some((item) => item.id === snapshot.id && item.status === "submitting"), (current, now) => {
          const candidates = current.candidates.map((item) => item.id === snapshot.id && item.status === "submitting" ? this.videoCandidate(item, generated, now) : item);
          return { ...current, status: aggregateStatus(candidates), candidates };
        }) ?? this.options.jobs.require(id);
      } catch (error) {
        job = this.options.jobs.updateIf(id, (current) => current.status !== "cancel_requested"
          && current.candidates.some((item) => item.id === snapshot.id && item.status === "submitting"), (current, now) => {
          const candidates = current.candidates.map((item) => item.id === snapshot.id && item.status === "submitting" ? {
            ...item,
            status: "submission_unknown" as const,
            error: { code: "toon_video_submission_unknown", message: error instanceof Error ? error.message.slice(0, 4_000) : "Video submission outcome is unknown", retryable: false },
            updatedAt: now,
          } : item);
          return { ...current, status: aggregateStatus(candidates), candidates };
        }) ?? this.options.jobs.require(id);
      }
      await this.persist(job);
    }
  }

  private async reconcileVideo(id: string): Promise<void> {
    let job = this.options.jobs.require(id);
    const context = { workspaceId: job.workspaceId, sessionId: `toon-factory:${job.projectId}` };
    for (const candidate of job.candidates) {
      if (!candidate.runtimeJobId || TERMINAL.has(candidate.status)) continue;
      const response = await this.options.mediaGeneration.getJob(candidate.runtimeJobId, context);
      const updated = runtimeJob(response);
      if (!updated) continue;
      job = this.options.jobs.updateIf(id, (current) => current.candidates.some((item) => item.id === candidate.id && !TERMINAL.has(item.status)), (current, now) => {
        const candidates = current.candidates.map((item) => item.id === candidate.id && !TERMINAL.has(item.status) ? this.videoCandidate(item, updated, now) : item);
        const status = current.status === "cancel_requested" && candidates.some((item) => !TERMINAL.has(item.status))
          ? "cancel_requested"
          : aggregateStatus(candidates);
        return { ...current, status, candidates };
      }) ?? this.options.jobs.require(id);
      await this.persist(job);
    }
  }

  private videoCandidate(candidate: ToonMediaCandidate, runtime: Record<string, unknown>, now: string): ToonMediaCandidate {
    const status = typeof runtime.status === "string" ? runtime.status : "running";
    const artifact = record(runtime.artifact);
    const error = record(runtime.error);
    return {
      ...candidate,
      runtimeJobId: typeof runtime.id === "string" ? runtime.id : candidate.runtimeJobId,
      status: status === "completed" ? "awaiting-review" : status === "failed" || status === "cancelled" || status === "submission_unknown" ? status : "running",
      ...(typeof runtime.progress === "number" ? { progress: runtime.progress } : {}),
      ...(artifact && typeof artifact.path === "string" && typeof artifact.mimeType === "string" && typeof artifact.bytes === "number"
        ? { artifact: { scope: "workspace" as const, path: artifact.path, mimeType: artifact.mimeType, bytes: artifact.bytes } } : {}),
      ...(error && typeof error.code === "string" && typeof error.message === "string"
        ? { error: { code: error.code, message: error.message, retryable: error.retryable === true } } : {}),
      updatedAt: now,
    };
  }

  private async persist(job: ToonMediaJob): Promise<void> {
    job = this.options.jobs.require(job.id);
    try {
      if (this.runtimeGeneration(job)) {
        await this.options.workspaceProjector!.project(job);
        this.options.jobs.markProjectionClean(job.id);
        return;
      }
      const repository = await this.options.repository(job.workspaceId);
      await repository.writeMediaJobManifest(job);
      const adopted = job.candidates.find((candidate) => candidate.status === "adopted" && candidate.review.decision === "adopted");
      if (adopted) {
        await repository.adoptMediaCandidate(job, adopted);
        job = this.options.jobs.require(job.id);
        if (job.candidates.find((candidate) => candidate.id === adopted.id)?.status !== "adopted") {
          await repository.reconcileMediaJob(job);
          this.options.jobs.markProjectionClean(job.id);
          return;
        }
      }
      await repository.reconcileMediaJob(job);
      this.options.jobs.markProjectionClean(job.id);
    } catch {
      this.options.jobs.markProjectionFailed(job.id);
    }
  }

  private runtimeGeneration(job: ToonMediaJob) {
    return this.options.workspaceProjector && this.options.workspaceProjector["options"].runtime.generationLinkByJob(job.id);
  }
}

import { createHash } from "node:crypto";
import type { ToonMediaCandidate, ToonMediaJob } from "@jugglework/types/toon-factory";
import type { ToonWorkspaceCommand, ToonWorkspaceGenerationRecord } from "@jugglework/types/toon-workspace";
import { ApiError } from "../errors.js";
import { ToonWorkspaceCoordinator } from "./workspace-coordinator.js";
import { ToonWorkspaceRuntimeStore } from "./workspace-runtime-store.js";

export class ToonWorkspaceMediaProjector {
  constructor(private readonly options: {
    runtime: ToonWorkspaceRuntimeStore;
    coordinator: (workspaceId: string) => Promise<ToonWorkspaceCoordinator>;
  }) {}

  hasJob(jobId: string): boolean {
    return this.options.runtime.generationLinkByJob(jobId) !== null;
  }

  async generation(workspaceId: string, projectId: string, generationId: string): Promise<ToonWorkspaceGenerationRecord> {
    const read = await (await this.options.coordinator(workspaceId)).query(projectId, { kind: "generation.read", generationId });
    if (read.kind !== "generation.read") throw new ApiError(404, "toon_generation_not_found", "Toon generation record not found");
    return read.generation;
  }

  async resolveReference(workspaceId: string, projectId: string, relativePath: string): Promise<string> {
    return (await this.options.coordinator(workspaceId)).resolveProjectFile(projectId, relativePath);
  }

  async link(job: ToonMediaJob, generationId: string): Promise<void> {
    const generation = await this.generation(job.workspaceId, job.projectId, generationId);
    if (generation.requestId !== job.requestSnapshot.requestId || generation.requestHash !== job.requestHash || generation.canvasId !== job.canvasId || generation.nodeId !== job.nodeId || generation.workflowRecordId !== job.stepId) {
      throw new ApiError(409, "toon_generation_job_conflict", "The durable job does not match the portable generation plan");
    }
    this.options.runtime.linkGeneration({ workspaceScope: job.workspaceId, projectId: job.projectId, generationId, runtimeJobId: job.id, canvasId: job.canvasId, nodeId: job.nodeId });
  }

  async owns(job: ToonMediaJob): Promise<boolean> {
    const link = this.options.runtime.generationLinkByJob(job.id);
    if (!link || link.workspaceScope !== job.workspaceId || link.projectId !== job.projectId) return false;
    const generation = await this.generation(job.workspaceId, job.projectId, link.generationId);
    return generation.requestHash === job.requestHash && generation.authorization?.scopeHash === job.requestHash && !generation.authorization.invalidatedAt;
  }

  async assertPrerequisites(job: Pick<ToonMediaJob, "id" | "workspaceId" | "projectId" | "canvasId" | "nodeId" | "stepId" | "requestHash">): Promise<void> {
    const link = this.options.runtime.generationLinkByJob(job.id);
    if (!link) throw new ApiError(409, "toon_media_job_target_changed", "The durable job has no v2 workflow owner");
    const generation = await this.generation(job.workspaceId, job.projectId, link.generationId);
    if (generation.canvasId !== job.canvasId || generation.nodeId !== job.nodeId || generation.workflowRecordId !== job.stepId || generation.requestHash !== job.requestHash) {
      throw new ApiError(409, "toon_media_job_target_changed", "The v2 workflow ownership changed");
    }
    if (!generation.authorization || generation.authorization.scopeHash !== generation.requestHash || generation.authorization.invalidatedAt) {
      throw new ApiError(409, "toon_compute_authorization_scope_changed", "The exact generation authorization is missing or invalidated");
    }
    await (await this.options.coordinator(job.workspaceId)).assertGenerationPrerequisites(job.projectId, link.generationId);
  }

  async project(job: ToonMediaJob): Promise<void> {
    const link = this.options.runtime.generationLinkByJob(job.id);
    if (!link) return;
    const coordinator = await this.options.coordinator(job.workspaceId);
    const command: ToonWorkspaceCommand = {
      operationId: operationId(`project-${job.id}-${job.updatedAt}`),
      actor: { kind: "system" }, origin: "recovery", expectedRevisions: {}, kind: "generation.project",
      generationId: link.generationId, status: generationStatus(job),
      candidates: job.candidates.map((candidate) => ({
        id: candidate.id, ordinal: candidate.ordinal, status: candidate.status,
        ...(candidate.progress !== undefined ? { progress: candidate.progress } : {}),
        ...(candidate.artifact ? { artifact: candidate.artifact } : {}),
        ...(candidate.error ? { error: candidate.error } : {}),
        createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
      })),
    };
    await coordinator.executeRecoveryCommand(job.projectId, command);
    const owner = this.options.runtime.generationAssistantOwner(job.workspaceId, job.projectId, job.requestSnapshot.requestId);
    if (owner) this.options.runtime.appendEvent({
      eventId: operationId(`generation-progress-${job.id}-${job.updatedAt}-${job.status}`), workspaceId: job.workspaceId, projectId: job.projectId,
      conversationId: owner.conversationId, turnId: owner.turnId, type: "generation.progress", data: { generationId: link.generationId, job },
    });
  }

  async adopt(job: ToonMediaJob, candidate: ToonMediaCandidate, operation: { operationId: string; adoptionId: string; principalId: string; episodeId: string; workflowRecordId: string }): Promise<void> {
    const link = this.options.runtime.generationLinkByJob(job.id);
    if (!link) throw new ApiError(409, "toon_media_job_target_changed", "The durable job has no v2 workflow owner");
    await this.project(job);
    const project = await (await this.options.coordinator(job.workspaceId)).query(job.projectId, { kind: "project.read" });
    const catalogs = await (await this.options.coordinator(job.workspaceId)).query(job.projectId, { kind: "catalogs.read" });
    if (project.kind !== "project.read" || catalogs.kind !== "catalogs.read") throw new ApiError(409, "toon_media_job_target_changed", "The v2 workflow owner is unavailable");
    const generation = project.project.workflow.generations.find((item) => item.id === link.generationId);
    if (!generation || generation.episodeId !== operation.episodeId || generation.workflowRecordId !== operation.workflowRecordId) throw new ApiError(409, "toon_workflow_scope_changed", "Generation workflow scope changed before adoption");
    const existingAdoption = project.project.workflow.adoptions.find((item) => item.id === operation.adoptionId);
    if (existingAdoption) {
      if (existingAdoption.generationId !== link.generationId || existingAdoption.candidateId !== candidate.id) {
        throw new ApiError(409, "toon_operation_id_conflict", "The adoption ID is already used for another candidate");
      }
      return;
    }
    const descriptor = catalogs.canvases.canvases.find((item) => item.id === generation?.canvasId);
    if (!descriptor) throw new ApiError(409, "toon_media_job_target_changed", "The generation canvas is unavailable");
    await (await this.options.coordinator(job.workspaceId)).executeHumanInteraction(job.projectId, {
      operationId: operation.operationId, actor: { kind: "human", id: operation.principalId }, origin: "human-ui",
      expectedRevisions: {
        "toon-project.json": project.revision,
        "catalogs/canvases.json": catalogs.revisions["catalogs/canvases.json"]!,
        "catalogs/assets.json": catalogs.revisions["catalogs/assets.json"]!,
        [descriptor.file]: catalogs.revisions[descriptor.file]!,
      }, kind: "workflow.adopt",
      episodeId: operation.episodeId, workflowRecordId: operation.workflowRecordId,
      generationId: link.generationId, candidateId: candidate.id, adoptionId: operation.adoptionId,
    }, operation.principalId);
  }
}

function operationId(value: string): string {
  const prefix = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 72);
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function generationStatus(job: ToonMediaJob): "queued" | "submitting" | "running" | "awaiting-review" | "adopted" | "failed" | "cancelled" | "submission_unknown" {
  if (job.status === "cancel_requested") return "running";
  if (["queued", "submitting", "running", "awaiting-review", "adopted", "failed", "cancelled", "submission_unknown"].includes(job.status)) return job.status as ReturnType<typeof generationStatus>;
  return "failed";
}

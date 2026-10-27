import { randomUUID } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import { automationSqliteAdapter, type AutomationSqlite } from "../automation/sqlite.js";
import type { ServerConfig } from "../types.js";
import { migrateMediaGenerationDatabase } from "./migrations.js";
import { TERMINAL_VIDEO_JOB_STATUSES, type VideoAdapterBinding, type VideoArtifact, type VideoGenerationJob, type VideoJobStatus } from "./types.js";
import type { ImageGenerationMode, VideoGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";
import type { ImageArtifact } from "../extensions/openai-image-generation.js";
import { ApiError } from "../errors.js";

type JobRow = {
  id: string; workspace_id: string; session_id: string | null; client_request_id: string;
  request_hash: string | null;
  provider_id: string; model_id: string; mode: VideoGenerationMode; status: VideoJobStatus;
  progress: number | null; options_json: string; provider_job_id: string | null;
  next_poll_at: number | null; poll_attempts: number; artifact_json: string | null;
  error_code: string | null; error_message: string | null; error_retryable: number | null;
  adapter_binding_json: string | null;
  revision: number; created_at: number; updated_at: number;
};

const COLUMNS = `id, workspace_id, session_id, client_request_id, request_hash, provider_id, model_id, mode,
 status, progress, options_json, provider_job_id, next_poll_at, poll_attempts, artifact_json,
  error_code, error_message, error_retryable, adapter_binding_json, revision, created_at, updated_at`;

const VIDEO_SUBMISSION_RECOVERY_DELAY_MS = 5 * 60_000;

const ALLOWED_TRANSITIONS: Record<VideoJobStatus, ReadonlySet<VideoJobStatus>> = {
  queued: new Set(["queued", "submitting", "cancel_requested", "cancelled", "failed"]),
  submitting: new Set(["submitting", "submitted", "cancel_requested", "failed", "submission_unknown"]),
  submitted: new Set(["submitted", "running", "downloading", "cancel_requested", "cancelled", "failed"]),
  running: new Set(["running", "downloading", "cancel_requested", "cancelled", "failed"]),
  cancel_requested: new Set(["cancel_requested", "cancelled", "running", "downloading", "failed"]),
  downloading: new Set(["downloading", "completed", "failed"]), completed: new Set(), failed: new Set(), cancelled: new Set(), submission_unknown: new Set(),
};

export class MediaGenerationRepository {
  private constructor(private readonly database: AutomationSqlite) {}
  static async open(config: ServerConfig) {
    const database = automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config)));
    migrateMediaGenerationDatabase(database);
    return new MediaGenerationRepository(database);
  }
  static fromDatabase(database: AutomationSqlite) {
    migrateMediaGenerationDatabase(database);
    return new MediaGenerationRepository(database);
  }
  close() { this.database.close(); }

  createOrGet(input: { workspaceId: string; sessionId?: string; clientRequestId: string; requestHash: string; model: VideoModelRef; mode: VideoGenerationMode; options?: Record<string, unknown>; now?: number }): VideoGenerationJob {
    return this.database.transaction(() => {
      const now = input.now ?? Date.now();
      const id = randomUUID();
      this.database.run(`INSERT INTO video_generation_jobs
        (id, workspace_id, session_id, client_request_id, request_hash, provider_id, model_id, mode, status, options_json, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM video_generation_jobs
          WHERE workspace_id = ? AND session_id IS ? AND client_request_id = ?)
        ON CONFLICT DO NOTHING`, [
        id, input.workspaceId, input.sessionId ?? null, input.clientRequestId, input.requestHash,
        input.model.providerID, input.model.modelID, input.mode, JSON.stringify(input.options ?? {}), now, now,
        input.workspaceId, input.sessionId ?? null, input.clientRequestId,
      ]);
      const created = this.getByRequest(input.workspaceId, input.sessionId, input.clientRequestId);
      if (!created) throw new Error("video_job_create_failed");
      return assertMatchingVideoRequest(created, input.requestHash);
    });
  }

  get(id: string): VideoGenerationJob | null {
    const row = this.database.get<JobRow>(`SELECT ${COLUMNS} FROM video_generation_jobs WHERE id = ?`, [id]);
    return row ? fromRow(row) : null;
  }

  getByRequest(workspaceId: string, sessionId: string | undefined, clientRequestId: string): VideoGenerationJob | null {
    const row = this.database.get<JobRow>(`SELECT ${COLUMNS} FROM video_generation_jobs
      WHERE workspace_id = ? AND session_id IS ? AND client_request_id = ?`, [workspaceId, sessionId ?? null, clientRequestId]);
    return row ? fromRow(row) : null;
  }

  setAdapterBinding(id: string, expectedRevision: number, binding: VideoAdapterBinding, now = Date.now()): VideoGenerationJob {
    const result = this.database.run(`UPDATE video_generation_jobs SET adapter_binding_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = 'queued'`, [JSON.stringify(binding), now, id, expectedRevision]);
    if (result.changes !== 1) throw new Error("video_job_conflict");
    return this.get(id)!;
  }

  claimSubmission(id: string, expectedRevision: number, binding: VideoAdapterBinding, now = Date.now()): { job: VideoGenerationJob; claimed: boolean } {
    const current = this.get(id);
    if (!current) throw new Error("video_job_not_found");
    if (current.status !== "queued" || current.revision !== expectedRevision) return { job: current, claimed: false };
    if (current.adapterBinding && JSON.stringify(current.adapterBinding) !== JSON.stringify(binding)) {
      throw new Error("video_adapter_binding_immutable");
    }
    const result = this.database.run(`UPDATE video_generation_jobs SET status = 'submitting', adapter_binding_json = ?, next_poll_at = ?,
      revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND status = 'queued'`, [
      JSON.stringify(binding), now + VIDEO_SUBMISSION_RECOVERY_DELAY_MS, now, id, expectedRevision,
    ]);
    const job = this.get(id)!;
    return { job, claimed: result.changes === 1 };
  }

  listReconcilable(now: number, limit = 50): VideoGenerationJob[] {
    return this.database.all<JobRow>(`SELECT ${COLUMNS} FROM video_generation_jobs
      WHERE status NOT IN ('completed','failed','cancelled','submission_unknown') AND (next_poll_at IS NULL OR next_poll_at <= ?)
      ORDER BY created_at ASC LIMIT ?`, [now, Math.max(1, Math.min(100, limit))]).map(fromRow);
  }

  countActive(workspaceId: string): number {
    return this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM video_generation_jobs
      WHERE workspace_id = ? AND status NOT IN ('completed','failed','cancelled','submission_unknown')`, [workspaceId])?.count ?? 0;
  }

  transition(id: string, expectedRevision: number, status: VideoJobStatus, patch: {
    providerJobId?: string; progress?: number; nextPollAt?: number | null; incrementPollAttempts?: boolean;
    adapterBinding?: VideoAdapterBinding; artifact?: VideoArtifact; error?: { code: string; message: string; retryable: boolean }; now?: number;
  } = {}): VideoGenerationJob {
    const current = this.get(id);
    if (!current || current.revision !== expectedRevision) throw new Error("video_job_conflict");
    if (!ALLOWED_TRANSITIONS[current.status].has(status)) throw new Error(`invalid_video_job_transition:${current.status}:${status}`);
    if (current.adapterBinding && patch.adapterBinding && JSON.stringify(current.adapterBinding) !== JSON.stringify(patch.adapterBinding)) {
      throw new Error("video_adapter_binding_immutable");
    }
    const now = patch.now ?? Date.now();
    const result = this.database.run(`UPDATE video_generation_jobs SET status = ?, provider_job_id = COALESCE(?, provider_job_id),
      progress = COALESCE(?, progress), next_poll_at = ?, poll_attempts = poll_attempts + ?, artifact_json = COALESCE(?, artifact_json),
      error_code = ?, error_message = ?, error_retryable = ?, adapter_binding_json = COALESCE(?, adapter_binding_json), revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = ?`, [status, patch.providerJobId ?? null, patch.progress ?? null,
      patch.nextPollAt ?? null, patch.incrementPollAttempts ? 1 : 0, patch.artifact ? JSON.stringify(patch.artifact) : null,
      patch.error?.code ?? null, patch.error?.message ?? null, patch.error ? Number(patch.error.retryable) : null,
      patch.adapterBinding ? JSON.stringify(patch.adapterBinding) : null,
      now, id, expectedRevision, current.status]);
    if (result.changes !== 1) throw new Error("video_job_conflict");
    return this.get(id)!;
  }

  requestCancellation(id: string, now = Date.now()): VideoGenerationJob {
    const current = this.get(id);
    if (!current) throw new Error("video_job_not_found");
    if (TERMINAL_VIDEO_JOB_STATUSES.has(current.status) || current.status === "cancel_requested") return current;
    return this.transition(id, current.revision, "cancel_requested", { now });
  }
}

export type ImageGenerationJob = {
  id: string;
  workspaceId: string;
  clientRequestId: string;
  requestHash: string;
  model: VideoModelRef;
  mode: ImageGenerationMode;
  status: "running" | "completed" | "failed" | "submission_unknown";
  artifact?: ImageArtifact;
  error?: { code: string; message: string };
  createdAt: number;
  updatedAt: number;
};

type ImageJobRow = {
  id: string; workspace_id: string; client_request_id: string; request_hash: string;
  provider_id: string; model_id: string; mode: ImageGenerationMode; status: ImageGenerationJob["status"];
  artifact_json: string | null; error_code: string | null; error_message: string | null;
  created_at: number; updated_at: number;
};

const IMAGE_COLUMNS = `id, workspace_id, client_request_id, request_hash, provider_id, model_id, mode,
  status, artifact_json, error_code, error_message, created_at, updated_at`;

export class ImageGenerationRepository {
  private constructor(private readonly database: AutomationSqlite) {}
  static async open(config: ServerConfig) {
    const database = automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config)));
    return ImageGenerationRepository.fromDatabase(database);
  }
  static fromDatabase(database: AutomationSqlite) {
    migrateMediaGenerationDatabase(database);
    database.run(`UPDATE image_generation_jobs SET status = 'submission_unknown', error_code = ?, error_message = ?, updated_at = ?
      WHERE status = 'running'`, ["image_submission_outcome_unknown", "Image generation was interrupted; it will not be resubmitted automatically.", Date.now()]);
    return new ImageGenerationRepository(database);
  }
  close() { this.database.close(); }

  claim(input: { workspaceId: string; clientRequestId: string; requestHash: string; model: VideoModelRef; mode: ImageGenerationMode; now?: number }): { job: ImageGenerationJob; created: boolean } {
    return this.database.transaction(() => {
      const existing = this.getByRequest(input.workspaceId, input.clientRequestId);
      if (existing) {
        if (existing.requestHash !== input.requestHash) throw new Error("image_request_conflict");
        return { job: existing, created: false };
      }
      const now = input.now ?? Date.now();
      const id = randomUUID();
      this.database.run(`INSERT INTO image_generation_jobs
        (id, workspace_id, client_request_id, request_hash, provider_id, model_id, mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`, [
        id, input.workspaceId, input.clientRequestId, input.requestHash,
        input.model.providerID, input.model.modelID, input.mode, now, now,
      ]);
      return { job: this.get(id)!, created: true };
    });
  }

  get(id: string): ImageGenerationJob | null {
    const row = this.database.get<ImageJobRow>(`SELECT ${IMAGE_COLUMNS} FROM image_generation_jobs WHERE id = ?`, [id]);
    return row ? imageJobFromRow(row) : null;
  }

  getByRequest(workspaceId: string, clientRequestId: string): ImageGenerationJob | null {
    const row = this.database.get<ImageJobRow>(`SELECT ${IMAGE_COLUMNS} FROM image_generation_jobs WHERE workspace_id = ? AND client_request_id = ?`, [workspaceId, clientRequestId]);
    return row ? imageJobFromRow(row) : null;
  }

  finish(id: string, status: "completed" | "failed" | "submission_unknown", patch: { artifact?: ImageArtifact; error?: { code: string; message: string }; now?: number } = {}): ImageGenerationJob {
    const result = this.database.run(`UPDATE image_generation_jobs SET status = ?, artifact_json = ?, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'running'`, [status, patch.artifact ? JSON.stringify(patch.artifact) : null,
      patch.error?.code ?? null, patch.error?.message ?? null, patch.now ?? Date.now(), id]);
    if (result.changes !== 1) throw new Error("image_job_conflict");
    return this.get(id)!;
  }
}

export function publicImageGenerationJob(job: ImageGenerationJob): Omit<ImageGenerationJob, "clientRequestId" | "requestHash"> {
  const { clientRequestId: _clientRequestId, requestHash: _requestHash, ...publicJob } = job;
  return publicJob;
}

function fromRow(row: JobRow): VideoGenerationJob {
  return {
    id: row.id, workspaceId: row.workspace_id, ...(row.session_id ? { sessionId: row.session_id } : {}),
    clientRequestId: row.client_request_id, ...(row.request_hash ? { requestHash: row.request_hash } : {}),
    model: { providerID: row.provider_id, modelID: row.model_id },
    mode: row.mode, status: row.status, ...(row.progress !== null ? { progress: row.progress } : {}),
    options: JSON.parse(row.options_json) as Record<string, unknown>, ...(row.provider_job_id ? { providerJobId: row.provider_job_id } : {}),
    ...(row.next_poll_at !== null ? { nextPollAt: row.next_poll_at } : {}), pollAttempts: row.poll_attempts,
    ...(row.adapter_binding_json ? { adapterBinding: JSON.parse(row.adapter_binding_json) as VideoAdapterBinding } : {}),
    ...(row.artifact_json ? { artifact: JSON.parse(row.artifact_json) as VideoArtifact } : {}),
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message, retryable: row.error_retryable === 1 } } : {}),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function assertMatchingVideoRequest(job: VideoGenerationJob, requestHash: string): VideoGenerationJob {
  if (job.requestHash !== requestHash) {
    throw new ApiError(409, "video_request_conflict", "clientRequestId is already bound to a different video request.");
  }
  return job;
}

function imageJobFromRow(row: ImageJobRow): ImageGenerationJob {
  return {
    id: row.id, workspaceId: row.workspace_id, clientRequestId: row.client_request_id, requestHash: row.request_hash,
    model: { providerID: row.provider_id, modelID: row.model_id }, mode: row.mode, status: row.status,
    ...(row.artifact_json ? { artifact: JSON.parse(row.artifact_json) as ImageArtifact } : {}),
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message } } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

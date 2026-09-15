import { randomUUID } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import { automationSqliteAdapter, type AutomationSqlite } from "../automation/sqlite.js";
import type { ServerConfig } from "../types.js";
import { migrateMediaGenerationDatabase } from "./migrations.js";
import { TERMINAL_VIDEO_JOB_STATUSES, type VideoArtifact, type VideoGenerationJob, type VideoJobStatus } from "./types.js";
import type { VideoGenerationMode, VideoModelRef } from "@jugglework/types/media-generation";

type JobRow = {
  id: string; workspace_id: string; session_id: string | null; client_request_id: string;
  provider_id: string; model_id: string; mode: VideoGenerationMode; status: VideoJobStatus;
  progress: number | null; options_json: string; provider_job_id: string | null;
  next_poll_at: number | null; poll_attempts: number; artifact_json: string | null;
  error_code: string | null; error_message: string | null; error_retryable: number | null;
  revision: number; created_at: number; updated_at: number;
};

const COLUMNS = `id, workspace_id, session_id, client_request_id, provider_id, model_id, mode,
 status, progress, options_json, provider_job_id, next_poll_at, poll_attempts, artifact_json,
 error_code, error_message, error_retryable, revision, created_at, updated_at`;

const ALLOWED_TRANSITIONS: Record<VideoJobStatus, ReadonlySet<VideoJobStatus>> = {
  queued: new Set(["submitting", "cancel_requested", "cancelled", "failed"]),
  submitting: new Set(["submitted", "cancel_requested", "failed"]),
  submitted: new Set(["running", "downloading", "cancel_requested", "cancelled", "failed"]),
  running: new Set(["running", "downloading", "cancel_requested", "cancelled", "failed"]),
  cancel_requested: new Set(["cancel_requested", "cancelled", "running", "downloading", "failed"]),
  downloading: new Set(["completed", "failed"]), completed: new Set(), failed: new Set(), cancelled: new Set(),
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

  createOrGet(input: { workspaceId: string; sessionId?: string; clientRequestId: string; model: VideoModelRef; mode: VideoGenerationMode; options?: Record<string, unknown>; now?: number }): VideoGenerationJob {
    return this.database.transaction(() => {
      const existing = this.getByRequest(input.workspaceId, input.sessionId, input.clientRequestId);
      if (existing) return existing;
      const now = input.now ?? Date.now();
      const id = randomUUID();
      this.database.run(`INSERT INTO video_generation_jobs
        (id, workspace_id, session_id, client_request_id, provider_id, model_id, mode, status, options_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, [
        id, input.workspaceId, input.sessionId ?? null, input.clientRequestId,
        input.model.providerID, input.model.modelID, input.mode, JSON.stringify(input.options ?? {}), now, now,
      ]);
      return this.get(id)!;
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

  listReconcilable(now: number, limit = 50): VideoGenerationJob[] {
    return this.database.all<JobRow>(`SELECT ${COLUMNS} FROM video_generation_jobs
      WHERE status NOT IN ('completed','failed','cancelled') AND (next_poll_at IS NULL OR next_poll_at <= ?)
      ORDER BY created_at ASC LIMIT ?`, [now, Math.max(1, Math.min(100, limit))]).map(fromRow);
  }

  countActive(workspaceId: string): number {
    return this.database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM video_generation_jobs
      WHERE workspace_id = ? AND status NOT IN ('completed','failed','cancelled')`, [workspaceId])?.count ?? 0;
  }

  transition(id: string, expectedRevision: number, status: VideoJobStatus, patch: {
    providerJobId?: string; progress?: number; nextPollAt?: number | null; incrementPollAttempts?: boolean;
    artifact?: VideoArtifact; error?: { code: string; message: string; retryable: boolean }; now?: number;
  } = {}): VideoGenerationJob {
    const current = this.get(id);
    if (!current || current.revision !== expectedRevision) throw new Error("video_job_conflict");
    if (!ALLOWED_TRANSITIONS[current.status].has(status)) throw new Error(`invalid_video_job_transition:${current.status}:${status}`);
    const now = patch.now ?? Date.now();
    const result = this.database.run(`UPDATE video_generation_jobs SET status = ?, provider_job_id = COALESCE(?, provider_job_id),
      progress = COALESCE(?, progress), next_poll_at = ?, poll_attempts = poll_attempts + ?, artifact_json = COALESCE(?, artifact_json),
      error_code = ?, error_message = ?, error_retryable = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ? AND status = ?`, [status, patch.providerJobId ?? null, patch.progress ?? null,
      patch.nextPollAt ?? null, patch.incrementPollAttempts ? 1 : 0, patch.artifact ? JSON.stringify(patch.artifact) : null,
      patch.error?.code ?? null, patch.error?.message ?? null, patch.error ? Number(patch.error.retryable) : null,
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

function fromRow(row: JobRow): VideoGenerationJob {
  return {
    id: row.id, workspaceId: row.workspace_id, ...(row.session_id ? { sessionId: row.session_id } : {}),
    clientRequestId: row.client_request_id, model: { providerID: row.provider_id, modelID: row.model_id },
    mode: row.mode, status: row.status, ...(row.progress !== null ? { progress: row.progress } : {}),
    options: JSON.parse(row.options_json) as Record<string, unknown>, ...(row.provider_job_id ? { providerJobId: row.provider_job_id } : {}),
    ...(row.next_poll_at !== null ? { nextPollAt: row.next_poll_at } : {}), pollAttempts: row.poll_attempts,
    ...(row.artifact_json ? { artifact: JSON.parse(row.artifact_json) as VideoArtifact } : {}),
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message, retryable: row.error_retryable === 1 } } : {}),
    revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

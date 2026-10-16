import { randomUUID } from "node:crypto";
import {
  TOON_FACTORY_SCHEMA_VERSION,
  toonTextJobSchema,
  type ToonTextJob,
  type ToonTextJobCreateRequest,
  type ToonTextJobResult,
  type ToonTextJobStatus,
} from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { automationSqliteAdapter, type AutomationSqlite } from "../automation/sqlite.js";
import { migrateToonTextJobDatabase } from "./text-job-migrations.js";

type JobRow = {
  id: string; workspace_id: string; project_id: string; episode_id: string; canvas_id: string;
  node_id: string; stage: ToonTextJob["stage"]; action: ToonTextJob["action"];
  provider_id: string; model_id: string; output_schema_json: string; request_snapshot_json: string;
  status: ToonTextJobStatus; transient_session_id: string | null; dispatched: number;
  error_code: string | null; error_message: string | null; result_json: string | null;
  revision: number; created_at: number; updated_at: number; started_at: number | null;
  completed_at: number | null; cancelled_at: number | null;
  projection_dirty: number;
};

const COLUMNS = `id, workspace_id, project_id, episode_id, canvas_id, node_id, stage, action,
  provider_id, model_id, output_schema_json, request_snapshot_json, status, transient_session_id,
  dispatched, error_code, error_message, result_json, revision, created_at, updated_at, started_at,
  completed_at, cancelled_at, projection_dirty`;

export class ToonTextJobRepository {
  private constructor(private readonly database: AutomationSqlite) {}

  static async open(config: ServerConfig): Promise<ToonTextJobRepository> {
    return ToonTextJobRepository.fromDatabase(
      automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config))),
    );
  }

  static fromDatabase(database: AutomationSqlite): ToonTextJobRepository {
    migrateToonTextJobDatabase(database);
    return new ToonTextJobRepository(database);
  }

  close(): void { this.database.close(); }

  create(workspaceId: string, projectId: string, request: ToonTextJobCreateRequest, now = Date.now()): ToonTextJob {
    const id = `text-job-${randomUUID()}`;
    const snapshot = { ...request, projectId };
    this.database.run(`INSERT INTO toon_factory_text_jobs(
      id, workspace_id, project_id, episode_id, canvas_id, node_id, stage, action, provider_id,
      model_id, output_schema_json, request_snapshot_json, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`, [
      id, workspaceId, projectId, request.episodeId, request.canvasId, request.nodeId, request.stage,
      request.action, request.selectedModel.providerID, request.selectedModel.modelID,
      JSON.stringify(request.outputSchema), JSON.stringify(snapshot), now, now,
    ]);
    return this.require(id);
  }

  get(id: string): ToonTextJob | null {
    const row = this.database.get<JobRow>(`SELECT ${COLUMNS} FROM toon_factory_text_jobs WHERE id = ?`, [id]);
    return row ? fromRow(row) : null;
  }

  require(id: string): ToonTextJob {
    const job = this.get(id);
    if (!job) throw new ApiError(404, "toon_text_job_not_found", "Toon Factory text job not found");
    return job;
  }

  isDispatched(id: string): boolean {
    return this.database.get<{ dispatched: number }>(
      "SELECT dispatched FROM toon_factory_text_jobs WHERE id = ?",
      [id],
    )?.dispatched === 1;
  }

  listActive(limit = 50): ToonTextJob[] {
    return this.database.all<JobRow>(`SELECT ${COLUMNS} FROM toon_factory_text_jobs
      WHERE status IN ('queued','running','cancel_requested') ORDER BY created_at ASC LIMIT ?`,
    [Math.max(1, Math.min(100, limit))]).map(fromRow);
  }

  listAll(limit = 1_000): ToonTextJob[] {
    return this.database.all<JobRow>(`SELECT ${COLUMNS} FROM toon_factory_text_jobs
      ORDER BY created_at ASC LIMIT ?`, [Math.max(1, Math.min(10_000, limit))]).map(fromRow);
  }

  listProjectionDirty(now = Date.now(), limit = 25): ToonTextJob[] {
    return this.database.all<JobRow>(`SELECT ${COLUMNS} FROM toon_factory_text_jobs
      WHERE projection_dirty = 1 AND projection_retry_at <= ? ORDER BY projection_retry_at ASC, updated_at ASC LIMIT ?`,
    [now, Math.max(1, Math.min(100, limit))]).map(fromRow);
  }

  markProjectionClean(id: string): void {
    this.database.run("UPDATE toon_factory_text_jobs SET projection_dirty = 0, projection_attempts = 0, projection_retry_at = 0 WHERE id = ?", [id]);
  }

  markProjectionFailed(id: string, now = Date.now()): void {
    const row = this.database.get<{ projection_attempts: number }>("SELECT projection_attempts FROM toon_factory_text_jobs WHERE id = ?", [id]);
    const attempts = Math.min(10, (row?.projection_attempts ?? 0) + 1);
    const delay = Math.min(30_000, 250 * 2 ** (attempts - 1));
    this.database.run("UPDATE toon_factory_text_jobs SET projection_dirty = 1, projection_attempts = ?, projection_retry_at = ? WHERE id = ?", [attempts, now + delay, id]);
  }

  start(id: string, sessionId: string, now = Date.now()): ToonTextJob {
    const result = this.database.run(`UPDATE toon_factory_text_jobs SET status = 'running',
      transient_session_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?, revision = revision + 1,
      projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0
      WHERE id = ? AND status IN ('queued','running')`, [sessionId, now, now, id]);
    if (result.changes !== 1) throw new ApiError(409, "toon_text_job_not_runnable", "Toon Factory text job is not runnable");
    return this.require(id);
  }

  markDispatched(id: string, now = Date.now()): ToonTextJob {
    this.database.run("UPDATE toon_factory_text_jobs SET dispatched = 1, updated_at = ?, revision = revision + 1, projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0 WHERE id = ? AND status = 'running'", [now, id]);
    return this.require(id);
  }

  complete(id: string, result: ToonTextJobResult, now = Date.now()): ToonTextJob {
    const current = this.require(id);
    if (current.status === "completed") return current;
    const updated = this.database.run(`UPDATE toon_factory_text_jobs SET status = 'completed', result_json = ?,
      transient_session_id = NULL, completed_at = ?, updated_at = ?, revision = revision + 1,
      projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0
      WHERE id = ? AND status = 'running'`, [JSON.stringify(result), now, now, id]);
    if (updated.changes !== 1) throw new ApiError(409, "toon_text_job_transition_conflict", "Toon Factory text job cannot complete");
    return this.require(id);
  }

  fail(id: string, error: { code: string; message: string }, now = Date.now()): ToonTextJob {
    this.database.run(`UPDATE toon_factory_text_jobs SET status = 'failed', error_code = ?, error_message = ?,
      transient_session_id = NULL, completed_at = ?, updated_at = ?, revision = revision + 1,
      projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0
      WHERE id = ? AND status IN ('queued','running')`, [error.code, error.message, now, now, id]);
    return this.require(id);
  }

  requestCancellation(id: string, now = Date.now()): ToonTextJob {
    return this.database.transaction(() => {
      const current = this.require(id);
      if (["completed", "failed", "cancelled", "cancel_requested"].includes(current.status)) return current;
      const status: ToonTextJobStatus = current.status === "queued" ? "cancelled" : "cancel_requested";
      this.database.run(`UPDATE toon_factory_text_jobs SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
        updated_at = ?, revision = revision + 1, projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0 WHERE id = ?`, [status, status, now, now, id]);
      return this.require(id);
    });
  }

  cancelled(id: string, now = Date.now()): ToonTextJob {
    this.database.run(`UPDATE toon_factory_text_jobs SET status = 'cancelled', transient_session_id = NULL,
      cancelled_at = ?, completed_at = ?, updated_at = ?, revision = revision + 1,
      projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0
      WHERE id = ? AND status IN ('running','cancel_requested')`, [now, now, now, id]);
    return this.require(id);
  }
}

function fromRow(row: JobRow): ToonTextJob {
  return toonTextJobSchema.parse({
    schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    episodeId: row.episode_id,
    canvasId: row.canvas_id,
    nodeId: row.node_id,
    stage: row.stage,
    action: row.action,
    selectedModel: { kind: "text", providerID: row.provider_id, modelID: row.model_id },
    outputSchema: JSON.parse(row.output_schema_json),
    requestSnapshot: JSON.parse(row.request_snapshot_json),
    status: row.status,
    ...(row.transient_session_id ? { transientSessionId: row.transient_session_id } : {}),
    ...(row.error_code && row.error_message ? { error: { code: row.error_code, message: row.error_message } } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    ...(row.started_at === null ? {} : { startedAt: new Date(row.started_at).toISOString() }),
    ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at).toISOString() }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: new Date(row.cancelled_at).toISOString() }),
    ...(row.projection_dirty === 1 ? { projectionPending: true } : {}),
  });
}

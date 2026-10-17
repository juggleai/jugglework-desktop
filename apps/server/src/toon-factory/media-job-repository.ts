import { createHash, randomUUID } from "node:crypto";
import {
  TOON_FACTORY_SCHEMA_VERSION,
  toonMediaJobSchema,
  type ToonMediaAuthorization,
  type ToonMediaCandidate,
  type ToonMediaJob,
  type ToonMediaJobCreateRequest,
  type ToonMediaJobRequestSnapshot,
} from "@jugglework/types/toon-factory";
import { ApiError } from "../errors.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { automationSqliteAdapter, type AutomationSqlite } from "../automation/sqlite.js";
import { migrateToonMediaJobDatabase } from "./media-job-migrations.js";

type JobRow = { job_json: string; projection_dirty?: number };
export type ToonMediaJobCreateResult = { job: ToonMediaJob; created: boolean };

export function canonicalToonMediaRequest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalToonMediaRequest).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalToonMediaRequest(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function toonMediaRequestHash(snapshot: ToonMediaJobRequestSnapshot): string {
  return createHash("sha256").update(canonicalToonMediaRequest(snapshot)).digest("hex");
}

export class ToonMediaJobRepository {
  private constructor(private readonly database: AutomationSqlite) {}

  static async open(config: ServerConfig): Promise<ToonMediaJobRepository> {
    return ToonMediaJobRepository.fromDatabase(automationSqliteAdapter(await openRuntimeSqliteDatabase(runtimeDbPath(config))));
  }

  static fromDatabase(database: AutomationSqlite): ToonMediaJobRepository {
    migrateToonMediaJobDatabase(database);
    return new ToonMediaJobRepository(database);
  }

  close(): void { this.database.close(); }

  createOrGet(workspaceId: string, projectId: string, request: ToonMediaJobCreateRequest, now = Date.now()): ToonMediaJobCreateResult {
    return this.database.transaction(() => this.createOrGetInTransaction(workspaceId, projectId, request, now));
  }

  consumeAuthorizationAndCreate(input: {
    authorizationId: string;
    principalId: string;
    workspaceId: string;
    projectId: string;
    generationId: string;
  }, now = Date.now()): ToonMediaJobCreateResult {
    return this.database.transaction(() => {
      const authorization = this.database.get<{
        principal_id: string; workspace_scope: string; project_id: string; generation_id: string;
        request_hash: string; request_json: string | null; invalidated_at: number | null; expires_at: number; consumed_at: number | null; runtime_job_id: string | null; created_at: number;
      }>(`SELECT principal_id, workspace_scope, project_id, generation_id, request_hash, request_json, invalidated_at, expires_at, consumed_at, runtime_job_id, created_at
        FROM toon_workspace_authorizations WHERE authorization_id = ?`, [input.authorizationId]);
      if (!authorization) throw new ApiError(404, "toon_compute_authorization_not_found", "Compute authorization not found");
      if (!authorization.request_json) throw new ApiError(409, "toon_compute_authorization_legacy", "Compute authorization must be issued again");
      const snapshot = JSON.parse(authorization.request_json) as ToonMediaJobRequestSnapshot;
      const requestHash = toonMediaRequestHash(snapshot);
      if (authorization.principal_id !== input.principalId || authorization.workspace_scope !== input.workspaceId
        || authorization.project_id !== input.projectId || authorization.generation_id !== input.generationId
        || snapshot.projectId !== input.projectId || authorization.request_hash !== requestHash) {
        throw new ApiError(403, "toon_compute_authorization_scope_changed", "Compute authorization does not match this principal or generation");
      }
      if (authorization.consumed_at !== null) {
        if (!authorization.runtime_job_id) throw new ApiError(409, "toon_compute_authorization_consumed", "Compute authorization was already consumed");
        return { job: this.require(authorization.runtime_job_id), created: false };
      }
      if (authorization.expires_at <= now) throw new ApiError(410, "toon_compute_authorization_expired", "Compute authorization expired");
      if (authorization.invalidated_at !== null) throw new ApiError(409, "toon_compute_authorization_scope_changed", "Compute authorization was invalidated by an upstream dependency change");
      const { projectId: _projectId, ...authorizedRequest } = snapshot;
      const request = {
        ...authorizedRequest,
        authorization: { id: input.authorizationId, scopeHash: requestHash, authorizedAt: new Date(authorization.created_at).toISOString() },
      } as ToonMediaJobCreateRequest;
      const created = this.createOrGetInTransaction(input.workspaceId, input.projectId, request, now);
      const consumed = this.database.run(`UPDATE toon_workspace_authorizations SET consumed_at = ?, runtime_job_id = ?
        WHERE authorization_id = ? AND consumed_at IS NULL`, [now, created.job.id, input.authorizationId]);
      if (consumed.changes !== 1) throw new ApiError(409, "toon_compute_authorization_consumed", "Compute authorization was already consumed");
      return created;
    });
  }

  private createOrGetInTransaction(workspaceId: string, projectId: string, request: ToonMediaJobCreateRequest, now: number): ToonMediaJobCreateResult {
    const snapshot: ToonMediaJobRequestSnapshot = {
      requestId: request.requestId,
      projectId,
      episodeId: request.episodeId,
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      stepId: request.stepId,
      plan: request.plan,
      ...(request.retryOf ? { retryOf: request.retryOf } : {}),
    };
    const requestHash = toonMediaRequestHash(snapshot);
    if (request.authorization.scopeHash !== requestHash) {
      throw new ApiError(409, "toon_compute_authorization_scope_changed", "The generation plan changed after compute authorization", {
        authorizedScopeHash: request.authorization.scopeHash,
        currentScopeHash: requestHash,
      });
    }
    const existing = this.getByRequest(workspaceId, projectId, request.requestId);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new ApiError(409, "toon_media_request_id_conflict", "The request ID is already used for a different generation plan");
      return { job: existing, created: false };
    }
    const createdAt = new Date(now).toISOString();
    const id = `media-job-${randomUUID()}`;
    const provenance = {
        model: request.plan.model,
        prompt: request.plan.prompt,
        mode: request.plan.mode,
        referencePaths: request.plan.referencePaths,
        referenceScope: request.plan.referenceScope,
        parameters: request.plan.kind === "image"
          ? { size: request.plan.size }
          : { durationSeconds: request.plan.durationSeconds, resolution: request.plan.resolution },
    };
    const candidates: ToonMediaCandidate[] = Array.from({ length: request.plan.executionCount }, (_, index) => ({
        id: `candidate-${randomUUID()}`,
        ordinal: index + 1,
        status: "queued",
        runtime: request.plan.kind === "image" ? "openai-image-generation" : "media-generation",
        clientRequestId: `${request.requestId}-${index + 1}`,
        provenance,
        review: { decision: "pending" },
        createdAt,
        updatedAt: createdAt,
    }));
    const job = toonMediaJobSchema.parse({
        schemaVersion: TOON_FACTORY_SCHEMA_VERSION,
        id,
        workspaceId,
        projectId,
        episodeId: request.episodeId,
        canvasId: request.canvasId,
        nodeId: request.nodeId,
        stepId: request.stepId,
        kind: request.plan.kind,
        requestSnapshot: snapshot,
        requestHash,
        authorization: request.authorization,
        status: "queued",
        candidates,
        createdAt,
        updatedAt: createdAt,
    });
    this.database.run(`INSERT INTO toon_factory_media_jobs
      (id, workspace_id, project_id, request_id, request_hash, job_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [id, workspaceId, projectId, request.requestId, requestHash, JSON.stringify(job), now, now]);
    return { job, created: true };
  }

  create(workspaceId: string, projectId: string, request: ToonMediaJobCreateRequest, now = Date.now()): ToonMediaJob {
    return this.createOrGet(workspaceId, projectId, request, now).job;
  }

  get(id: string): ToonMediaJob | null {
    const row = this.database.get<JobRow>("SELECT job_json, projection_dirty FROM toon_factory_media_jobs WHERE id = ?", [id]);
    return row ? withProjectionState(row) : null;
  }

  require(id: string): ToonMediaJob {
    const job = this.get(id);
    if (!job) throw new ApiError(404, "toon_media_job_not_found", "Toon Factory media job not found");
    return job;
  }

  getByRequest(workspaceId: string, projectId: string, requestId: string): ToonMediaJob | null {
    const row = this.database.get<JobRow>(`SELECT job_json, projection_dirty FROM toon_factory_media_jobs
      WHERE workspace_id = ? AND project_id = ? AND request_id = ?`, [workspaceId, projectId, requestId]);
    return row ? withProjectionState(row) : null;
  }

  list(workspaceId: string, projectId: string): ToonMediaJob[] {
    return this.database.all<JobRow>(`SELECT job_json, projection_dirty FROM toon_factory_media_jobs
      WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC`, [workspaceId, projectId])
      .map(withProjectionState);
  }

  listActive(): ToonMediaJob[] {
    return this.database.all<JobRow>("SELECT job_json, projection_dirty FROM toon_factory_media_jobs ORDER BY created_at ASC")
      .map(withProjectionState)
      .filter((job) => ["queued", "running", "submitting", "cancel_requested"].includes(job.status));
  }

  listAll(): ToonMediaJob[] {
    return this.database.all<JobRow>("SELECT job_json, projection_dirty FROM toon_factory_media_jobs ORDER BY created_at ASC")
      .map(withProjectionState);
  }

  listProjectionDirty(now = Date.now(), limit = 25): ToonMediaJob[] {
    return this.database.all<JobRow>(`SELECT job_json, projection_dirty FROM toon_factory_media_jobs
      WHERE projection_dirty = 1 AND projection_retry_at <= ? ORDER BY projection_retry_at ASC, updated_at ASC LIMIT ?`,
    [now, Math.max(1, Math.min(100, limit))]).map(withProjectionState);
  }

  markProjectionClean(id: string): void {
    this.database.run("UPDATE toon_factory_media_jobs SET projection_dirty = 0, projection_attempts = 0, projection_retry_at = 0 WHERE id = ?", [id]);
  }

  markProjectionFailed(id: string, now = Date.now()): void {
    const row = this.database.get<{ projection_attempts: number }>("SELECT projection_attempts FROM toon_factory_media_jobs WHERE id = ?", [id]);
    const attempts = Math.min(10, (row?.projection_attempts ?? 0) + 1);
    const delay = Math.min(30_000, 250 * 2 ** (attempts - 1));
    this.database.run("UPDATE toon_factory_media_jobs SET projection_dirty = 1, projection_attempts = ?, projection_retry_at = ? WHERE id = ?", [attempts, now + delay, id]);
  }

  save(job: ToonMediaJob, now = Date.now()): ToonMediaJob {
    const { projectionPending: _projectionPending, ...persisted } = job;
    const updated = toonMediaJobSchema.parse({ ...persisted, updatedAt: new Date(now).toISOString() });
    const result = this.database.run("UPDATE toon_factory_media_jobs SET job_json = ?, updated_at = ?, projection_dirty = 1, projection_attempts = 0, projection_retry_at = 0 WHERE id = ?", [JSON.stringify(updated), now, job.id]);
    if (result.changes !== 1) throw new ApiError(404, "toon_media_job_not_found", "Toon Factory media job not found");
    return updated;
  }

  update(id: string, mutate: (job: ToonMediaJob, now: string) => ToonMediaJob, now = Date.now()): ToonMediaJob {
    return this.database.transaction(() => this.save(mutate(this.require(id), new Date(now).toISOString()), now));
  }

  updateIf(id: string, predicate: (job: ToonMediaJob) => boolean, mutate: (job: ToonMediaJob, now: string) => ToonMediaJob, now = Date.now()): ToonMediaJob | null {
    return this.database.transaction(() => {
      const current = this.require(id);
      if (!predicate(current)) return null;
      return this.save(mutate(current, new Date(now).toISOString()), now);
    });
  }
}

function withProjectionState(row: JobRow): ToonMediaJob {
  const job = toonMediaJobSchema.parse(JSON.parse(row.job_json));
  return row.projection_dirty === 1 ? { ...job, projectionPending: true } : job;
}

export function createToonMediaAuthorization(scopeHash: string, now = Date.now()): ToonMediaAuthorization {
  return { id: `authorization-${randomUUID()}`, scopeHash, authorizedAt: new Date(now).toISOString() };
}

import {
  isAutomationPermissionProfile,
  AUTOMATION_RUN_SCHEMA,
  type AutomationDefinition,
  type AutomationDefinitionRecord,
  type AutomationErrorCode,
  type AutomationRun,
  type AutomationRunListResponse,
  type AutomationSyncMutation,
  type AutomationSyncState,
} from "@jugglework/types/automation";
import { ApiError } from "../errors.js";
import { openRuntimeSqliteDatabase, runtimeDbPath } from "../runtime-db.js";
import type { ServerConfig } from "../types.js";
import { migrateAutomationDatabase } from "./migrations.js";
import { automationSqliteAdapter, type AutomationSqlite } from "./sqlite.js";

type AutomationTaskRow = {
  id: string;
  definition_json: string;
  raw_document_json: string;
  compatibility_state: AutomationDefinitionRecord["compatibility"];
  sync_state: AutomationSyncState;
  sync_error_code: AutomationErrorCode | null;
  deleted_at: number | null;
  updated_at: number;
};

type AutomationRunRow = {
  id: string;
  automation_id: string;
  automation_name: string;
  definition_revision: number;
  trigger_source: AutomationRun["triggerSource"];
  state: AutomationRun["state"];
  scheduled_for: number;
  workspace_id: string;
  workspace_name: string;
  session_id: string | null;
  concrete_selection_json: string | null;
  error_code: AutomationErrorCode | null;
  error_message: string | null;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  revision: number;
  sync_state: AutomationSyncState;
};

export type AutomationDefinitionPage = {
  items: AutomationDefinitionRecord[];
  nextCursor?: string;
};

export type AutomationRunQuery = {
  automationId?: string;
  states?: AutomationRun["state"][];
  triggerSources?: AutomationRun["triggerSource"][];
  scheduledFrom?: number;
  scheduledTo?: number;
  limit?: number;
  cursor?: string;
};

export type ClaimScheduledRunInput = {
  automationId: string;
  definitionRevision: number;
  runId: string;
  scheduledFor: number;
  triggerSource: "scheduled" | "catchup";
  nextRunAt: number | null;
  now: number;
  terminalReason?: "missed_deadline";
};

export type AutomationRunSnapshot = {
  run: AutomationRun;
  definition: AutomationDefinition;
};

/** 自动化任务及运行记录的 runtime.sqlite 仓储。 */
export class AutomationRepository {
  private constructor(private readonly database: AutomationSqlite) {}

  /** 打开 runtime.sqlite、执行迁移并返回仓储。 */
  static async open(config: ServerConfig): Promise<AutomationRepository> {
    const runtimeDb = await openRuntimeSqliteDatabase(runtimeDbPath(config));
    const database = automationSqliteAdapter(runtimeDb);
    migrateAutomationDatabase(database);
    return new AutomationRepository(database);
  }

  /** 使用已打开的数据库构建仓储，主要供测试和嵌入场景使用。 */
  static fromDatabase(database: AutomationSqlite): AutomationRepository {
    migrateAutomationDatabase(database);
    return new AutomationRepository(database);
  }

  /** 关闭仓储持有的数据库连接。 */
  close(): void {
    this.database.close();
  }

  /** 按 ID 读取任务；默认不返回墓碑。 */
  getDefinition(id: string, includeDeleted = false): AutomationDefinitionRecord | null {
    const row = this.database.get<AutomationTaskRow>(
      `SELECT id, definition_json, raw_document_json, compatibility_state, sync_state, sync_error_code, deleted_at, updated_at
       FROM automation_tasks WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
      [id],
    );
    return row ? definitionRecordFromRow(row) : null;
  }

  /** 按更新时间倒序分页读取本地任务。 */
  listDefinitions(input: { limit?: number; cursor?: string; includeDeleted?: boolean } = {}): AutomationDefinitionPage {
    const limit = boundedLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const conditions = [input.includeDeleted ? "1 = 1" : "deleted_at IS NULL"];
    const values: Array<string | number> = [];
    if (cursor) {
      conditions.push("(updated_at < ? OR (updated_at = ? AND id < ?))");
      values.push(cursor.at, cursor.at, cursor.id);
    }
    values.push(limit + 1);
    const rows = this.database.all<AutomationTaskRow>(
      `SELECT id, definition_json, raw_document_json, compatibility_state, sync_state, sync_error_code, deleted_at, updated_at
       FROM automation_tasks WHERE ${conditions.join(" AND ")}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
      values,
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(definitionRecordFromRow),
      ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.updated_at, id: last.id }) } : {}),
    };
  }

  /** 返回指定时刻已经到期且可由本机执行的任务定义。 */
  listDueDefinitions(now: number, limit = 100): AutomationDefinitionRecord[] {
    return this.database.all<AutomationTaskRow>(
      `SELECT id, definition_json, raw_document_json, compatibility_state, sync_state, sync_error_code, deleted_at, updated_at
       FROM automation_tasks
       WHERE deleted_at IS NULL AND compatibility_state = 'compatible' AND lifecycle = 'enabled'
         AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC, id ASC LIMIT ?`,
      [now, boundedLimit(limit)],
    ).map(definitionRecordFromRow);
  }

  /** 返回距离当前最近的未来任务截止时间。 */
  nearestNextRunAt(now: number): number | null {
    const row = this.database.get<{ next_run_at: number | null }>(
      `SELECT MIN(next_run_at) AS next_run_at FROM automation_tasks
       WHERE deleted_at IS NULL AND compatibility_state = 'compatible' AND lifecycle = 'enabled' AND next_run_at > ?`,
      [now],
    );
    return row?.next_run_at ?? null;
  }

  /** 原子创建仅在本机工作区执行的任务。 */
  createDefinition(definition: AutomationDefinition, rawDocument: Record<string, unknown>): AutomationDefinitionRecord {
    this.database.transaction(() => {
      if (this.database.get<{ id: string }>("SELECT id FROM automation_tasks WHERE id = ?", [definition.id])) {
        conflict();
      }
      this.database.run(
        `INSERT INTO automation_tasks(
          id, name, workspace_id, workspace_name, definition_schema, definition_json, raw_document_json,
          compatibility_state, lifecycle, revision, executor_device_id, next_run_at, timezone,
          active_start_date, active_end_date, permission_profile_version, permission_acknowledged_at,
          sync_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'compatible', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
        taskValues(definition, rawDocument),
      );
    });
    return requiredDefinition(this.getDefinition(definition.id));
  }

  /** 以乐观锁原子更新本机任务；不会覆盖墓碑或不兼容任务。 */
  updateDefinition(
    definition: AutomationDefinition,
    rawDocument: Record<string, unknown>,
    expectedRevision: number,
  ): AutomationDefinitionRecord {
    this.database.transaction(() => {
      const current = this.database.get<{ revision: number; deleted_at: number | null; compatibility_state: string }>(
        "SELECT revision, deleted_at, compatibility_state FROM automation_tasks WHERE id = ?",
        [definition.id],
      );
      if (!current) notFound();
      if (current.deleted_at !== null || current.compatibility_state !== "compatible") readOnly();
      if (current.revision !== expectedRevision || definition.revision !== expectedRevision + 1) conflict(current.revision);
      const result = this.database.run(
        `UPDATE automation_tasks SET
          name = ?, workspace_id = ?, workspace_name = ?, definition_schema = ?, definition_json = ?, raw_document_json = ?,
          lifecycle = ?, revision = ?, executor_device_id = ?, next_run_at = ?, timezone = ?, active_start_date = ?, active_end_date = ?,
          permission_profile_version = ?, permission_acknowledged_at = ?, sync_state = 'synced', sync_error_code = NULL, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at IS NULL AND compatibility_state = 'compatible'`,
        [...taskUpdateValues(definition, rawDocument), definition.id, expectedRevision],
      );
      if (result.changes !== 1) conflict();
    });
    return requiredDefinition(this.getDefinition(definition.id));
  }

  /** 创建版本化墓碑并保留运行历史，防止离线旧写复活任务。 */
  tombstoneDefinition(id: string, expectedRevision: number, now: number): AutomationDefinitionRecord {
    this.database.transaction(() => {
      const current = requiredDefinition(this.getDefinition(id));
      if (current.compatibility !== "compatible") readOnly();
      if (current.definition.revision !== expectedRevision) conflict(current.definition.revision);
      const nextRevision = expectedRevision + 1;
      const tombstonedDefinition = {
        ...current.definition,
        revision: nextRevision,
        nextRunAt: null,
        updatedAt: now,
      };
      const tombstonedRaw = {
        ...current.rawDocument,
        revision: nextRevision,
        nextRunAt: null,
        updatedAt: now,
      };
      const result = this.database.run(
        `UPDATE automation_tasks SET lifecycle = 'tombstoned', revision = ?, definition_json = ?, raw_document_json = ?,
          deleted_at = ?, sync_state = 'synced', sync_error_code = NULL, next_run_at = NULL, updated_at = ?
         WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
        [nextRevision, JSON.stringify(tombstonedDefinition), JSON.stringify(tombstonedRaw), now, now, id, expectedRevision],
      );
      if (result.changes !== 1) conflict();
    });
    return requiredDefinition(this.getDefinition(id, true));
  }

  /** 原子创建手动运行；任务存在非终态运行时返回冲突。 */
  createManualRun(definition: AutomationDefinition, runId: string, now: number): AutomationRun {
    return this.database.transaction(() => {
      ensureRunnableRecord(this.getDefinition(definition.id, true), definition.revision);
      if (this.hasActiveRun(definition.id)) overlap();
      const run = newRun(definition, runId, "manual", now, now);
      this.insertRun(run, definition);
      return run;
    });
  }

  /**
   * 原子认领一个计划时间并推进 next_run_at。
   * TIPS: 运行插入与 next_run_at 推进必须同事务完成，定时器重复唤醒只能命中唯一索引。
   */
  claimScheduledRun(input: ClaimScheduledRunInput): AutomationRun {
    return this.database.transaction(() => {
      const record = ensureRunnableRecord(this.getDefinition(input.automationId, true), input.definitionRevision);
      const definition = record.definition;
      const existing = this.database.get<{ id: string }>(
        `SELECT id FROM automation_runs WHERE automation_id = ? AND scheduled_for = ?
         AND trigger_source IN ('scheduled', 'catchup') LIMIT 1`,
        [definition.id, input.scheduledFor],
      );
      if (existing) return requiredRun(this.getRun(existing.id));
      const overlapping = this.hasActiveRun(definition.id);
      const terminalReason = input.terminalReason ?? (overlapping ? "overlap_blocked" : undefined);
      const run = newRun(
        definition,
        input.runId,
        input.triggerSource,
        input.scheduledFor,
        input.now,
        terminalReason ? { state: "skipped", errorCode: terminalReason, endedAt: input.now } : undefined,
      );
      this.insertRun(run, definition);
      definition.nextRunAt = input.nextRunAt;
      if (input.nextRunAt === null) definition.lifecycle = "completed";
      this.database.run(
        "UPDATE automation_tasks SET lifecycle = ?, next_run_at = ?, definition_json = ?, updated_at = ? WHERE id = ? AND revision = ?",
        [definition.lifecycle, input.nextRunAt, JSON.stringify(definition), input.now, definition.id, definition.revision],
      );
      return run;
    });
  }

  /** 按状态、触发来源和时间范围分页查询运行历史。 */
  listRuns(input: AutomationRunQuery = {}): AutomationRunListResponse {
    const limit = boundedLimit(input.limit);
    const cursor = decodeCursor(input.cursor);
    const conditions: string[] = ["1 = 1"];
    const values: Array<string | number> = [];
    if (input.automationId) {
      conditions.push("automation_id = ?");
      values.push(input.automationId);
    }
    addInFilter(conditions, values, "state", input.states);
    addInFilter(conditions, values, "trigger_source", input.triggerSources);
    if (Number.isFinite(input.scheduledFrom)) {
      conditions.push("scheduled_for >= ?");
      values.push(Number(input.scheduledFrom));
    }
    if (Number.isFinite(input.scheduledTo)) {
      conditions.push("scheduled_for <= ?");
      values.push(Number(input.scheduledTo));
    }
    if (cursor) {
      conditions.push("(scheduled_for < ? OR (scheduled_for = ? AND id < ?))");
      values.push(cursor.at, cursor.at, cursor.id);
    }
    values.push(limit + 1);
    const rows = this.database.all<AutomationRunRow>(
      `SELECT id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state
       FROM automation_runs WHERE ${conditions.join(" AND ")}
       ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
      values,
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(runFromRow),
      ...(hasMore && last ? { nextCursor: encodeCursor({ at: last.scheduled_for, id: last.id }) } : {}),
    };
  }

  /** 按 ID 读取单条运行记录。 */
  getRun(id: string): AutomationRun | null {
    const row = this.database.get<AutomationRunRow>(
      `SELECT id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state FROM automation_runs WHERE id = ?`,
      [id],
    );
    return row ? runFromRow(row) : null;
  }

  /** 读取运行记录及认领时冻结的完整任务定义。 */
  getRunSnapshot(id: string): AutomationRunSnapshot | null {
    const row = this.database.get<AutomationRunRow & { snapshot_json: string }>(
      `SELECT id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, snapshot_json, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state FROM automation_runs WHERE id = ?`,
      [id],
    );
    return row ? { run: runFromRow(row), definition: JSON.parse(row.snapshot_json) as AutomationDefinition } : null;
  }

  /** 返回等待执行或需要启动恢复的非终态运行，按入队顺序排列。 */
  listActiveRunSnapshots(): AutomationRunSnapshot[] {
    return this.database.all<AutomationRunRow & { snapshot_json: string }>(
      `SELECT id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, snapshot_json, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state FROM automation_runs
       WHERE state IN ('queued', 'running') ORDER BY queued_at ASC, id ASC`,
    ).map((row) => ({ run: runFromRow(row), definition: JSON.parse(row.snapshot_json) as AutomationDefinition }));
  }

  /** 更新运行状态并在同一事务写入同步 outbox。 */
  updateRun(
    id: string,
    expectedRevision: number,
    patch: Partial<Pick<AutomationRun, "state" | "sessionId" | "startedAt" | "endedAt" | "concreteModel" | "agentId" | "connectorIds" | "errorCode" | "errorMessage">>,
    now: number,
  ): AutomationRun {
    return this.database.transaction(() => {
      const current = this.getRun(id);
      if (!current) throw new ApiError(404, "automation_run_not_found", "Automation run not found");
      if (current.revision !== expectedRevision) conflict(current.revision);
      const state = patch.state ?? current.state;
      validateRunTransition(current.state, state);
      const next: AutomationRun = {
        ...current,
        ...patch,
        state,
        revision: current.revision + 1,
        syncState: "synced",
      };
      const result = this.database.run(
        `UPDATE automation_runs SET state = ?, session_id = ?, concrete_selection_json = ?, error_code = ?, error_message = ?,
          started_at = ?, ended_at = ?, revision = ?, sync_state = 'synced', sync_error_code = NULL, updated_at = ?
         WHERE id = ? AND revision = ?`,
        [
          next.state,
          next.sessionId ?? null,
          JSON.stringify({ concreteModel: next.concreteModel, agentId: next.agentId, connectorIds: next.connectorIds }),
          next.errorCode ?? null,
          next.errorMessage ?? null,
          next.startedAt ?? null,
          next.endedAt ?? null,
          next.revision,
          now,
          id,
          expectedRevision,
        ],
      );
      if (result.changes !== 1) conflict();
      return next;
    });
  }

  /** 读取到期的同步 outbox，保持实体内版本顺序。 */
  readOutbox(input: { limit?: number; now?: number } = {}): AutomationSyncMutation[] {
    const limit = boundedLimit(input.limit);
    const rows = this.database.all<{
      id: string; mutation_id: string; entity_type: "definition" | "run"; entity_id: string;
      local_revision: number; operation: "upsert" | "delete"; payload_version: 1; payload_json: string;
      attempts: number; next_attempt_at: number; last_error_code: AutomationErrorCode | null; created_at: number;
    }>(
      `SELECT id, mutation_id, entity_type, entity_id, local_revision, operation, payload_version, payload_json,
        attempts, next_attempt_at, last_error_code, created_at
       FROM automation_sync_outbox WHERE state IN ('pending', 'error') AND next_attempt_at <= ?
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [input.now ?? Date.now(), limit],
    );
    return rows.map((row) => ({
      id: row.id,
      mutationId: row.mutation_id,
      entityType: row.entity_type,
      entityId: row.entity_id,
      localRevision: row.local_revision,
      operation: row.operation,
      payloadVersion: row.payload_version,
      payload: JSON.parse(row.payload_json),
      attempts: row.attempts,
      nextAttemptAt: row.next_attempt_at,
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
      createdAt: row.created_at,
    }));
  }

  /** 仅确认完全匹配的 outbox 变更，并更新实体同步状态。 */
  acknowledgeOutbox(mutationId: string, entityId: string, localRevision: number, now = Date.now()): boolean {
    return this.database.transaction(() => {
      const row = this.database.get<{ entity_type: "definition" | "run"; entity_id: string; local_revision: number }>(
        "SELECT entity_type, entity_id, local_revision FROM automation_sync_outbox WHERE mutation_id = ?",
        [mutationId],
      );
      if (!row || row.entity_id !== entityId || row.local_revision !== localRevision) return false;
      this.database.run("DELETE FROM automation_sync_outbox WHERE mutation_id = ?", [mutationId]);
      const table = row.entity_type === "definition" ? "automation_tasks" : "automation_runs";
      this.database.run(
        `UPDATE ${table} SET sync_state = 'synced', sync_error_code = NULL, updated_at = ? WHERE id = ? AND revision = ?`,
        [now, entityId, localRevision],
      );
      return true;
    });
  }

  /** 记录一次同步失败和下一次退避时间，不删除可恢复的 outbox。 */
  failOutbox(
    mutationId: string,
    errorCode: AutomationErrorCode,
    errorMessage: string,
    nextAttemptAt: number,
    now = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      const row = this.database.get<{ entity_type: "definition" | "run"; entity_id: string }>(
        "SELECT entity_type, entity_id FROM automation_sync_outbox WHERE mutation_id = ?",
        [mutationId],
      );
      if (!row) return false;
      this.database.run(
        `UPDATE automation_sync_outbox SET state = 'error', attempts = attempts + 1, next_attempt_at = ?,
          last_error_code = ?, last_error_message = ?, updated_at = ? WHERE mutation_id = ?`,
        [nextAttemptAt, errorCode, errorMessage.slice(0, 500), now, mutationId],
      );
      const table = row.entity_type === "definition" ? "automation_tasks" : "automation_runs";
      const syncState = errorCode === "automation_projection_unsupported" ? "incompatible-read-only" : "error";
      this.database.run(
        `UPDATE ${table} SET sync_state = ?, sync_error_code = ?, updated_at = ? WHERE id = ?`,
        [syncState, errorCode, now, row.entity_id],
      );
      return true;
    });
  }

  private hasActiveRun(automationId: string): boolean {
    return Boolean(this.database.get<{ id: string }>(
      "SELECT id FROM automation_runs WHERE automation_id = ? AND state IN ('queued', 'running') LIMIT 1",
      [automationId],
    ));
  }

  private insertRun(run: AutomationRun, definition: AutomationDefinition): void {
    try {
      this.database.run(
        `INSERT INTO automation_runs(
          id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
          workspace_id, workspace_name, session_id, snapshot_json, concrete_selection_json, error_code, error_message,
          queued_at, started_at, ended_at, revision, sync_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
        [
          run.id,
          run.automationId,
          run.automationName,
          run.definitionRevision,
          run.triggerSource,
          run.state,
          run.scheduledFor,
          run.workspaceId,
          run.workspaceName,
          run.sessionId ?? null,
          JSON.stringify(definition),
          JSON.stringify({ concreteModel: run.concreteModel, agentId: run.agentId, connectorIds: run.connectorIds }),
          run.errorCode ?? null,
          run.errorMessage ?? null,
          run.queuedAt,
          run.startedAt ?? null,
          run.endedAt ?? null,
          run.revision,
          run.queuedAt,
          run.queuedAt,
        ],
      );
    } catch (error) {
      if (isConstraintError(error)) overlap();
      throw error;
    }
  }
}

function taskValues(definition: AutomationDefinition, rawDocument: Record<string, unknown>): Array<string | number | null> {
  return [
    definition.id,
    definition.name,
    definition.workspace.id,
    definition.workspace.name,
    definition.schema,
    JSON.stringify(definition),
    JSON.stringify(rawDocument),
    definition.lifecycle,
    definition.revision,
    definition.executorDeviceId,
    definition.nextRunAt,
    definition.schedule.timezone,
    definition.activeRange?.startDate ?? null,
    definition.activeRange?.endDate ?? null,
    definition.permission.profile,
    definition.permission.acknowledgedAt,
    definition.createdAt,
    definition.updatedAt,
  ];
}

function taskUpdateValues(definition: AutomationDefinition, rawDocument: Record<string, unknown>): Array<string | number | null> {
  return taskValues(definition, rawDocument).slice(1, -2).concat(definition.updatedAt);
}

function definitionRecordFromRow(row: AutomationTaskRow): AutomationDefinitionRecord {
  return {
    definition: JSON.parse(row.definition_json) as AutomationDefinition,
    compatibility: row.compatibility_state,
    syncState: row.sync_state,
    ...(row.sync_error_code ? { syncErrorCode: row.sync_error_code } : {}),
    rawDocument: JSON.parse(row.raw_document_json) as Record<string, unknown>,
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
  };
}

function runFromRow(row: AutomationRunRow): AutomationRun {
  const selections = row.concrete_selection_json
    ? JSON.parse(row.concrete_selection_json) as Pick<AutomationRun, "concreteModel" | "agentId" | "connectorIds">
    : { connectorIds: [] };
  return {
    schema: AUTOMATION_RUN_SCHEMA,
    id: row.id,
    automationId: row.automation_id,
    automationName: row.automation_name,
    definitionRevision: row.definition_revision,
    triggerSource: row.trigger_source,
    state: row.state,
    scheduledFor: row.scheduled_for,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    queuedAt: row.queued_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(selections.concreteModel ? { concreteModel: selections.concreteModel } : {}),
    ...(selections.agentId ? { agentId: selections.agentId } : {}),
    connectorIds: selections.connectorIds ?? [],
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    revision: row.revision,
    syncState: row.sync_state,
  };
}

function newRun(
  definition: AutomationDefinition,
  id: string,
  triggerSource: AutomationRun["triggerSource"],
  scheduledFor: number,
  now: number,
  terminal?: { state: "skipped"; errorCode: "overlap_blocked" | "missed_deadline"; endedAt: number },
): AutomationRun {
  return {
    schema: AUTOMATION_RUN_SCHEMA,
    id,
    automationId: definition.id,
    automationName: definition.name,
    definitionRevision: definition.revision,
    triggerSource,
    state: terminal?.state ?? "queued",
    scheduledFor,
    workspaceId: definition.workspace.id,
    workspaceName: definition.workspace.name,
    queuedAt: now,
    ...(terminal ? { endedAt: terminal.endedAt, errorCode: terminal.errorCode } : {}),
    connectorIds: definition.connectors.map((connector) => connector.id),
    revision: 1,
    syncState: "synced",
  };
}

function ensureRunnableRecord(record: AutomationDefinitionRecord | null, revision: number): AutomationDefinitionRecord {
  if (!record || record.deletedAt !== undefined) notFound();
  if (record.compatibility !== "compatible") readOnly();
  if (record.definition.revision !== revision) conflict(record.definition.revision);
  if (!isAutomationPermissionProfile(record.definition.permission.profile) || record.definition.permission.acknowledgedAt <= 0) {
    throw new ApiError(409, "automation_read_only", "Automation requires a current permission acknowledgement");
  }
  return record;
}

function validateRunTransition(current: AutomationRun["state"], next: AutomationRun["state"]): void {
  if (current === next) return;
  const allowed: Record<AutomationRun["state"], AutomationRun["state"][]> = {
    queued: ["running", "failed", "skipped", "cancelled"],
    running: ["succeeded", "failed", "cancelled"],
    succeeded: [],
    failed: [],
    skipped: [],
    cancelled: [],
  };
  if (!allowed[current].includes(next)) {
    throw new ApiError(409, "automation_run_transition_conflict", "Automation run state cannot move backward", { current, next });
  }
}

function addInFilter<T extends string>(conditions: string[], values: Array<string | number>, column: string, filter: T[] | undefined): void {
  if (!filter?.length) return;
  conditions.push(`${column} IN (${filter.map(() => "?").join(", ")})`);
  values.push(...filter);
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 50;
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new ApiError(400, "invalid_query", "limit must be an integer from 1 to 100");
  }
  return value;
}

function encodeCursor(cursor: { at: number; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (!Number.isFinite(value.at) || typeof value.id !== "string" || !value.id) throw new Error("invalid");
    return { at: Number(value.at), id: value.id };
  } catch {
    throw new ApiError(400, "invalid_cursor", "Automation cursor is invalid");
  }
}

function requiredDefinition(value: AutomationDefinitionRecord | null): AutomationDefinitionRecord {
  if (!value) notFound();
  return value;
}

function requiredRun(value: AutomationRun | null): AutomationRun {
  if (!value) throw new ApiError(404, "automation_run_not_found", "Automation run not found");
  return value;
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint|unique/i.test(message);
}

function notFound(): never {
  throw new ApiError(404, "automation_not_found", "Automation not found");
}

function readOnly(): never {
  throw new ApiError(409, "automation_read_only", "Automation is incompatible or deleted and cannot be changed");
}

function conflict(currentRevision?: number): never {
  throw new ApiError(409, "automation_revision_conflict", "Automation revision conflict", currentRevision ? { currentRevision } : undefined);
}

function overlap(): never {
  throw new ApiError(409, "overlap_blocked", "Automation already has a queued or running run");
}

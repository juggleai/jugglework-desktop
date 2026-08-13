import { randomUUID } from "node:crypto";
import {
  runtimeEventSchema,
  type RuntimeEvent,
  type RuntimeKind,
} from "@jugglework/types/agent-runtime";
import {
  migrateLegacyOpenCodeSession,
  runtimeSessionRecordSchema,
  type LegacyOpenCodeSessionMigrationContext,
  type RuntimeSessionRecord,
} from "@jugglework/types/runtime-session";
import { openRuntimeSqliteDatabase, type RuntimeSqliteDatabase } from "./runtime-db.js";

const SCHEMA_VERSION = 1;

type Sqlite = RuntimeSqliteDatabase["sqlite"];
type Scope = { orgId: string; workspaceId: string; sessionId: string };
type SqlValue = string | number | bigint | Uint8Array | null;

export class RuntimeSessionStoreError extends Error {
  constructor(readonly code: "scope_mismatch" | "not_found" | "schema_too_new" | "invalid_event") {
    super("Runtime session storage request failed.");
    this.name = "RuntimeSessionStoreError";
  }
}

function statement(db: Sqlite, sql: string) {
  return "query" in db ? db.query(sql) : db.prepare(sql);
}

function execute(db: Sqlite, sql: string): void {
  db.exec(sql);
}

function get(db: Sqlite, sql: string, ...values: SqlValue[]): Record<string, unknown> | null {
  return (statement(db, sql).get(...values) as Record<string, unknown> | null) ?? null;
}

function all(db: Sqlite, sql: string, ...values: SqlValue[]): Record<string, unknown>[] {
  return statement(db, sql).all(...values) as Record<string, unknown>[];
}

function run(db: Sqlite, sql: string, ...values: SqlValue[]): { changes: number | bigint } {
  return statement(db, sql).run(...values) as { changes: number | bigint };
}

function changes(value: { changes: number | bigint }): number {
  return Number(value.changes);
}

function migrate(db: Sqlite): void {
  execute(db, `
    CREATE TABLE IF NOT EXISTS runtime_schema_versions (
      component TEXT PRIMARY KEY NOT NULL,
      version INTEGER NOT NULL
    );
  `);
  const row = get(db, "SELECT version FROM runtime_schema_versions WHERE component = ?", "runtime_sessions");
  const version = row ? Number(row.version) : 0;
  if (version > SCHEMA_VERSION) throw new RuntimeSessionStoreError("schema_too_new");
  execute(db, `
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      org_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('opencode', 'codex')),
      backend_thread_id TEXT,
      record_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runtime_sessions_backend
      ON runtime_sessions(org_id, workspace_id, runtime_kind, backend_thread_id)
      WHERE backend_thread_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS runtime_sessions_scope
      ON runtime_sessions(org_id, workspace_id, archived_at, updated_at DESC);
    CREATE TABLE IF NOT EXISTS runtime_session_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
      org_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      runtime_kind TEXT NOT NULL,
      backend_thread_id TEXT NOT NULL,
      backend_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      turn_id TEXT,
      occurred_at INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      UNIQUE(runtime_kind, backend_thread_id, backend_event_id)
    );
    CREATE INDEX IF NOT EXISTS runtime_events_projection
      ON runtime_session_events(session_id, occurred_at, sequence);
    CREATE TABLE IF NOT EXISTS runtime_turn_projections (
      session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running', 'completed', 'failed', 'interrupted')),
      last_occurred_at INTEGER NOT NULL,
      terminal_event_id TEXT,
      PRIMARY KEY(session_id, turn_id)
    );
    INSERT INTO runtime_schema_versions(component, version) VALUES ('runtime_sessions', 1)
      ON CONFLICT(component) DO UPDATE SET version = excluded.version;
  `);
}

function parseRecord(row: Record<string, unknown>): RuntimeSessionRecord {
  return runtimeSessionRecordSchema.parse(JSON.parse(String(row.record_json)));
}

function assertScope(record: RuntimeSessionRecord, scope: Scope): void {
  if (record.id !== scope.sessionId || record.orgId !== scope.orgId || record.workspaceId !== scope.workspaceId) {
    throw new RuntimeSessionStoreError("scope_mismatch");
  }
}

function turnState(event: RuntimeEvent): "running" | "completed" | "failed" | "interrupted" | null {
  if (event.type === "turn.started") return "running";
  if (event.type === "turn.completed") return "completed";
  if (event.type === "turn.failed") return "failed";
  if (event.type === "turn.interrupted") return "interrupted";
  return null;
}

export class RuntimeSessionStore {
  private constructor(private readonly runtime: RuntimeSqliteDatabase) {}

  static async open(path: string): Promise<RuntimeSessionStore> {
    const runtime = await openRuntimeSqliteDatabase(path);
    try {
      execute(runtime.sqlite, "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
      migrate(runtime.sqlite);
      return new RuntimeSessionStore(runtime);
    } catch (error) {
      runtime.close();
      throw error;
    }
  }

  close(): void {
    this.runtime.close();
  }

  putSession(value: RuntimeSessionRecord): RuntimeSessionRecord {
    const record = runtimeSessionRecordSchema.parse(value);
    for (const attachment of record.attachments) {
      if (/^(?:data:|https?:)/i.test(attachment.objectRef) || attachment.objectRef.includes("base64,")) {
        throw new RuntimeSessionStoreError("invalid_event");
      }
    }
    const current = get(this.runtime.sqlite, "SELECT record_json FROM runtime_sessions WHERE session_id = ?", record.id);
    if (current) assertScope(parseRecord(current), { orgId: record.orgId, workspaceId: record.workspaceId, sessionId: record.id });
    run(this.runtime.sqlite, `
      INSERT INTO runtime_sessions(session_id, org_id, workspace_id, runtime_kind, backend_thread_id, record_json, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        runtime_kind = excluded.runtime_kind,
        backend_thread_id = excluded.backend_thread_id,
        record_json = excluded.record_json,
        updated_at = excluded.updated_at,
        archived_at = excluded.archived_at
    `, record.id, record.orgId, record.workspaceId, record.runtimeKind, record.backendThreadId,
    JSON.stringify(record), record.createdAt, record.updatedAt, record.archivedAt);
    return record;
  }

  getSession(scope: Scope): RuntimeSessionRecord {
    const row = get(this.runtime.sqlite, "SELECT record_json FROM runtime_sessions WHERE session_id = ?", scope.sessionId);
    if (!row) throw new RuntimeSessionStoreError("not_found");
    const record = parseRecord(row);
    assertScope(record, scope);
    return record;
  }

  listSessions(input: { orgId: string; workspaceId: string; includeArchived?: boolean }): RuntimeSessionRecord[] {
    const rows = all(this.runtime.sqlite, `SELECT record_json FROM runtime_sessions
      WHERE org_id = ? AND workspace_id = ? ${input.includeArchived ? "" : "AND archived_at IS NULL"}
      ORDER BY updated_at DESC, session_id ASC`, input.orgId, input.workspaceId);
    return rows.map(parseRecord);
  }

  searchSessions(input: { orgId: string; workspaceId: string; search: string; includeArchived?: boolean; limit?: number }): RuntimeSessionRecord[] {
    const needle = input.search.trim().toLocaleLowerCase();
    const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
    return this.listSessions(input)
      .filter((record) => !needle || record.title.toLocaleLowerCase().includes(needle))
      .slice(0, limit);
  }

  migrateLegacyOpenCodeSessions(values: unknown[], context: LegacyOpenCodeSessionMigrationContext): RuntimeSessionRecord[] {
    return values.map((value) => this.putSession(migrateLegacyOpenCodeSession(value, context)));
  }

  bindBackendThread(scope: Scope, input: { runtimeKind: RuntimeKind; backendThreadId: string; updatedAt: number }): RuntimeSessionRecord {
    const current = this.getSession(scope);
    const next = runtimeSessionRecordSchema.parse({
      ...current, runtimeKind: input.runtimeKind, backendThreadId: input.backendThreadId,
      runtimeLocked: true, updatedAt: Math.max(current.updatedAt, input.updatedAt),
    });
    return this.putSession(next);
  }

  archiveSession(scope: Scope, archivedAt: number | null): RuntimeSessionRecord {
    const current = this.getSession(scope);
    return this.putSession(runtimeSessionRecordSchema.parse({
      ...current, archivedAt, updatedAt: Math.max(current.updatedAt, archivedAt ?? current.updatedAt),
    }));
  }

  appendEvent(scope: Scope, backendEventId: string, value: unknown): { inserted: boolean; event: RuntimeEvent } {
    const event = runtimeEventSchema.parse(value);
    if (event.type === "user.message" && event.content.some((part) =>
      part.type === "attachment" && (/^(?:data:|https?:)/i.test(part.attachment.objectRef) || part.attachment.objectRef.includes("base64,")))) {
      throw new RuntimeSessionStoreError("invalid_event");
    }
    const record = this.getSession(scope);
    if (event.orgId !== scope.orgId || event.workspaceId !== scope.workspaceId ||
        ("sessionId" in event && event.sessionId !== scope.sessionId) ||
        ("threadId" in event && event.threadId !== record.backendThreadId) ||
        event.runtimeKind !== record.runtimeKind || !record.backendThreadId) {
      throw new RuntimeSessionStoreError("invalid_event");
    }
    const db = this.runtime.sqlite;
    execute(db, "BEGIN IMMEDIATE");
    try {
      const inserted = changes(run(db, `INSERT OR IGNORE INTO runtime_session_events
        (session_id, org_id, workspace_id, runtime_kind, backend_thread_id, backend_event_id, event_type, turn_id, occurred_at, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      scope.sessionId, scope.orgId, scope.workspaceId, event.runtimeKind, record.backendThreadId, backendEventId,
      event.type, "turnId" in event ? event.turnId : null, event.occurredAt, JSON.stringify(event))) > 0;
      if (inserted && "turnId" in event) {
        const state = turnState(event);
        if (state) run(db, `INSERT INTO runtime_turn_projections(session_id, turn_id, state, last_occurred_at, terminal_event_id)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id, turn_id) DO UPDATE SET
            state = CASE
              WHEN excluded.last_occurred_at < runtime_turn_projections.last_occurred_at THEN runtime_turn_projections.state
              WHEN runtime_turn_projections.state IN ('completed','failed','interrupted') AND excluded.state = 'running' THEN runtime_turn_projections.state
              ELSE excluded.state END,
            last_occurred_at = MAX(runtime_turn_projections.last_occurred_at, excluded.last_occurred_at),
            terminal_event_id = CASE WHEN excluded.state = 'running' THEN runtime_turn_projections.terminal_event_id ELSE excluded.terminal_event_id END`,
        scope.sessionId, event.turnId, state, event.occurredAt, state === "running" ? null : backendEventId);
      }
      execute(db, "COMMIT");
      return { inserted, event };
    } catch (error) {
      execute(db, "ROLLBACK");
      throw error;
    }
  }

  readEvents(scope: Scope): RuntimeEvent[] {
    this.getSession(scope);
    return all(this.runtime.sqlite, `SELECT event_json FROM runtime_session_events
      WHERE session_id = ? AND org_id = ? AND workspace_id = ? ORDER BY occurred_at, sequence`,
    scope.sessionId, scope.orgId, scope.workspaceId).map((row) => runtimeEventSchema.parse(JSON.parse(String(row.event_json))));
  }

  listIncompleteTurns(scope: Scope): Array<{ turnId: string; lastOccurredAt: number }> {
    this.getSession(scope);
    return all(this.runtime.sqlite, `SELECT turn_id, last_occurred_at FROM runtime_turn_projections
      WHERE session_id = ? AND state = 'running' ORDER BY last_occurred_at`, scope.sessionId)
      .map((row) => ({ turnId: String(row.turn_id), lastOccurredAt: Number(row.last_occurred_at) }));
  }

  createRecoveryEventId(): string {
    return `recovery:${randomUUID()}`;
  }
}

import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export const SESSION_PENDING_OPERATION_SCHEMA_VERSION = 1;
export const SESSION_PENDING_OPERATION_MAX_PROMPT_BYTES = 200_000;
export const SESSION_PENDING_OPERATION_MAX_LIVE = 1_000;

export type SessionPendingOperationMode = "steer" | "enqueue";
export type SessionPendingOperationState =
  | "pending"
  | "dispatching"
  | "admitted"
  | "cancelled"
  | "completed"
  | "failed";

export type SessionPendingOperation = {
  id: string;
  workspaceId: string;
  sessionId: string;
  mode: SessionPendingOperationMode;
  prompt: string;
  origin: "remote-control";
  commandCorrelationId: string;
  state: SessionPendingOperationState;
  queueSequence: number;
  admittedId: string | null;
  errorCode: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SessionPendingOperationAudit = {
  id: number;
  pendingOperationId: string;
  workspaceId: string;
  sessionId: string;
  mode: SessionPendingOperationMode;
  action: "created" | "claimed" | "admitted" | "cancelled" | "completed" | "failed" | "recovered";
  commandCorrelationId: string;
  outcome: string;
  occurredAt: number;
};

export class SessionPendingOperationError extends Error {
  constructor(public readonly code: "invalid_request" | "capacity_exceeded" | "not_found" | "not_cancellable" | "store_unavailable") {
    super(code);
    this.name = "SessionPendingOperationError";
  }
}

type Sqlite = RuntimeSqliteDatabase["sqlite"];
type SqlStatement = {
  run: (...args: unknown[]) => unknown;
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown;
};

function statement(sqlite: Sqlite, sql: string): SqlStatement {
  const candidate = "query" in sqlite
    ? (sqlite as { query(value: string): SqlStatement }).query(sql)
    : (sqlite as { prepare(value: string): SqlStatement }).prepare(sql);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredIdentifier(value: unknown): string {
  if (typeof value !== "string" || value !== value.trim() || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new SessionPendingOperationError("invalid_request");
  }
  return value;
}

function requiredPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > SESSION_PENDING_OPERATION_MAX_PROMPT_BYTES) {
    throw new SessionPendingOperationError("invalid_request");
  }
  return value;
}

function modeValue(value: unknown): SessionPendingOperationMode {
  if (value !== "steer" && value !== "enqueue") throw new SessionPendingOperationError("invalid_request");
  return value;
}

function rowValue(row: unknown): SessionPendingOperation {
  if (!isRecord(row)) throw new SessionPendingOperationError("store_unavailable");
  return {
    id: String(row.id),
    workspaceId: String(row.workspaceId),
    sessionId: String(row.sessionId),
    mode: modeValue(row.mode),
    prompt: String(row.prompt),
    origin: "remote-control",
    commandCorrelationId: String(row.commandCorrelationId),
    state: String(row.state) as SessionPendingOperationState,
    queueSequence: Number(row.queueSequence),
    admittedId: row.admittedId === null ? null : String(row.admittedId),
    errorCode: row.errorCode === null ? null : String(row.errorCode),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

const SELECT_COLUMNS = `id, workspace_id AS workspaceId, session_id AS sessionId, mode, prompt,
  command_correlation_id AS commandCorrelationId, state, queue_sequence AS queueSequence,
  admitted_id AS admittedId, error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt`;

function initialize(sqlite: Sqlite): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_pending_operation_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_pending_operations (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('steer','enqueue')),
      prompt TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin = 'remote-control'),
      command_correlation_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending','dispatching','admitted','cancelled','completed','failed')),
      queue_sequence INTEGER NOT NULL,
      admitted_id TEXT NULL,
      error_code TEXT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_pending_operations_command
      ON session_pending_operations(command_correlation_id);
    CREATE INDEX IF NOT EXISTS session_pending_operations_fifo
      ON session_pending_operations(workspace_id, session_id, state, queue_sequence);
    CREATE TABLE IF NOT EXISTS session_pending_operation_audits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pending_operation_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      action TEXT NOT NULL,
      command_correlation_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
  `);
  const version = statement(sqlite, "SELECT schema_version AS schemaVersion FROM session_pending_operation_meta WHERE singleton = 1").get();
  if (version === undefined || version === null) {
    statement(sqlite, "INSERT INTO session_pending_operation_meta(singleton, schema_version) VALUES (1, ?)").run(SESSION_PENDING_OPERATION_SCHEMA_VERSION);
  } else if (!isRecord(version) || version.schemaVersion !== SESSION_PENDING_OPERATION_SCHEMA_VERSION) {
    throw new SessionPendingOperationError("store_unavailable");
  }
}

function transaction<T>(sqlite: Sqlite, work: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const value = work();
    sqlite.exec("COMMIT");
    return value;
  } catch (error) {
    try { sqlite.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

function audit(sqlite: Sqlite, operation: SessionPendingOperation, action: SessionPendingOperationAudit["action"], outcome: string, occurredAt: number): void {
  statement(sqlite, `INSERT INTO session_pending_operation_audits
    (pending_operation_id, workspace_id, session_id, mode, action, command_correlation_id, outcome, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(operation.id, operation.workspaceId, operation.sessionId, operation.mode, action, operation.commandCorrelationId, outcome, occurredAt);
}

export async function createSessionPendingOperationStore(options: {
  config?: ServerConfig;
  path?: string;
  now?: () => number;
  randomUUID?: () => string;
}) {
  const path = options.path ?? (options.config ? runtimeDbPath(options.config) : null);
  if (!path) throw new SessionPendingOperationError("store_unavailable");
  const runtime = await openRuntimeSqliteDatabase(path);
  const sqlite = runtime.sqlite;
  initialize(sqlite);
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;

  // A crash may leave a claim in dispatching with an ambiguous upstream outcome.
  // Fail it closed instead of dispatching it a second time.
  transaction(sqlite, () => {
    const rows = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations WHERE state = 'dispatching'`).all();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const operation = rowValue(raw);
      const timestamp = now();
      statement(sqlite, "UPDATE session_pending_operations SET state = 'failed', error_code = 'restart_outcome_unknown', updated_at = ? WHERE id = ? AND state = 'dispatching'").run(timestamp, operation.id);
      audit(sqlite, operation, "recovered", "restart_outcome_unknown", timestamp);
    }
  });

  function get(id: string): SessionPendingOperation | null {
    const row = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations WHERE id = ?`).get(requiredIdentifier(id));
    return row ? rowValue(row) : null;
  }

  function create(input: {
    workspaceId: string;
    sessionId: string;
    mode: SessionPendingOperationMode;
    prompt: string;
    commandCorrelationId: string;
  }): SessionPendingOperation {
    const workspaceId = requiredIdentifier(input.workspaceId);
    const sessionId = requiredIdentifier(input.sessionId);
    const mode = modeValue(input.mode);
    const prompt = requiredPrompt(input.prompt);
    const commandCorrelationId = requiredIdentifier(input.commandCorrelationId);
    return transaction(sqlite, () => {
      const prior = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations WHERE command_correlation_id = ?`).get(commandCorrelationId);
      if (prior) return rowValue(prior);
      const count = statement(sqlite, "SELECT COUNT(*) AS count FROM session_pending_operations WHERE state IN ('pending','dispatching','admitted')").get();
      if (!isRecord(count) || Number(count.count) >= SESSION_PENDING_OPERATION_MAX_LIVE) throw new SessionPendingOperationError("capacity_exceeded");
      const sequenceRow = statement(sqlite, "SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS next FROM session_pending_operations WHERE workspace_id = ? AND session_id = ?").get(workspaceId, sessionId);
      const queueSequence = isRecord(sequenceRow) ? Number(sequenceRow.next) : 1;
      const timestamp = now();
      const id = randomUUID();
      requiredIdentifier(id);
      statement(sqlite, `INSERT INTO session_pending_operations
        (id, workspace_id, session_id, mode, prompt, origin, command_correlation_id, state, queue_sequence, admitted_id, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'remote-control', ?, 'pending', ?, NULL, NULL, ?, ?)`)
        .run(id, workspaceId, sessionId, mode, prompt, commandCorrelationId, queueSequence, timestamp, timestamp);
      const operation = get(id);
      if (!operation) throw new SessionPendingOperationError("store_unavailable");
      audit(sqlite, operation, "created", "pending", timestamp);
      return operation;
    });
  }

  function claimNext(workspaceId: string, sessionId: string, mode: SessionPendingOperationMode = "enqueue"): SessionPendingOperation | null {
    return transaction(sqlite, () => {
      const row = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations
        WHERE workspace_id = ? AND session_id = ? AND mode = ? AND state = 'pending'
        ORDER BY queue_sequence ASC LIMIT 1`).get(requiredIdentifier(workspaceId), requiredIdentifier(sessionId), modeValue(mode));
      if (!row) return null;
      const operation = rowValue(row);
      const timestamp = now();
      const result = statement(sqlite, "UPDATE session_pending_operations SET state = 'dispatching', updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, operation.id) as { changes?: number };
      if (typeof result?.changes === "number" && result.changes !== 1) return null;
      audit(sqlite, operation, "claimed", "dispatching", timestamp);
      return get(operation.id);
    });
  }

  function cancel(id: string, cancellationCommandCorrelationId: string): { operation: SessionPendingOperation; cancelled: boolean } {
    requiredIdentifier(cancellationCommandCorrelationId);
    return transaction(sqlite, () => {
      const operation = get(id);
      if (!operation) throw new SessionPendingOperationError("not_found");
      if (operation.state === "cancelled") return { operation, cancelled: false };
      if (operation.state !== "pending") throw new SessionPendingOperationError("not_cancellable");
      const timestamp = now();
      statement(sqlite, "UPDATE session_pending_operations SET state = 'cancelled', error_code = 'cancelled', updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, operation.id);
      const cancelled = get(operation.id);
      if (!cancelled) throw new SessionPendingOperationError("store_unavailable");
      audit(sqlite, { ...cancelled, commandCorrelationId: cancellationCommandCorrelationId }, "cancelled", "cancelled", timestamp);
      return { operation: cancelled, cancelled: true };
    });
  }

  function transition(id: string, from: SessionPendingOperationState[], state: SessionPendingOperationState, action: SessionPendingOperationAudit["action"], details: { admittedId?: string | null; errorCode?: string | null } = {}): SessionPendingOperation {
    return transaction(sqlite, () => {
      const operation = get(id);
      if (!operation) throw new SessionPendingOperationError("not_found");
      if (!from.includes(operation.state)) {
        if (operation.state === state) return operation;
        throw new SessionPendingOperationError("not_cancellable");
      }
      const timestamp = now();
      statement(sqlite, "UPDATE session_pending_operations SET state = ?, admitted_id = ?, error_code = ?, updated_at = ? WHERE id = ?")
        .run(state, details.admittedId ?? operation.admittedId, details.errorCode ?? null, timestamp, operation.id);
      const updated = get(operation.id);
      if (!updated) throw new SessionPendingOperationError("store_unavailable");
      audit(sqlite, updated, action, state, timestamp);
      return updated;
    });
  }

  function list(workspaceId?: string, sessionId?: string): SessionPendingOperation[] {
    const clauses: string[] = [];
    const args: string[] = [];
    if (workspaceId !== undefined) { clauses.push("workspace_id = ?"); args.push(requiredIdentifier(workspaceId)); }
    if (sessionId !== undefined) { clauses.push("session_id = ?"); args.push(requiredIdentifier(sessionId)); }
    const rows = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY queue_sequence ASC`).all(...args);
    return (Array.isArray(rows) ? rows : []).map(rowValue);
  }

  function listAudits(pendingOperationId?: string): SessionPendingOperationAudit[] {
    const rows = statement(sqlite, `SELECT id, pending_operation_id AS pendingOperationId, workspace_id AS workspaceId,
      session_id AS sessionId, mode, action, command_correlation_id AS commandCorrelationId,
      outcome, occurred_at AS occurredAt FROM session_pending_operation_audits
      ${pendingOperationId ? "WHERE pending_operation_id = ?" : ""} ORDER BY id ASC`).all(...(pendingOperationId ? [requiredIdentifier(pendingOperationId)] : []));
    return (Array.isArray(rows) ? rows : []).map((row) => {
      if (!isRecord(row)) throw new SessionPendingOperationError("store_unavailable");
      return { ...row, id: Number(row.id), occurredAt: Number(row.occurredAt) } as SessionPendingOperationAudit;
    });
  }

  function cancelAllPendingRemote(commandCorrelationId: string): number {
    return transaction(sqlite, () => {
      const pending = list().filter((item) => item.state === "pending");
      for (const operation of pending) cancel(operation.id, commandCorrelationId);
      return pending.length;
    });
  }

  return Object.freeze({
    create,
    get,
    list,
    listAudits,
    claimNext,
    cancel,
    cancelAllPendingRemote,
    markAdmitted: (id: string, admittedId: string) => transition(id, ["dispatching"], "admitted", "admitted", { admittedId: requiredIdentifier(admittedId) }),
    markCompleted: (id: string) => transition(id, ["admitted"], "completed", "completed"),
    markFailed: (id: string, errorCode: string) => transition(id, ["dispatching", "admitted"], "failed", "failed", { errorCode: requiredIdentifier(errorCode) }),
    close: () => runtime.close(),
  });
}

export type SessionPendingOperationStore = Awaited<ReturnType<typeof createSessionPendingOperationStore>>;

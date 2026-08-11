import { randomUUID as cryptoRandomUUID } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export const SESSION_PENDING_OPERATION_SCHEMA_VERSION = 2;
export const SESSION_PENDING_OPERATION_MAX_PROMPT_BYTES = 200_000;
export const SESSION_PENDING_OPERATION_MAX_LIVE = 1_000;
export const SESSION_PENDING_OPERATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_PENDING_OPERATION_AUDIT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_PENDING_OPERATION_MAX_TERMINAL = 5_000;
export const SESSION_PENDING_OPERATION_MAX_AUDITS = 20_000;

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
  acceptanceGeneration: number;
  admittedAt: number | null;
  idleObservedAt: number | null;
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
    acceptanceGeneration: Number(row.acceptanceGeneration),
    admittedAt: row.admittedAt === null ? null : Number(row.admittedAt),
    idleObservedAt: row.idleObservedAt === null ? null : Number(row.idleObservedAt),
    errorCode: row.errorCode === null ? null : String(row.errorCode),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

const SELECT_COLUMNS = `id, workspace_id AS workspaceId, session_id AS sessionId, mode, prompt,
  command_correlation_id AS commandCorrelationId, state, queue_sequence AS queueSequence,
  admitted_id AS admittedId, acceptance_generation AS acceptanceGeneration,
  admitted_at AS admittedAt, idle_observed_at AS idleObservedAt,
  error_code AS errorCode, created_at AS createdAt, updated_at AS updatedAt`;

function initialize(sqlite: Sqlite): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_pending_operation_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      remote_accepting INTEGER NOT NULL DEFAULT 1 CHECK (remote_accepting IN (0,1)),
      steer_enabled INTEGER NOT NULL DEFAULT 0 CHECK (steer_enabled IN (0,1)),
      enqueue_enabled INTEGER NOT NULL DEFAULT 0 CHECK (enqueue_enabled IN (0,1)),
      acceptance_generation INTEGER NOT NULL DEFAULT 1
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
      acceptance_generation INTEGER NOT NULL DEFAULT 1,
      admitted_at INTEGER NULL,
      idle_observed_at INTEGER NULL,
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
    statement(sqlite, "INSERT INTO session_pending_operation_meta(singleton, schema_version, remote_accepting, steer_enabled, enqueue_enabled, acceptance_generation) VALUES (1, ?, 0, 0, 0, 1)").run(SESSION_PENDING_OPERATION_SCHEMA_VERSION);
  } else {
    const schemaVersion = isRecord(version) ? Number(version.schemaVersion) : Number.NaN;
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SESSION_PENDING_OPERATION_SCHEMA_VERSION) {
      throw new SessionPendingOperationError("store_unavailable");
    }

    // Repair columns independently of the stored version. Older releases could
    // persist schema_version=2 before all v2 columns reached disk, leaving a
    // nominally current database that could no longer start.
    const addColumn = (table: string, name: string, definition: string) => {
      const columns = statement(sqlite, `PRAGMA table_info(${table})`).all();
      if (!(Array.isArray(columns) && columns.some((column) => isRecord(column) && column.name === name))) {
        sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      }
    };
    addColumn("session_pending_operation_meta", "remote_accepting", "INTEGER NOT NULL DEFAULT 0 CHECK (remote_accepting IN (0,1))");
    addColumn("session_pending_operation_meta", "steer_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK (steer_enabled IN (0,1))");
    addColumn("session_pending_operation_meta", "enqueue_enabled", "INTEGER NOT NULL DEFAULT 0 CHECK (enqueue_enabled IN (0,1))");
    addColumn("session_pending_operation_meta", "acceptance_generation", "INTEGER NOT NULL DEFAULT 1");
    addColumn("session_pending_operations", "acceptance_generation", "INTEGER NOT NULL DEFAULT 1");
    addColumn("session_pending_operations", "admitted_at", "INTEGER NULL");
    addColumn("session_pending_operations", "idle_observed_at", "INTEGER NULL");
    if (schemaVersion !== SESSION_PENDING_OPERATION_SCHEMA_VERSION) {
      statement(sqlite, "UPDATE session_pending_operation_meta SET schema_version = ? WHERE singleton = 1")
        .run(SESSION_PENDING_OPERATION_SCHEMA_VERSION);
    }
  }
  try { sqlite.exec("PRAGMA secure_delete = ON"); } catch {}
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
  beforeMarkAdmitted?: (id: string) => void;
  terminalRetentionMs?: number;
  auditRetentionMs?: number;
  maxTerminal?: number;
  maxAudits?: number;
}) {
  const path = options.path ?? (options.config ? runtimeDbPath(options.config) : null);
  if (!path) throw new SessionPendingOperationError("store_unavailable");
  const runtime = await openRuntimeSqliteDatabase(path);
  const sqlite = runtime.sqlite;
  initialize(sqlite);
  const now = options.now ?? Date.now;
  const randomUUID = options.randomUUID ?? cryptoRandomUUID;
  const terminalRetentionMs = options.terminalRetentionMs ?? SESSION_PENDING_OPERATION_TERMINAL_RETENTION_MS;
  const auditRetentionMs = options.auditRetentionMs ?? SESSION_PENDING_OPERATION_AUDIT_RETENTION_MS;
  const maxTerminal = options.maxTerminal ?? SESSION_PENDING_OPERATION_MAX_TERMINAL;
  const maxAudits = options.maxAudits ?? SESSION_PENDING_OPERATION_MAX_AUDITS;

  function purgeStatements(timestamp: number): { operations: number; audits: number } {
    const terminalCutoff = timestamp - terminalRetentionMs;
    const auditCutoff = timestamp - auditRetentionMs;
    const oldOperations = statement(sqlite, `DELETE FROM session_pending_operations
      WHERE state IN ('cancelled','completed','failed') AND updated_at < ?`).run(terminalCutoff) as { changes?: number };
    const excessOperations = statement(sqlite, `DELETE FROM session_pending_operations WHERE id IN (
      SELECT id FROM session_pending_operations WHERE state IN ('cancelled','completed','failed')
      ORDER BY updated_at DESC, queue_sequence DESC LIMIT -1 OFFSET ?
    )`).run(maxTerminal) as { changes?: number };
    const oldAudits = statement(sqlite, "DELETE FROM session_pending_operation_audits WHERE occurred_at < ?").run(auditCutoff) as { changes?: number };
    const excessAudits = statement(sqlite, `DELETE FROM session_pending_operation_audits WHERE id IN (
      SELECT id FROM session_pending_operation_audits ORDER BY id DESC LIMIT -1 OFFSET ?
    )`).run(maxAudits) as { changes?: number };
    return {
      operations: Number(oldOperations.changes ?? 0) + Number(excessOperations.changes ?? 0),
      audits: Number(oldAudits.changes ?? 0) + Number(excessAudits.changes ?? 0),
    };
  }

  // Admission uses the pending operation ID as OpenCode's durable idempotency
  // identity. A crash may therefore safely return an unfinished claim to the
  // pending state and retry the same identity without duplicating execution.
  transaction(sqlite, () => {
    // Every managed-server process starts fail-closed. Electron re-enables
    // acceptance only after it has re-read current local settings and policy.
    statement(sqlite, "UPDATE session_pending_operation_meta SET remote_accepting = 0, steer_enabled = 0, enqueue_enabled = 0, acceptance_generation = acceptance_generation + 1 WHERE singleton = 1").run();
    statement(sqlite, "UPDATE session_pending_operations SET idle_observed_at = NULL WHERE state = 'admitted'").run();
    const rows = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations WHERE state = 'dispatching'`).all();
    for (const raw of Array.isArray(rows) ? rows : []) {
      const operation = rowValue(raw);
      const timestamp = now();
      // Preserve unknown admission outcomes across restart. The reconciliation
      // pump re-submits the same durable ID and original delivery mode.
      statement(sqlite, "UPDATE session_pending_operations SET error_code = 'admission_outcome_unknown', updated_at = ? WHERE id = ? AND state = 'dispatching'").run(timestamp, operation.id);
      audit(sqlite, operation, "recovered", "dispatching", timestamp);
    }
  });
  transaction(sqlite, () => purgeStatements(now()));

  function acceptance(): { enabled: boolean; steer: boolean; enqueue: boolean; generation: number } {
    const row = statement(sqlite, "SELECT remote_accepting AS enabled, steer_enabled AS steer, enqueue_enabled AS enqueue, acceptance_generation AS generation FROM session_pending_operation_meta WHERE singleton = 1").get();
    if (!isRecord(row)) throw new SessionPendingOperationError("store_unavailable");
    return { enabled: Number(row.enabled) === 1, steer: Number(row.steer) === 1, enqueue: Number(row.enqueue) === 1, generation: Number(row.generation) };
  }

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
      const gate = acceptance();
      if (!gate.enabled || !gate[mode]) throw new SessionPendingOperationError("not_cancellable");
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
        (id, workspace_id, session_id, mode, prompt, origin, command_correlation_id, state, queue_sequence, admitted_id,
         acceptance_generation, admitted_at, idle_observed_at, error_code, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'remote-control', ?, 'pending', ?, NULL, ?, NULL, NULL, NULL, ?, ?)`)
        .run(id, workspaceId, sessionId, mode, prompt, commandCorrelationId, queueSequence, gate.generation, timestamp, timestamp);
      const operation = get(id);
      if (!operation) throw new SessionPendingOperationError("store_unavailable");
      audit(sqlite, operation, "created", "pending", timestamp);
      return operation;
    });
  }

  function claimNext(workspaceId: string, sessionId: string, mode: SessionPendingOperationMode = "enqueue"): SessionPendingOperation | null {
    return transaction(sqlite, () => {
      const gate = acceptance();
      if (!gate.enabled || !gate[mode]) return null;
      const row = statement(sqlite, `SELECT ${SELECT_COLUMNS} FROM session_pending_operations
        WHERE workspace_id = ? AND session_id = ? AND mode = ? AND state = 'pending'
        ORDER BY queue_sequence ASC LIMIT 1`).get(requiredIdentifier(workspaceId), requiredIdentifier(sessionId), modeValue(mode));
      if (!row) return null;
      const operation = rowValue(row);
      const timestamp = now();
      const result = statement(sqlite, "UPDATE session_pending_operations SET state = 'dispatching', acceptance_generation = ?, updated_at = ? WHERE id = ? AND state = 'pending'").run(gate.generation, timestamp, operation.id) as { changes?: number };
      if (typeof result?.changes === "number" && result.changes !== 1) return null;
      audit(sqlite, operation, "claimed", "dispatching", timestamp);
      return get(operation.id);
    });
  }

  function claimById(id: string, notBefore: number): SessionPendingOperation | null {
    return transaction(sqlite, () => {
      const operation = get(id);
      if (!operation || operation.state !== "pending" || operation.createdAt > notBefore) return null;
      const gate = acceptance();
      if (!gate.enabled || !gate[operation.mode]) return null;
      const timestamp = now();
      const result = statement(sqlite, "UPDATE session_pending_operations SET state = 'dispatching', acceptance_generation = ?, updated_at = ? WHERE id = ? AND state = 'pending'")
        .run(gate.generation, timestamp, operation.id) as { changes?: number };
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
      statement(sqlite, "UPDATE session_pending_operations SET state = 'cancelled', prompt = '', error_code = 'cancelled', updated_at = ? WHERE id = ? AND state = 'pending'").run(timestamp, operation.id);
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
      const retainedPrompt = state === "pending" || state === "dispatching" ? operation.prompt : "";
      const admittedAt = state === "admitted" ? operation.admittedAt ?? timestamp : operation.admittedAt;
      statement(sqlite, "UPDATE session_pending_operations SET state = ?, prompt = ?, admitted_id = ?, admitted_at = ?, idle_observed_at = NULL, error_code = ?, updated_at = ? WHERE id = ?")
        .run(state, retainedPrompt, details.admittedId ?? operation.admittedId, admittedAt, details.errorCode ?? null, timestamp, operation.id);
      const updated = get(operation.id);
      if (!updated) throw new SessionPendingOperationError("store_unavailable");
      audit(sqlite, updated, action, state, timestamp);
      if (state === "cancelled" || state === "completed" || state === "failed") purgeStatements(timestamp);
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

  function fenceRemoteAcceptance(): number {
    return transaction(sqlite, () => {
      statement(sqlite, "UPDATE session_pending_operation_meta SET remote_accepting = 0, steer_enabled = 0, enqueue_enabled = 0, acceptance_generation = acceptance_generation + 1 WHERE singleton = 1").run();
      return acceptance().generation;
    });
  }

  function enableRemoteAcceptance(
    policy: { steer?: boolean; enqueue?: boolean } = { steer: true, enqueue: true },
    commandCorrelationId = "policy_mode_disabled",
  ): { generation: number; cancelled: number } {
    requiredIdentifier(commandCorrelationId);
    return transaction(sqlite, () => {
      statement(sqlite, "UPDATE session_pending_operation_meta SET remote_accepting = ?, steer_enabled = ?, enqueue_enabled = ?, acceptance_generation = acceptance_generation + 1 WHERE singleton = 1")
        .run(policy.steer || policy.enqueue ? 1 : 0, policy.steer ? 1 : 0, policy.enqueue ? 1 : 0);
      const disabledModes: SessionPendingOperationMode[] = [];
      if (!policy.steer) disabledModes.push("steer");
      if (!policy.enqueue) disabledModes.push("enqueue");
      const candidates = disabledModes.length === 0
        ? []
        : list().filter((item) => item.state === "pending" && disabledModes.includes(item.mode));
      for (const operation of candidates) {
        const timestamp = now();
        statement(sqlite, "UPDATE session_pending_operations SET state = 'cancelled', prompt = '', error_code = 'policy_mode_disabled', updated_at = ? WHERE id = ? AND state = 'pending'")
          .run(timestamp, operation.id);
        audit(sqlite, { ...operation, commandCorrelationId }, "cancelled", "policy_mode_disabled", timestamp);
      }
      purgeStatements(now());
      return { generation: acceptance().generation, cancelled: candidates.length };
    });
  }

  function cancelAllPendingRemote(commandCorrelationId: string, fenceGeneration = fenceRemoteAcceptance(), releasableDispatchingIds: readonly string[] = []): { cancelled: number; blockedDispatching: string[] } {
    requiredIdentifier(commandCorrelationId);
    return transaction(sqlite, () => {
      const gate = acceptance();
      if (gate.enabled || gate.generation !== fenceGeneration) throw new SessionPendingOperationError("store_unavailable");
      const releasable = new Set(releasableDispatchingIds.map(requiredIdentifier));
      const candidates = list().filter((item) => item.state === "pending" || (item.state === "dispatching" && releasable.has(item.id)));
      for (const operation of candidates) {
        const timestamp = now();
        statement(sqlite, "UPDATE session_pending_operations SET state = 'cancelled', prompt = '', error_code = 'cancelled', updated_at = ? WHERE id = ? AND state IN ('pending','dispatching')").run(timestamp, operation.id);
        audit(sqlite, { ...operation, commandCorrelationId }, "cancelled", "local_stop_all", timestamp);
      }
      purgeStatements(now());
      return {
        cancelled: candidates.length,
        blockedDispatching: list().filter((item) => item.state === "dispatching").map((item) => item.id),
      };
    });
  }

  function confirmIdle(id: string, minimumIntervalMs: number): boolean {
    return transaction(sqlite, () => {
      const operation = get(id);
      if (!operation || operation.state !== "admitted" || operation.admittedAt === null) return false;
      const timestamp = now();
      if (operation.idleObservedAt === null) {
        statement(sqlite, "UPDATE session_pending_operations SET idle_observed_at = ?, updated_at = ? WHERE id = ? AND state = 'admitted'").run(timestamp, timestamp, id);
        return false;
      }
      return timestamp - operation.idleObservedAt >= minimumIntervalMs;
    });
  }

  function clearIdleConfirmation(id: string): void {
    statement(sqlite, "UPDATE session_pending_operations SET idle_observed_at = NULL WHERE id = ? AND state = 'admitted'").run(requiredIdentifier(id));
  }

  return Object.freeze({
    create,
    get,
    list,
    listAudits,
    claimNext,
    claimById,
    acceptance,
    fenceRemoteAcceptance,
    enableRemoteAcceptance,
    cancel,
    cancelAllPendingRemote,
    confirmIdle,
    clearIdleConfirmation,
    purge: () => transaction(sqlite, () => purgeStatements(now())),
    releaseClaim: (id: string, errorCode: string) => transition(id, ["dispatching"], "pending", "recovered", { errorCode: requiredIdentifier(errorCode) }),
    markAdmitted: (id: string, admittedId: string) => {
      options.beforeMarkAdmitted?.(id);
      return transition(id, ["dispatching"], "admitted", "admitted", { admittedId: requiredIdentifier(admittedId) });
    },
    markCompleted: (id: string) => transition(id, ["admitted"], "completed", "completed"),
    markFailed: (id: string, errorCode: string) => transition(id, ["dispatching", "admitted"], "failed", "failed", { errorCode: requiredIdentifier(errorCode) }),
    close: () => runtime.close(),
  });
}

export type SessionPendingOperationStore = Awaited<ReturnType<typeof createSessionPendingOperationStore>>;

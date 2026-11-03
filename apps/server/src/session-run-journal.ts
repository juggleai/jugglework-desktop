import { randomUUID } from "node:crypto";
import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ActiveSessionMutation, SessionMutationTerminalStatus } from "./session-mutation-coordinator.js";
import type { ServerConfig } from "./types.js";

export const SESSION_RUN_JOURNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const SESSION_RUN_JOURNAL_MAX_EVENTS = 20_000;

export type SessionRunLifecycleEvent =
  | "run_reserved"
  | "run_started"
  | "progress"
  | "idle_suspected"
  | "abort_requested"
  | "abort_accepted"
  | "abort_rolled_back"
  | "start_rolled_back"
  | "run_terminal";

export type SessionRunJournalInput = {
  event: SessionRunLifecycleEvent;
  run: ActiveSessionMutation;
  terminalReason?: SessionMutationTerminalStatus | "dispatch_failed" | null;
  occurredAt?: number;
};

export type SessionRunJournalEntry = {
  id: number;
  workspaceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  origin: ActiveSessionMutation["origin"];
  event: SessionRunLifecycleEvent;
  status: ActiveSessionMutation["status"];
  terminalReason: string | null;
  startCommandCorrelationId: string | null;
  abortCommandCorrelationId: string | null;
  occurredAt: number;
};

export type SessionLifecycleFeedEntry = {
  deviceEpoch: string;
  sequence: number;
  eventId: string;
  workspaceId: string;
  sessionId: string;
  runId: string;
  generation: number;
  revision: number;
  origin: ActiveSessionMutation["origin"];
  status: "running" | SessionMutationTerminalStatus;
  title: string;
  occurredAt: number;
};

type Sqlite = RuntimeSqliteDatabase["sqlite"];
type SqlStatement = {
  run: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown;
};

function statement(sqlite: Sqlite, sql: string): SqlStatement {
  return "query" in sqlite
    ? (sqlite as { query(value: string): SqlStatement }).query(sql)
    : (sqlite as { prepare(value: string): SqlStatement }).prepare(sql);
}

function initialize(sqlite: Sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_run_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('local-renderer','remote-control')),
      event TEXT NOT NULL,
      status TEXT NOT NULL,
      terminal_reason TEXT NULL,
      start_command_correlation_id TEXT NULL,
      abort_command_correlation_id TEXT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_run_journal_session
      ON session_run_journal(workspace_id, session_id, id DESC);
    CREATE INDEX IF NOT EXISTS session_run_journal_run
      ON session_run_journal(run_id, id DESC);
    CREATE TABLE IF NOT EXISTS session_runs (
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL, revision INTEGER NOT NULL, origin TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, observed_active INTEGER NOT NULL,
      start_command_correlation_id TEXT NULL, abort_command_correlation_id TEXT NULL,
      started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, active_observed_at INTEGER NULL,
      abort_requested_at INTEGER NULL, terminal_reason TEXT NULL, terminal_at INTEGER NULL,
      PRIMARY KEY(run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS session_runs_one_active
      ON session_runs(workspace_id, session_id) WHERE terminal_reason IS NULL;
    CREATE TABLE IF NOT EXISTS session_lifecycle_device (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1), device_epoch TEXT NOT NULL,
      next_sequence INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS session_lifecycle_feed (
      device_epoch TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
      generation INTEGER NOT NULL, revision INTEGER NOT NULL, origin TEXT NOT NULL,
      status TEXT NOT NULL, title TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      PRIMARY KEY(device_epoch, sequence)
    );
    CREATE TABLE IF NOT EXISTS session_lifecycle_consumers (
      consumer_id TEXT PRIMARY KEY, device_epoch TEXT NOT NULL, next_sequence INTEGER NOT NULL,
      last_event_id TEXT NULL, updated_at INTEGER NOT NULL
    );
  `);
}

export async function createSessionRunJournal(options: {
  config?: ServerConfig;
  path?: string;
  now?: () => number;
  retentionMs?: number;
  maxEvents?: number;
}) {
  const path = options.path ?? (options.config ? runtimeDbPath(options.config) : null);
  if (!path) throw new Error("session_run_journal_path_required");
  const runtime = await openRuntimeSqliteDatabase(path);
  const sqlite = runtime.sqlite;
  initialize(sqlite);
  statement(sqlite, `INSERT OR IGNORE INTO session_lifecycle_device(singleton, device_epoch, next_sequence)
    VALUES (1, ?, 1)`).run(randomUUID());
  // Kept separately from the bounded diagnostic journal. BEGIN IMMEDIATE
  // serializes migration/allocation across connections and processes.
  sqlite.exec("PRAGMA busy_timeout = 5000");
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS session_run_generation (
      singleton INTEGER PRIMARY KEY, value INTEGER NOT NULL
    );
    INSERT INTO session_run_generation(singleton, value)
      SELECT 1, MAX(COALESCE((SELECT MAX(generation) FROM session_run_journal), 0),
        COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'session_run_journal'), 0))
      WHERE NOT EXISTS (SELECT 1 FROM session_run_generation WHERE singleton = 1);`);
    // A one-time transactional backfill cannot replay pruned outbox rows on reopen.
    sqlite.exec(`CREATE TABLE IF NOT EXISTS session_run_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS session_run_terminals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
        generation INTEGER NOT NULL, terminal_reason TEXT NOT NULL, occurred_at INTEGER NOT NULL,
        UNIQUE(workspace_id, session_id, run_id, generation)
      );
      CREATE INDEX IF NOT EXISTS session_run_terminals_workspace ON session_run_terminals(workspace_id, id);
      CREATE INDEX IF NOT EXISTS session_run_terminals_age ON session_run_terminals(occurred_at);
      INSERT OR IGNORE INTO session_run_terminals(workspace_id, session_id, run_id, generation, terminal_reason, occurred_at)
        SELECT workspace_id, session_id, run_id, generation, terminal_reason, occurred_at
        FROM session_run_journal WHERE event = 'run_terminal'
        AND terminal_reason IN ('completed','failed','aborted')
        AND NOT EXISTS (SELECT 1 FROM session_run_migrations WHERE name = 'terminal_outbox_v1') ORDER BY id;
      INSERT OR IGNORE INTO session_run_migrations VALUES ('terminal_outbox_v1');`);
    sqlite.exec(`INSERT OR IGNORE INTO session_runs(workspace_id,session_id,run_id,generation,revision,origin,title,status,
      observed_active,start_command_correlation_id,abort_command_correlation_id,started_at,updated_at,active_observed_at,abort_requested_at)
      SELECT j.workspace_id,j.session_id,j.run_id,j.generation,1,j.origin,'',j.status,
        CASE WHEN j.status='starting' THEN 0 ELSE 1 END,j.start_command_correlation_id,j.abort_command_correlation_id,
        MIN(j.occurred_at),MAX(j.occurred_at),CASE WHEN j.status='starting' THEN NULL ELSE MAX(j.occurred_at) END,NULL
      FROM session_run_journal j
      WHERE NOT EXISTS (SELECT 1 FROM session_run_migrations WHERE name='session_runs_v3')
        AND j.id=(SELECT MAX(x.id) FROM session_run_journal x WHERE x.workspace_id=j.workspace_id AND x.session_id=j.session_id)
        AND j.event NOT IN ('run_terminal','start_rolled_back')
      GROUP BY j.workspace_id,j.session_id,j.run_id;
      INSERT OR IGNORE INTO session_run_migrations VALUES ('session_runs_v3');`);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    runtime.close();
    throw error;
  }
  const allocateGeneration = () => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const rows = statement(sqlite, `UPDATE session_run_generation SET value = value + 1
        WHERE singleton = 1 AND value < 9007199254740991 RETURNING value`).all() as { value: number }[];
      const value = rows[0]?.value;
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("session_run_generation_exhausted");
      sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? SESSION_RUN_JOURNAL_RETENTION_MS;
  const maxEvents = options.maxEvents ?? SESSION_RUN_JOURNAL_MAX_EVENTS;

  const purge = (timestamp = now()) => {
    statement(sqlite, "DELETE FROM session_run_terminals WHERE occurred_at < ?").run(timestamp - retentionMs);
    statement(sqlite, "DELETE FROM session_run_journal WHERE occurred_at < ?").run(timestamp - retentionMs);
    statement(sqlite, `DELETE FROM session_run_journal WHERE id IN (
      SELECT id FROM session_run_journal ORDER BY id DESC LIMIT -1 OFFSET ?
    )`).run(maxEvents);
  };

  const appendFeed = (run: ActiveSessionMutation, status: SessionLifecycleFeedEntry["status"], timestamp: number) => {
    const device = statement(sqlite, `UPDATE session_lifecycle_device SET next_sequence = next_sequence + 1
      WHERE singleton = 1 RETURNING device_epoch AS deviceEpoch, next_sequence - 1 AS sequence`).all() as { deviceEpoch: string; sequence: number }[];
    const row = device[0];
    if (!row || !Number.isSafeInteger(row.sequence)) throw new Error("session_lifecycle_sequence_unavailable");
    statement(sqlite, `INSERT INTO session_lifecycle_feed(device_epoch,sequence,event_id,workspace_id,session_id,run_id,
      generation,revision,origin,status,title,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.deviceEpoch, row.sequence, randomUUID(), run.workspaceId, run.sessionId, run.runId,
      run.generation, run.revision, run.origin, status, run.title, timestamp,
    );
  };

  const record = (input: SessionRunJournalInput) => {
    const timestamp = input.occurredAt ?? now();
    const { run } = input;
    sqlite.exec("BEGIN IMMEDIATE");
    try {
    if (input.event === "run_reserved") {
      statement(sqlite, `INSERT INTO session_runs(workspace_id,session_id,run_id,generation,revision,origin,title,status,
        observed_active,start_command_correlation_id,abort_command_correlation_id,started_at,updated_at,active_observed_at,abort_requested_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(run.workspaceId, run.sessionId, run.runId, run.generation,
        run.revision, run.origin, run.title, run.status, run.observedActive ? 1 : 0, run.startCommandCorrelationId,
        run.abortCommandCorrelationId, run.startedAt, run.updatedAt, run.activeObservedAt, run.abortRequestedAt);
    } else if (input.event === "run_terminal" || input.event === "start_rolled_back") {
      const terminal = input.terminalReason ?? "failed";
      const result = statement(sqlite, `UPDATE session_runs SET revision=?, status='terminal', terminal_reason=?, terminal_at=?, updated_at=?
        WHERE workspace_id=? AND session_id=? AND run_id=? AND terminal_reason IS NULL`).run(
        run.revision + 1, terminal, timestamp, timestamp, run.workspaceId, run.sessionId, run.runId) as { changes?: number };
      if (Number(result.changes ?? 0) !== 1) throw new Error("session_run_terminal_conflict");
      if (["completed", "failed", "aborted"].includes(terminal)) appendFeed({ ...run, revision: run.revision + 1 }, terminal as SessionMutationTerminalStatus, timestamp);
    } else {
      const result = statement(sqlite, `UPDATE session_runs SET revision=?,status=?,observed_active=?,abort_command_correlation_id=?,
        updated_at=?,active_observed_at=?,abort_requested_at=? WHERE workspace_id=? AND session_id=? AND run_id=? AND terminal_reason IS NULL`).run(
        run.revision, run.status, run.observedActive ? 1 : 0, run.abortCommandCorrelationId, run.updatedAt,
        run.activeObservedAt, run.abortRequestedAt, run.workspaceId, run.sessionId, run.runId) as { changes?: number };
      if (Number(result.changes ?? 0) !== 1) {
        const known = statement(sqlite, "SELECT 1 FROM session_runs WHERE run_id=?").all(run.runId);
        if (input.event !== "progress" || !Array.isArray(known) || known.length === 0) throw new Error("session_run_update_conflict");
      }
      if (input.event === "run_started") appendFeed(run, "running", timestamp);
    }
    if (input.event === "run_terminal" && ["completed", "failed", "aborted"].includes(input.terminalReason ?? "")) {
      statement(sqlite, `INSERT OR IGNORE INTO session_run_terminals
        (workspace_id, session_id, run_id, generation, terminal_reason, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(run.workspaceId, run.sessionId, run.runId, run.generation, input.terminalReason, timestamp);
    }
    statement(sqlite, `INSERT INTO session_run_journal (
      workspace_id, session_id, run_id, generation, origin, event, status,
      terminal_reason, start_command_correlation_id, abort_command_correlation_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      run.workspaceId,
      run.sessionId,
      run.runId,
      run.generation,
      run.origin,
      input.event,
      run.status,
      input.terminalReason ?? null,
      run.startCommandCorrelationId,
      run.abortCommandCorrelationId,
      timestamp,
    );
    purge(timestamp);
    sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  };

  const listActive = (): ActiveSessionMutation[] => (statement(sqlite, `SELECT workspace_id AS workspaceId,
    session_id AS sessionId,run_id AS runId,generation,revision,origin,title,
    start_command_correlation_id AS startCommandCorrelationId,abort_command_correlation_id AS abortCommandCorrelationId,
    status,observed_active AS observedActive,started_at AS startedAt,updated_at AS updatedAt,
    active_observed_at AS activeObservedAt,abort_requested_at AS abortRequestedAt
    FROM session_runs WHERE terminal_reason IS NULL ORDER BY started_at`).all() as any[])
    .map((row) => ({ ...row, observedActive: Boolean(row.observedActive) })) as ActiveSessionMutation[];

  const listFeed = (consumerId: string, after?: number, limit = 100) => {
    const device = statement(sqlite, "SELECT device_epoch AS deviceEpoch FROM session_lifecycle_device WHERE singleton=1").all() as { deviceEpoch: string }[];
    const deviceEpoch = device[0]?.deviceEpoch;
    if (!deviceEpoch) throw new Error("session_lifecycle_device_unavailable");
    const consumer = statement(sqlite, `SELECT device_epoch AS deviceEpoch,next_sequence AS nextSequence FROM session_lifecycle_consumers
      WHERE consumer_id=?`).all(consumerId) as { deviceEpoch: string; nextSequence: number }[];
    const nextSequence = consumer[0]?.deviceEpoch === deviceEpoch ? consumer[0].nextSequence : 1;
    const cursor = after === undefined ? nextSequence - 1 : after;
    const items = statement(sqlite, `SELECT device_epoch AS deviceEpoch,sequence,event_id AS eventId,workspace_id AS workspaceId,
      session_id AS sessionId,run_id AS runId,generation,revision,origin,status,title,occurred_at AS occurredAt
      FROM session_lifecycle_feed WHERE device_epoch=? AND sequence>? ORDER BY sequence LIMIT ?`).all(
      deviceEpoch, cursor, Math.max(1, Math.min(100, Math.trunc(limit))),
    ) as SessionLifecycleFeedEntry[];
    return { deviceEpoch, nextSequence, items };
  };

  const ackFeed = (consumerId: string, deviceEpoch: string, sequence: number, eventId: string) => {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const current = statement(sqlite, "SELECT device_epoch AS deviceEpoch FROM session_lifecycle_device WHERE singleton=1").all() as { deviceEpoch: string }[];
      if (current[0]?.deviceEpoch !== deviceEpoch) throw new Error("session_lifecycle_epoch_mismatch");
      statement(sqlite, `INSERT OR IGNORE INTO session_lifecycle_consumers(consumer_id,device_epoch,next_sequence,last_event_id,updated_at)
        VALUES (?,?,1,NULL,?)`).run(consumerId, deviceEpoch, now());
      const consumer = statement(sqlite, `SELECT next_sequence AS nextSequence FROM session_lifecycle_consumers WHERE consumer_id=?`).all(consumerId) as { nextSequence: number }[];
      if (consumer[0]?.nextSequence !== sequence) throw new Error("session_lifecycle_ack_out_of_order");
      const event = statement(sqlite, `SELECT event_id AS eventId FROM session_lifecycle_feed WHERE device_epoch=? AND sequence=?`).all(deviceEpoch, sequence) as { eventId: string }[];
      if (event[0]?.eventId !== eventId) throw new Error("session_lifecycle_event_conflict");
      statement(sqlite, `UPDATE session_lifecycle_consumers SET next_sequence=?,last_event_id=?,updated_at=? WHERE consumer_id=?`).run(sequence + 1, eventId, now(), consumerId);
      sqlite.exec("COMMIT");
      return { deviceEpoch, nextSequence: sequence + 1, eventId };
    } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  };

  const list = (workspaceId: string, sessionId: string, limit = 100): SessionRunJournalEntry[] => {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 100;
    return statement(sqlite, `SELECT
      id, workspace_id AS workspaceId, session_id AS sessionId, run_id AS runId,
      generation, origin, event, status, terminal_reason AS terminalReason,
      start_command_correlation_id AS startCommandCorrelationId,
      abort_command_correlation_id AS abortCommandCorrelationId,
      occurred_at AS occurredAt
      FROM session_run_journal
      WHERE workspace_id = ? AND session_id = ?
      ORDER BY id DESC LIMIT ?`).all(workspaceId, sessionId, safeLimit) as SessionRunJournalEntry[];
  };

  const terminalStatus = (workspaceId: string, sessionId: string, runId: string): SessionMutationTerminalStatus | null => {
    const rows = statement(sqlite, `SELECT terminal_reason AS reason FROM session_run_terminals
      WHERE workspace_id = ? AND session_id = ? AND run_id = ? AND occurred_at >= ?
      ORDER BY id DESC LIMIT 1`).all(workspaceId, sessionId, runId, now() - retentionMs) as { reason: string }[];
    const reason = rows[0]?.reason;
    return reason === "completed" || reason === "failed" || reason === "aborted" ? reason : null;
  };

  const listTerminals = (workspaceId: string, after = 0, limit = 100) => {
    const items = statement(sqlite, `SELECT id, workspace_id AS workspaceId,
      session_id AS sessionId, run_id AS runId, generation,
      terminal_reason AS terminalReason, occurred_at AS occurredAt
      FROM session_run_terminals WHERE workspace_id = ? AND id > ?
      AND occurred_at >= ?
      AND terminal_reason IN ('completed', 'failed', 'aborted')
      ORDER BY id ASC LIMIT ?`).all(workspaceId, after, now() - retentionMs,
        Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 100) as Pick<SessionRunJournalEntry,
          "id" | "workspaceId" | "sessionId" | "runId" | "generation" | "terminalReason" | "occurredAt">[];
    return { items, cursor: items.at(-1)?.id ?? after };
  };

  return Object.freeze({ allocateGeneration, record, list, listActive, listFeed, ackFeed, listTerminals, terminalStatus, purge, close: runtime.close });
}

export type SessionRunJournal = Awaited<ReturnType<typeof createSessionRunJournal>>;

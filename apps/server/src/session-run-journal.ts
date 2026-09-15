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
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? SESSION_RUN_JOURNAL_RETENTION_MS;
  const maxEvents = options.maxEvents ?? SESSION_RUN_JOURNAL_MAX_EVENTS;

  const purge = (timestamp = now()) => {
    statement(sqlite, "DELETE FROM session_run_journal WHERE occurred_at < ?").run(timestamp - retentionMs);
    statement(sqlite, `DELETE FROM session_run_journal WHERE id IN (
      SELECT id FROM session_run_journal ORDER BY id DESC LIMIT -1 OFFSET ?
    )`).run(maxEvents);
  };

  const record = (input: SessionRunJournalInput) => {
    const timestamp = input.occurredAt ?? now();
    const { run } = input;
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
  };

  const list = (workspaceId: string, sessionId: string, limit = 100): SessionRunJournalEntry[] => {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
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

  return Object.freeze({ record, list, purge, close: runtime.close });
}

export type SessionRunJournal = Awaited<ReturnType<typeof createSessionRunJournal>>;


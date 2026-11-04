import { openRuntimeSqliteDatabase, runtimeDbPath, type RuntimeSqliteDatabase } from "./runtime-db.js";
import type { ServerConfig } from "./types.js";

export type SessionModelPreference = {
  workspaceId: string;
  sessionId: string;
  revision: number;
  mode: "auto" | "explicit";
  model: { providerID: string; modelID: string } | null;
  updatedAt: number;
};

export type SessionModelPreferenceEvent = SessionModelPreference & { seq: number; type: "session.model.updated" };
type Sqlite = RuntimeSqliteDatabase["sqlite"];
type Statement = { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown };
const statement = (sqlite: Sqlite, sql: string): Statement => "query" in sqlite
  ? (sqlite as { query(value: string): Statement }).query(sql)
  : (sqlite as { prepare(value: string): Statement }).prepare(sql);

function preference(row: any, workspaceId: string, sessionId: string): SessionModelPreference {
  if (!row) return { workspaceId, sessionId, revision: 0, mode: "auto", model: null, updatedAt: 0 };
  return {
    workspaceId, sessionId, revision: Number(row.revision), mode: row.mode,
    model: row.mode === "explicit" ? { providerID: String(row.providerId), modelID: String(row.modelId) } : null,
    updatedAt: Number(row.updatedAt),
  };
}

export async function createSessionModelPreferenceStore(options: { config?: ServerConfig; path?: string; now?: () => number }) {
  const path = options.path ?? (options.config ? runtimeDbPath(options.config) : null);
  if (!path) throw new Error("session_model_preference_store_unavailable");
  const runtime = await openRuntimeSqliteDatabase(path);
  const sqlite = runtime.sqlite;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS session_model_preferences (
      workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, revision INTEGER NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('auto','explicit')), provider_id TEXT NULL, model_id TEXT NULL,
      updated_at INTEGER NOT NULL, PRIMARY KEY (workspace_id, session_id)
    );
    CREATE TABLE IF NOT EXISTS session_model_preference_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL,
      revision INTEGER NOT NULL, mode TEXT NOT NULL, provider_id TEXT NULL, model_id TEXT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_model_preference_events_workspace ON session_model_preference_events(workspace_id, seq);
  `);
  const now = options.now ?? Date.now;
  const get = (workspaceId: string, sessionId: string) => preference(statement(sqlite, `SELECT revision, mode, provider_id AS providerId, model_id AS modelId, updated_at AS updatedAt
    FROM session_model_preferences WHERE workspace_id = ? AND session_id = ?`).get(workspaceId, sessionId), workspaceId, sessionId);
  return {
    get,
    set(input: { workspaceId: string; sessionId: string; expectedRevision: number; mode: "auto" | "explicit"; model: { providerID: string; modelID: string } | null }) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const current = get(input.workspaceId, input.sessionId);
        if (current.revision !== input.expectedRevision) {
          sqlite.exec("ROLLBACK");
          return { updated: false as const, preference: current };
        }
        const revision = current.revision + 1;
        const updatedAt = now();
        statement(sqlite, `INSERT INTO session_model_preferences(workspace_id, session_id, revision, mode, provider_id, model_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, session_id) DO UPDATE SET
          revision=excluded.revision, mode=excluded.mode, provider_id=excluded.provider_id, model_id=excluded.model_id, updated_at=excluded.updated_at`)
          .run(input.workspaceId, input.sessionId, revision, input.mode, input.model?.providerID ?? null, input.model?.modelID ?? null, updatedAt);
        statement(sqlite, `INSERT INTO session_model_preference_events(workspace_id, session_id, revision, mode, provider_id, model_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(input.workspaceId, input.sessionId, revision, input.mode, input.model?.providerID ?? null, input.model?.modelID ?? null, updatedAt);
        statement(sqlite, `DELETE FROM session_model_preference_events WHERE workspace_id = ? AND seq NOT IN (
          SELECT seq FROM session_model_preference_events WHERE workspace_id = ? ORDER BY seq DESC LIMIT 5000
        )`).run(input.workspaceId, input.workspaceId);
        sqlite.exec("COMMIT");
        return { updated: true as const, preference: get(input.workspaceId, input.sessionId) };
      } catch (error) {
        try { sqlite.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    events(workspaceId: string, since = 0): { items: SessionModelPreferenceEvent[]; cursor: number } {
      const rows = statement(sqlite, `SELECT seq, workspace_id AS workspaceId, session_id AS sessionId, revision, mode,
        provider_id AS providerId, model_id AS modelId, updated_at AS updatedAt FROM session_model_preference_events
        WHERE workspace_id = ? AND seq > ? ORDER BY seq ASC LIMIT 500`).all(workspaceId, since) as any[];
      const items = rows.map((row) => ({ ...preference(row, row.workspaceId, row.sessionId), seq: Number(row.seq), type: "session.model.updated" as const }));
      return { items, cursor: items.at(-1)?.seq ?? since };
    },
    delete(workspaceId: string, sessionId: string): void {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        statement(sqlite, "DELETE FROM session_model_preferences WHERE workspace_id = ? AND session_id = ?").run(workspaceId, sessionId);
        statement(sqlite, "DELETE FROM session_model_preference_events WHERE workspace_id = ? AND session_id = ?").run(workspaceId, sessionId);
        sqlite.exec("COMMIT");
      } catch (error) {
        try { sqlite.exec("ROLLBACK"); } catch {}
        throw error;
      }
    },
    close: runtime.close,
  };
}

export type SessionModelPreferenceStore = Awaited<ReturnType<typeof createSessionModelPreferenceStore>>;

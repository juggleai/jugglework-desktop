import type { AutomationSqlite } from "../automation/sqlite.js";

export function migrateMediaGenerationDatabase(database: AutomationSqlite): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS media_generation_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    const applied = database.get<{ version: number }>(
      "SELECT MAX(version) AS version FROM media_generation_schema_migrations",
    )?.version ?? 0;
    if (applied < 1) {
      database.exec(`CREATE TABLE IF NOT EXISTS video_generation_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      session_id TEXT,
      client_request_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL,
      options_json TEXT NOT NULL,
      provider_job_id TEXT,
      next_poll_at INTEGER,
      poll_attempts INTEGER NOT NULL DEFAULT 0,
      artifact_json TEXT,
      error_code TEXT,
      error_message TEXT,
      error_retryable INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (mode IN ('text-to-video', 'image-to-video')),
      CHECK (status IN ('queued','submitting','submitted','running','cancel_requested','downloading','completed','failed','cancelled')),
      CHECK (revision > 0 AND poll_attempts >= 0),
      UNIQUE (workspace_id, session_id, client_request_id)
    )`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_video_jobs_reconcile
        ON video_generation_jobs(status, next_poll_at, created_at)`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_video_jobs_session
        ON video_generation_jobs(workspace_id, session_id, created_at DESC)`);
      database.run("INSERT INTO media_generation_schema_migrations(version, applied_at) VALUES (?, ?)", [1, Date.now()]);
    }
    if (applied < 2) {
      const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(video_generation_jobs)").map((column) => column.name));
      if (!columns.has("adapter_binding_json")) database.exec("ALTER TABLE video_generation_jobs ADD COLUMN adapter_binding_json TEXT");
      database.run(`UPDATE video_generation_jobs SET status = 'failed', error_code = ?, error_message = ?, error_retryable = 0,
        revision = revision + 1, updated_at = ? WHERE status NOT IN ('completed','failed','cancelled')`, [
        "video_adapter_binding_unavailable",
        "This video job predates immutable provider binding and cannot be reconciled safely.",
        Date.now(),
      ]);
      database.run("INSERT INTO media_generation_schema_migrations(version, applied_at) VALUES (?, ?)", [2, Date.now()]);
    }
    if (applied < 3) {
      const sql = database.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'video_generation_jobs'")?.sql ?? "";
      if (!sql.includes("submission_unknown")) {
        database.exec(`ALTER TABLE video_generation_jobs RENAME TO video_generation_jobs_v2;
          CREATE TABLE video_generation_jobs (
            id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT, client_request_id TEXT NOT NULL,
            provider_id TEXT NOT NULL, model_id TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, progress REAL,
            options_json TEXT NOT NULL, provider_job_id TEXT, next_poll_at INTEGER, poll_attempts INTEGER NOT NULL DEFAULT 0,
            artifact_json TEXT, error_code TEXT, error_message TEXT, error_retryable INTEGER, adapter_binding_json TEXT,
            revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            CHECK (mode IN ('text-to-video', 'image-to-video')),
            CHECK (status IN ('queued','submitting','submitted','running','cancel_requested','downloading','completed','failed','cancelled','submission_unknown')),
            CHECK (revision > 0 AND poll_attempts >= 0), UNIQUE (workspace_id, session_id, client_request_id)
          );
          INSERT INTO video_generation_jobs (
            id, workspace_id, session_id, client_request_id, provider_id, model_id, mode, status, progress,
            options_json, provider_job_id, next_poll_at, poll_attempts, artifact_json, error_code, error_message,
            error_retryable, adapter_binding_json, revision, created_at, updated_at
          ) SELECT
            id, workspace_id, session_id, client_request_id, provider_id, model_id, mode, status, progress,
            options_json, provider_job_id, next_poll_at, poll_attempts, artifact_json, error_code, error_message,
            error_retryable, adapter_binding_json, revision, created_at, updated_at
          FROM video_generation_jobs_v2;
          DROP TABLE video_generation_jobs_v2;
          CREATE INDEX idx_video_jobs_reconcile ON video_generation_jobs(status, next_poll_at, created_at);
          CREATE INDEX idx_video_jobs_session ON video_generation_jobs(workspace_id, session_id, created_at DESC);`);
      }
      database.run("INSERT INTO media_generation_schema_migrations(version, applied_at) VALUES (?, ?)", [3, Date.now()]);
    }
  });
}

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
    if (applied >= 1) return;
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
  });
}

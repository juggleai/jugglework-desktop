import type { AutomationSqlite } from "../automation/sqlite.js";

export function migrateToonTextJobDatabase(database: AutomationSqlite): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_factory_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at INTEGER NOT NULL
    )`);
    const applied = database.get<{ version: number }>(
      "SELECT MAX(version) AS version FROM toon_factory_schema_migrations",
    )?.version ?? 0;
    if (applied < 1) {
      database.exec(`CREATE TABLE IF NOT EXISTS toon_factory_text_jobs (
        id TEXT PRIMARY KEY NOT NULL,
        workspace_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        episode_id TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        output_schema_json TEXT NOT NULL,
        request_snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL,
        transient_session_id TEXT,
        dispatched INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        result_json TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        cancelled_at INTEGER,
        projection_dirty INTEGER NOT NULL DEFAULT 1,
        projection_attempts INTEGER NOT NULL DEFAULT 0,
        projection_retry_at INTEGER NOT NULL DEFAULT 0,
        CHECK (status IN ('queued','running','cancel_requested','completed','failed','cancelled')),
        CHECK (action IN ('script','asset-plan','storyboard')),
        CHECK (revision > 0)
      )`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_toon_text_jobs_active
        ON toon_factory_text_jobs(status, created_at)`);
      database.exec(`CREATE INDEX IF NOT EXISTS idx_toon_text_jobs_project
        ON toon_factory_text_jobs(workspace_id, project_id, created_at DESC)`);
      database.run("INSERT INTO toon_factory_schema_migrations(version, applied_at) VALUES (?, ?)", [1, Date.now()]);
    }
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_factory_text_jobs)").map((column) => column.name));
    if (!columns.has("projection_dirty")) database.exec("ALTER TABLE toon_factory_text_jobs ADD COLUMN projection_dirty INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("projection_attempts")) database.exec("ALTER TABLE toon_factory_text_jobs ADD COLUMN projection_attempts INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("projection_retry_at")) database.exec("ALTER TABLE toon_factory_text_jobs ADD COLUMN projection_retry_at INTEGER NOT NULL DEFAULT 0");
    database.exec(`CREATE INDEX IF NOT EXISTS idx_toon_text_jobs_projection
      ON toon_factory_text_jobs(projection_dirty, projection_retry_at, updated_at)`);
  });
}

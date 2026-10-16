import type { AutomationSqlite } from "../automation/sqlite.js";

export function migrateToonMediaJobDatabase(database: AutomationSqlite): void {
  database.transaction(() => {
    database.exec(`CREATE TABLE IF NOT EXISTS toon_factory_media_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      job_json TEXT NOT NULL,
      projection_dirty INTEGER NOT NULL DEFAULT 1,
      projection_attempts INTEGER NOT NULL DEFAULT 0,
      projection_retry_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_id, project_id, request_id)
    )`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_toon_media_jobs_project
      ON toon_factory_media_jobs(workspace_id, project_id, created_at DESC)`);
    const columns = new Set(database.all<{ name: string }>("PRAGMA table_info(toon_factory_media_jobs)").map((column) => column.name));
    if (!columns.has("projection_dirty")) database.exec("ALTER TABLE toon_factory_media_jobs ADD COLUMN projection_dirty INTEGER NOT NULL DEFAULT 1");
    if (!columns.has("projection_attempts")) database.exec("ALTER TABLE toon_factory_media_jobs ADD COLUMN projection_attempts INTEGER NOT NULL DEFAULT 0");
    if (!columns.has("projection_retry_at")) database.exec("ALTER TABLE toon_factory_media_jobs ADD COLUMN projection_retry_at INTEGER NOT NULL DEFAULT 0");
    database.exec(`CREATE INDEX IF NOT EXISTS idx_toon_media_jobs_projection
      ON toon_factory_media_jobs(projection_dirty, projection_retry_at, updated_at)`);
  });
}

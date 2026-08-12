import type { AutomationSqlite } from "./sqlite.js";

type AutomationMigration = {
  version: number;
  statements: string[];
};

const migrations: AutomationMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS automation_tasks (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        definition_schema TEXT NOT NULL,
        definition_json TEXT NOT NULL,
        raw_document_json TEXT NOT NULL,
        compatibility_state TEXT NOT NULL DEFAULT 'compatible',
        lifecycle TEXT NOT NULL,
        revision INTEGER NOT NULL,
        executor_device_id TEXT NOT NULL,
        next_run_at INTEGER,
        timezone TEXT NOT NULL,
        active_start_date TEXT,
        active_end_date TEXT,
        permission_profile_version TEXT NOT NULL,
        permission_acknowledged_at INTEGER NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'pending',
        sync_error_code TEXT,
        deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (revision > 0),
        CHECK (lifecycle IN ('enabled', 'paused', 'completed', 'tombstoned')),
        CHECK (compatibility_state IN ('compatible', 'incompatible-read-only')),
        CHECK (sync_state IN ('pending', 'synced', 'error', 'incompatible-read-only')),
        CHECK ((active_start_date IS NULL AND active_end_date IS NULL) OR (active_start_date IS NOT NULL AND active_end_date IS NOT NULL))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_automation_tasks_list
        ON automation_tasks(deleted_at, lifecycle, next_run_at, updated_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_tasks_workspace
        ON automation_tasks(workspace_id, deleted_at, updated_at DESC)`,
      `CREATE TABLE IF NOT EXISTS automation_runs (
        id TEXT PRIMARY KEY NOT NULL,
        automation_id TEXT NOT NULL,
        automation_name TEXT NOT NULL,
        definition_revision INTEGER NOT NULL,
        trigger_source TEXT NOT NULL,
        state TEXT NOT NULL,
        scheduled_for INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        workspace_name TEXT NOT NULL,
        session_id TEXT,
        snapshot_json TEXT NOT NULL,
        concrete_selection_json TEXT,
        error_code TEXT,
        error_message TEXT,
        queued_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        revision INTEGER NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'pending',
        sync_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automation_tasks(id) ON DELETE RESTRICT,
        CHECK (definition_revision > 0 AND revision > 0),
        CHECK (trigger_source IN ('scheduled', 'catchup', 'manual')),
        CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
        CHECK (sync_state IN ('pending', 'synced', 'error', 'incompatible-read-only'))
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_automation_runs_scheduled_occurrence
        ON automation_runs(automation_id, scheduled_for)
        WHERE trigger_source IN ('scheduled', 'catchup')`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_automation_runs_nonterminal
        ON automation_runs(automation_id)
        WHERE state IN ('queued', 'running')`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_history
        ON automation_runs(scheduled_for DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_task_history
        ON automation_runs(automation_id, scheduled_for DESC, id DESC)`,
      `CREATE TABLE IF NOT EXISTS automation_sync_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        mutation_id TEXT NOT NULL UNIQUE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        local_revision INTEGER NOT NULL,
        operation TEXT NOT NULL,
        payload_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error_code TEXT,
        last_error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (entity_type IN ('definition', 'run')),
        CHECK (operation IN ('upsert', 'delete')),
        CHECK (state IN ('pending', 'leased', 'error')),
        CHECK (local_revision > 0 AND payload_version > 0 AND attempts >= 0)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_automation_outbox_delivery
        ON automation_sync_outbox(state, next_attempt_at, created_at, id)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_outbox_entity
        ON automation_sync_outbox(entity_type, entity_id, local_revision)`,
      `CREATE TABLE IF NOT EXISTS automation_runtime_state (
        state_key TEXT PRIMARY KEY NOT NULL,
        value_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    statements: [
      // TIPS: 当前产品只允许本地工作区自动化。旧版本可能已经留下待上传 outbox，升级后必须
      // 一次性清理并把已有记录标成本地完成，避免后台继续请求尚未开放的远端自动化接口。
      "DELETE FROM automation_sync_outbox",
      "UPDATE automation_tasks SET sync_state = 'synced', sync_error_code = NULL WHERE compatibility_state = 'compatible'",
      "UPDATE automation_runs SET sync_state = 'synced', sync_error_code = NULL",
    ],
  },
];

/** 按版本顺序执行自动化模块的前向 SQLite 迁移。 */
export function migrateAutomationDatabase(database: AutomationSqlite, now = Date.now()): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE IF NOT EXISTS automation_schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(database.all<{ version: number }>("SELECT version FROM automation_schema_migrations").map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      for (const statement of migration.statements) database.exec(statement);
      database.run("INSERT INTO automation_schema_migrations(version, applied_at) VALUES (?, ?)", [migration.version, now]);
    });
  }
}

/** 返回当前自动化数据库结构版本。 */
export function automationDatabaseVersion(database: AutomationSqlite): number {
  const row = database.get<{ version: number }>("SELECT MAX(version) AS version FROM automation_schema_migrations");
  return Number(row?.version ?? 0);
}

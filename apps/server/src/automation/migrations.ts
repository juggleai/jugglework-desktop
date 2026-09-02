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
  {
    version: 3,
    statements: [
      // TIPS: v1 的 automation_runs 有一条 CHECK (trigger_source IN ('scheduled','catchup','manual'))，
      // 不包含 'event'。SQLite 不支持直接改 CHECK 约束，只能整表重建——新建同构表（换成放开的
      // CHECK、补上 entity_ref/event_metadata_json 两列）、搬数据、删旧表、改名，最后重建全部索引。
      `CREATE TABLE automation_runs_rebuild (
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
        entity_ref TEXT,
        event_metadata_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (automation_id) REFERENCES automation_tasks(id) ON DELETE RESTRICT,
        CHECK (definition_revision > 0 AND revision > 0),
        CHECK (trigger_source IN ('scheduled', 'catchup', 'manual', 'event')),
        CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
        CHECK (sync_state IN ('pending', 'synced', 'error', 'incompatible-read-only'))
      )`,
      `INSERT INTO automation_runs_rebuild (
        id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, snapshot_json, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state, sync_error_code, created_at, updated_at
      ) SELECT
        id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
        workspace_id, workspace_name, session_id, snapshot_json, concrete_selection_json, error_code, error_message,
        queued_at, started_at, ended_at, revision, sync_state, sync_error_code, created_at, updated_at
      FROM automation_runs`,
      "DROP TABLE automation_runs",
      "ALTER TABLE automation_runs_rebuild RENAME TO automation_runs",
      // TIPS: 事件触发的非重叠约束粒度是按 (automation_id, entity_ref)，不是按 automation_id
      // 全局唯一——不同 PR 允许并行，只有同一 PR 才互斥。定时/手动触发继续用原来的全局唯一约束，
      // 两条约束分别是"trigger_source != 'event'"和"= 'event'"两个不相交的部分索引，互不影响。
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_automation_runs_scheduled_occurrence
        ON automation_runs(automation_id, scheduled_for)
        WHERE trigger_source IN ('scheduled', 'catchup')`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_automation_runs_nonterminal_scheduled
        ON automation_runs(automation_id)
        WHERE state IN ('queued', 'running') AND trigger_source != 'event'`,
      `CREATE UNIQUE INDEX IF NOT EXISTS uk_automation_runs_nonterminal_event
        ON automation_runs(automation_id, entity_ref)
        WHERE state IN ('queued', 'running') AND trigger_source = 'event'`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_history
        ON automation_runs(scheduled_for DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_task_history
        ON automation_runs(automation_id, scheduled_for DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_runs_entity
        ON automation_runs(automation_id, entity_ref, scheduled_for DESC)`,
      // TIPS: 会话归属映射，见桌面 PRD 4.8——一个 (automation_id, entity_ref) 最多绑定一个当前会话；
      // `status = 'closed'` 表示已结束生命周期（合并/关闭/上游失效），不会被下一次触发命中复用。
      `CREATE TABLE IF NOT EXISTS automation_entity_sessions (
        automation_id TEXT NOT NULL,
        entity_ref TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        invalid_reason TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL,
        PRIMARY KEY (automation_id, entity_ref),
        CHECK (status IN ('active', 'closed', 'invalid'))
      )`,
    ],
  },
  {
    version: 4,
    statements: [
      // TIPS: 同样的 CHECK 约束改不了的问题，这次在 automation_tasks 上——v1 的
      // CHECK (lifecycle IN ('enabled','paused','completed','tombstoned')) 没有 'shadow'。
      // 跟 v3 处理 automation_runs 一样，整表重建，其余列/索引原样保留。
      `CREATE TABLE automation_tasks_rebuild (
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
        CHECK (lifecycle IN ('enabled', 'paused', 'shadow', 'completed', 'tombstoned')),
        CHECK (compatibility_state IN ('compatible', 'incompatible-read-only')),
        CHECK (sync_state IN ('pending', 'synced', 'error', 'incompatible-read-only')),
        CHECK ((active_start_date IS NULL AND active_end_date IS NULL) OR (active_start_date IS NOT NULL AND active_end_date IS NOT NULL))
      )`,
      `INSERT INTO automation_tasks_rebuild SELECT * FROM automation_tasks`,
      "DROP TABLE automation_tasks",
      "ALTER TABLE automation_tasks_rebuild RENAME TO automation_tasks",
      `CREATE INDEX IF NOT EXISTS idx_automation_tasks_list
        ON automation_tasks(deleted_at, lifecycle, next_run_at, updated_at DESC, id DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_automation_tasks_workspace
        ON automation_tasks(workspace_id, deleted_at, updated_at DESC)`,
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

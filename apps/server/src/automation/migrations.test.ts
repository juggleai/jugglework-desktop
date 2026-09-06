import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import { automationDatabaseVersion, migrateAutomationDatabase } from "./migrations.js";
import { automationSqliteAdapter, type AutomationSqlite } from "./sqlite.js";

async function withTempDb(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "jugglework-automation-migrations-"));
  try {
    await run(join(dir, "runtime.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * 手工搭出一个"已经升级到 v3，且带真实数据"的数据库——不经过 migrateAutomationDatabase，
 * 因为在空表上跑完整链路(v1→v4)不会触发 FK 冲突（DROP 一个没有任何行引用它的父表永远成功）。
 * 只有先落地数据、再单独触发 v4 这一步，才能复现本地开发库实际遇到的失败路径。
 */
function seedV3DatabaseWithData(database: AutomationSqlite, now: number): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE automation_schema_migrations (
    version INTEGER PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  for (const version of [1, 2, 3]) {
    database.run("INSERT INTO automation_schema_migrations(version, applied_at) VALUES (?, ?)", [version, now]);
  }
  database.exec(`CREATE TABLE automation_tasks (
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
    CHECK (lifecycle IN ('enabled', 'paused', 'completed', 'tombstoned'))
  )`);
  // v3 之后的 automation_runs 形状：带 FOREIGN KEY REFERENCES automation_tasks(id)。
  database.exec(`CREATE TABLE automation_runs (
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
    FOREIGN KEY (automation_id) REFERENCES automation_tasks(id) ON DELETE RESTRICT
  )`);

  database.run(
    `INSERT INTO automation_tasks (
      id, name, workspace_id, workspace_name, definition_schema, definition_json, raw_document_json,
      lifecycle, revision, executor_device_id, timezone, permission_profile_version, permission_acknowledged_at,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["task-1", "每日任务", "ws-1", "工作区", "automation.v1", "{}", "{}", "enabled", 1, "device-1", "Asia/Shanghai", "v1", now, now, now],
  );
  database.run(
    `INSERT INTO automation_runs (
      id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for,
      workspace_id, workspace_name, snapshot_json, queued_at, revision, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["run-1", "task-1", "每日任务", 1, "scheduled", "queued", now, "ws-1", "工作区", "{}", now, 1, now, now],
  );
}

// TIPS: 回归测试——v4 迁移对 automation_tasks 做整表重建（DROP TABLE + RENAME），
// 而 automation_runs 有 FOREIGN KEY REFERENCES automation_tasks(id)。当数据库里已经
// 存在跨越这条外键的真实数据（已运行过的任务 + 它的执行记录）时，foreign_keys=ON 下直接
// DROP 父表会被 SQLite 拒绝并抛出 "FOREIGN KEY constraint failed"——这正是本地开发数据库
// 从 v3 升到 v4 时实测复现的故障，本测试固定复现同样的前置状态。
test("migrating a populated v3 database to v4 does not throw a foreign key error and preserves data", async () => {
  await withTempDb(async (path) => {
    const runtimeDb = await openRuntimeSqliteDatabase(path);
    const database = automationSqliteAdapter(runtimeDb);
    const now = Date.parse("2026-08-11T00:00:00Z");
    seedV3DatabaseWithData(database, now);

    migrateAutomationDatabase(database, now);
    assert.equal(automationDatabaseVersion(database), 5);

    const task = database.get<{ id: string; lifecycle: string }>("SELECT id, lifecycle FROM automation_tasks WHERE id = ?", ["task-1"]);
    const run = database.get<{ id: string; automation_id: string }>("SELECT id, automation_id FROM automation_runs WHERE id = ?", ["run-1"]);
    assert.deepEqual(task, { id: "task-1", lifecycle: "enabled" });
    assert.deepEqual(run, { id: "run-1", automation_id: "task-1" });

    // 迁移收尾必须把外键检查重新打开，否则运行期的正常增删也会静默丢失完整性保护。
    const fkEnabled = database.get<{ foreign_keys: number }>("PRAGMA foreign_keys");
    assert.equal(fkEnabled?.foreign_keys, 1);
    assert.throws(
      () => database.run("INSERT INTO automation_runs (id, automation_id, automation_name, definition_revision, trigger_source, state, scheduled_for, workspace_id, workspace_name, snapshot_json, queued_at, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        "run-orphan", "task-does-not-exist", "x", 1, "scheduled", "queued", now, "ws-1", "工作区", "{}", now, 1, now, now,
      ]),
      /FOREIGN KEY constraint failed/,
    );

    runtimeDb.close();
  });
});

test("migrating a fresh (empty) database applies every version without error", async () => {
  await withTempDb(async (path) => {
    const runtimeDb = await openRuntimeSqliteDatabase(path);
    const database = automationSqliteAdapter(runtimeDb);
    migrateAutomationDatabase(database);
    assert.equal(automationDatabaseVersion(database), 5);
    runtimeDb.close();
  });
});

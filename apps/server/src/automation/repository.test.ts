import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { ApiError } from "../errors.js";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import { automationDatabaseVersion, migrateAutomationDatabase } from "./migrations.js";
import { createAutomationEnvelope } from "./envelope.js";
import { AutomationRepository } from "./repository.js";
import { automationSqliteAdapter } from "./sqlite.js";
import { automationDraftFromUnknown, mergeAutomationRawDocument, validateAutomationDraft } from "./validation.js";

const NOW = Date.parse("2026-08-11T00:00:00Z");

test("validation applies defaults, rejects secrets and preserves unknown fields", () => {
  const draft = automationDraftFromUnknown({
    name: "  每日任务  ",
    workspace: workspace(),
    prompt: { version: 1, parts: [{ type: "text", text: "检查项目" }] },
    trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai", futureRule: true },
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: NOW },
    executorDeviceId: "device-1",
  }, "device-1");
  const definition = validateAutomationDraft(draft, context(), { id: "task-1", revision: 1, createdAt: NOW });
  // TIPS: 用旧版本只写过 `schedule` 顶层键的 rawDocument 触发一次性迁移路径，
  // 验证输出统一收敛到 `trigger`，且未知字段（futureRule）在迁移中不丢失。
  const raw = mergeAutomationRawDocument({ futureTopLevel: { enabled: true }, schedule: { futureRule: true } }, definition);
  assert.equal(definition.name, "每日任务");
  assert.deepEqual(definition.model, { mode: "auto" });
  assert.equal(definition.nextRunAt, Date.parse("2026-08-11T01:00:00Z"));
  assert.deepEqual(raw.futureTopLevel, { enabled: true });
  assert.equal(raw.schedule, undefined);
  assert.equal((raw.trigger as Record<string, unknown>).futureRule, true);

  assert.throws(
    () => automationDraftFromUnknown({ ...draft, accessToken: "secret" }, "device-1"),
    (error) => error instanceof ApiError && error.code === "invalid_automation_definition",
  );
});

test("cloud envelopes strip the workspace path and reject every other external absolute path", () => {
  const value = definition("task-envelope", "Envelope", 1, NOW);
  const envelope = createAutomationEnvelope("definition", value);
  const document = JSON.parse(Buffer.from(envelope.documentBase64, "base64").toString("utf8"));
  assert.equal(document.workspace.path, undefined);
  assert.throws(
    () => createAutomationEnvelope("definition", { ...value, extensions: { location: "/tmp/private.txt" } }),
    /non-portable data/,
  );
  for (const prohibited of [
    { transcript: "private model transcript" },
    { toolOutput: "private tool response" },
    { sessionMessages: [{ role: "assistant", content: "private" }] },
    { attachment: "data:application/octet-stream;base64,cHJpdmF0ZQ==" },
  ]) {
    assert.throws(() => createAutomationEnvelope("run", { ...value, extensions: prohibited }));
  }
});

test("automation migrations preserve an existing populated runtime database and reopen idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-existing-"));
  const path = join(root, "runtime.sqlite");
  const firstRuntime = await openRuntimeSqliteDatabase(path);
  const firstDatabase = automationSqliteAdapter(firstRuntime);
  try {
    firstDatabase.exec("CREATE TABLE existing_runtime_records (id TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
    firstDatabase.run("INSERT INTO existing_runtime_records(id, value) VALUES (?, ?)", ["legacy-1", "preserved"]);
    migrateAutomationDatabase(firstDatabase, NOW);
    assert.deepEqual(firstDatabase.get("SELECT id, value FROM existing_runtime_records WHERE id = ?", ["legacy-1"]), {
      id: "legacy-1",
      value: "preserved",
    });
  } finally {
    firstDatabase.close();
  }

  const reopenedRuntime = await openRuntimeSqliteDatabase(path);
  const reopenedDatabase = automationSqliteAdapter(reopenedRuntime);
  try {
    migrateAutomationDatabase(reopenedDatabase, NOW + 1);
    assert.equal(automationDatabaseVersion(reopenedDatabase), 3);
    assert.equal(reopenedDatabase.get<{ value: string }>("SELECT value FROM existing_runtime_records WHERE id = ?", ["legacy-1"])?.value, "preserved");
  } finally {
    reopenedDatabase.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("migration replay, revisions, pagination and local-only persistence are atomic", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const database = automationSqliteAdapter(runtime);
  try {
    migrateAutomationDatabase(database, NOW);
    migrateAutomationDatabase(database, NOW + 1);
    assert.equal(automationDatabaseVersion(database), 3);
    const repository = AutomationRepository.fromDatabase(database);
    const first = definition("task-1", "任务一", 1, NOW);
    const second = definition("task-2", "任务二", 1, NOW + 1);
    repository.createDefinition(first, { ...first, futureField: "kept" });
    repository.createDefinition(second, second);
    assert.equal(repository.readOutbox({ now: NOW + 10 }).length, 0);
    assert.equal(repository.getDefinition(first.id)?.syncState, "synced");
    assert.equal(repository.getDefinition(first.id)?.rawDocument.futureField, "kept");

    const page = repository.listDefinitions({ limit: 1 });
    assert.equal(page.items.length, 1);
    assert.ok(page.nextCursor);
    assert.equal(repository.listDefinitions({ limit: 1, cursor: page.nextCursor }).items.length, 1);

    const updated = { ...first, name: "任务一更新", revision: 2, updatedAt: NOW + 2 };
    repository.updateDefinition(updated, mergeAutomationRawDocument(repository.getDefinition(first.id)?.rawDocument, updated), 1);
    assert.throws(
      () => repository.updateDefinition({ ...updated, revision: 3 }, updated, 1),
      (error) => error instanceof ApiError && error.code === "automation_revision_conflict",
    );

    const run = repository.claimScheduledRun({
      automationId: first.id,
      definitionRevision: 2,
      runId: "run-1",
      scheduledFor: first.nextRunAt!,
      triggerSource: "scheduled",
      nextRunAt: first.nextRunAt! + 86_400_000,
      now: first.nextRunAt!,
    });
    assert.equal(run.state, "queued");
    const duplicate = repository.claimScheduledRun({
        automationId: first.id,
        definitionRevision: 2,
        runId: "run-duplicate",
        scheduledFor: first.nextRunAt!,
        triggerSource: "scheduled",
        nextRunAt: first.nextRunAt! + 86_400_000,
        now: first.nextRunAt!,
    });
    assert.equal(duplicate.id, run.id);
    assert.equal(repository.listRuns({ automationId: first.id }).items.length, 1);

    const deleted = repository.tombstoneDefinition(second.id, 1, NOW + 3);
    assert.equal(deleted.deletedAt, NOW + 3);
    assert.equal(repository.getDefinition(second.id), null);
    assert.ok(repository.getDefinition(second.id, true));
    assert.equal(repository.readOutbox({ now: first.nextRunAt! + 1 }).length, 0);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("manual runs allow paused and completed tasks without changing lifecycle or next run", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-manual-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  try {
    const paused = { ...definition("task-paused", "Paused", 1, NOW), lifecycle: "paused" as const, nextRunAt: NOW + 10_000 };
    const completed = { ...definition("task-completed", "Completed", 1, NOW), lifecycle: "completed" as const, nextRunAt: null };
    repository.createDefinition(paused, paused);
    repository.createDefinition(completed, completed);
    assert.equal(repository.createManualRun(paused, "manual-paused", NOW).triggerSource, "manual");
    assert.equal(repository.createManualRun(completed, "manual-completed", NOW + 1).triggerSource, "manual");
    assert.equal(repository.getDefinition(paused.id)?.definition.lifecycle, "paused");
    assert.equal(repository.getDefinition(paused.id)?.definition.nextRunAt, paused.nextRunAt);
    assert.equal(repository.getDefinition(completed.id)?.definition.lifecycle, "completed");
    assert.equal(repository.getDefinition(completed.id)?.definition.nextRunAt, null);
    assert.throws(() => repository.createManualRun(paused, "manual-overlap", NOW + 2), (error) =>
      error instanceof ApiError && error.code === "overlap_blocked");
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("claimEventRun creates one run per entity and merges same-entity retriggers without a new row", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-event-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  try {
    const task = definition("task-event", "Event", 1, NOW);
    repository.createDefinition(task, task);

    const first = repository.claimEventRun({
      automationId: task.id, definitionRevision: 1, runId: "run-pr-482-a",
      entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-1", now: NOW,
    });
    assert.equal(first.merged, false);
    assert.equal(first.run.eventMetadata?.entityRef, "github:pull_request:482");
    assert.equal(first.run.eventMetadata?.mergedEventCount, undefined);

    // TIPS: 同一实体第二次触发必须合并进已有非终态运行，不新建行——这是防抖的数据库层保证。
    const second = repository.claimEventRun({
      automationId: task.id, definitionRevision: 1, runId: "run-pr-482-b",
      entityRef: "github:pull_request:482", sourceDeliveryId: "delivery-2", now: NOW + 1_000,
    });
    assert.equal(second.merged, true);
    assert.equal(second.run.id, first.run.id);
    assert.equal(second.run.eventMetadata?.mergedEventCount, 1);
    assert.equal(repository.listRuns({ automationId: task.id }).items.length, 1);

    // TIPS: 不同实体（不同 PR）之间允许并行，不受上面这条非终态运行阻塞。
    const other = repository.claimEventRun({
      automationId: task.id, definitionRevision: 1, runId: "run-pr-483",
      entityRef: "github:pull_request:483", sourceDeliveryId: "delivery-3", now: NOW + 2_000,
    });
    assert.equal(other.merged, false);
    assert.notEqual(other.run.id, first.run.id);
    assert.equal(repository.listRuns({ automationId: task.id }).items.length, 2);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("recordSkippedEventRun records a terminal skip without ever touching entity non-overlap", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-skip-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  try {
    const task = definition("task-skip", "Skip", 1, NOW);
    repository.createDefinition(task, task);
    const run = repository.recordSkippedEventRun({
      automationId: task.id, definitionRevision: 1, runId: "run-dropped",
      errorCode: "event_backlog_dropped",
      eventMetadata: { backlogDropped: { count: 12, sinceAt: NOW - 604_800_000, untilAt: NOW } },
      now: NOW,
    });
    assert.equal(run.state, "skipped");
    assert.equal(run.errorCode, "event_backlog_dropped");
    assert.equal(run.eventMetadata?.backlogDropped?.count, 12);
    // TIPS: 跳过记录不占用非重叠约束——紧接着认领一条真正的事件运行必须成功，不被这条跳过记录挡住。
    const claimed = repository.claimEventRun({
      automationId: task.id, definitionRevision: 1, runId: "run-real",
      entityRef: "github:pull_request:1", sourceDeliveryId: "delivery-1", now: NOW + 1,
    });
    assert.equal(claimed.merged, false);
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("entity session mapping round-trips through upsert, close and invalidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-entity-session-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  try {
    assert.equal(repository.getEntitySessionMapping("task-1", "github:pull_request:482"), null);
    repository.upsertEntitySessionMapping("task-1", "github:pull_request:482", "workspace-1", "session-1", NOW);
    const active = repository.getEntitySessionMapping("task-1", "github:pull_request:482");
    assert.equal(active?.status, "active");
    assert.equal(active?.sessionId, "session-1");

    // TIPS: 复用发生在第二轮触发换到新会话时——再次 upsert 必须覆盖旧的 session_id，而不是并存两条记录。
    repository.upsertEntitySessionMapping("task-1", "github:pull_request:482", "workspace-1", "session-2", NOW + 1_000);
    assert.equal(repository.getEntitySessionMapping("task-1", "github:pull_request:482")?.sessionId, "session-2");

    repository.closeEntitySessionMapping("task-1", "github:pull_request:482", NOW + 2_000);
    assert.equal(repository.getEntitySessionMapping("task-1", "github:pull_request:482")?.status, "closed");

    repository.upsertEntitySessionMapping("task-1", "github:pull_request:999", "workspace-1", "session-3", NOW);
    repository.invalidateEntitySessionMapping("task-1", "github:pull_request:999", "connector_unavailable", NOW + 1);
    const invalid = repository.getEntitySessionMapping("task-1", "github:pull_request:999");
    assert.equal(invalid?.status, "invalid");
    assert.equal(invalid?.invalidReason, "connector_unavailable");
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("entity session mapping is scoped per automation, not shared across automations on the same entity", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-automation-entity-scope-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  try {
    // TIPS:两个不同的自动化（比如"自动评审" task-review 和"合并后通知群里" task-notify）
    // 都配置在同一个 PR 上，各自的会话归属必须互不干扰。
    repository.upsertEntitySessionMapping("task-review", "github:pull_request:482", "workspace-1", "session-review", NOW);
    repository.upsertEntitySessionMapping("task-notify", "github:pull_request:482", "workspace-1", "session-notify", NOW);
    assert.equal(repository.getEntitySessionMapping("task-review", "github:pull_request:482")?.sessionId, "session-review");
    assert.equal(repository.getEntitySessionMapping("task-notify", "github:pull_request:482")?.sessionId, "session-notify");

    repository.closeEntitySessionMapping("task-review", "github:pull_request:482", NOW + 1_000);
    assert.equal(repository.getEntitySessionMapping("task-review", "github:pull_request:482")?.status, "closed");
    // TIPS:关掉一个自动化的归属不能影响另一个——这才是"按 automation_id + entity_ref 隔离"真正要保证的事。
    assert.equal(repository.getEntitySessionMapping("task-notify", "github:pull_request:482")?.status, "active");
  } finally {
    repository.close();
    await rm(root, { recursive: true, force: true });
  }
});

function definition(id: string, name: string, revision: number, updatedAt: number): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id,
    name,
    workspace: workspace(),
    prompt: { version: 1, parts: [{ type: "text", text: "执行任务" }] },
    trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai" },
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: NOW },
    lifecycle: "enabled",
    executorDeviceId: "device-1",
    revision,
    nextRunAt: Date.parse("2026-08-11T01:00:00Z"),
    createdAt: NOW,
    updatedAt,
  };
}

function workspace() {
  return { id: "workspace-1", name: "工作空间", path: "/tmp/workspace", workspaceType: "local" as const };
}

function context() {
  return { now: NOW, workspaces: [workspace()] };
}

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
    schedule: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai", futureRule: true },
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: NOW },
    executorDeviceId: "device-1",
  }, "device-1");
  const definition = validateAutomationDraft(draft, context(), { id: "task-1", revision: 1, createdAt: NOW });
  const raw = mergeAutomationRawDocument({ futureTopLevel: { enabled: true }, schedule: { futureRule: true } }, definition);
  assert.equal(definition.name, "每日任务");
  assert.deepEqual(definition.model, { mode: "auto" });
  assert.equal(definition.nextRunAt, Date.parse("2026-08-11T01:00:00Z"));
  assert.deepEqual(raw.futureTopLevel, { enabled: true });
  assert.equal((raw.schedule as Record<string, unknown>).futureRule, true);

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
    assert.equal(automationDatabaseVersion(reopenedDatabase), 2);
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
    assert.equal(automationDatabaseVersion(database), 2);
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

function definition(id: string, name: string, revision: number, updatedAt: number): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id,
    name,
    workspace: workspace(),
    prompt: { version: 1, parts: [{ type: "text", text: "执行任务" }] },
    schedule: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai" },
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

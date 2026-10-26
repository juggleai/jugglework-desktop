import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { allocateAutomationWorkspace, automationDirectoryName, isAutomationManagedWorkspacePath } from "./workspace.js";

test("distinguishes automation-managed paths from selectable local workspaces", () => {
  const root = join(tmpdir(), "JuggleWork", "Automations");
  assert.equal(isAutomationManagedWorkspacePath(join(root, "2026-10-22", "daily_news"), root), true);
  assert.equal(isAutomationManagedWorkspacePath(join(tmpdir(), "projects", "daily_news"), root), false);
});

test("allocates atomically under the task timezone and sanitizes Windows names", async () => {
  const root = await mkdtemp(join(tmpdir(), "jw-allocation-"));
  try {
    const workspaces = await Promise.all(Array.from({ length: 12 }, () => allocateAutomationWorkspace({ root, name: "新闻", directoryName: "Daily News", timezone: "Asia/Shanghai", now: Date.parse("2026-10-20T17:00:00Z") })));
    assert.equal(new Set(workspaces.map((w) => w.path)).size, 12);
    assert.ok(workspaces.every((w) => w.path.startsWith(join(root, "2026-10-21"))));
    assert.ok(workspaces.some((w) => basename(w.path) === "daily_news_12"));
    assert.equal(automationDirectoryName("CON"), "scheduled_task");
    assert.equal(automationDirectoryName("../../hello / world"), "hello_world");
    assert.equal(automationDirectoryName("每日摘要"), "scheduled_task");
  } finally { await rm(root, { recursive: true, force: true }); }
});

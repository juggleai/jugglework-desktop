import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSessionMutationCoordinator } from "./session-mutation-coordinator.js";
import { createSessionRunJournal } from "./session-run-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createHarness() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-run-journal-"));
  roots.push(root);
  let time = 1_000;
  const journal = await createSessionRunJournal({
    path: join(root, "runtime.sqlite"),
    now: () => ++time,
  });
  const coordinator = createSessionMutationCoordinator({
    now: () => ++time,
    randomUUID: () => "run-1",
    onLifecycleEvent: journal.record,
  });
  return { journal, coordinator };
}

describe("session run journal", () => {
  test("persists a content-free fenced lifecycle across reopen", async () => {
    const { journal, coordinator } = await createHarness();
    const run = coordinator.reserveStart({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      origin: "local-renderer",
      startCommandCorrelationId: "command-a",
    });
    coordinator.acceptStart({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId });
    coordinator.observe({ ...run, status: "running" });
    coordinator.observe({ ...run, status: "completed" });

    const entries = journal.list("workspace-a", "session-a").reverse();
    expect(entries.map((entry) => entry.event)).toEqual([
      "run_reserved",
      "run_started",
      "progress",
      "run_terminal",
    ]);
    expect(entries.at(-1)).toMatchObject({
      runId: "run-1",
      generation: 1,
      terminalReason: "completed",
      startCommandCorrelationId: "command-a",
    });
    expect(JSON.stringify(entries)).not.toContain("prompt");
    expect(JSON.stringify(entries)).not.toContain("toolInput");
    journal.close();
  });

  test("records the two-sample idle suspicion before terminalization", async () => {
    const { journal, coordinator } = await createHarness();
    const run = coordinator.reserveStart({
      workspaceId: "workspace-a",
      sessionId: "session-a",
      origin: "remote-control",
      startCommandCorrelationId: null,
    });
    coordinator.acceptStart({ workspaceId: run.workspaceId, sessionId: run.sessionId, runId: run.runId });
    coordinator.reconcileAuthoritativeIdle({ ...run, minimumIntervalMs: 0 });
    coordinator.reconcileAuthoritativeIdle({ ...run, minimumIntervalMs: 0 });

    expect(journal.list("workspace-a", "session-a").map((entry) => entry.event)).toEqual([
      "run_terminal",
      "idle_suspected",
      "run_started",
      "run_reserved",
    ]);
    journal.close();
  });
});


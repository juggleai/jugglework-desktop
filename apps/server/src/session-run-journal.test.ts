import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createSessionMutationCoordinator } from "./session-mutation-coordinator.js";
import { createSessionRunJournal } from "./session-run-journal.js";
import { Database } from "bun:sqlite";

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
  test("persists active runs and an ordered ACK-gated lifecycle feed across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "lifecycle-v3-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    let journal = await createSessionRunJournal({ path, now: () => 2_000 });
    let coordinator = createSessionMutationCoordinator({
      allocateGeneration: journal.allocateGeneration,
      randomUUID: () => "run-a",
      onLifecycleEvent: journal.record,
    });
    const run = coordinator.reserveStart({ workspaceId: "w", sessionId: "a", origin: "local-renderer", startCommandCorrelationId: null, title: "A" });
    coordinator.acceptStart(run);
    const first = journal.listFeed("electron");
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ sequence: 1, runId: "run-a", generation: run.generation, revision: 2, status: "running", title: "A" });
    expect(() => journal.ackFeed("electron", first.deviceEpoch, 2, first.items[0]!.eventId)).toThrow("out_of_order");
    journal.close();

    journal = await createSessionRunJournal({ path, now: () => 3_000 });
    expect(journal.listActive()).toMatchObject([{ runId: "run-a", status: "running", revision: 2 }]);
    expect(journal.listFeed("electron").items[0]?.eventId).toBe(first.items[0]?.eventId);
    journal.ackFeed("electron", first.deviceEpoch, 1, first.items[0]!.eventId);
    coordinator = createSessionMutationCoordinator({ initialRuns: journal.listActive(), onLifecycleEvent: journal.record });
    coordinator.observe({ ...run, status: "completed" });
    const terminal = journal.listFeed("electron");
    expect(terminal.nextSequence).toBe(2);
    expect(terminal.items).toMatchObject([{ sequence: 2, runId: "run-a", status: "completed" }]);
    journal.close();
  });

  test("same sequence wrong eventId conflicts and unacked feed is not purged", async () => {
    const { journal, coordinator } = await createHarness();
    const run = coordinator.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null });
    coordinator.acceptStart(run);
    const page = journal.listFeed("electron");
    expect(() => journal.ackFeed("electron", page.deviceEpoch, 1, "99999999-9999-4999-8999-999999999999")).toThrow("event_conflict");
    journal.purge(Number.MAX_SAFE_INTEGER);
    expect(journal.listFeed("electron").items[0]?.eventId).toBe(page.items[0]?.eventId);
    journal.close();
  });

  test("journal write failure prevents admission from becoming active", async () => {
    const coordinator = createSessionMutationCoordinator({ onLifecycleEvent: () => { throw new Error("disk_full"); } });
    expect(() => coordinator.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null })).toThrow("disk_full");
    expect(coordinator.listActive()).toEqual([]);
  });
  test("backfills legacy terminals once and bounds reads independently of diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-migration-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const initial = await createSessionRunJournal({ path });
    initial.close();
    const db = new Database(path);
    db.exec(`DROP TABLE session_run_terminals; DROP TABLE session_run_migrations;
      INSERT INTO session_run_journal(workspace_id,session_id,run_id,generation,origin,event,status,terminal_reason,occurred_at)
      VALUES ('w','s','legacy',1,'local-renderer','run_terminal','failed','failed',1000)`);
    db.close();
    let journal = await createSessionRunJournal({ path, now: () => 1000 });
    const first = journal.listTerminals("w");
    expect(first.items).toHaveLength(1);
    journal.close();
    journal = await createSessionRunJournal({ path, now: () => 1000 });
    expect(journal.listTerminals("w", first.cursor).items).toHaveLength(0);
    const coordinator = createSessionMutationCoordinator({ onLifecycleEvent: journal.record });
    for (let i = 0; i < 105; i++) {
      const run = coordinator.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null });
      coordinator.observe({ ...run, status: "completed" });
    }
    expect(journal.listTerminals("w", 0, 999).items).toHaveLength(100);
    expect(journal.list("w", "s", 999)).toHaveLength(100);
    const cursor = journal.listTerminals("w", 100).cursor;
    journal.purge(Number.MAX_SAFE_INTEGER);
    expect(journal.listTerminals("w").items).toHaveLength(0);
    journal.close();
    journal = await createSessionRunJournal({ path, now: () => 1000 });
    expect(journal.listTerminals("w").items).toHaveLength(0);
    const next = createSessionMutationCoordinator({ onLifecycleEvent: journal.record });
    const run = next.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null });
    next.observe({ ...run, status: "aborted" });
    expect(journal.listTerminals("w").cursor).toBeGreaterThan(cursor);
    journal.close();
  });
  test("terminal outbox survives diagnostic capacity and restart with monotonic cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "terminal-outbox-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    let journal = await createSessionRunJournal({ path, maxEvents: 2, now: () => 1000 });
    const coordinator = createSessionMutationCoordinator({ onLifecycleEvent: (event) => journal.record(event) });
    const input = { workspaceId: "w", sessionId: "s", origin: "local-renderer" as const, startCommandCorrelationId: null };
    const run = coordinator.reserveStart(input);
    coordinator.observe({ ...run, status: "failed" });
    const cursor = journal.listTerminals("w").cursor;
    for (let i = 0; i < 5; i++) journal.record({ event: "progress", run });
    expect(journal.list("w", "s")).toHaveLength(2);
    expect(journal.terminalStatus("w", "s", run.runId)).toBe("failed");
    expect(journal.listTerminals("w").items).toHaveLength(1);
    journal.close();
    journal = await createSessionRunJournal({ path, now: () => 1000 });
    expect(journal.listTerminals("w", cursor).items).toHaveLength(0);
    const next = coordinator.reserveStart(input);
    coordinator.observe({ ...next, status: "aborted" });
    expect(journal.listTerminals("w", cursor).items[0]?.id).toBeGreaterThan(cursor);
    journal.close();
  });
  test("returns only the exact persisted terminal after authority clears", async () => {
    const { journal, coordinator } = await createHarness();
    try {
      const run = coordinator.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null });
      expect(journal.terminalStatus("w", "s", run.runId)).toBeNull();
      coordinator.observe({ ...run, status: "aborted" });
      expect(coordinator.getActive("w", "s")).toBeNull();
      expect(journal.terminalStatus("w", "s", run.runId)).toBe("aborted");
      expect(journal.terminalStatus("other", "s", run.runId)).toBeNull();
      expect(journal.terminalStatus("w", "other", run.runId)).toBeNull();
      expect(journal.terminalStatus("w", "s", "unknown")).toBeNull();
    } finally { journal.close(); }
  });
  test("restart resets in-memory identity, not the durable fence, even after purge", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-generation-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const input = { workspaceId: "w", sessionId: "s", origin: "local-renderer" as const, startCommandCorrelationId: null };
    let journal = await createSessionRunJournal({ path });
    const a = createSessionMutationCoordinator({ allocateGeneration: journal.allocateGeneration });
    const runA = a.reserveStart(input);
    a.observe({ ...runA, status: "completed" });
    const lastA = a.reserveStart(input);
    journal.purge(Number.MAX_SAFE_INTEGER);
    journal.close();
    journal = await createSessionRunJournal({ path });
    const b = createSessionMutationCoordinator({ allocateGeneration: journal.allocateGeneration });
    const runB = b.reserveStart(input); // B's local counter would be 1.
    expect(runB.generation).toBeGreaterThan(lastA.generation);
    expect(runB.runId).not.toBe(lastA.runId);
    expect(() => b.observe({ ...lastA, status: "completed" })).toThrow("run_mismatch");
    expect(b.getActive("w", "s")?.runId).toBe(runB.runId);
    const other = await createSessionRunJournal({ path });
    expect(other.allocateGeneration()).toBe(runB.generation + 1);
    expect(journal.allocateGeneration()).toBe(runB.generation + 2);
    other.close();
    journal.close();
  });

  test("migrates legacy journal high water and retains it independently of pruning", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-generation-migration-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const initial = await createSessionRunJournal({ path });
    initial.close();
    const db = new Database(path);
    db.exec("DROP TABLE session_run_generation");
    db.exec(`INSERT INTO session_run_journal(workspace_id,session_id,run_id,generation,origin,event,status,occurred_at)
      VALUES ('w','s','legacy',87,'local-renderer','run_reserved','running',1)`);
    db.close();
    const migrated = await createSessionRunJournal({ path });
    migrated.purge(Number.MAX_SAFE_INTEGER);
    expect(migrated.allocateGeneration()).toBe(88);
    migrated.close();
    const reopened = await createSessionRunJournal({ path });
    expect(reopened.allocateGeneration()).toBe(89);
    reopened.close();
  });

  test("allocation failure exposes no run and cannot dispatch using a fallback counter", () => {
    const coordinator = createSessionMutationCoordinator({ allocateGeneration: () => { throw new Error("disk_full"); } });
    expect(() => coordinator.reserveStart({ workspaceId: "w", sessionId: "s", origin: "local-renderer", startCommandCorrelationId: null })).toThrow("disk_full");
    expect(coordinator.listActive()).toEqual([]);
  });

  test("legacy migration uses retained AUTOINCREMENT water even when all events were pruned", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-generation-pruned-"));
    roots.push(root);
    const path = join(root, "runtime.sqlite");
    const initial = await createSessionRunJournal({ path });
    initial.close();
    const db = new Database(path);
    db.exec(`DROP TABLE session_run_generation;
      INSERT INTO session_run_journal(id,workspace_id,session_id,run_id,generation,origin,event,status,occurred_at)
        VALUES (120,'w','s','legacy',87,'local-renderer','run_reserved','running',1);
      DELETE FROM session_run_journal;`);
    db.close();
    const migrated = await createSessionRunJournal({ path });
    expect(migrated.allocateGeneration()).toBe(121);
    migrated.close();
  });
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

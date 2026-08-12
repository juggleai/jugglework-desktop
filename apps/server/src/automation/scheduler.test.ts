import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";
import { openRuntimeSqliteDatabase } from "../runtime-db.js";
import { AutomationRepository, type AutomationRunSnapshot } from "./repository.js";
import { AutomationScheduler, type AutomationSchedulerClock } from "./scheduler.js";
import { automationSqliteAdapter } from "./sqlite.js";

test("scheduler catches up only the latest occurrence and executes queued work", async () => {
  const fixture = await repositoryFixture();
  const now = Date.parse("2026-08-11T01:05:00Z");
  try {
    const definition = dailyDefinition("task-1", Date.parse("2026-08-10T01:00:00Z"));
    fixture.repository.createDefinition(definition, definition);
    const executed: string[] = [];
    const executor = {
      execute: async (snapshot: AutomationRunSnapshot) => {
        executed.push(snapshot.run.id);
        let run = fixture.repository.updateRun(snapshot.run.id, snapshot.run.revision, { state: "running", startedAt: now }, now);
        run = fixture.repository.updateRun(run.id, run.revision, { state: "succeeded", endedAt: now + 1 }, now + 1);
        assert.equal(run.state, "succeeded");
      },
    };
    const scheduler = new AutomationScheduler({ repository: fixture.repository, executor, clock: fakeClock(now) });
    scheduler.start();
    await eventually(() => executed.length === 1);
    scheduler.dispose();
    const [run] = fixture.repository.listRuns().items;
    assert.equal(run.triggerSource, "catchup");
    assert.equal(run.scheduledFor, Date.parse("2026-08-11T01:00:00Z"));
    assert.equal(run.state, "succeeded");
    assert.equal(fixture.repository.getDefinition(definition.id)?.definition.nextRunAt, Date.parse("2026-08-12T01:00:00Z"));
  } finally {
    await fixture.close();
  }
});

test("scheduler records missed deadlines without dispatch", async () => {
  const fixture = await repositoryFixture();
  const now = Date.parse("2026-08-11T01:30:00Z");
  try {
    const definition = {
      ...dailyDefinition("task-2", Date.parse("2026-08-10T01:00:00Z")),
      prompt: { version: 1 as const, parts: [{ type: "text" as const, text: "private prompt content" }] },
    };
    fixture.repository.createDefinition(definition, definition);
    let executions = 0;
    const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const scheduler = new AutomationScheduler({
      repository: fixture.repository,
      executor: { execute: async () => { executions += 1; } },
      clock: fakeClock(now),
      log: (event, fields) => logs.push({ event, fields }),
    });
    scheduler.start();
    await eventually(() => fixture.repository.listRuns().items.length === 1);
    scheduler.dispose();
    const [run] = fixture.repository.listRuns().items;
    assert.equal(run.state, "skipped");
    assert.equal(run.errorCode, "missed_deadline");
    assert.equal(executions, 0);
    assert.ok(logs.some(({ event, fields }) => event === "automation_run_skipped" && fields.reason === "missed_deadline"));
    assert.doesNotMatch(JSON.stringify(logs), /private prompt content/i);
  } finally {
    await fixture.close();
  }
});

test("scheduler reconciles persisted running sessions before dispatching queued runs", async () => {
  const fixture = await repositoryFixture();
  const now = Date.parse("2026-08-11T01:00:00Z");
  try {
    const runningDefinition = dailyDefinition("task-running", now + 60_000);
    const queuedDefinition = dailyDefinition("task-queued", now + 60_000);
    fixture.repository.createDefinition(runningDefinition, runningDefinition);
    fixture.repository.createDefinition(queuedDefinition, queuedDefinition);
    const first = fixture.repository.createManualRun(runningDefinition, "run-running", now - 100);
    fixture.repository.updateRun(first.id, first.revision, { state: "running", sessionId: "session-running", startedAt: now - 50 }, now - 50);
    fixture.repository.createManualRun(queuedDefinition, "run-queued", now - 25);
    const order: string[] = [];
    const scheduler = new AutomationScheduler({
      repository: fixture.repository,
      executor: {
        reconcile: async (snapshot) => {
          order.push(`reconcile:${snapshot.run.id}`);
          const current = fixture.repository.getRun(snapshot.run.id)!;
          fixture.repository.updateRun(current.id, current.revision, { state: "succeeded", endedAt: now }, now);
        },
        execute: async (snapshot) => {
          order.push(`execute:${snapshot.run.id}`);
          let current = fixture.repository.updateRun(snapshot.run.id, snapshot.run.revision, { state: "running", startedAt: now }, now);
          current = fixture.repository.updateRun(current.id, current.revision, { state: "succeeded", endedAt: now }, now);
        },
      },
      clock: fakeClock(now),
    });
    scheduler.start();
    await eventually(() => order.length === 2);
    await scheduler.dispose();
    assert.deepEqual(order, ["reconcile:run-running", "execute:run-queued"]);
  } finally {
    await fixture.close();
  }
});

test("duplicate wake-ups claim one occurrence and a clock jump uses one latest catch-up", async () => {
  const fixture = await repositoryFixture();
  const scheduledFor = Date.parse("2026-08-11T01:00:00Z");
  const clock = new ControlledClock(Date.parse("2026-08-11T00:00:00Z"));
  try {
    const definition = dailyDefinition("task-clock-jump", scheduledFor);
    fixture.repository.createDefinition(definition, definition);
    const executed: string[] = [];
    const scheduler = new AutomationScheduler({
      repository: fixture.repository,
      executor: {
        execute: async (snapshot) => {
          executed.push(snapshot.run.id);
          let current = fixture.repository.updateRun(snapshot.run.id, snapshot.run.revision, { state: "running", startedAt: clock.now() }, clock.now());
          current = fixture.repository.updateRun(current.id, current.revision, { state: "succeeded", endedAt: clock.now() }, clock.now());
        },
      },
      clock,
    });
    scheduler.start();
    await eventually(() => clock.timerCount === 1);
    clock.advanceTo(scheduledFor + 7 * 60_000);
    scheduler.notifyChanged();
    scheduler.notifyChanged();
    await eventually(() => executed.length === 1);
    assert.equal(fixture.repository.listRuns().items.length, 1);
    assert.equal(fixture.repository.listRuns().items[0].triggerSource, "catchup");
    await scheduler.dispose();
  } finally {
    await fixture.close();
  }
});

test("finite active range and one-time schedules become completed after their final claim", async () => {
  const fixture = await repositoryFixture();
  const now = Date.parse("2026-08-11T01:00:00Z");
  try {
    const ranged = { ...dailyDefinition("task-range", now), activeRange: { startDate: "2026-08-11", endDate: "2026-08-11" } };
    const once: AutomationDefinition = {
      ...dailyDefinition("task-once", now),
      schedule: { version: 1, kind: "once", localDate: "2026-08-11", localTime: "09:00", timezone: "Asia/Shanghai" },
    };
    fixture.repository.createDefinition(ranged, ranged);
    fixture.repository.createDefinition(once, once);
    fixture.repository.claimScheduledRun({ automationId: ranged.id, definitionRevision: 1, runId: "run-range", scheduledFor: now, triggerSource: "scheduled", nextRunAt: null, now });
    fixture.repository.claimScheduledRun({ automationId: once.id, definitionRevision: 1, runId: "run-once", scheduledFor: now, triggerSource: "scheduled", nextRunAt: null, now });
    assert.equal(fixture.repository.getDefinition(ranged.id)?.definition.lifecycle, "completed");
    assert.equal(fixture.repository.getDefinition(once.id)?.definition.lifecycle, "completed");
  } finally {
    await fixture.close();
  }
});

test("simultaneous tasks remain durably queued behind one global executor slot", async () => {
  const fixture = await repositoryFixture();
  const now = Date.parse("2026-08-11T01:00:00Z");
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  try {
    for (const id of ["task-a", "task-b"]) {
      const definition = dailyDefinition(id, now);
      fixture.repository.createDefinition(definition, definition);
    }
    const started: string[] = [];
    const scheduler = new AutomationScheduler({
      repository: fixture.repository,
      executor: {
        execute: async (snapshot) => {
          started.push(snapshot.run.automationId);
          let current = fixture.repository.updateRun(snapshot.run.id, snapshot.run.revision, { state: "running", startedAt: now }, now);
          if (started.length === 1) await firstGate;
          current = fixture.repository.updateRun(current.id, current.revision, { state: "succeeded", endedAt: now + started.length }, now + started.length);
        },
      },
      clock: fakeClock(now),
    });
    scheduler.start();
    await eventually(() => started.length === 1 && fixture.repository.listActiveRunSnapshots().length === 2);
    assert.equal(started.length, 1);
    releaseFirst?.();
    await eventually(() => started.length === 2 && fixture.repository.listActiveRunSnapshots().length === 0);
    await scheduler.dispose();
  } finally {
    await fixture.close();
  }
});

test("embedded scheduling is independent of renderer visibility and stops after disposal", async () => {
  const fixture = await repositoryFixture();
  const firstDueAt = Date.parse("2026-08-11T01:00:00Z");
  const clock = new ControlledClock(firstDueAt - 60_000);
  try {
    const definition = dailyDefinition("task-background", firstDueAt);
    fixture.repository.createDefinition(definition, definition);
    const executed: string[] = [];
    const scheduler = new AutomationScheduler({
      repository: fixture.repository,
      executor: {
        execute: async (snapshot) => {
          executed.push(snapshot.run.id);
          let current = fixture.repository.updateRun(snapshot.run.id, snapshot.run.revision, { state: "running", startedAt: clock.now() }, clock.now());
          current = fixture.repository.updateRun(current.id, current.revision, { state: "succeeded", endedAt: clock.now() }, clock.now());
        },
      },
      clock,
    });
    scheduler.start();
    await eventually(() => clock.timerCount === 1);
    // Renderer/window state is intentionally absent: the embedded server owns the timer.
    clock.advanceTo(firstDueAt);
    await eventually(() => executed.length === 1);
    await scheduler.dispose();
    clock.advanceTo(firstDueAt + 86_400_000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(executed.length, 1);
    assert.equal(clock.timerCount, 0);
  } finally {
    await fixture.close();
  }
});

function dailyDefinition(id: string, nextRunAt: number): AutomationDefinition {
  const createdAt = Date.parse("2026-08-01T00:00:00Z");
  return {
    schema: "automation-definition/v1",
    id,
    name: id,
    workspace: { id: "workspace", name: "Workspace", path: "/tmp/workspace", workspaceType: "local" },
    prompt: { version: 1, parts: [{ type: "text", text: "run" }] },
    schedule: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai" },
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: createdAt },
    lifecycle: "enabled",
    executorDeviceId: "device",
    revision: 1,
    nextRunAt,
    createdAt,
    updatedAt: createdAt,
  };
}

function fakeClock(now: number): AutomationSchedulerClock {
  return { now: () => now, setTimer: () => 1, clearTimer: () => undefined };
}

class ControlledClock implements AutomationSchedulerClock {
  private current: number;
  private nextHandle = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now: number) {
    this.current = now;
  }

  get timerCount(): number {
    return this.timers.size;
  }

  now(): number {
    return this.current;
  }

  setTimer(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { at: this.current + delayMs, callback });
    return handle;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  /** 推进墙上时钟并同步触发所有已经到期的调度回调。 */
  advanceTo(now: number): void {
    this.current = now;
    const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= now);
    for (const [handle, timer] of due) {
      this.timers.delete(handle);
      timer.callback();
    }
  }
}

async function repositoryFixture() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-scheduler-"));
  const runtime = await openRuntimeSqliteDatabase(join(root, "runtime.sqlite"));
  const repository = AutomationRepository.fromDatabase(automationSqliteAdapter(runtime));
  return { repository, close: async () => { repository.close(); await rm(root, { recursive: true, force: true }); } };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

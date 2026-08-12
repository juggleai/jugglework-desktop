import { randomUUID } from "node:crypto";
import type { AutomationDefinitionRecord } from "@jugglework/types/automation";
import { ApiError } from "../errors.js";
import type { AutomationExecutor } from "./executor.js";
import type { AutomationRepository, AutomationRunSnapshot } from "./repository.js";
import { latestAutomationOccurrenceAtOrBefore, nextAutomationOccurrence } from "./schedule.js";

const MISFIRE_GRACE_MS = 10 * 60_000;
const MAX_TIMER_MS = 2_147_000_000;
const IDLE_RECHECK_MS = 60_000;

export type AutomationSchedulerClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
};

export type AutomationSchedulerOptions = {
  repository: AutomationRepository;
  executor: Pick<AutomationExecutor, "execute"> & Partial<Pick<AutomationExecutor, "reconcile">>;
  clock?: AutomationSchedulerClock;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

/** Embedded Server 内的单定时器、单执行槽自动化调度器。 */
export class AutomationScheduler {
  private timer: unknown = null;
  private started = false;
  private waking = false;
  private executing = false;
  private executionPromise: Promise<void> | null = null;
  private readonly clock: AutomationSchedulerClock;

  constructor(private readonly options: AutomationSchedulerOptions) {
    this.clock = options.clock ?? systemClock();
  }

  /** 启动恢复、到期认领和最近截止时间定时器。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.recoverAndWake();
  }

  private async recoverAndWake(): Promise<void> {
    const reconcile = this.options.executor.reconcile?.bind(this.options.executor);
    if (reconcile) {
      for (const snapshot of this.options.repository.listActiveRunSnapshots()) {
        if (!this.started) return;
        if (snapshot.run.state !== "running") continue;
        this.log("automation_reconciliation_started", { automationId: snapshot.run.automationId, runId: snapshot.run.id });
        await reconcile(snapshot);
        const result = this.options.repository.getRun(snapshot.run.id);
        this.log("automation_reconciliation_finished", {
          automationId: snapshot.run.automationId,
          runId: snapshot.run.id,
          state: result?.state ?? "missing",
        });
      }
    }
    if (this.started) await this.wake();
  }

  /** 通知调度器任务或运行状态已改变，并立即重新计算最近截止时间。 */
  notifyChanged(): void {
    if (!this.started) return;
    this.clearTimer();
    void this.wake();
  }

  /** 清理定时器；调用后不会再认领或派发新的运行。 */
  async dispose(): Promise<void> {
    this.started = false;
    this.clearTimer();
    await this.executionPromise?.catch(() => undefined);
  }

  private async wake(): Promise<void> {
    if (!this.started || this.waking) return;
    this.waking = true;
    try {
      const now = this.clock.now();
      for (const record of this.options.repository.listDueDefinitions(now)) this.claimLatest(record, now);
      void this.pump();
    } finally {
      this.waking = false;
      this.scheduleNext();
    }
  }

  private claimLatest(record: AutomationDefinitionRecord, now: number): void {
    const definition = record.definition;
    const latest = latestAutomationOccurrenceAtOrBefore(definition.schedule, definition.activeRange, now);
    const scheduledFor = Math.max(definition.nextRunAt ?? now, latest ?? definition.nextRunAt ?? now);
    const nextRunAt = nextAutomationOccurrence(definition.schedule, definition.activeRange, now);
    const age = now - scheduledFor;
    const terminalReason = age > MISFIRE_GRACE_MS ? "missed_deadline" as const : undefined;
    const triggerSource = age > 1_000 ? "catchup" as const : "scheduled" as const;
    try {
      const run = this.options.repository.claimScheduledRun({
        automationId: definition.id,
        definitionRevision: definition.revision,
        runId: randomUUID(),
        scheduledFor,
        triggerSource,
        nextRunAt,
        now,
        ...(terminalReason ? { terminalReason } : {}),
      });
      this.log("automation_due_claimed", {
        automationId: definition.id,
        runId: run.id,
        queueDelayMs: Math.max(0, age),
        skipped: run.state === "skipped",
      });
      if (run.state === "skipped") {
        this.log("automation_run_skipped", {
          automationId: definition.id,
          runId: run.id,
          reason: run.errorCode ?? "unknown",
        });
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "overlap_blocked") return;
      this.log("automation_due_claim_failed", { automationId: definition.id, error: safeErrorCode(error) });
    }
  }

  private async pump(): Promise<void> {
    if (!this.started || this.executing) return;
    const next = this.options.repository.listActiveRunSnapshots().find((snapshot) => snapshot.run.state === "queued");
    if (!next) return;
    this.executing = true;
    const execution = this.execute(next);
    this.executionPromise = execution;
    try {
      await execution;
    } finally {
      this.executing = false;
      this.executionPromise = null;
      if (this.started) void this.pump();
    }
  }

  private async execute(snapshot: AutomationRunSnapshot): Promise<void> {
    this.log("automation_dispatch_started", { automationId: snapshot.run.automationId, runId: snapshot.run.id });
    await this.options.executor.execute(snapshot);
    const run = this.options.repository.getRun(snapshot.run.id);
    this.log("automation_dispatch_finished", {
      automationId: snapshot.run.automationId,
      runId: snapshot.run.id,
      state: run?.state ?? "missing",
      errorCode: run?.errorCode ?? null,
      durationMs: run?.startedAt && run.endedAt ? Math.max(0, run.endedAt - run.startedAt) : null,
    });
  }

  private scheduleNext(): void {
    if (!this.started) return;
    this.clearTimer();
    const now = this.clock.now();
    const nextRunAt = this.options.repository.nearestNextRunAt(now);
    const delay = nextRunAt === null
      ? IDLE_RECHECK_MS
      : Math.max(0, Math.min(MAX_TIMER_MS, nextRunAt - now));
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.wake();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private log(event: string, fields: Record<string, string | number | boolean | null>): void {
    this.options.log?.(event, fields);
  }
}

function systemClock(): AutomationSchedulerClock {
  return {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function safeErrorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
}

import { randomUUID } from "node:crypto";
import type { AutomationDefinitionRecord, AutomationRun } from "@jugglework/types/automation";
import { ApiError } from "../errors.js";
import type { AutomationEventExecutionContext, AutomationExecutor } from "./executor.js";
import { appendEventContextPromptParts } from "./event-pipeline.js";
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
    // TIPS: `listDueDefinitions` 只按 `next_run_at IS NOT NULL` 过滤，事件触发的
    // `nextRunAt` 永远是 null（到期由事件投递驱动，不是时钟算出来的），所以这里
    // 理论上永远收不到事件触发的定义；这个显式判断只是让类型系统和这条不变量对齐，
    // 不是一条真实会命中的运行路径。
    if (definition.trigger.kind === "event") return;
    const schedule = definition.trigger;
    const latest = latestAutomationOccurrenceAtOrBefore(schedule, definition.activeRange, now);
    const scheduledFor = Math.max(definition.nextRunAt ?? now, latest ?? definition.nextRunAt ?? now);
    const nextRunAt = nextAutomationOccurrence(schedule, definition.activeRange, now);
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
    await this.options.executor.execute(snapshot, eventContextFor(snapshot.run));
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

/**
 * 把一次已认领的运行还原成执行器需要的事件延续上下文。
 * TIPS: `AutomationEventPipeline.processOne` 在 claim 的同一时刻其实算出过更丰富的
 * 增量上下文（`deltaSince`/`untrustedText`，见 event-pipeline.ts 的
 * `appendEventContextPromptParts`），但那个结果只活在轮询器那一次调用栈里——
 * `onDispatched()` 只是个"唤醒调度器"的无参数信号，`pump()` 之后是重新从数据库里按
 * `state === "queued"` 捞快照来发，这条 delta 早就丢了。这里只能从运行记录自己持久化
 * 下来的 `eventMetadata` 重建上下文——`untrustedText`/`deltaSince` 这两块目前还没有落库，
 * 仍然是故意留白，不是疏漏；要补上需要把它们也塞进 `eventMetadata`，跨过轮询器和调度器
 * 的这次调用边界才能读到。
 *
 * `entityUrl` 是个例外：它已经落库（`eventMetadata.entityUrl`，供运行记录展示用），
 * 这里顺手拿来当"这一轮到底是哪个 PR/Issue"的直接提示——2026-09-05 用真实 GitHub PR
 * 触发验证写回时实测到，没有这条提示模型会去调用搜索类工具盲猜实体，且鉴于写回工具背后
 * 的 GitHub App 安装可能同时挂在多个仓库上，猜出来的经常是完全不相关的 PR（见
 * openspec/changes/add-event-triggered-automation/tasks.md 3b.5 的记录）。
 */
function eventContextFor(run: AutomationRun): AutomationEventExecutionContext | undefined {
  const entityRef = run.triggerSource === "event" ? run.eventMetadata?.entityRef : undefined;
  if (!entityRef) return undefined;
  const entityUrl = run.eventMetadata?.entityUrl;
  // TIPS：untrustedText/deltaEvents 只在 claimEventRun 新建运行（非防抖合并）那一支落库
  // （见 event-pipeline.ts processOne 的注释），所以这里读到的永远是"这一轮实际分发时"
  // 的数据，不是某次被合并掉的旧事件的残留。
  const extraPromptParts = appendEventContextPromptParts(
    [],
    { untrustedText: run.eventMetadata?.untrustedText ?? [], sourceUrl: entityUrl },
    run.eventMetadata?.deltaEvents ?? [],
  );
  if (entityUrl) {
    extraPromptParts.push({
      type: "text",
      text: "请直接针对上面这个触发来源地址对应的 PR/Issue 操作，不要用搜索工具去猜测目标——写回工具背后的身份可能同时能看到其它不相关仓库。",
    });
  }
  return { entityRef, extraPromptParts };
}

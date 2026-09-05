import { ApiError } from "../errors.js";
import type { AutomationEventPipeline, GithubEventDelivery } from "./event-pipeline.js";
import type { GithubEventRelayClient } from "./github-event-client.js";
import { parseGithubEventDeliveryPayload } from "./github-event-payload.js";
import type { AutomationRepository } from "./repository.js";

const DEFAULT_INTERVAL_MS = 30_000;

export type AutomationEventPollerClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
};

export type AutomationEventPollerOptions = {
  relay: GithubEventRelayClient;
  // TIPS: 只依赖这两个方法，不要求真的传一整个 AutomationEventPipeline——单测可以直接
  // 塞一个假实现，不用为了测轮询逻辑连带搭一整套 sqlite repository。
  pipeline: Pick<AutomationEventPipeline, "processOne" | "recordBacklogDropped">;
  // TIPS: 认领过期（automation_event_delivery_expired）落一条 backlog-dropped 记录（task 3.6）
  // 需要知道这条自动化"本地当前的" definitionRevision——只依赖这一个方法，用真实
  // AutomationRepository 传进来就行，不需要额外适配。
  repository: Pick<AutomationRepository, "getDefinition">;
  /** 一轮里只要有任意一条投递被 processOne 判定为 dispatched，就调用一次，唤醒调度器立即执行。 */
  onDispatched: () => void;
  intervalMs?: number;
  clock?: AutomationEventPollerClock;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

type ExpiredBucket = { count: number; sinceAt: number; untilAt: number };

/**
 * Embedded Server 内的事件投递轮询器（task 3.1 的兜底通道——headless IM 推送是主通道，
 * 这次改动没做，见 add-event-triggered-automation 的 design.md；轮询独立于它工作，
 * 编辑器里"强制轮询"选的就是这条路）。
 *
 * TIPS: `listPendingDeliveries` 是"这台设备名下"的投递，不是"某个自动化"的——服务端已经按
 * `owner_device_id` 做完路由，这里不需要先枚举本地哪些自动化是事件触发才知道拉什么，直接
 * 分页拉完这台设备的全部待处理投递，一条条 claim、解析、丢给 pipeline 判定；pipeline 自己
 * 会对不认识的 automationId（比如本地已经删除的定义）安全地判定为 self_loop_suppressed，
 * 不需要轮询器自己先做一遍存在性检查。
 */
export class AutomationEventPoller {
  private started = false;
  private polling = false;
  private timer: unknown = null;
  private readonly clock: AutomationEventPollerClock;
  private readonly intervalMs: number;
  private inflight: Promise<void> | null = null;
  /** `pollNow()` 在一轮已经在跑的时候设置——不打断当前这轮，等它结束后立刻再来一轮，
   * 而不是乖乖等满剩下的轮询间隔。见 `pollNow()` 自己的 TIPS。 */
  private pendingImmediatePoll = false;

  constructor(private readonly options: AutomationEventPollerOptions) {
    this.clock = options.clock ?? systemClock();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.pollLoop();
  }

  /** 停止后不会再发起新的轮询请求；等当前正在进行的这一轮（如果有）结束再返回。 */
  async dispose(): Promise<void> {
    this.started = false;
    this.clearTimer();
    await this.inflight?.catch(() => undefined);
  }

  /**
   * 跳过剩余的轮询等待，立刻发起一轮认领。供收到 IM 唤醒推送的调用方使用——那条推送本身
   * 只是个信号，不带投递内容，真正的投递数据仍然要靠这一轮真实的 `listPendingDeliveries` 拉取。
   * TIPS: 如果这一刻已经有一轮轮询在跑，不会打断它、也不会并发发起第二轮（`pollLoop` 的
   * `this.polling` 互斥保证了这一点）——只是记一个"这轮跑完之后不要等定时器，立刻再来一轮"
   * 的标记，因为触发这次唤醒的那条投递，很可能还没被这正在进行的一轮看见（服务端处理和
   * IM 推送到达之间没有顺序保证）。
   */
  pollNow(): void {
    if (!this.started) return;
    if (this.polling) {
      this.pendingImmediatePoll = true;
      return;
    }
    this.clearTimer();
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    if (!this.started || this.polling) return;
    this.polling = true;
    const execution = this.pollOnce();
    this.inflight = execution;
    try {
      await execution;
    } finally {
      this.polling = false;
      this.inflight = null;
      if (this.started) {
        if (this.pendingImmediatePoll) {
          this.pendingImmediatePoll = false;
          void this.pollLoop();
        } else {
          this.scheduleNext();
        }
      }
    }
  }

  private async pollOnce(): Promise<void> {
    const expiredByAutomation = new Map<string, ExpiredBucket>();
    let anyDispatched = false;
    let cursor: string | null | undefined;

    do {
      let page: Awaited<ReturnType<GithubEventRelayClient["listPendingDeliveries"]>>;
      try {
        page = await this.options.relay.listPendingDeliveries(cursor ?? undefined);
      } catch (error) {
        this.log("automation_event_poll_failed", { error: safeErrorCode(error) });
        return;
      }

      for (const item of page.items) {
        if (!this.started) return;
        let detail;
        try {
          detail = await this.options.relay.claimDelivery(item.id);
        } catch (error) {
          if (error instanceof ApiError && error.code === "automation_event_delivery_expired") {
            const bucket = expiredByAutomation.get(item.automationId) ?? {
              count: 0, sinceAt: item.eventTimestampMs, untilAt: item.eventTimestampMs,
            };
            bucket.count += 1;
            bucket.sinceAt = Math.min(bucket.sinceAt, item.eventTimestampMs);
            bucket.untilAt = Math.max(bucket.untilAt, item.eventTimestampMs);
            expiredByAutomation.set(item.automationId, bucket);
            continue;
          }
          // TIPS: 单条投递认领失败（网络故障、服务端瞬时错误……）不该让这一整轮轮询直接
          // 放弃——跳过这一条，继续处理这一页剩下的，下一轮轮询会自然重试它（只要它还没
          // 过期）。
          this.log("automation_event_claim_failed", { deliveryId: item.id, automationId: item.automationId, error: safeErrorCode(error) });
          continue;
        }

        const delivery: GithubEventDelivery = parseGithubEventDeliveryPayload(detail);
        const outcome = this.options.pipeline.processOne(delivery);
        this.log("automation_event_processed", { deliveryId: delivery.id, automationId: delivery.automationId, outcome: outcome.kind });
        if (outcome.kind === "dispatched") anyDispatched = true;
      }

      cursor = page.nextCursor;
    } while (cursor && this.started);

    for (const [automationId, bucket] of expiredByAutomation) {
      const record = this.options.repository.getDefinition(automationId);
      if (!record) continue; // 本地已经没有这条自动化的定义了，没有可归因的 revision，跳过。
      this.options.pipeline.recordBacklogDropped({
        automationId, definitionRevision: record.definition.revision,
        count: bucket.count, sinceAt: bucket.sinceAt, untilAt: bucket.untilAt,
      });
      this.log("automation_event_backlog_dropped", { automationId, count: bucket.count });
    }

    if (anyDispatched) this.options.onDispatched();
  }

  private scheduleNext(): void {
    if (!this.started) return;
    this.clearTimer();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.pollLoop();
    }, this.intervalMs);
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

function systemClock(): AutomationEventPollerClock {
  return {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export function safeErrorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : error instanceof Error ? error.name : "unknown";
}

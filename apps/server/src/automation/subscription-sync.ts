import { isAutomationEventTrigger, type AutomationDefinitionRecord } from "@jugglework/types/automation";
import { safeErrorCode } from "./event-poller.js";
import type { GithubEventRelayClient, GithubEventSubscriptionInput } from "./github-event-client.js";
import type { AutomationRepository } from "./repository.js";

const DEFAULT_INTERVAL_MS = 30_000;

/**
 * 事件触发自动化在服务端的订阅路由元数据同步器。
 *
 * TIPS：这是 task 3.1 遗漏的一环——`resolveAuth`、轮询、认领全都建好了，但服务端
 * `routeAutomationEvent` 靠 `automation_event_subscriptions` 表决定"这条 webhook 事件
 * 该不该给哪个自动化建一条投递"，而这张表在这次改动之前从来没有任何代码往里写过东西：
 * 本地新建/启用一个事件触发自动化，`PUT /automations/:id/event-subscription`
 * （jugglework-server 早就实现并测试过这个端点）从来没被调用过。少了这一步，事件触发
 * 自动化本地看起来"已启用"，实际上服务端完全不知道它的存在，任何真实 webhook 都会在
 * `FindAutomationEventSubscriptions` 那一步直接查出零命中——`enqueuedCount` 恒为 0，
 * `listPendingDeliveries` 永远空。
 *
 * TIPS：跟 `event-poller.ts`/`scheduler.ts` 同一个设计——自驱动的周期性 reconciler，
 * 不是每次写路由都补一次推送。全量重读本地定义、跟"上一次成功推送的状态摘要"比对，
 * 只在真正变化时才发请求，省得每个自动化写操作都要记得调用它，也不用为漏调用一个
 * 写入口而返工。
 */
export type AutomationSubscriptionSyncClock = {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
};

export type AutomationSubscriptionSyncOptions = {
  relay: Pick<GithubEventRelayClient, "upsertEventSubscription" | "deleteEventSubscription">;
  // TIPS: 只依赖分页读取 + 账号记账两个窄方法，测试可以直接塞一个假仓储，不用为了测同步
  // 逻辑连带搭一整套 sqlite repository。
  repository: Pick<AutomationRepository, "listDefinitions" | "getSubscriptionAccount" | "setSubscriptionAccount" | "deleteSubscriptionAccount">;
  /**
   * 当前登录账号 id；返回 null 表示还不知道（未登录，或渲染进程尚未推送）。
   * 任务 6.1：这是账号切换检测的信号来源——见下面 `reconcileOne` 的账号比对。
   */
  currentAccountId?: () => string | null;
  intervalMs?: number;
  clock?: AutomationSubscriptionSyncClock;
  log?: (event: string, fields?: Record<string, unknown>) => void;
};

/** 一个自动化当前的账号一致性状态，供桌面 UI 渲染重新确认横幅。 */
export type AutomationSubscriptionAccountStatus =
  | { state: "ok" }
  | { state: "unknown" }
  | { state: "mismatch"; confirmedAccountId: string; currentAccountId: string };

/**
 * 从本地定义算出这条自动化"期望在服务端呈现的订阅状态"——`null` 表示不该存在订阅
 * （触发方式不是 event，或者已经被本地墓碑删除）。
 *
 * TIPS: `lifecycle === "shadow"` 也算需要订阅——影子模式跑完整条管线只是不真的派发执行
 * （task 5.3），事件还是要真的送到本机才有得"影子"；只有 `paused`/`completed` 才关掉。
 * 服务端 `AutomationEventSubscriptionInput.BranchFilter`/`LabelFilter` 是整条订阅一份、
 * 不分事件类型的粗筛（真正精细的按 changedPaths 等过滤是设备侧认领之后做的，见 task 5.1），
 * 这里把所有 match 各自的 `github.branches.base`/`common.labels` 取并集上报，跟服务端
 * "先粗筛、设备再收窄"的既有设计一致。
 */
export function desiredGithubEventSubscription(record: AutomationDefinitionRecord): GithubEventSubscriptionInput | null {
  if (record.deletedAt) return null;
  const { trigger } = record.definition;
  if (!isAutomationEventTrigger(trigger)) return null;
  const branchFilter = [...new Set(trigger.matches.flatMap((match) => match.github?.branches?.base ?? []))];
  const labelFilter = [...new Set(trigger.matches.flatMap((match) => match.common?.labels ?? []))];
  return {
    connectorInstanceId: trigger.connectorId,
    eventTypes: [...new Set(trigger.matches.map((match) => match.event))],
    branchFilter,
    labelFilter,
    permissionTier: trigger.permissionTier,
    enabled: record.definition.lifecycle === "enabled" || record.definition.lifecycle === "shadow",
  };
}

function subscriptionDigest(state: GithubEventSubscriptionInput | null): string {
  return state ? JSON.stringify(state) : "\0deleted";
}

function defaultClock(): AutomationSubscriptionSyncClock {
  return {
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

export class AutomationSubscriptionSync {
  private readonly relay: AutomationSubscriptionSyncOptions["relay"];
  private readonly repository: AutomationSubscriptionSyncOptions["repository"];
  private readonly currentAccountId: () => string | null;
  private readonly intervalMs: number;
  private readonly clock: AutomationSubscriptionSyncClock;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  private started = false;
  private syncing = false;
  private timer: unknown = null;
  private inflight: Promise<void> | null = null;
  // TIPS: 记的是"上一次成功推送到服务端的状态摘要"，不是本地定义本身——同一份没变化的
  // 订阅不需要每个周期都重复 PUT。进程重启后这份内存状态会丢，下一轮会把所有事件触发
  // 自动化全量重推一次；服务端那条 PUT 是幂等 upsert，重推的代价是可接受的，换来的是
  // 不需要为"是否已同步"这件事另开一张持久化表。
  private readonly pushed = new Map<string, string>();
  // TIPS: 任务 6.1——账号不一致时这一轮不推送，状态记在这里供 UI 轮询；不落库是因为它
  // 只是"当前观察到的偏差"，跟 automation_subscription_accounts 那张记录"上次确认在哪个
  // 账号下"的表意义不同，重启后重新计算一次就行，不需要持久化。
  private readonly accountMismatches = new Map<string, { confirmedAccountId: string; currentAccountId: string }>();

  constructor(options: AutomationSubscriptionSyncOptions) {
    this.relay = options.relay;
    this.repository = options.repository;
    this.currentAccountId = options.currentAccountId ?? (() => null);
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.clock = options.clock ?? defaultClock();
    this.log = options.log ?? (() => undefined);
  }

  /**
   * 某个自动化当前的账号一致性状态。`"unknown"`：还没确认过账号（首次推送尚未发生），
   * 或者当前根本不知道登录账号是谁——都不算异常，只是还没有可比对的证据。
   */
  getAccountStatus(automationId: string): AutomationSubscriptionAccountStatus {
    const mismatch = this.accountMismatches.get(automationId);
    if (mismatch) return { state: "mismatch", confirmedAccountId: mismatch.confirmedAccountId, currentAccountId: mismatch.currentAccountId };
    return this.repository.getSubscriptionAccount(automationId) ? { state: "ok" } : { state: "unknown" };
  }

  /**
   * 用户在重新确认横幅里点了"继续使用当前账号"——把记账更新到当前账号，解除拦截，
   * 让下一轮同步正常按新账号推送。不在这里直接推送：让常规的 syncLoop 周期去做，
   * 避免这条路径要重复一遍 reconcileOne 的全部逻辑。
   */
  confirmAccount(automationId: string, accountId: string): void {
    this.repository.setSubscriptionAccount(automationId, accountId, this.clock.now());
    this.accountMismatches.delete(automationId);
    // 摘要清掉才能让下一轮真的重新发起推送——不然会命中"没变化就不用推"的短路。
    this.pushed.delete(automationId);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.syncLoop();
  }

  /** 停止后不会再发起新的同步；等当前正在进行的这一轮（如果有）结束再返回。 */
  async dispose(): Promise<void> {
    this.started = false;
    this.clearTimer();
    await this.inflight?.catch(() => undefined);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.clock.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private async syncLoop(): Promise<void> {
    if (!this.started || this.syncing) return;
    this.syncing = true;
    const execution = this.syncOnce();
    this.inflight = execution;
    try {
      await execution;
    } finally {
      this.syncing = false;
      this.inflight = null;
      if (this.started) this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    this.clearTimer();
    this.timer = this.clock.setTimer(() => {
      this.timer = null;
      void this.syncLoop();
    }, this.intervalMs);
  }

  private async syncOnce(): Promise<void> {
    let cursor: string | undefined;
    do {
      if (!this.started) return;
      const page = this.repository.listDefinitions({ limit: 100, cursor, includeDeleted: true });
      for (const record of page.items) {
        if (!this.started) return;
        await this.reconcileOne(record);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  private async reconcileOne(record: AutomationDefinitionRecord): Promise<void> {
    const automationId = record.definition.id;
    const desired = desiredGithubEventSubscription(record);
    if (!desired) {
      // 不再是事件触发（或已墓碑删除）——记账没有意义了，一并清掉，免得这个自动化
      // 的 id 被复用（理论上不会，但没有理由留着一条永远匹配不到定义的记账行）。
      this.accountMismatches.delete(automationId);
      if (this.repository.getSubscriptionAccount(automationId)) this.repository.deleteSubscriptionAccount(automationId);
    } else {
      // TIPS: 任务 6.1——先做账号一致性检查，再决定要不要推送。服务端的 `OwnerIMUserID`
      // 每次 upsert 都会被"这次推送用的是哪个 session"悄悄覆盖（见 jugglework-server
      // `UpsertSubscription` 的注释），也就是说如果这里不拦，账号切换之后账号仅仅是被
      // 服务端安静地改写成新账号——不是"忘了检测"，是"检测的证据在推送那一刻自己被抹掉了"。
      // 所以这道拦截必须在调用 upsertEventSubscription 之前。
      const accountId = this.currentAccountId();
      if (accountId) {
        const confirmed = this.repository.getSubscriptionAccount(automationId);
        if (confirmed && confirmed.accountId !== accountId) {
          this.accountMismatches.set(automationId, { confirmedAccountId: confirmed.accountId, currentAccountId: accountId });
          return; // 拦下——不推送，也不更新 pushed 摘要，等用户显式确认。
        }
        // 到这里要么是首次推送（confirmed 为 null），要么账号本来就一致——都可以放行，
        // 顺带（重新）登记一次账号记账，让下一次账号切换有据可查。
        if (!confirmed || confirmed.accountId !== accountId) this.repository.setSubscriptionAccount(automationId, accountId, this.clock.now());
        this.accountMismatches.delete(automationId);
      }
      // accountId 为 null（还不知道当前登录是谁）时不拦截——这不是本任务要处理的场景，
      // resolveAuth 自己的"未登录时优雅降级"已经覆盖了这种情况，upsertEventSubscription
      // 会在没有凭据时自然失败，跟原有行为一致。
    }
    const digest = subscriptionDigest(desired);
    if (this.pushed.get(automationId) === digest) return;
    try {
      if (desired) {
        await this.relay.upsertEventSubscription(automationId, desired);
      } else {
        // 只有确实之前成功推送过点什么，才有必要发一次删除——本来就不是事件触发的
        // 自动化，或者从没同步成功过的，不用管。
        if (!this.pushed.has(automationId)) return;
        await this.relay.deleteEventSubscription(automationId);
      }
      this.pushed.set(automationId, digest);
    } catch (error) {
      // 不重新抛出——这一条这轮没同步上，下一轮 digest 依然不匹配会自动重试；一条
      // 失败不该挡住这一轮里其它自动化的同步。
      this.log("automation_event_subscription_sync_failed", { automationId, error: safeErrorCode(error) });
    }
  }
}

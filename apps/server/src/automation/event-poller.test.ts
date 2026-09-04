import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../errors.js";
import { AutomationEventPoller } from "./event-poller.js";
import type { EventPipelineOutcome, GithubEventDelivery } from "./event-pipeline.js";
import type { GithubEventDeliveryDetail, GithubEventDeliverySummary, GithubEventRelayClient } from "./github-event-client.js";

function summary(overrides: Partial<GithubEventDeliverySummary> = {}): GithubEventDeliverySummary {
  return {
    id: "delivery-1", automationId: "automation-1", eventType: "pull_request", action: "opened",
    entityRef: "github:pull_request:1", eventTimestampMs: 1_000, createdAtMs: 1_100,
    ...overrides,
  };
}

function detail(overrides: Partial<GithubEventDeliveryDetail> = {}): GithubEventDeliveryDetail {
  return {
    id: "delivery-1", automationId: "automation-1", eventType: "pull_request", action: "opened",
    entityRef: "github:pull_request:1", eventTimestampMs: 1_000, payload: { pull_request: { title: "t" } },
    authorIsAppIdentity: false,
    ...overrides,
  };
}

// TIPS: 跟 scheduler.test.ts 用的是同一套 eventually 轮询等待模式——start() 是异步链条的
// 起点，真正的"这一轮轮询做完了"没有同步信号；用 start(); await dispose() 背靠背调用会
// 命中一个真实的时序竞争：dispose() 同步把 started 置 false，pollOnce 内部 for 循环每条
// 都会检查 started，第一条 listPendingDeliveries 的 await 还没落地就被叫停，后面的投递
// 一条都不会处理。等一个可观察的副作用出现了再 dispose，不背靠背调用。
async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("condition was not reached");
}

function fakeClock() {
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  return {
    clock: {
      now: () => 0,
      setTimer: (callback: () => void, delayMs: number) => {
        const handle = { callback, delayMs };
        timers.push(handle);
        return handle;
      },
      clearTimer: (handle: unknown) => {
        const index = timers.indexOf(handle as { callback: () => void; delayMs: number });
        if (index !== -1) timers.splice(index, 1);
      },
    },
    timers,
  };
}

function relayStub(overrides: Partial<GithubEventRelayClient> = {}): GithubEventRelayClient {
  return {
    listRepositories: async () => [],
    checkReadiness: async () => "ready",
    requestInstall: async () => {},
    requestBind: async () => {},
    estimateFrequency: async () => null,
    fetchWriteBackGrant: async () => { throw new Error("not used"); },
    listPendingDeliveries: async () => ({ items: [], nextCursor: null }),
    claimDelivery: async () => { throw new Error("not used"); },
    upsertEventSubscription: async () => { throw new Error("not used"); },
    deleteEventSubscription: async () => { throw new Error("not used"); },
    ...overrides,
  };
}

test("polls, claims, parses, and hands each delivery to the pipeline in order", async () => {
  const claimed: string[] = [];
  const processed: GithubEventDelivery[] = [];
  const relay = relayStub({
    listPendingDeliveries: async () => ({ items: [summary({ id: "d1" }), summary({ id: "d2" })], nextCursor: null }),
    claimDelivery: async (id) => { claimed.push(id); return detail({ id }); },
  });
  let dispatchedCalls = 0;
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: {
      processOne: (delivery) => { processed.push(delivery); return { kind: "dispatched", snapshot: {} as never, deltaSince: [] } satisfies EventPipelineOutcome; },
      recordBacklogDropped: () => { throw new Error("should not be called"); },
    },
    repository: { getDefinition: () => null },
    onDispatched: () => { dispatchedCalls += 1; },
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1); // scheduleNext only runs after the poll cycle finishes

  assert.deepEqual(claimed, ["d1", "d2"]);
  assert.equal(processed.length, 2);
  assert.equal(processed[0]?.id, "d1");
  assert.equal(dispatchedCalls, 1, "onDispatched fires once per poll cycle that produced at least one dispatch, not once per delivery");

  await poller.dispose();
});

test("follows pagination cursors until the server reports none left", async () => {
  const pages = [
    { items: [summary({ id: "d1" })], nextCursor: "cursor-2" },
    { items: [summary({ id: "d2" })], nextCursor: null },
  ];
  const requestedCursors: Array<string | null | undefined> = [];
  const relay = relayStub({
    listPendingDeliveries: async (cursor) => { requestedCursors.push(cursor); return pages.shift()!; },
    claimDelivery: async (id) => detail({ id }),
  });
  const processedIds: string[] = [];
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: {
      processOne: (delivery) => { processedIds.push(delivery.id); return { kind: "merged", runId: "r1" }; },
      recordBacklogDropped: () => { throw new Error("should not be called"); },
    },
    repository: { getDefinition: () => null },
    onDispatched: () => { throw new Error("should not be called — nothing was dispatched"); },
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1);

  assert.deepEqual(requestedCursors, [undefined, "cursor-2"]);
  assert.deepEqual(processedIds, ["d1", "d2"]);

  await poller.dispose();
});

test("an expired claim (automation_event_delivery_expired) is aggregated into a single backlog-dropped record per automation, not one per delivery", async () => {
  const relay = relayStub({
    listPendingDeliveries: async () => ({
      items: [
        summary({ id: "d1", automationId: "auto-1", eventTimestampMs: 1_000 }),
        summary({ id: "d2", automationId: "auto-1", eventTimestampMs: 3_000 }),
        summary({ id: "d3", automationId: "auto-2", eventTimestampMs: 2_000 }),
      ],
      nextCursor: null,
    }),
    claimDelivery: async () => { throw new ApiError(410, "automation_event_delivery_expired", "gone"); },
  });
  const backlogCalls: Array<{ automationId: string; definitionRevision: number; count: number; sinceAt: number; untilAt: number }> = [];
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: {
      processOne: () => { throw new Error("should not be called — every claim expired"); },
      recordBacklogDropped: (input) => { backlogCalls.push(input); },
    },
    repository: {
      getDefinition: (id) => id === "auto-1" || id === "auto-2"
        ? { definition: { revision: id === "auto-1" ? 5 : 9 } } as never
        : null,
    },
    onDispatched: () => { throw new Error("should not be called"); },
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1);

  assert.equal(backlogCalls.length, 2);
  const auto1 = backlogCalls.find((call) => call.automationId === "auto-1");
  assert.deepEqual(auto1, { automationId: "auto-1", definitionRevision: 5, count: 2, sinceAt: 1_000, untilAt: 3_000 });
  const auto2 = backlogCalls.find((call) => call.automationId === "auto-2");
  assert.deepEqual(auto2, { automationId: "auto-2", definitionRevision: 9, count: 1, sinceAt: 2_000, untilAt: 2_000 });

  await poller.dispose();
});

test("skips a backlog-dropped record for an automation that no longer exists locally, instead of throwing", async () => {
  const relay = relayStub({
    listPendingDeliveries: async () => ({ items: [summary({ id: "d1", automationId: "deleted-locally" })], nextCursor: null }),
    claimDelivery: async () => { throw new ApiError(410, "automation_event_delivery_expired", "gone"); },
  });
  let backlogCalled = false;
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: { processOne: () => { throw new Error("unused"); }, recordBacklogDropped: () => { backlogCalled = true; } },
    repository: { getDefinition: () => null },
    onDispatched: () => { throw new Error("should not be called"); },
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1);

  assert.equal(backlogCalled, false);

  await poller.dispose();
});

test("a non-expired claim failure is skipped without aborting the rest of the page", async () => {
  const relay = relayStub({
    listPendingDeliveries: async () => ({ items: [summary({ id: "d1" }), summary({ id: "d2" })], nextCursor: null }),
    claimDelivery: async (id) => { if (id === "d1") throw new Error("network blip"); return detail({ id }); },
  });
  const processedIds: string[] = [];
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: {
      processOne: (delivery) => { processedIds.push(delivery.id); return { kind: "merged", runId: "r1" }; },
      recordBacklogDropped: () => { throw new Error("should not be called"); },
    },
    repository: { getDefinition: () => null },
    onDispatched: () => { throw new Error("should not be called"); },
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1);

  assert.deepEqual(processedIds, ["d2"]);

  await poller.dispose();
});

test("a failed listPendingDeliveries page aborts that poll cycle without throwing out of start()", async () => {
  const relay = relayStub({ listPendingDeliveries: async () => { throw new Error("server unreachable"); } });
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: { processOne: () => { throw new Error("unused"); }, recordBacklogDropped: () => { throw new Error("unused"); } },
    repository: { getDefinition: () => null },
    onDispatched: () => { throw new Error("should not be called"); },
    clock,
  });

  poller.start();
  // TIPS: pollOnce 内部 catch 住了拉取失败、用一个普通 return 结束这一轮——对 pollLoop 的
  // finally 块来说这跟正常结束没有区别，下一轮定时器照常会排上，不会因为这次失败就彻底
  // 停摆（网络抖动不该让轮询永久失效，下一轮会自然重试）。
  await eventually(() => timers.length === 1);

  await poller.dispose();
});

test("schedules the next poll after the configured interval and stops scheduling once disposed", async () => {
  const relay = relayStub();
  const { clock, timers } = fakeClock();
  const poller = new AutomationEventPoller({
    relay,
    pipeline: { processOne: () => ({ kind: "merged", runId: "r1" }), recordBacklogDropped: () => {} },
    repository: { getDefinition: () => null },
    onDispatched: () => {},
    intervalMs: 5_000,
    clock,
  });

  poller.start();
  await eventually(() => timers.length === 1);
  assert.equal(timers[0]?.delayMs, 5_000);

  await poller.dispose();
  assert.equal(timers.length, 0, "dispose must clear the pending timer");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition, type AutomationDefinitionRecord, type AutomationEventTrigger, type AutomationSchedule } from "@jugglework/types/automation";
import { AutomationSubscriptionSync, desiredGithubEventSubscription } from "./subscription-sync.js";
import type { GithubEventSubscriptionInput } from "./github-event-client.js";
import type { AutomationDefinitionPage } from "./repository.js";

const NOW = Date.parse("2026-09-05T00:00:00Z");

function eventTrigger(overrides: Partial<AutomationEventTrigger> = {}): AutomationEventTrigger {
  return {
    version: 1,
    kind: "event",
    provider: "github",
    connectorId: "cin_1",
    repository: { owner: "juggleai", name: "skillhub" },
    matches: [{ event: "pull_request" }],
    concurrencyKey: "entity",
    deliveryMode: "poll",
    permissionTier: "auto",
    ...overrides,
  };
}

function eventDefinition(id: string, overrides: Partial<AutomationDefinition> = {}, triggerOverrides: Partial<AutomationEventTrigger> = {}): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id,
    name: "Event automation",
    workspace: { id: "workspace-1", name: "工作空间", path: "/tmp/workspace", workspaceType: "local" },
    prompt: { version: 1, parts: [{ type: "text", text: "评审这个 PR" }] },
    trigger: eventTrigger(triggerOverrides),
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: NOW },
    lifecycle: "enabled",
    executorDeviceId: "device-1",
    revision: 1,
    nextRunAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function scheduleDefinition(id: string): AutomationDefinition {
  const schedule: AutomationSchedule = { version: 1, kind: "calendar", frequency: "daily", timezone: "UTC", localTime: "09:00" };
  return {
    schema: "automation-definition/v1",
    id,
    name: "Schedule automation",
    workspace: { id: "workspace-1", name: "工作空间", path: "/tmp/workspace", workspaceType: "local" },
    prompt: { version: 1, parts: [{ type: "text", text: "整理今天的待办" }] },
    trigger: schedule,
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: NOW },
    lifecycle: "enabled",
    executorDeviceId: "device-1",
    revision: 1,
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function record(definition: AutomationDefinition, deletedAt?: number): AutomationDefinitionRecord {
  return {
    definition,
    compatibility: "compatible",
    syncState: "synced",
    rawDocument: {},
    ...(deletedAt !== undefined ? { deletedAt } : {}),
  };
}

// TIPS: 跟 event-poller.test.ts 同一套 eventually 轮询等待模式——start() 是异步链条的
// 起点，真正的"这一轮同步做完了"没有同步信号。
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

function fakeRepository(recordsRef: { current: AutomationDefinitionRecord[] }) {
  return {
    listDefinitions: (): AutomationDefinitionPage => ({ items: recordsRef.current }),
  };
}

function fakeRelay() {
  const upserts: Array<{ automationId: string; input: GithubEventSubscriptionInput }> = [];
  const deletes: string[] = [];
  let failNextUpsertFor: string | null = null;
  return {
    upserts,
    deletes,
    failNextUpsertFor: (automationId: string) => { failNextUpsertFor = automationId; },
    relay: {
      upsertEventSubscription: async (automationId: string, input: GithubEventSubscriptionInput) => {
        if (failNextUpsertFor === automationId) { failNextUpsertFor = null; throw new Error("simulated failure"); }
        upserts.push({ automationId, input });
      },
      deleteEventSubscription: async (automationId: string) => { deletes.push(automationId); },
    },
  };
}

test("desiredGithubEventSubscription: maps a plain event-triggered automation, unions branch/label filters across matches", () => {
  const definition = eventDefinition("automation-1", {}, {
    matches: [
      { event: "pull_request", github: { branches: { base: ["main"] } } },
      { event: "issue_comment_on_pull_request", common: { labels: ["needs-review"] }, github: { branches: { base: ["main", "release"] } } },
    ],
  });
  const desired = desiredGithubEventSubscription(record(definition));
  assert.deepEqual(desired, {
    connectorInstanceId: "cin_1",
    eventTypes: ["pull_request", "issue_comment_on_pull_request"],
    branchFilter: ["main", "release"],
    labelFilter: ["needs-review"],
    permissionTier: "auto",
    enabled: true,
  });
});

test("desiredGithubEventSubscription: shadow lifecycle still wants an active (enabled) subscription", () => {
  const definition = eventDefinition("automation-1", { lifecycle: "shadow" });
  assert.equal(desiredGithubEventSubscription(record(definition))?.enabled, true);
});

test("desiredGithubEventSubscription: paused lifecycle wants the subscription disabled, not deleted", () => {
  const definition = eventDefinition("automation-1", { lifecycle: "paused" });
  assert.equal(desiredGithubEventSubscription(record(definition))?.enabled, false);
});

test("desiredGithubEventSubscription: schedule-triggered and soft-deleted automations want no subscription at all", () => {
  assert.equal(desiredGithubEventSubscription(record(scheduleDefinition("automation-2"))), null);
  assert.equal(desiredGithubEventSubscription(record(eventDefinition("automation-3"), NOW)), null);
});

test("pushes a subscription for a newly-seen event automation, then does not re-push once in sync", async () => {
  const recordsRef = { current: [record(eventDefinition("automation-1"))] };
  const { clock, timers } = fakeClock();
  const { upserts, relay } = fakeRelay();
  const sync = new AutomationSubscriptionSync({ relay, repository: fakeRepository(recordsRef), clock });
  sync.start();
  await eventually(() => timers.length === 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.automationId, "automation-1");

  // Second cycle, nothing changed locally — must not re-push.
  timers[0]?.callback();
  await eventually(() => timers.length === 1);
  assert.equal(upserts.length, 1);

  await sync.dispose();
});

test("re-pushes once the definition actually changes (enabled -> paused)", async () => {
  const definition = eventDefinition("automation-1");
  const recordsRef = { current: [record(definition)] };
  const { clock, timers } = fakeClock();
  const { upserts, relay } = fakeRelay();
  const sync = new AutomationSubscriptionSync({ relay, repository: fakeRepository(recordsRef), clock });
  sync.start();
  await eventually(() => timers.length === 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0]?.input.enabled, true);

  recordsRef.current = [record({ ...definition, lifecycle: "paused" })];
  timers[0]?.callback();
  await eventually(() => upserts.length === 2);
  assert.equal(upserts[1]?.input.enabled, false);

  await sync.dispose();
});

test("deletes the server-side subscription once an automation that was previously synced switches away from event triggers, but never bothers deleting one that was never event-triggered", async () => {
  const eventDef = eventDefinition("automation-1");
  const scheduleDef = scheduleDefinition("automation-2");
  const recordsRef = { current: [record(eventDef), record(scheduleDef)] };
  const { clock, timers } = fakeClock();
  const { upserts, deletes, relay } = fakeRelay();
  const sync = new AutomationSubscriptionSync({ relay, repository: fakeRepository(recordsRef), clock });
  sync.start();
  await eventually(() => timers.length === 1);
  assert.equal(upserts.length, 1);
  assert.equal(deletes.length, 0); // automation-2 was never event-triggered — nothing to clean up.

  // automation-1's trigger kind switches to schedule (a real, if rare, edit path).
  recordsRef.current = [record({ ...eventDef, trigger: scheduleDef.trigger }), record(scheduleDef)];
  timers[0]?.callback();
  await eventually(() => deletes.length === 1);
  assert.deepEqual(deletes, ["automation-1"]);

  await sync.dispose();
});

test("a failed push for one automation doesn't block others in the same cycle, and is retried on the next cycle", async () => {
  const recordsRef = { current: [record(eventDefinition("automation-1")), record(eventDefinition("automation-2"))] };
  const { clock, timers } = fakeClock();
  const { upserts, relay, failNextUpsertFor } = fakeRelay();
  failNextUpsertFor("automation-1");
  const failures: string[] = [];
  const sync = new AutomationSubscriptionSync({
    relay, repository: fakeRepository(recordsRef), clock,
    log: (event, fields) => { if (event === "automation_event_subscription_sync_failed") failures.push(String(fields?.automationId)); },
  });
  sync.start();
  await eventually(() => timers.length === 1);
  // automation-2 succeeded despite automation-1 failing.
  assert.deepEqual(upserts.map((entry) => entry.automationId), ["automation-2"]);
  assert.deepEqual(failures, ["automation-1"]);

  // Next cycle: automation-1 is retried since it never recorded a successful digest.
  timers[0]?.callback();
  await eventually(() => upserts.some((entry) => entry.automationId === "automation-1"));

  await sync.dispose();
});

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTOMATION_DEFINITION_SCHEMA,
  isAutomationEventTrigger,
  type AutomationDefinition,
  type AutomationEventTrigger,
  type AutomationSchedule,
} from "../src/automation.ts";

const BASE: Omit<AutomationDefinition, "trigger"> = {
  schema: AUTOMATION_DEFINITION_SCHEMA,
  id: "task-1",
  name: "Task",
  workspace: { id: "workspace-1", name: "Workspace", path: "/tmp/workspace", workspaceType: "local" },
  prompt: { version: 1, parts: [{ type: "text", text: "run" }] },
  model: { mode: "auto" },
  skillIds: [],
  connectors: [],
  permission: { profile: "unattended-full-access-v1", acknowledgedAt: 1 },
  lifecycle: "enabled",
  executorDeviceId: "device-1",
  revision: 1,
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const SCHEDULE_TRIGGER: AutomationSchedule = {
  version: 1,
  kind: "calendar",
  frequency: "daily",
  localTime: "09:00",
  timezone: "Asia/Shanghai",
};

const EVENT_TRIGGER: AutomationEventTrigger = {
  version: 1,
  kind: "event",
  provider: "github",
  connectorId: "connector-1",
  repository: { owner: "juggleai", name: "jugglework-desktop" },
  matches: [
    { event: "pull_request", actions: ["opened", "synchronize"] },
    { event: "issue_comment", common: { mentionText: "@juggle" } },
  ],
  concurrencyKey: "entity",
  deliveryMode: "auto",
  permissionTier: "auto",
};

test("AutomationDefinition round-trips a schedule-kind trigger through JSON losslessly", () => {
  const definition: AutomationDefinition = { ...BASE, trigger: SCHEDULE_TRIGGER };
  const roundTripped = JSON.parse(JSON.stringify(definition)) as AutomationDefinition;
  assert.deepEqual(roundTripped, definition);
  assert.equal(isAutomationEventTrigger(roundTripped.trigger), false);
  assert.equal(roundTripped.trigger.kind, "calendar");
});

test("AutomationDefinition round-trips an event-kind trigger through JSON losslessly", () => {
  const definition: AutomationDefinition = { ...BASE, trigger: EVENT_TRIGGER };
  const roundTripped = JSON.parse(JSON.stringify(definition)) as AutomationDefinition;
  assert.deepEqual(roundTripped, definition);
  assert.equal(isAutomationEventTrigger(roundTripped.trigger), true);
  if (isAutomationEventTrigger(roundTripped.trigger)) {
    assert.equal(roundTripped.trigger.repository.owner, "juggleai");
    assert.equal(roundTripped.trigger.matches.length, 2);
  }
});

test("isAutomationEventTrigger narrows the union in both directions", () => {
  const triggers: Array<AutomationSchedule | AutomationEventTrigger> = [SCHEDULE_TRIGGER, EVENT_TRIGGER];
  const [schedule, event] = triggers;
  assert.equal(isAutomationEventTrigger(schedule), false);
  assert.equal(isAutomationEventTrigger(event), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";

import { automationConversationPrompt } from "./conversation.js";

function definition(): AutomationDefinition {
  return {
    schema: "automation-definition/v1",
    id: "task",
    name: "查询北京天气",
    prompt: { version: 1, parts: [{ type: "text", text: "查询下北京是否下雨" }] },
    trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "Asia/Shanghai" },
    model: { mode: "auto" },
    skillIds: [],
    connectors: [],
    permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: 1 },
    lifecycle: "enabled",
    executorDeviceId: "device",
    revision: 1,
    nextRunAt: 1_000,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("builds a localized confirmation turn without exposing the timezone suffix", () => {
  const zh = automationConversationPrompt(definition(), "zh");
  assert.equal(zh.userMessage, "查询下北京是否下雨\n\n日程安排：每天 09:00");
  assert.match(zh.systemInstruction, /不是任务的执行时间/);
  assert.match(zh.systemInstruction, /不要调用任何工具/);

  const en = automationConversationPrompt(definition(), "en");
  assert.equal(en.userMessage, "查询下北京是否下雨\n\nSchedule: Daily at 09:00");
  assert.match(en.systemInstruction, /Do not perform the requested work/);
});

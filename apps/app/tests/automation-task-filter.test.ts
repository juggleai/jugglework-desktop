import { describe, expect, test } from "bun:test";
import type { AutomationDefinitionRecord } from "@jugglework/types/automation";
import {
  DEFAULT_AUTOMATION_TASK_STATUS_FILTERS,
  automationTaskStatus,
  matchesAutomationTaskFilter,
} from "../src/react-app/domains/automations/automation-task-filter";

function record(lifecycle: "enabled" | "paused" | "shadow" | "completed", hasUnreadResult = false): AutomationDefinitionRecord {
  return {
    definition: { lifecycle } as AutomationDefinitionRecord["definition"],
    compatibility: "compatible",
    syncState: "pending",
    rawDocument: {},
    hasUnreadResult,
  };
}

describe("automation task filter", () => {
  test("shows every lifecycle under the default three status choices", () => {
    for (const lifecycle of ["enabled", "paused", "shadow", "completed"] as const) {
      expect(matchesAutomationTaskFilter(record(lifecycle), DEFAULT_AUTOMATION_TASK_STATUS_FILTERS, false)).toBe(true);
    }
  });

  test("groups shadow tasks under enabled", () => {
    expect(automationTaskStatus(record("shadow"))).toBe("enabled");
    expect(matchesAutomationTaskFilter(record("shadow"), ["enabled"], false)).toBe(true);
    expect(matchesAutomationTaskFilter(record("paused"), ["enabled"], false)).toBe(false);
  });

  test("applies unread as an additional AND filter", () => {
    expect(matchesAutomationTaskFilter(record("enabled", true), ["enabled"], true)).toBe(true);
    expect(matchesAutomationTaskFilter(record("enabled", false), ["enabled"], true)).toBe(false);
    expect(matchesAutomationTaskFilter(record("paused", true), ["enabled"], true)).toBe(false);
    expect(matchesAutomationTaskFilter(record("enabled", true), [], false)).toBe(false);
  });
});

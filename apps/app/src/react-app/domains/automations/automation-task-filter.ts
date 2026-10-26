import type { AutomationDefinitionRecord } from "@jugglework/types/automation";

export type AutomationTaskStatusFilter = "enabled" | "paused" | "completed";

export const DEFAULT_AUTOMATION_TASK_STATUS_FILTERS: AutomationTaskStatusFilter[] = ["enabled", "paused", "completed"];

export function automationTaskStatus(record: AutomationDefinitionRecord): AutomationTaskStatusFilter {
  if (record.definition.lifecycle === "paused") return "paused";
  if (record.definition.lifecycle === "completed") return "completed";
  // Shadow automations are still active, so the three-state menu groups them under Enabled.
  return "enabled";
}

export function matchesAutomationTaskFilter(
  record: AutomationDefinitionRecord,
  statuses: readonly AutomationTaskStatusFilter[],
  unreadOnly: boolean,
): boolean {
  return statuses.includes(automationTaskStatus(record)) && (!unreadOnly || record.hasUnreadResult);
}

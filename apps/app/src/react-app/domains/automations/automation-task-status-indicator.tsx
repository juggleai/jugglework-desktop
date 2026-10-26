/** @jsxImportSource react */
import type { AutomationDefinitionRecord, AutomationRun } from "@jugglework/types/automation";

import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SessionCircularProgress } from "@/react-app/domains/session/sidebar/session-circular-progress";

/** Keep Automation outcomes visually aligned with the ordinary session list. */
const AUTOMATION_SUCCESS_DOT = "#2FBE54";
const AUTOMATION_FAILURE_DOT = "#E8933A";

export type AutomationTaskVisualStatus = "running" | "succeeded-unread" | "failed-unread" | null;

export function resolveAutomationTaskVisualStatus(
  record: Pick<AutomationDefinitionRecord, "hasUnreadResult" | "latestResultRun">,
  activeRun?: Pick<AutomationRun, "state">,
): AutomationTaskVisualStatus {
  if (activeRun?.state === "queued" || activeRun?.state === "running") return "running";
  if (!record.hasUnreadResult || !record.latestResultRun) return null;
  return record.latestResultRun.state === "failed" ? "failed-unread" : "succeeded-unread";
}

/** Running spinner, unread-success green dot, or unread-failure amber dot for a task row. */
export function AutomationTaskStatusIndicator({
  activeRun,
  className,
  record,
}: {
  activeRun?: AutomationRun;
  className?: string;
  record: Pick<AutomationDefinitionRecord, "hasUnreadResult" | "latestResultRun">;
}) {
  const status = resolveAutomationTaskVisualStatus(record, activeRun);
  if (!status) return null;

  if (status === "running") {
    const label = t(`automation.state_${activeRun?.state === "queued" ? "queued" : "running"}`);
    return (
      <span
        className={cn("flex size-5 shrink-0 items-center justify-center", className)}
        data-automation-task-status="running"
        role="status"
        title={label}
        aria-label={label}
      >
        <SessionCircularProgress className="dark:text-white" />
      </span>
    );
  }

  const failed = status === "failed-unread";
  const label = `${t(`automation.state_${failed ? "failed" : "succeeded"}`)}, ${t("automation.filter_unread")}`;
  return (
    <span
      className={cn("size-2 shrink-0 rounded-full", className)}
      data-automation-task-status={status}
      style={{ backgroundColor: failed ? AUTOMATION_FAILURE_DOT : AUTOMATION_SUCCESS_DOT }}
      title={label}
      aria-label={label}
    />
  );
}

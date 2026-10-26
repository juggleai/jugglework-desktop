import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleCheck, CircleX, Clock3, LoaderCircle } from "lucide-react";
import type { AutomationRun } from "@jugglework/types/automation";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";

export function AutomationRunStateBadge({ run }: { run: AutomationRun }) {
  const active = run.state === "queued" || run.state === "running";
  const Icon = run.state === "succeeded" ? CircleCheck : run.state === "failed" ? CircleX : active ? LoaderCircle : Clock3;
  const label = run.state === "succeeded" ? t("automation.state_completed") : t(`automation.state_${run.state}`);
  return (
    <span
      role="status"
      title={run.errorMessage || label}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        run.state === "succeeded" ? "bg-green-3 text-green-11" : run.state === "failed" ? "bg-red-3 text-red-11" : "bg-dls-hover text-dls-secondary",
      )}
    >
      <Icon className={cn("size-3", active && "animate-spin")} />
      {label}
    </span>
  );
}

/** Use persisted run results so reopening a conversation retains its outcome. */
export function AutomationSessionStatus({ client, workspaceId, sessionId, showBadge = true }: {
  client: JuggleWorkServerClient;
  workspaceId: string;
  sessionId: string;
  showBadge?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["automation-session-run", client.baseUrl, workspaceId, sessionId],
    queryFn: () => client.listAutomationRuns({ workspaceId, sessionId, limit: 1 }),
    refetchInterval: 2_000,
  });
  const run = data?.items.find((item) => item.workspaceId === workspaceId && item.sessionId === sessionId);
  useEffect(() => {
    if (!run || run.state !== "succeeded" && run.state !== "failed") return;
    // The conversation itself is the source of truth for "viewed". This also covers entry
    // paths outside the Automation list (for example a restored or directly opened session).
    void client.markAutomationResultViewed(run.automationId, run.id).catch(() => undefined);
  }, [client, run?.automationId, run?.id, run?.state]);
  return showBadge && run ? <AutomationRunStateBadge run={run} /> : null;
}

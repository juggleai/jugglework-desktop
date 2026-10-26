/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlarmClock, Clock3, Newspaper, Plus, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import type { AutomationDefinitionRecord } from "@jugglework/types/automation";
import type { JuggleWorkServerClient } from "@/app/lib/jugglework-server";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useOptionalJuggleWorkServer } from "@/react-app/domains/connections/jugglework-server-provider";
import { useAutomationActivity } from "./automation-activity-provider";
import { AutomationTaskStatusIndicator } from "./automation-task-status-indicator";

/** Lightweight task list used by the global collapsed-Rail hover preview. */
export function AutomationSidebarPreview() {
  const navigate = useNavigate();
  const { activeRuns } = useAutomationActivity();
  const store = useOptionalJuggleWorkServer();
  const snapshot = store?.getSnapshot() ?? null;
  const client = snapshot?.juggleworkServerReady ? snapshot.juggleworkServerClient : null;
  const [tasks, setTasks] = useState<AutomationDefinitionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchVisible, setSearchVisible] = useState(false);

  const load = useCallback(async (activeClient: JuggleWorkServerClient | null, silent = false) => {
    if (!activeClient) {
      setLoading(false);
      setError("本机服务尚未连接");
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const page = await activeClient.listAutomations({ limit: 50 });
      setTasks(page.items);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(client);
    if (!client) return;
    const interval = window.setInterval(() => { void load(client, true); }, 2_000);
    return () => window.clearInterval(interval);
  }, [client, load]);

  const normalized = query.trim().toLocaleLowerCase();
  const visibleTasks = useMemo(() => tasks.filter(({ definition }) => (
    !normalized || `${definition.name} ${(definition.workspace?.name ?? t("automation.workspace_automatic_short"))}`.toLocaleLowerCase().includes(normalized)
  )), [normalized, tasks]);
  const activeRunByAutomationId = useMemo(
    () => new Map(activeRuns.map((run) => [run.automationId, run])),
    [activeRuns],
  );

  return (
    <aside
      className="flex h-full w-full flex-col overflow-hidden rounded-[18px] border border-dls-border bg-[var(--app-secondary-sidebar-bg)] mac:titlebar-no-drag"
      data-testid="automation-sidebar-preview"
    >
      <div className="flex h-[var(--app-topbar-height)] shrink-0 items-center gap-2 px-4">
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{t("automation.tabs.tasks")}</h1>
        <button
          type="button"
          title={t("automation.search")}
          aria-label={t("automation.search")}
          onClick={() => setSearchVisible((visible) => !visible)}
          className={cn("rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text", searchVisible && "bg-dls-hover text-dls-text")}
        >
          <Search className="size-4" />
        </button>
      </div>
      <div className="space-y-2 px-3 pb-3">
        {searchVisible ? (
          <label className="relative block">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("automation.search")} className="h-9 w-full rounded-xl bg-dls-hover pl-9 pr-3 text-[13px] outline-none" />
          </label>
        ) : null}
        <button type="button" onClick={() => navigate("/automations/new")} className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] font-medium transition-colors hover:bg-dls-hover">
          <Plus className="size-4" />{t("automation.new_task")}
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center px-4 text-[13px] text-dls-secondary">{t("automation.upcoming")}</div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {loading ? <div className="px-2 py-4 text-[13px] text-dls-secondary">{t("automation.loading")}</div> : null}
          {error ? <div className="mx-2 rounded-xl bg-red-3 px-3 py-2 text-xs text-red-11">{error}</div> : null}
          {!loading && !error && visibleTasks.length === 0 ? <p className="px-2 py-2 text-[13px] text-dls-secondary">{query ? t("automation.no_search_results") : t("automation.no_scheduled_tasks")}</p> : null}
          <div className="space-y-1">
            {visibleTasks.map((record) => {
              const { definition } = record;
              return (
              <button
                key={definition.id}
                type="button"
                onClick={() => navigate(`/automations/${encodeURIComponent(definition.id)}`)}
                className="relative flex min-h-[58px] w-full flex-col justify-center overflow-hidden rounded-xl px-2 py-2 pr-9 text-left transition-colors hover:bg-dls-hover/60"
              >
                <span className="truncate text-[13px] font-medium">{definition.name}</span>
                {definition.workspace?.name ? <span className="mt-0.5 truncate text-xs text-dls-secondary">{definition.workspace.name}</span> : null}
                <AutomationTaskStatusIndicator
                  activeRun={activeRunByAutomationId.get(definition.id)}
                  record={record}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                />
              </button>
              );
            })}
          </div>
        </div>
      </div>
      <nav className="shrink-0 space-y-1 border-t border-dls-border p-3" aria-label={t("automation.navigation")}>
        <button type="button" onClick={() => navigate("/automations/runs")} className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] transition-colors hover:bg-dls-hover">
          <Clock3 className="size-4 text-dls-secondary" />{t("automation.tabs.runs")}
        </button>
        <button type="button" onClick={() => navigate("/automations/templates")} className="flex h-9 w-full items-center gap-2 rounded-xl px-2 text-left text-[13px] transition-colors hover:bg-dls-hover">
          <Newspaper className="size-4 text-dls-secondary" />{t("automation.from_template")}
        </button>
      </nav>
    </aside>
  );
}

/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
import type { WorkspacePluginPolicy, WorkspacePluginRow } from "./types";

/** Inventory, not an installation surface. Only explicitly controllable specs expose a switch. */
export function PluginsManagerModal({ open, plugins, policy, error, onClose }: {
  open: boolean;
  plugins: WorkspacePluginRow[];
  policy?: WorkspacePluginPolicy;
  error?: string | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => plugins.filter((plugin) => (
    `${plugin.name} ${plugin.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  )), [plugins, query]);
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) { setQuery(""); onClose(); } }}>
      <DialogContent className="flex h-[85vh] max-h-[85vh] max-w-[1000px] flex-col sm:max-w-[1000px]">
        <DialogHeader>
          <DialogTitle>{t("project_extensions.group_plugin")}</DialogTitle>
          <DialogDescription>{t("project_extensions.plugin_workspace_desc")}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-dls-secondary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={t("project_extensions.search_plugins")}
            className="w-full rounded-lg border border-dls-border bg-dls-surface py-1.5 pl-8 pr-3 text-sm text-dls-text outline-none placeholder:text-dls-secondary"
          />
        </div>
        {error || policy?.error ? <p role="alert" className="text-sm text-destructive">{error || policy?.error}</p> : null}
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {visible.length === 0 ? <p className="py-8 text-center text-sm text-dls-secondary">{t("project_extensions.no_plugins")}</p> : visible.map((plugin) => {
            const controllable = Boolean(policy?.available && plugin.spec && policy.controllablePluginSpecs.includes(plugin.spec));
            const disabled = Boolean(plugin.spec && policy?.disabledPluginSpecs.includes(plugin.spec));
            return (
              <div key={plugin.id} className="flex items-center gap-3 rounded-xl border border-dls-border bg-dls-surface p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-dls-text">{plugin.name}</span>
                    <span className="shrink-0 rounded-full bg-dls-bg px-2 py-0.5 text-[10px] text-dls-secondary">
                      {t(plugin.scope === "global" ? "project_extensions.scope_global" : "project_extensions.scope_workspace")}
                    </span>
                    {disabled ? <span className="text-xs text-dls-secondary">{t("connect.workspace_disabled_here")}</span> : null}
                  </div>
                  {plugin.description ? <p className="mt-1 line-clamp-2 text-xs text-dls-secondary">{plugin.description}</p> : null}
                  {!controllable ? <p className="mt-1 text-xs text-dls-secondary">{t("project_extensions.plugin_policy_unavailable")}</p> : null}
                </div>
                {controllable && plugin.spec ? (
                  <div className="flex shrink-0 items-center gap-2">
                    {policy?.savingSpec === plugin.spec ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    <Switch
                      checked={!disabled}
                      disabled={policy?.savingSpec === plugin.spec}
                      onCheckedChange={(enabled) => void policy?.setPluginEnabled(plugin.spec!, enabled)}
                      aria-label={t("connect.workspace_toggle_label", { name: plugin.name })}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

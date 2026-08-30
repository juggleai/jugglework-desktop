/** @jsxImportSource react */
import * as React from "react";
import { AlertTriangle, CheckCircle2, Cloud, Loader2, MonitorDown } from "lucide-react";

import type { DenExternalMcpConnection, DenOrgPlugin, DenOrgPluginResolved } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { SettingsNotice, SettingsPill } from "@/react-app/domains/settings/settings-section";
import type { MarketplacePackageRow } from "@/react-app/domains/settings/pages/cloud-marketplaces-view";
import type {
  MarketplacePluginActionKind,
  MarketplacePluginComponentAvailability,
  MarketplaceDetailResolutionState,
  MarketplacePluginLifecycle,
} from "@/react-app/domains/settings/pages/marketplace-plugin-state";
import { isMarketplacePluginActionDisabled } from "@/react-app/domains/settings/pages/marketplace-plugin-state";

export type MarketplacePackageDetailModalProps = {
  row: MarketplacePackageRow;
  lifecycle: MarketplacePluginLifecycle;
  resolved: DenOrgPluginResolved | null;
  resolutionState: MarketplaceDetailResolutionState;
  resolveError: string | null;
  orgMcpConnections: DenExternalMcpConnection[];
  orgMcpConnectingId: string | null;
  onClose: () => void;
  onOpenAccount: () => void;
  onConnectOrgMcp?: (connectionId: string) => void;
  onRemovePlugin: (pluginId: string, pluginName: string) => void | Promise<void>;
  onInstallPlugin: (marketplaceId: string, plugin: DenOrgPlugin) => void | Promise<void>;
  onRetryResolve: () => void;
  accessHint: string | null;
  canMutate: boolean;
};

function componentStateLabel(component: MarketplacePluginComponentAvailability) {
  return t(`marketplace.component_state_${component.state}`);
}

function actionLabel(action: MarketplacePluginActionKind) {
  return t(`marketplace.action_${action}`);
}

function lifecycleTone(state: MarketplacePluginLifecycle["state"]) {
  if (state === "current") return "border-green-6 bg-green-2 text-green-11";
  if (state === "failed" || state === "repair_required") return "border-red-6 bg-red-2 text-red-11";
  return "border-amber-6 bg-amber-2 text-amber-11";
}

function componentStateTone(state: MarketplacePluginComponentAvailability["state"]) {
  if (state === "current") return "text-green-11";
  if (state === "failed") return "text-red-11";
  return "text-amber-11";
}

/**
 * 展示市场包的规范生命周期、组件可用性与明确操作。
 * @param props 当前市场包、生命周期与操作回调
 */
export function MarketplacePackageDetailModal(props: MarketplacePackageDetailModalProps) {
  const { row, lifecycle } = props;
  const busy = lifecycle.state === "installing" || lifecycle.state === "removing";
  const cloudBuiltIn = row.plugin.extension?.sourceFormat === "jugglework-builtin";
  const connectionById = new Map(props.orgMcpConnections.map((connection) => [connection.id, connection]));
  const mcpObjectIds = new Set(lifecycle.components.map((component) => component.configObjectId));
  const workspaceComponents = props.resolved?.memberships.flatMap((membership) => {
    const object = membership.configObject;
    if (!object || mcpObjectIds.has(object.id)) return [];
    const importedFile = row.imported?.files.find((file) => file.configObjectId === object.id);
    const state: MarketplacePluginComponentAvailability["state"] = importedFile?.outcome === "failed" || importedFile?.errorMessage
      ? "failed"
      : importedFile?.outcome === "needs_admin_setup"
        ? "needs_admin"
        : importedFile?.outcome === "needs_signin"
          ? "needs_signin"
          : importedFile ? "current" : "not_installed";
    return [{ object, state }];
  }) ?? [];
  const primary = cloudBuiltIn ? null : lifecycle.primaryAction;
  const secondary = cloudBuiltIn ? null : lifecycle.secondaryAction;
  const failedDetails = row.imported?.files.flatMap((file) => file.errorMessage
    ? [`${file.title}: ${file.errorMessage}`]
    : []) ?? [];
  const visibleErrors = [...new Set([
    ...(lifecycle.error ? [lifecycle.error] : []),
    ...failedDetails,
  ])];
  const detailCurrent = props.resolutionState === "current";
  const detailLoading = props.resolutionState === "loading" || props.resolutionState === "refreshing";
  const statusLabel = detailCurrent
    ? t(`marketplace.lifecycle_${lifecycle.state}`)
    : t(`marketplace.detail_state_${props.resolutionState}`);

  const runAction = (kind: MarketplacePluginActionKind) => {
    if (kind === "sign_in") {
      const connectionId = lifecycle.components.find((component) =>
        component.state === "needs_signin" && Boolean(component.connectionId),
      )?.connectionId;
      if (connectionId && props.onConnectOrgMcp) props.onConnectOrgMcp(connectionId);
      else props.onOpenAccount();
      return;
    }
    if (kind === "retry" && lifecycle.failedOperation === "remove") {
      void props.onRemovePlugin(row.plugin.id, row.plugin.name);
      return;
    }
    void props.onInstallPlugin(row.marketplaceId, row.plugin);
  };

  const primaryConnecting = lifecycle.state === "installing";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) props.onClose(); }}>
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-dls-border px-6 pb-5 pt-6 pr-14">
          <div className="flex min-w-0 items-start justify-between gap-4">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-lg">{row.plugin.name}</DialogTitle>
                <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${lifecycleTone(lifecycle.state)}`}>
                  {statusLabel}
                </span>
              </div>
              <DialogDescription>{row.plugin.description || t("marketplace.no_description")}</DialogDescription>
            </div>
            <SettingsPill>{row.marketplaceName}</SettingsPill>
          </div>
          <div className="mt-3 rounded-xl bg-dls-hover px-4 py-3 text-sm text-card-foreground">
            <div className="font-medium">
              {props.resolutionState === "loading"
                ? t("marketplace.detail_loading_summary")
                : props.resolutionState === "refreshing"
                  ? t("marketplace.detail_refreshing_summary")
                  : props.resolutionState === "unknown"
                    ? t("marketplace.detail_unknown_summary")
                    : props.resolutionState === "stale"
                      ? t("marketplace.detail_stale_summary")
                      : t(`marketplace.summary_${lifecycle.state}`)}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {detailCurrent ? t(`marketplace.delivery_${lifecycle.delivery}`) : t("marketplace.delivery_unknown")}
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <ScrollAreaViewport className="h-auto! min-h-0">
            <div className="space-y-5 px-6 py-5">
              <section className="space-y-3">
                <div>
                  <h3 className="text-sm font-semibold text-card-foreground">{t("marketplace.component_availability_title")}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{t("marketplace.component_availability_description")}</p>
                </div>
                {detailLoading && lifecycle.components.length === 0 ? (
                  <SettingsNotice>{t("marketplace.loading_contents")}</SettingsNotice>
                ) : lifecycle.components.length > 0 || workspaceComponents.length > 0 ? (
                  <div className="grid gap-2">
                    {lifecycle.components.map((component) => {
                      const connection = component.connectionId ? connectionById.get(component.connectionId) : null;
                      const connecting = component.connectionId === props.orgMcpConnectingId;
                      return (
                        <div key={`${component.configObjectId}:${component.serverName}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                          <div className="flex min-w-0 items-start gap-3">
                            {component.delivery === "cloud"
                              ? <Cloud className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                              : <MonitorDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                            <div className="min-w-0">
                              <div className="truncate text-sm font-medium text-card-foreground">{component.serverName || row.plugin.name}</div>
                              <div className="truncate text-xs text-muted-foreground">
                                {connection?.name ?? component.url ?? component.command?.join(" ") ?? t("marketplace.component_endpoint_unavailable")}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <SettingsPill>{t(`marketplace.component_delivery_${component.delivery}`)}</SettingsPill>
                            <span className={`text-xs font-semibold ${componentStateTone(component.state)}`}>
                              {componentStateLabel(component)}
                            </span>
                            {component.state === "needs_signin" && component.connectionId && props.onConnectOrgMcp ? (
                              <Button size="xs" variant="outline" disabled={connecting} onClick={() => props.onConnectOrgMcp?.(component.connectionId as string)}>
                                {connecting ? t("mcp.waiting_for_browser") : t("marketplace.action_sign_in")}
                              </Button>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                    {workspaceComponents.map(({ object, state }) => (
                      <div key={object.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                        <div className="flex min-w-0 items-start gap-3">
                          <MonitorDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-card-foreground">{object.title}</div>
                            <div className="truncate text-xs uppercase text-muted-foreground">{object.objectType}</div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <SettingsPill>{t("marketplace.component_delivery_workspace")}</SettingsPill>
                          <span className={`text-xs font-semibold ${componentStateTone(state)}`}>
                            {t(`marketplace.component_state_${state}`)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-sm text-muted-foreground">
                    {t("marketplace.no_runtime_components")}
                  </div>
                )}
              </section>

              {props.accessHint ? <SettingsNotice>{props.accessHint}</SettingsNotice> : null}
              {visibleErrors.length > 0 ? (
                <SettingsNotice tone="error">{visibleErrors.join("\n")}</SettingsNotice>
              ) : null}
              {props.resolutionState === "refreshing" ? (
                <SettingsNotice>{t("marketplace.detail_refreshing_stale")}</SettingsNotice>
              ) : props.resolutionState === "stale" ? (
                <SettingsNotice tone="error">{t("marketplace.detail_stale")}</SettingsNotice>
              ) : props.resolutionState === "unknown" ? (
                <SettingsNotice tone="error">{t("marketplace.detail_unknown")}</SettingsNotice>
              ) : null}
              {props.resolveError ? <SettingsNotice tone="error">{props.resolveError}</SettingsNotice> : null}
              {props.resolutionState !== "current" ? (
                <Button size="sm" variant="outline" disabled={detailLoading} onClick={props.onRetryResolve}>
                  {detailLoading ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                  {t("marketplace.action_retry_details")}
                </Button>
              ) : null}

              <details className="rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                <summary className="cursor-pointer text-sm font-semibold text-card-foreground">
                  {t("marketplace.technical_details_title")}
                </summary>
                <div className="mt-4 space-y-3 text-xs text-muted-foreground">
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div><span className="font-semibold text-card-foreground">{t("marketplace.technical_plugin_id")}</span><div className="mt-1 break-all font-mono">{row.plugin.id}</div></div>
                    <div><span className="font-semibold text-card-foreground">{t("marketplace.technical_published")}</span><div className="mt-1">{row.plugin.updatedAt ?? t("marketplace.technical_unknown")}</div></div>
                    <div><span className="font-semibold text-card-foreground">{t("marketplace.technical_imported")}</span><div className="mt-1">{row.imported?.updatedAt ?? t("marketplace.technical_not_imported")}</div></div>
                  </div>
                  {props.resolved?.memberships.length ? (
                    <div className="border-t border-dls-border pt-3">
                      <div className="font-semibold text-card-foreground">{t("marketplace.extension_contents")}</div>
                      <ul className="mt-2 grid gap-1">
                        {props.resolved.memberships.map((membership) => membership.configObject ? (
                          <li key={membership.id} className="flex items-center justify-between gap-3">
                            <span className="truncate">{membership.configObject.title}</span>
                            <span className="shrink-0 uppercase">{membership.configObject.objectType}</span>
                          </li>
                        ) : null)}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          </ScrollAreaViewport>
        </ScrollArea>

        <DialogFooter className="mx-0! mb-0! shrink-0 items-center justify-between rounded-none bg-dls-surface px-6 py-4">
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            {lifecycle.state === "current" ? <CheckCircle2 className="size-4 text-green-11" /> : <AlertTriangle className="size-4" />}
            {detailCurrent
              ? t(`marketplace.footer_${lifecycle.state}`)
              : t(`marketplace.detail_footer_${props.resolutionState}`)}
          </div>
          {lifecycle.hasLocalLedger && !cloudBuiltIn ? (
            <Button variant="destructive" size="sm" disabled={busy || !props.canMutate || !detailCurrent} onClick={() => void props.onRemovePlugin(row.plugin.id, row.plugin.name)}>
              {lifecycle.state === "removing" ? t("marketplace.lifecycle_removing") : t("marketplace.remove")}
            </Button>
          ) : null}
          {secondary ? (
            <Button variant="outline" size="sm" disabled={busy || !props.canMutate || !detailCurrent} onClick={() => runAction(secondary.kind)}>
              {actionLabel(secondary.kind)}
            </Button>
          ) : null}
          {primary ? (
            <Button
              size="sm"
              disabled={isMarketplacePluginActionDisabled(primary, {
                busy,
                canMutate: props.canMutate,
                resolutionState: props.resolutionState,
              })}
              onClick={() => runAction(primary.kind)}
            >
              {primaryConnecting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
              {primaryConnecting ? t("marketplace.lifecycle_installing") : actionLabel(primary.kind)}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

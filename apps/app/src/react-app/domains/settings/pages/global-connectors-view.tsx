/** @jsxImportSource react */
import { useState } from "react";
import { Plus, Power, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import type { McpServerConfig, McpStatus } from "@/app/types";
import type { McpDirectoryInfo } from "@/app/constants";
import { SettingsNotice } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

/**
 * 全局连接器条目
 * @param name MCP 服务名
 * @param config 全局配置中声明的 MCP 配置
 * @param status 引擎侧的连接状态，未知时为 undefined
 */
export type GlobalConnectorItem = {
  name: string;
  config: McpServerConfig;
  status?: McpStatus;
};

/** 引擎侧连接状态的展示文案，未知状态不渲染。 */
function connectorStatusLabel(status: McpStatus | undefined) {
  switch (status?.status) {
    case "connected":
      return t("mcp.status_connected");
    case "failed":
      return t("mcp.status_failed");
    case "needs_auth":
      return t("mcp.status_needs_auth");
    default:
      return null;
  }
}

export type GlobalConnectorsViewProps = {
  busy: boolean;
  connectors: GlobalConnectorItem[];
  unconnected: McpDirectoryInfo[];
  status?: string | null;
  error?: string | null;
  /** 正在写入的连接器名，用于按条目隔离忙碌状态。 */
  pendingConnectorName?: string | null;
  onAddConnector: (name: string, config: McpServerConfig) => void | Promise<void>;
  onConnectDirectory: (entry: McpDirectoryInfo) => void | Promise<void>;
  onToggleEnabled: (name: string, enabled: boolean) => void | Promise<void>;
  onAuthorize: (connector: GlobalConnectorItem) => void;
  onRemoveConnector: (name: string) => void | Promise<void>;
  onRefresh: () => void;
};

/**
 * 触发一次写入并吞掉拒绝。
 *
 * TIPS: 写入失败的文案由上层写进 `error` 展示，这里必须接住 rejection——
 * 直接 `void somePromise` 在失败时会变成 unhandled rejection。
 */
function runWrite(task: void | Promise<void>) {
  void Promise.resolve(task).catch(() => {});
}

function connectorTarget(config: McpServerConfig) {
  return config.type === "remote" ? config.url ?? "" : (config.command ?? []).join(" ");
}

export function GlobalConnectorsView(props: GlobalConnectorsViewProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<GlobalConnectorItem | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<"remote" | "local">("remote");
  const [draftTarget, setDraftTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const resetDraft = () => {
    setDraftName("");
    setDraftType("remote");
    setDraftTarget("");
    setFormError(null);
  };

  const submitDraft = async () => {
    const name = draftName.trim();
    const target = draftTarget.trim();
    if (!name || !target) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const config: McpServerConfig = draftType === "remote"
        ? { type: "remote", url: target }
        : { type: "local", command: target.split(/\s+/).filter(Boolean) };
      await props.onAddConnector(name, config);
      setAddOpen(false);
      resetDraft();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("mcp.add_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <LayoutStack>
        <LayoutSection>
          <LayoutSectionHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <LayoutSectionTitle>{t("settings.tab_connectors")}</LayoutSectionTitle>
                <LayoutSectionDescription className="mt-1">
                  {t("global_connectors.description")}
                </LayoutSectionDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" disabled={props.busy} onClick={props.onRefresh}>
                  <RefreshCw size={14} className={props.busy ? "animate-spin" : undefined} />
                  {t("common.refresh")}
                </Button>
                <Button disabled={props.busy} onClick={() => { resetDraft(); setAddOpen(true); }}>
                  <Plus size={14} />
                  {t("global_connectors.add")}
                </Button>
              </div>
            </div>
          </LayoutSectionHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                {t("project_extensions.connected_group")}
                <span className="text-dls-secondary">{props.connectors.length}</span>
              </div>
          {props.connectors.length > 0 ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {props.connectors.map((connector) => {
                const enabled = connector.config.enabled !== false;
                const rowPending = props.pendingConnectorName === connector.name;
                return (
                  <LayoutSectionItem
                    key={connector.name}
                    className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-dls-text">{connector.name}</span>
                        <span className="shrink-0 rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {connector.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}
                        </span>
                        <span
                          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            enabled
                              ? "border-green-6 bg-green-2 text-green-11"
                              : "border-gray-6 bg-gray-3 text-gray-11"
                          }`}
                        >
                          {t(enabled ? "mcp.enabled_label" : "mcp.disabled_label")}
                        </span>
                        {enabled && connectorStatusLabel(connector.status) ? (
                          <span className="shrink-0 rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {connectorStatusLabel(connector.status)}
                          </span>
                        ) : null}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {connectorTarget(connector.config)}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {enabled && connector.status?.status === "needs_auth" ? (
                        <Button variant="outline" disabled={props.busy || rowPending} onClick={() => props.onAuthorize(connector)}>
                          {t("mcp.connect")}
                        </Button>
                      ) : null}
                      <Button
                        variant="outline"
                        disabled={props.busy || rowPending}
                        onClick={() => runWrite(props.onToggleEnabled(connector.name, !enabled))}
                      >
                        <Power size={13} />
                        {enabled ? t("mcp.disable_app") : t("mcp.enable_app")}
                      </Button>
                      <Button
                        variant="destructive"
                        disabled={props.busy || rowPending}
                        onClick={() => setRemoveTarget(connector)}
                      >
                        {t("mcp.remove_app")}
                      </Button>
                    </div>
                  </LayoutSectionItem>
                );
              })}
            </div>
          ) : (
            <SettingsNotice>{props.status ?? t("mcp.no_servers_configured")}</SettingsNotice>
          )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                {t("project_extensions.unconnected_group")}
                <span className="text-dls-secondary">{props.unconnected.length}</span>
              </div>
              {props.unconnected.length ? (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {props.unconnected.map((entry) => (
                    <LayoutSectionItem
                      key={entry.serverName ?? entry.id ?? entry.name}
                      className="flex-row items-center justify-between gap-3 rounded-2xl border border-dls-border px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-dls-text">{entry.name}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-dls-secondary">{entry.description}</p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={props.busy || props.pendingConnectorName === (entry.serverName ?? entry.name)}
                        onClick={() => runWrite(props.onConnectDirectory(entry))}
                      >
                        {t("project_extensions.connect")}
                      </Button>
                    </LayoutSectionItem>
                  ))}
                </div>
              ) : <SettingsNotice>{t("project_extensions.no_unconnected")}</SettingsNotice>}
            </div>
          </div>

          {props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
        </LayoutSection>
      </LayoutStack>

      <Dialog open={addOpen} onOpenChange={(open) => { if (!open && !submitting) setAddOpen(false); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("global_connectors.add")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-dls-secondary">{t("global_connectors.add_hint")}</p>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              {t("global_connectors.field_name")}
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.currentTarget.value)}
                placeholder="context7"
                className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 text-sm font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
              />
            </label>
            <div className="grid gap-1.5 text-sm font-medium text-dls-text">
              {t("mcp.connection_type")}
              <div className="flex gap-2">
                <Button
                  variant={draftType === "remote" ? "secondary" : "outline"}
                  onClick={() => setDraftType("remote")}
                >
                  {t("mcp.type_cloud")}
                </Button>
                <Button
                  variant={draftType === "local" ? "secondary" : "outline"}
                  onClick={() => setDraftType("local")}
                >
                  {t("mcp.type_local")}
                </Button>
              </div>
            </div>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              {draftType === "remote"
                ? t("global_connectors.field_url")
                : t("global_connectors.field_command")}
              <input
                value={draftTarget}
                onChange={(event) => setDraftTarget(event.currentTarget.value)}
                placeholder={draftType === "remote" ? "https://example.com/mcp" : "npx -y my-mcp-server"}
                className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
              />
            </label>
            {formError ? <SettingsNotice tone="error">{formError}</SettingsNotice> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={() => setAddOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                disabled={submitting || !draftName.trim() || !draftTarget.trim()}
                onClick={() => void submitDraft()}
              >
                {submitting ? t("common.saving") : t("common.create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmModal
        open={Boolean(removeTarget)}
        title={t("mcp.remove_app")}
        message={t("global_connectors.remove_warning").replace("{name}", removeTarget?.name ?? "")}
        confirmLabel={t("mcp.remove_app")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) runWrite(props.onRemoveConnector(target.name));
        }}
      />
    </>
  );
}

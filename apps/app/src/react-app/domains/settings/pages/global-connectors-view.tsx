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
import { ExtensionMeshAvatar } from "@/react-app/design-system/extension-mesh-avatar";
import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";
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

/**
 * 解析引擎侧连接状态的展示文案，未知状态不渲染。
 * @param status 引擎侧连接状态
 */
export function connectorStatusLabel(status: McpStatus | undefined) {
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

/**
 * 将本地连接器命令格式化为可无损编辑的 JSON 字符串数组。
 * @param command 命令及其参数
 * @returns 格式化后的 JSON
 */
export function formatLocalCommand(command: string[] | undefined) {
  return JSON.stringify(command ?? [], null, 2);
}

/**
 * 解析本地连接器命令草稿，只接受非空字符串数组。
 * @param draft JSON 字符串数组草稿
 * @returns 有效的命令数组；无效时返回 null
 */
export function parseLocalCommand(draft: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(draft);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((argument) => typeof argument === "string")) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function connectorTarget(config: McpServerConfig) {
  return config.type === "remote" ? config.url ?? "" : JSON.stringify(config.command ?? []);
}

/** 全局连接器头像：目录品牌图标 → 服务域名图标 → 名称哈希占位。 */
function GlobalConnectorAvatar(props: { name: string; url?: string; iconSlug?: string; iconSrc?: string }) {
  const iconUrl = resolveExtensionIconUrl({ iconSlug: props.iconSlug, iconSrc: props.iconSrc, serviceUrl: props.url });
  return (
    <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-dls-border bg-dls-bg">
      {iconUrl ? (
        <span className="flex size-6 items-center justify-center rounded-md bg-white">
          <img src={iconUrl} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
        </span>
      ) : <ExtensionMeshAvatar name={props.name} category="mcp" className="size-6 rounded-md" />}
    </span>
  );
}

export function GlobalConnectorsView(props: GlobalConnectorsViewProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [detailTargetName, setDetailTargetName] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<GlobalConnectorItem | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<"remote" | "local">("remote");
  const [draftTarget, setDraftTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const detailTarget = detailTargetName
    ? props.connectors.find((connector) => connector.name === detailTargetName) ?? null
    : null;
  const detailPending = Boolean(detailTargetName && props.pendingConnectorName === detailTargetName);
  const mutationPending = Boolean(props.pendingConnectorName);

  const openEditor = (connector: GlobalConnectorItem) => {
    setDetailTargetName(connector.name);
    setDraftName(connector.name);
    setDraftType(connector.config.type);
    setDraftTarget(connector.config.type === "local"
      ? formatLocalCommand(connector.config.command)
      : connector.config.url ?? "");
    setFormError(null);
  };

  const saveDetail = async () => {
    if (!detailTarget) return;
    const command = detailTarget.config.type === "local" ? parseLocalCommand(draftTarget) : null;
    const target = detailTarget.config.type === "remote" ? draftTarget.trim() : "";
    if (detailTarget.config.type === "local" && !command) {
      setFormError(t("global_connectors.command_invalid"));
      return;
    }
    if (detailTarget.config.type === "remote" && !target) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const config: McpServerConfig = detailTarget.config.type === "remote"
        ? { ...detailTarget.config, type: "remote", url: target }
        : { ...detailTarget.config, type: "local", command: command! };
      await props.onAddConnector(detailTarget.name, config);
      setDetailTargetName(null);
      resetDraft();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("mcp.add_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const resetDraft = () => {
    setDraftName("");
    setDraftType("remote");
    setDraftTarget("");
    setFormError(null);
  };

  const submitDraft = async () => {
    const name = draftName.trim();
    const command = draftType === "local" ? parseLocalCommand(draftTarget) : null;
    const target = draftType === "remote" ? draftTarget.trim() : "";
    if (!name) return;
    if (draftType === "local" && !command) {
      setFormError(t("global_connectors.command_invalid"));
      return;
    }
    if (draftType === "remote" && !target) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const config: McpServerConfig = draftType === "remote"
        ? { type: "remote", url: target }
        : { type: "local", command: command! };
      await props.onAddConnector(name, config);
      if (detailTarget) setDetailTargetName(null);
      else setAddOpen(false);
      resetDraft();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("mcp.add_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const draftTargetValid = draftType === "remote"
    ? Boolean(draftTarget.trim())
    : parseLocalCommand(draftTarget) !== null;
  const commandDraftInvalid = draftType === "local" && Boolean(draftTarget.trim()) && !draftTargetValid;

  return (
    <>
      <LayoutStack>
        <LayoutSection>
          <LayoutSectionHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <LayoutSectionTitle>{t("settings.tab_connectors")}</LayoutSectionTitle>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={props.busy}
                    onClick={props.onRefresh}
                    aria-label={t("common.refresh")}
                    title={t("common.refresh")}
                  >
                    <RefreshCw className={props.busy ? "size-4 animate-spin" : "size-4"} />
                  </Button>
                </div>
                <LayoutSectionDescription className="mt-1">
                  {t("global_connectors.description")}
                </LayoutSectionDescription>
              </div>
              <div className="flex flex-wrap items-center gap-2">
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
                return (
                  <LayoutSectionItem
                    key={connector.name}
                    className="rounded-2xl border border-dls-border p-0 transition-colors hover:bg-dls-hover"
                  >
                    <button type="button" disabled={mutationPending} onClick={() => openEditor(connector)} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left disabled:cursor-wait">
                      <GlobalConnectorAvatar name={connector.name} url={connector.config.url} />
                      <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-dls-text">{connector.name}</span>
                        <span className="shrink-0 rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {connector.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}
                        </span>
                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${enabled && connector.status?.status === "connected" ? "border-green-6 bg-green-2 text-green-11" : "border-gray-6 bg-gray-3 text-gray-11"}`}>
                          {enabled ? connectorStatusLabel(connector.status) ?? t("mcp.enabled_label") : t("mcp.disabled_label")}
                        </span>
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {connectorTarget(connector.config)}
                      </div>
                      </div>
                    </button>
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
                      <GlobalConnectorAvatar name={entry.name} url={entry.url} iconSlug={entry.iconSlug} iconSrc={entry.iconSrc} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-dls-text">{entry.name}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-dls-secondary">{entry.description}</p>
                      </div>
                      <Button
                        variant="outline"
                        disabled={props.busy || mutationPending}
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
              {draftType === "remote" ? (
                <input
                  value={draftTarget}
                  onChange={(event) => setDraftTarget(event.currentTarget.value)}
                  placeholder="https://example.com/mcp"
                  className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20"
                />
              ) : (
                <textarea
                  value={draftTarget}
                  onChange={(event) => { setDraftTarget(event.currentTarget.value); setFormError(null); }}
                  placeholder={'["npx", "-y", "my-mcp-server"]'}
                  rows={5}
                  aria-invalid={commandDraftInvalid}
                  className="resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20 aria-invalid:border-destructive"
                />
              )}
              {draftType === "local" ? <span className="text-xs font-normal text-dls-secondary">{t("global_connectors.command_help")}</span> : null}
            </label>
            {formError || commandDraftInvalid ? <SettingsNotice tone="error">{formError ?? t("global_connectors.command_invalid")}</SettingsNotice> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={() => setAddOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                disabled={submitting || !draftName.trim() || !draftTargetValid}
                onClick={() => void submitDraft()}
              >
                {submitting ? t("common.saving") : t("common.create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(detailTarget)} onOpenChange={(open) => { if (!open && !submitting && !detailPending) setDetailTargetName(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{detailTarget?.name}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-dls-secondary">
              <span>{detailTarget?.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}</span>
              <span>{detailTarget?.config.enabled === false ? t("mcp.disabled_label") : connectorStatusLabel(detailTarget?.status) ?? t("mcp.enabled_label")}</span>
            </div>
            <label className="grid gap-1.5 text-sm font-medium text-dls-text">
              {detailTarget?.config.type === "remote" ? t("global_connectors.field_url") : t("global_connectors.field_command")}
              {detailTarget?.config.type === "remote" ? (
                <input value={draftTarget} onChange={(event) => setDraftTarget(event.currentTarget.value)} className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20" />
              ) : (
                <textarea
                  value={draftTarget}
                  onChange={(event) => { setDraftTarget(event.currentTarget.value); setFormError(null); }}
                  rows={5}
                  aria-invalid={commandDraftInvalid}
                  className="resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20 aria-invalid:border-destructive"
                />
              )}
              {detailTarget?.config.type === "local" ? <span className="text-xs font-normal text-dls-secondary">{t("global_connectors.command_help")}</span> : null}
            </label>
            {formError || commandDraftInvalid ? <SettingsNotice tone="error">{formError ?? t("global_connectors.command_invalid")}</SettingsNotice> : null}
            <div className="flex flex-wrap justify-between gap-2">
              <Button variant="destructive" disabled={props.busy || mutationPending || submitting} onClick={() => { const target = detailTarget; setDetailTargetName(null); if (target) setRemoveTarget(target); }}>
                {t("mcp.remove_app")}
              </Button>
              <div className="flex gap-2">
                {detailTarget?.config.enabled !== false && detailTarget?.status?.status === "needs_auth" ? <Button variant="outline" disabled={mutationPending || submitting} onClick={() => props.onAuthorize(detailTarget)}>{t("mcp.connect")}</Button> : null}
                <Button variant="outline" disabled={props.busy || mutationPending || submitting} onClick={() => detailTarget && runWrite(props.onToggleEnabled(detailTarget.name, detailTarget.config.enabled === false))}>
                  <Power size={13} />
                  {detailTarget?.config.enabled === false ? t("mcp.enable_app") : t("mcp.disable_app")}
                </Button>
                <Button disabled={submitting || mutationPending || !draftTargetValid} onClick={() => void saveDetail()}>{submitting || detailPending ? t("common.saving") : t("common.save")}</Button>
              </div>
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

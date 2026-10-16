/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Plus, Power } from "lucide-react";

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
import { getMcpServerName, type McpDirectoryInfo } from "@/app/constants";
import { SettingsNotice } from "../settings-section";
import type { GlobalMcpEntry } from "../state/global-mcp-config";
import {
  LayoutSection,
  LayoutSectionItem,
  LayoutStack,
} from "../settings-layout";
import { CatalogHeader, type CatalogSource } from "./catalog-source";
import { CatalogDetailPage } from "./catalog-detail-page";
import { matchPublicConnector, resolveConnectorCatalogSource } from "./connector-catalog-source";
import { connectorReadiness } from "@/react-app/domains/connections/connector-readiness";

/**
 * 全局连接器条目
 * @param name MCP 服务名
 * @param config 全局配置中声明的 MCP 配置
 * @param status 引擎侧的连接状态，未知时为 undefined
 */
export type GlobalConnectorItem = GlobalMcpEntry & {
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
  detailPresentation?: "modal" | "page";
  detailRequest?: { id: string; nonce: number };
  source?: CatalogSource;
  onSourceChange?: (source: CatalogSource) => void;
  organizationName?: string | null;
  showOrganization?: boolean;
  publicEntries?: McpDirectoryInfo[];
  organizationContent?: ReactNode | ((search: string, openDetail: (id: string) => void) => ReactNode);
  organizationDetail?: (id: string) => { name: string; content: ReactNode; description?: string } | null;
  busy: boolean;
  connectors: GlobalConnectorItem[];
  unconnected: McpDirectoryInfo[];
  status?: string | null;
  error?: string | null;
  /** 正在写入的连接器名，用于按条目隔离忙碌状态。 */
  pendingConnectorName?: string | null;
  onAddConnector: (name: string, config: McpServerConfig) => void | Promise<void>;
  /** Create custom connectors with Personal provenance; onAddConnector edits existing ones. */
  onCreateConnector?: (name: string, config: McpServerConfig) => void | Promise<void>;
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
  const [detailSelection, setDetailSelection] = useState<{
    kind: "installed" | "directory" | "organization";
    id: string;
    source?: CatalogSource;
  } | null>(null);
  const handledDetailRequest = useRef<GlobalConnectorsViewProps["detailRequest"]>(undefined);
  const detailGeneration = useRef(0);
  useLayoutEffect(() => () => { detailGeneration.current += 1; }, [detailSelection, props.source, props.organizationName]);
  const [removeTarget, setRemoveTarget] = useState<GlobalConnectorItem | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<"remote" | "local">("remote");
  const [draftTarget, setDraftTarget] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const sourceGeneration = useRef(0);
  // Invalidate pending navigation on committed context changes and unmount.
  useLayoutEffect(() => () => { sourceGeneration.current += 1; }, [
    props.source, props.organizationName, props.onCreateConnector ?? props.onAddConnector, props.onConnectDirectory, props.onSourceChange,
  ]);
  const personal = !props.source || props.source === "personal";
  const organization = props.source === "organization";
  const query = search.trim().toLowerCase();
  const publicEntries = props.publicEntries ?? [];
  const connectors = props.connectors.filter((connector) =>
    (props.source !== "personal" || resolveConnectorCatalogSource(connector, publicEntries) === "personal")
    && (props.source !== "public" || (resolveConnectorCatalogSource(connector, publicEntries) === "public"
      && !matchPublicConnector(connector, publicEntries)))
    && [connector.name, connectorTarget(connector.config)].some((text) => text.toLowerCase().includes(query)),
  );
  const directoryEntries = (props.source === "public" ? publicEntries : props.unconnected).filter((entry) => {
    const installed = props.source === "public"
      ? props.connectors.find((connector) => matchPublicConnector(connector, [entry]))
      : undefined;
    return [entry.name, entry.description, getMcpServerName(entry),
      ...(installed ? [installed.name, connectorTarget(installed.config)] : []),
    ].some((text) => text.toLowerCase().includes(query));
  });
  const installedNames = new Set(props.connectors.map((connector) => connector.name));
  useEffect(() => {
    setDetailSelection(null);
    setRemoveTarget(null);
  }, [props.source, props.organizationName]);
  const selection = detailSelection?.source === props.source ? detailSelection : null;
  const detailEntries = props.source === "public" ? publicEntries : props.unconnected;
  const selectedEntry = selection?.kind === "directory"
    ? detailEntries.find((entry) => (entry.id ?? getMcpServerName(entry)) === selection.id)
    : undefined;
  const detailTarget = !organization && selection
    ? props.connectors.find((connector) =>
      (selection.kind === "installed" ? connector.name === selection.id : selectedEntry && matchPublicConnector(connector, [selectedEntry]))
      && (!props.source || resolveConnectorCatalogSource(connector, publicEntries) === props.source)) ?? null
    : null;
  const detailEntry = selectedEntry ?? (detailTarget ? matchPublicConnector(detailTarget, publicEntries) : undefined);
  const organizationDetail = organization && selection?.kind === "organization"
    ? props.organizationDetail?.(selection.id) : null;
  const detailName = organizationDetail?.name ?? detailTarget?.name ?? detailEntry?.name;
  const detailPending = Boolean(detailTarget && props.pendingConnectorName === detailTarget.name);
  const mutationPending = Boolean(props.pendingConnectorName);

  const openEditor = (connector: GlobalConnectorItem) => {
    setDetailSelection({ kind: "installed", id: connector.name, source: props.source });
  };
  const openDetail = (id: string): boolean => {
    if (organization) {
      if (!props.organizationDetail?.(id)) return false;
      setDetailSelection({ kind: "organization", id, source: props.source });
      return true;
    }
    const name = id.startsWith("global-connector:") ? id.slice("global-connector:".length) : id;
    const connector = props.connectors.find((item) => item.name === name
      && (!props.source || resolveConnectorCatalogSource(item, publicEntries) === props.source));
    const entry = !personal || !props.source
      ? detailEntries.find((item) => (item.id ?? getMcpServerName(item)) === id) : undefined;
    // Prefixed installed IDs are unambiguous; raw directory IDs take precedence over raw names.
    if (connector && (id.startsWith("global-connector:") || !entry)) {
      openEditor(connector);
      return true;
    }
    if (!entry) return false;
    const installed = props.connectors.find((item) => matchPublicConnector(item, [entry]));
    if (installed) openEditor(installed);
    else setDetailSelection({ kind: "directory", id, source: props.source });
    return true;
  };
  useEffect(() => {
    const request = props.detailRequest;
    if (!request || props.busy || addOpen
      || (handledDetailRequest.current?.id === request.id && handledDetailRequest.current.nonce === request.nonce)) return;
    // Leave unresolved requests pending while the parent's inventory is loading.
    if (openDetail(request.id)) handledDetailRequest.current = request;
  }, [props.detailRequest, props.source, props.busy, props.connectors, props.publicEntries, props.unconnected, props.organizationDetail, addOpen]);
  useLayoutEffect(() => {
    if (!detailTarget) return;
    setDraftName(detailTarget.name);
    setDraftType(detailTarget.config.type);
    setDraftTarget(detailTarget.config.type === "local"
      ? formatLocalCommand(detailTarget.config.command)
      : detailTarget.config.url ?? "");
    setFormError(null);
    // Inventory/status refreshes must not overwrite an in-progress edit.
  }, [detailSelection, detailTarget?.name, detailTarget?.config.type]);

  const saveDetail = async () => {
    if (organization || !detailTarget || submitting || mutationPending) return;
    const command = detailTarget.config.type === "local" ? parseLocalCommand(draftTarget) : null;
    const target = detailTarget.config.type === "remote" ? draftTarget.trim() : "";
    if (detailTarget.config.type === "local" && !command) {
      setFormError(t("global_connectors.command_invalid"));
      return;
    }
    if (detailTarget.config.type === "remote" && !target) return;
    setSubmitting(true);
    setFormError(null);
    const generation = detailGeneration.current;
    try {
      const config: McpServerConfig = detailTarget.config.type === "remote"
        ? { ...detailTarget.config, type: "remote", url: target }
        : { ...detailTarget.config, type: "local", command: command! };
      await props.onAddConnector(detailTarget.name, config);
      if (generation === detailGeneration.current) {
        setDetailSelection(null);
        resetDraft();
      }
    } catch (error) {
      if (generation === detailGeneration.current) setFormError(error instanceof Error ? error.message : t("mcp.add_failed"));
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
    if (installedNames.has(name)) {
      setFormError(t("customization.connector_name_conflict"));
      return;
    }
    if (draftType === "local" && !command) {
      setFormError(t("global_connectors.command_invalid"));
      return;
    }
    if (draftType === "remote" && !target) return;
    const generation = sourceGeneration.current;
    setSubmitting(true);
    setFormError(null);
    try {
      const config: McpServerConfig = draftType === "remote"
        ? { type: "remote", url: target }
        : { type: "local", command: command! };
      await (props.onCreateConnector ?? props.onAddConnector)(name, config);
      setAddOpen(false);
      resetDraft();
      if (generation === sourceGeneration.current) props.onSourceChange?.("personal");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : t("mcp.add_failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const connectDirectory = async (entry: McpDirectoryInfo) => {
    if (installedNames.has(getMcpServerName(entry)) || props.connectors.some((connector) => matchPublicConnector(connector, [entry]))) return;
    await props.onConnectDirectory(entry);
  };

  const draftTargetValid = draftType === "remote"
    ? Boolean(draftTarget.trim())
    : parseLocalCommand(draftTarget) !== null;
  const commandDraftInvalid = draftType === "local" && Boolean(draftTarget.trim()) && !draftTargetValid;
  const draftNameConflict = installedNames.has(draftName.trim());
  const pageDetail = props.detailPresentation === "page" && Boolean(detailName);
  const detailConflict = Boolean(detailEntry && !detailTarget && installedNames.has(getMcpServerName(detailEntry)));
  const detailActions = detailTarget ? (
    <div className="flex flex-wrap justify-between gap-2">
      <Button variant="destructive" disabled={props.busy || mutationPending || submitting} onClick={() => { setDetailSelection(null); setRemoveTarget(detailTarget); }}>
        {t("mcp.remove_app")}
      </Button>
      <div className="flex flex-wrap gap-2">
        {connectorReadiness(detailTarget.config, detailTarget.status).canAuthorize ? <Button variant="outline" disabled={mutationPending || submitting} onClick={() => props.onAuthorize(detailTarget)}>{t("mcp.connect")}</Button> : null}
        <Button variant="outline" disabled={props.busy || mutationPending || submitting} onClick={() => runWrite(props.onToggleEnabled(detailTarget.name, detailTarget.config.enabled === false))}>
          <Power size={13} />
          {detailTarget.config.enabled === false ? t("mcp.enable_app") : t("mcp.disable_app")}
        </Button>
        <Button disabled={submitting || mutationPending || !draftTargetValid} onClick={() => void saveDetail()}>{submitting || detailPending ? t("common.saving") : t("common.save")}</Button>
      </div>
    </div>
  ) : detailEntry ? (
    <Button disabled={props.busy || mutationPending || detailConflict} onClick={() => runWrite(connectDirectory(detailEntry))}>
      {t("project_extensions.connect")}
    </Button>
  ) : null;
  const detailBody = organizationDetail ? organizationDetail.content : (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 text-xs text-dls-secondary">
        <span>{(detailTarget?.config.type ?? detailEntry?.type ?? "remote") === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}</span>
        {detailTarget ? <span>{t("customization.installed")}{" · "}{connectorReadiness(detailTarget.config, detailTarget.status).label}</span> : null}
      </div>
      {detailTarget ? <>
        {connectorReadiness(detailTarget.config, detailTarget.status).hint ? <SettingsNotice>{connectorReadiness(detailTarget.config, detailTarget.status).hint}</SettingsNotice> : null}
        <label className="grid gap-1.5 text-sm font-medium text-dls-text">
          {detailTarget.config.type === "remote" ? t("global_connectors.field_url") : t("global_connectors.field_command")}
          {detailTarget.config.type === "remote" ? (
            <input value={draftTarget} disabled={submitting || detailPending} onChange={(event) => setDraftTarget(event.currentTarget.value)} className="rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20" />
          ) : (
            <textarea
              value={draftTarget}
              disabled={submitting || detailPending}
              onChange={(event) => { setDraftTarget(event.currentTarget.value); setFormError(null); }}
              rows={5}
              aria-invalid={commandDraftInvalid}
              className="resize-y rounded-lg border border-dls-border bg-dls-surface px-3 py-2 font-mono text-xs font-normal outline-none focus:ring-2 focus:ring-dls-accent/20 aria-invalid:border-destructive"
            />
          )}
          {detailTarget.config.type === "local" ? <span className="text-xs font-normal text-dls-secondary">{t("global_connectors.command_help")}</span> : null}
        </label>
        {formError || commandDraftInvalid ? <SettingsNotice tone="error">{formError ?? t("global_connectors.command_invalid")}</SettingsNotice> : null}
      </> : detailEntry ? (
        <div className="space-y-2">
          {detailEntry.url || detailEntry.command ? <pre className="whitespace-pre-wrap break-all rounded-lg border border-dls-border bg-dls-surface p-3 text-xs">{detailEntry.type === "local" ? formatLocalCommand(detailEntry.command) : detailEntry.url}</pre> : null}
          {detailConflict ? <SettingsNotice tone="error">{t("customization.connector_name_conflict")}</SettingsNotice> : null}
        </div>
      ) : null}
      {!pageDetail ? detailActions : null}
    </div>
  );

  return (
    <>
      {pageDetail ? (
        <CatalogDetailPage
          categoryLabel={t("settings.tab_connectors")}
          name={detailName!}
          description={organizationDetail?.description ?? detailEntry?.description}
          icon={<GlobalConnectorAvatar name={detailName!} url={detailTarget?.config.url ?? detailEntry?.url} iconSlug={detailEntry?.iconSlug} iconSrc={detailEntry?.iconSrc} />}
          actions={detailActions}
          onBack={() => setDetailSelection(null)}
        >
          {detailBody}
          {!organization && props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
        </CatalogDetailPage>
      ) : <LayoutStack>
        <LayoutSection>
          <CatalogHeader
            title={t("settings.tab_connectors")}
            description={t(props.source ? `customization.${props.source}_description` : "global_connectors.description")}
            busy={props.busy}
            onRefresh={props.onRefresh}
            source={props.source}
            onSourceChange={(source) => {
              sourceGeneration.current += 1;
              setDetailSelection(null);
              setRemoveTarget(null);
              props.onSourceChange?.(source);
            }}
            organizationName={props.organizationName}
            showOrganization={props.showOrganization}
            search={{ value: search, onChange: setSearch, placeholder: t("mcp.search_extensions_placeholder") }}
            actions={
              <Button disabled={props.busy} onClick={() => { resetDraft(); setAddOpen(true); }}>
                <Plus size={14} />
                {t("global_connectors.add")}
              </Button>
            }
          />

          {organization ? (
            <div className="min-h-[20rem]">
              {typeof props.organizationContent === "function" ? props.organizationContent(search, openDetail) : props.organizationContent}
            </div>
          ) : (
            <div className="min-h-[20rem] space-y-5">
              {personal || (props.source === "public" && connectors.length > 0) ? (
                <div className="space-y-2">
                  {!props.source ? (
                    <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                      {t("project_extensions.connected_group")}
                      <span className="text-dls-secondary">{props.connectors.length}</span>
                    </div>
                  ) : null}
                  {connectors.length > 0 ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {connectors.map((connector) => {
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
                                  {props.source === "public" ? <span className="text-xs text-dls-secondary">{t("customization.installed")}</span> : null}
                                  <span className="shrink-0 rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                                    {connector.config.type === "remote" ? t("mcp.type_cloud") : t("mcp.type_local")}
                                  </span>
                                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${enabled && connector.status?.status === "connected" ? "border-green-6 bg-green-2 text-green-11" : "border-gray-6 bg-gray-3 text-gray-11"}`}>
                                    {connectorReadiness(connector.config, connector.status).label}
                                  </span>
                                </div>
                                <div className="truncate font-mono text-[11px] text-muted-foreground">
                                  {connectorTarget(connector.config)}
                                </div>
                                <p className="mt-1 text-xs text-dls-secondary">{connectorReadiness(connector.config, connector.status).hint}</p>
                              </div>
                            </button>
                          </LayoutSectionItem>
                        );
                      })}
                    </div>
                  ) : (
                    <SettingsNotice>{query ? t("chat.no_search_results") : props.status ?? t("mcp.no_servers_configured")}</SettingsNotice>
                  )}
                </div>
              ) : null}

              {!props.source || props.source === "public" ? (
                <div className="space-y-2">
                  {!props.source ? (
                    <div className="flex items-center gap-2 text-sm font-medium text-dls-text">
                      {t("project_extensions.unconnected_group")}
                      <span className="text-dls-secondary">{props.unconnected.length}</span>
                    </div>
                  ) : null}
                  {directoryEntries.length ? (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {directoryEntries.map((entry) => {
                        const existing = props.connectors.find((connector) => connector.name === getMcpServerName(entry));
                        const installed = props.connectors.find((connector) => matchPublicConnector(connector, [entry]));
                        const conflict = Boolean(existing && !installed);
                        return (
                          <LayoutSectionItem
                            key={entry.serverName ?? entry.id ?? entry.name}
                            className="flex-row flex-wrap items-center justify-between gap-3 rounded-2xl border border-dls-border p-0 pr-4 transition-colors hover:bg-dls-hover"
                          >
                            <button type="button" onClick={() => installed ? openEditor(installed) : openDetail(entry.id ?? getMcpServerName(entry))} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
                              <GlobalConnectorAvatar name={entry.name} url={entry.url} iconSlug={entry.iconSlug} iconSrc={entry.iconSrc} />
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-dls-text">{entry.name}</p>
                                <p className="mt-1 line-clamp-2 text-xs text-dls-secondary">{entry.description}</p>
                                {conflict ? <p className="mt-1 text-xs text-destructive">{t("customization.connector_name_conflict")}</p> : null}
                                {installed ? <p className="mt-1 text-xs text-dls-secondary">{connectorReadiness(installed.config, installed.status).hint}</p> : null}
                              </div>
                            </button>
                            {installed ? (
                              <>
                                <span className="shrink-0 rounded-full border border-dls-border bg-dls-surface px-2 py-0.5 text-xs text-dls-secondary">
                                  {t("customization.installed")}
                                  {" · "}{connectorReadiness(installed.config, installed.status).label}
                                </span>
                                <Button variant="outline" disabled={props.busy || mutationPending} onClick={() => openEditor(installed)}>
                                  {t("common.edit")}
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="outline"
                                disabled={props.busy || mutationPending || conflict}
                                onClick={() => runWrite(connectDirectory(entry))}
                              >
                                {t("project_extensions.connect")}
                              </Button>
                            )}
                          </LayoutSectionItem>
                        );
                      })}
                    </div>
                  ) : props.source === "public" && connectors.length > 0 ? null : <SettingsNotice>{t(props.source === "public" || query ? "chat.no_search_results" : "project_extensions.no_unconnected")}</SettingsNotice>}
                </div>
              ) : null}
            </div>
          )}

          {!organization && props.error ? <SettingsNotice tone="error">{props.error}</SettingsNotice> : null}
        </LayoutSection>
      </LayoutStack>}

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
                onChange={(event) => { setDraftName(event.currentTarget.value); setFormError(null); }}
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
            {draftNameConflict || formError || commandDraftInvalid ? <SettingsNotice tone="error">{draftNameConflict ? t("customization.connector_name_conflict") : formError ?? t("global_connectors.command_invalid")}</SettingsNotice> : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={submitting} onClick={() => setAddOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button
                disabled={submitting || mutationPending || !draftName.trim() || draftNameConflict || !draftTargetValid}
                onClick={() => void submitDraft()}
              >
                {submitting ? t("common.saving") : t("common.create")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {props.detailPresentation !== "page" ? <Dialog open={Boolean(detailName)} onOpenChange={(open) => { if (!open && !submitting && !detailPending) setDetailSelection(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>{detailName}</DialogTitle></DialogHeader>
          {!detailTarget && detailEntry ? <p className="text-sm text-dls-secondary">{detailEntry.description}</p> : null}
          {detailBody}
        </DialogContent>
      </Dialog> : null}

      <ConfirmModal
        open={!organization && Boolean(removeTarget)}
        title={t("mcp.remove_app")}
        message={t("global_connectors.remove_warning").replace("{name}", removeTarget?.name ?? "")}
        confirmLabel={t("mcp.remove_app")}
        cancelLabel={t("common.cancel")}
        confirmButtonVariant="destructive"
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (!organization && target) runWrite(props.onRemoveConnector(target.name));
        }}
      />
    </>
  );
}

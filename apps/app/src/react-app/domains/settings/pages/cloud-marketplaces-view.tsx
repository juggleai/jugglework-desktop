/** @jsxImportSource react */
import * as React from "react";
import { toast } from "@/components/ui/sonner";

import type { McpDirectoryInfo } from "@/app/constants";
import type { CloudImportedPlugin } from "@/app/cloud/import-state";
import type { PendingCloudPluginChange } from "@/app/cloud/desktop-cloud-sync";
import { evaluateEnablement, type EnablementContext } from "@/app/enablement";
import type {
  DenExternalMcpConnection,
  DenOrgMarketplaceResolved,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginMcpComponent,
} from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { canDisconnectNativeProviderAccount } from "@/react-app/domains/connections/native-provider-connections";
import { ExtensionCard } from "@/react-app/design-system/extension-card";
import { ExtensionDetailModal } from "@/react-app/design-system/extension-detail-modal";
import { resolveMarketplaceDeliveryAction } from "@/react-app/domains/settings/connect-delivery";
import {
  aggregatePluginDelivery,
  resolvePluginMcpComponents,
  type PluginDeliveryComposition,
} from "@/react-app/domains/settings/connect-cloud-readiness";
import {
  isOrgMcpConnectionItem,
  isOrgMcpConnectionReady,
  isToggleControlledExtension,
  orgMcpConnectionActionLabel,
  type ExtensionItem,
} from "@/react-app/domains/settings/extension-items";
import { useCloudSession } from "@/react-app/domains/settings/cloud/cloud-session-provider";
import type { useDenSession } from "@/react-app/domains/settings/cloud/use-den-session";
import {
  RefreshButton,
  SettingsNotice,
  SettingsPill,
  SettingsSection,
  SettingsSectionHeader,
  SettingsSectionHeaderActions,
  SettingsSectionHeaderContent,
  SettingsSectionHeaderDescription,
  SettingsSectionHeaderTitle,
  SettingsStack,
} from "@/react-app/domains/settings/settings-section";
import {
  SettingsListEmptyState,
  SettingsListSearchInput,
} from "@/react-app/domains/settings/settings-list";
import {
  drainPendingMarketplacePlugin,
  openMarketplacePluginEvent,
  type OpenMarketplacePluginDetail,
} from "@/react-app/shell/notifications";

type AsyncResult = { ok: boolean; message: string; warnings?: string[] };
type MarketplacePackageStatus = "available" | "installed" | "update_available";
type MarketplaceStatusFilter = "all" | MarketplacePackageStatus;
type CloudMarketplacesSession = Pick<
  ReturnType<typeof useDenSession>,
  "syncCurrentDenSettings"
>;

type DenSettingsExtensionsStore = {
  cloudOrgMarketplaces: () => DenOrgMarketplaceResolved[];
  cloudOrgMarketplacesStatus: () => string | null;
  importedCloudPlugins: () => Record<string, CloudImportedPlugin>;
  pendingCloudPluginChanges: () => Record<string, PendingCloudPluginChange>;
  refreshCloudOrgMarketplaces: (options?: { force?: boolean }) => Promise<unknown>;
  importCloudOrgPlugin: (
    marketplaceId: string | null,
    plugin: DenOrgPlugin,
  ) => Promise<{ ok: boolean; message: string; warnings: string[] }>;
  removeCloudOrgPlugin: (pluginId: string) => Promise<AsyncResult>;
};

type MarketplacePackageRow = {
  source: "cloud";
  marketplaceId: string;
  marketplaceName: string;
  plugin: DenOrgPlugin;
  imported: CloudImportedPlugin | null;
  item: ExtensionItem | null;
  status: MarketplacePackageStatus;
  counts: string[];
  composition: Array<{ count: number; label: string; type: string }>;
  /** 逐个 MCP server 的承载明细，服务端下发时带连接绑定。 */
  mcpComponents: DenPluginMcpComponent[];
  /** 按最弱环节聚合出的投递构成；无 MCP 组件时为 null。 */
  delivery: PluginDeliveryComposition | null;
  searchableText: string;
};

type BuiltInMarketplaceRow = {
  source: "built-in";
  marketplaceId: "jugglework-builtins";
  marketplaceName: string;
  entry: McpDirectoryInfo;
  status: MarketplacePackageStatus;
  active: boolean;
  searchableText: string;
};

type OrgMcpMarketplaceRow = {
  source: "org-mcp";
  marketplaceId: "org-mcp-connections";
  marketplaceName: string;
  item: ExtensionItem & { orgMcpConnection: DenExternalMcpConnection };
  connection: DenExternalMcpConnection;
  status: MarketplacePackageStatus;
  searchableText: string;
};

type MarketplaceRow = MarketplacePackageRow | BuiltInMarketplaceRow | OrgMcpMarketplaceRow;

export function shouldShowMarketplaceRows(isSignedIn: boolean, activeOrgId: string) {
  return isSignedIn && activeOrgId.trim().length > 0;
}

export function shouldIncludeCloudMarketplacePluginRow(input: { embedded?: boolean }) {
  return input.embedded !== true;
}

export function shouldIncludeOrgMcpConnectionMarketplaceRow(_input: { embedded?: boolean }) {
  return false;
}

/**
 * 市场列表的搜索与筛选判据。
 * @param row 待判定行（只用到 marketplaceId / status / searchableText）
 * @param filters 搜索词与状态、市场筛选
 */
export function matchesMarketplaceFilters(
  row: Pick<MarketplaceRow, "marketplaceId" | "status" | "searchableText">,
  filters: { search: string; statusFilter: MarketplaceStatusFilter; marketplaceFilter: string },
): boolean {
  if (filters.marketplaceFilter !== "all" && row.marketplaceId !== filters.marketplaceFilter) return false;
  if (filters.statusFilter !== "all" && row.status !== filters.statusFilter) return false;
  const query = filters.search.trim().toLowerCase();
  if (!query) return true;
  return row.searchableText.toLowerCase().includes(query);
}

export type CloudMarketplacesViewProps = {
  extensions: DenSettingsExtensionsStore;
  embedded?: boolean;
  onOpenAccount: () => void;
  session: CloudMarketplacesSession;
  builtInEntries?: McpDirectoryInfo[];
  enablementContext?: EnablementContext;
  builtInExtensionsDisabled?: boolean;
  builtInConnectingName?: string | null;
  configSlotForBuiltIn?: (entry: McpDirectoryInfo) => React.ReactNode | null;
  isBuiltInConnected?: (entry: McpDirectoryInfo) => boolean;
  extensionItems?: ExtensionItem[];
  orgMcpConnections?: DenExternalMcpConnection[];
  orgMcpConnectingId?: string | null;
  orgMcpDisconnectingId?: string | null;
  onConnectOrgMcp?: (connectionId: string) => void;
  onDisconnectOrgMcp?: (connectionId: string) => void;
  refreshOrgMcpConnections?: () => Promise<unknown> | void;
  setBuiltInEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
  /** 只保留含技能组件的市场包，供「项目设置 → 技能 → 云端运行」复用同一数据源与详情弹窗。 */
  skillsOnly?: boolean;
  /** 隐藏分区标题/描述/刷新（宿主已有自己的标题栏时使用）。 */
  hideSectionHeader?: boolean;
  /** 由宿主接管搜索词；传入后不再渲染内置搜索框。 */
  searchValue?: string;
  /** 隐藏「筛选」下拉（按市场过滤），状态筛选按钮仍保留。 */
  hideMarketplaceFilter?: boolean;
  /** 卡片按固定行高等高展示。 */
  uniformCardHeight?: boolean;
  /** 卡片使用中性配色，不因已安装而整块变绿。 */
  plainCards?: boolean;
};

/** 市场包是否包含技能组件。 */
function pluginHasSkill(plugin: DenOrgPlugin) {
  return pluginComposition(plugin).some((entry) => entry.type === "skill" && entry.count > 0);
}

function pluginCounts(plugin: DenOrgPlugin) {
  return pluginComposition(plugin).map((entry) => `${entry.count} ${entry.label}${entry.count === 1 ? "" : "s"}`);
}

function pluginComposition(plugin: DenOrgPlugin) {
  const componentEntries = Object.entries(plugin.componentCounts).flatMap(([type, count]) => {
    if (count <= 0) return [];
    const label = type === "mcp" ? "MCP" : type;
    return [{ count, label, type }];
  });
  if (componentEntries.length > 0) return componentEntries;

  const manifestResources = plugin.extension?.manifest?.resources ?? [];
  const counts = manifestResources.reduce((accumulator, resource) => {
    accumulator.set(resource.type, (accumulator.get(resource.type) ?? 0) + 1);
    return accumulator;
  }, new Map<string, number>());
  return [...counts.entries()].map(([type, count]) => ({
    count,
    label: type === "mcp" ? "MCP" : type,
    type,
  }));
}

function isCloudBuiltInPlugin(plugin: DenOrgPlugin) {
  return plugin.extension?.sourceFormat === "jugglework-builtin";
}

function pluginManifestSearchText(plugin: DenOrgPlugin) {
  const manifest = plugin.extension?.manifest;
  if (!manifest) return "";
  return [
    manifest.name,
    manifest.description,
    manifest.setup?.instructions ?? "",
    ...(manifest.resources.map((resource) => `${resource.id} ${resource.label ?? ""} ${resource.description ?? ""}`)),
    ...(manifest.contributions?.map((contribution) => `${contribution.ref ?? ""} ${contribution.label ?? ""}`) ?? []),
  ].join(" ");
}

function pluginStatus(imported: CloudImportedPlugin | null, plugin: DenOrgPlugin): MarketplacePackageStatus {
  if (!imported) return "available";
  const importedObjectCount = new Set(imported.files.map((file) => file.configObjectId)).size;
  if (imported.updatedAt !== plugin.updatedAt || importedObjectCount !== plugin.memberCount) return "update_available";
  return "installed";
}

export function CloudMarketplacesView({
  extensions,
  embedded = false,
  onOpenAccount,
  session,
  builtInEntries = [],
  enablementContext,
  builtInExtensionsDisabled = false,
  builtInConnectingName = null,
  configSlotForBuiltIn,
  isBuiltInConnected,
  extensionItems = [],
  orgMcpConnections = [],
  orgMcpConnectingId = null,
  orgMcpDisconnectingId = null,
  onConnectOrgMcp,
  onDisconnectOrgMcp,
  refreshOrgMcpConnections,
  setBuiltInEnabled,
  skillsOnly = false,
  hideSectionHeader = false,
  searchValue,
  hideMarketplaceFilter = false,
  uniformCardHeight = false,
  plainCards = false,
}: CloudMarketplacesViewProps) {
  const { activeOrganization: activeOrg, authToken, client, isSignedIn, user } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [internalSearch, setInternalSearch] = React.useState("");
  // TIPS: searchValue 受控时由宿主（插件弹窗标题栏）提供搜索词，内置搜索框不再渲染。
  const searchControlled = searchValue !== undefined;
  const search = searchControlled ? searchValue : internalSearch;
  const setSearch = (value: string) => {
    if (!searchControlled) setInternalSearch(value);
  };
  const [statusFilter, setStatusFilter] = React.useState<MarketplaceStatusFilter>("all");
  const [marketplaceFilter, setMarketplaceFilter] = React.useState("all");
  const [detailRow, setDetailRow] = React.useState<MarketplaceRow | null>(null);
  const [resolvedPlugins, setResolvedPlugins] = React.useState<Record<string, DenOrgPluginResolved>>({});
  const [detailLoadingId, setDetailLoadingId] = React.useState<string | null>(null);
  const [detailError, setDetailError] = React.useState<string | null>(null);
  const [highlightPluginName, setHighlightPluginName] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";
  const canShowRows = shouldShowMarketplaceRows(isSignedIn, activeOrgId);
  const includeCloudMarketplaceRows = shouldIncludeCloudMarketplacePluginRow({ embedded });
  const includeOrgMcpRows = shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded });

  // Listen for "open marketplace plugin" requests from notifications.
  React.useEffect(() => {
    const pending = drainPendingMarketplacePlugin();
    if (pending) {
      setSearch(pending);
      setHighlightPluginName(pending);
    }
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<OpenMarketplacePluginDetail>).detail;
      if (detail?.pluginName) {
        setSearch(detail.pluginName);
        setHighlightPluginName(detail.pluginName);
      }
    };
    window.addEventListener(openMarketplacePluginEvent, handler);
    return () => window.removeEventListener(openMarketplacePluginEvent, handler);
  }, []);

  const marketplaces = extensions.cloudOrgMarketplaces();
  const importedPlugins = extensions.importedCloudPlugins();
  const pendingChanges = extensions.pendingCloudPluginChanges();
  const extensionItemsByBuiltInId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.builtInEntry ? [[item.builtInEntry.id ?? item.builtInEntry.serverName ?? item.builtInEntry.name, item] as const] : []),
  ), [extensionItems]);
  const extensionItemsByPluginId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.plugin ? [[item.plugin.id, item] as const] : []),
  ), [extensionItems]);
  const lastRowsRef = React.useRef<MarketplaceRow[]>([]);
  const cloudRows = React.useMemo<MarketplacePackageRow[]>(() => {
    return marketplaces.flatMap((marketplace) => marketplace.plugins.flatMap((plugin) => {
      if (!includeCloudMarketplaceRows) return [];
      if (skillsOnly && !pluginHasSkill(plugin)) return [];
      const imported = importedPlugins[plugin.id] ?? null;
      const composition = pluginComposition(plugin);
      const counts = pluginCounts(plugin);
      // 列表阶段只有插件摘要，没有配置对象 payload，因此这里只用服务端下发的明细；
      // 详情弹窗拿到 resolved 后会再补一次推断。
      const mcpComponents = resolvePluginMcpComponents(plugin);
      const item = extensionItemsByPluginId.get(plugin.id);
      const status: MarketplacePackageStatus = imported && pendingChanges[plugin.id] === "modified" && !isCloudBuiltInPlugin(plugin)
        ? "update_available"
        : item?.installState ?? (isCloudBuiltInPlugin(plugin) ? "installed" : pluginStatus(imported, plugin));
      return [{
        source: "cloud",
        marketplaceId: marketplace.marketplace.id,
        marketplaceName: marketplace.marketplace.name,
        plugin,
        imported,
        item: item ?? null,
        status,
        counts,
        composition,
        mcpComponents,
        delivery: aggregatePluginDelivery(mcpComponents),
        searchableText: [
          plugin.name,
          plugin.description ?? "",
          marketplace.marketplace.name,
          pluginManifestSearchText(plugin),
          ...counts,
          ...(imported?.files.map((file) => `${file.title} ${file.objectType} ${file.path}`) ?? []),
        ].join(" ").toLowerCase(),
      }];
    }));
  }, [extensionItemsByPluginId, importedPlugins, includeCloudMarketplaceRows, marketplaces, pendingChanges, skillsOnly]);

  const builtInRows = React.useMemo<BuiltInMarketplaceRow[]>(() => {
    return builtInEntries.map((entry) => {
      const item = extensionItemsByBuiltInId.get(entry.id ?? entry.serverName ?? entry.name);
      const enablement = entry.extensionManifest?.enablement && enablementContext
        ? evaluateEnablement(entry.extensionManifest.enablement, enablementContext)
        : null;
      const active = item?.active ?? enablement?.active ?? isBuiltInConnected?.(entry) ?? false;
      return {
        source: "built-in",
        marketplaceId: "jugglework-builtins",
        marketplaceName: "JuggleWork Built-ins",
        entry,
        active,
        status: item?.installState ?? (active ? "installed" : "available"),
        searchableText: [
          entry.name,
          entry.description,
          entry.extensionManifest?.setup?.instructions ?? "",
          ...(entry.extensionManifest?.resources.map((resource) => `${resource.id} ${resource.label ?? ""}`) ?? []),
        ].join(" ").toLowerCase(),
      };
    });
  }, [builtInEntries, enablementContext, extensionItemsByBuiltInId, isBuiltInConnected]);

  const orgMcpRows = React.useMemo<OrgMcpMarketplaceRow[]>(() => {
    if (!includeOrgMcpRows) return [];
    return extensionItems.flatMap((item) => {
      if (!isOrgMcpConnectionItem(item) || item.installState !== "available") return [];
      const connection = item.orgMcpConnection;
      return [{
        source: "org-mcp",
        marketplaceId: "org-mcp-connections",
        marketplaceName: "Organization MCP Connections",
        item,
        connection,
        status: item.installState,
        searchableText: [
          item.name,
          item.description ?? "",
          connection.url,
          connection.credentialMode,
          "shared by your organization mcp connect account",
        ].join(" ").toLowerCase(),
      }];
    });
  }, [extensionItems, includeOrgMcpRows]);

  // TIPS: skillsOnly 只保留云端市场包这一路来源，内置项与组织 MCP 连接不属于「技能」。
  const rows = React.useMemo<MarketplaceRow[]>(
    () => canShowRows ? (skillsOnly ? [...cloudRows] : [...builtInRows, ...cloudRows, ...orgMcpRows]) : [],
    [builtInRows, canShowRows, cloudRows, orgMcpRows, skillsOnly],
  );

  React.useEffect(() => {
    if (detailRow?.source !== "org-mcp") return;
    const current = orgMcpRows.find((row) => row.connection.id === detailRow.connection.id);
    if (!current) {
      setDetailRow(null);
      return;
    }
    if (current.item !== detailRow.item) setDetailRow(current);
  }, [detailRow, orgMcpRows]);

  React.useEffect(() => {
    if (rows.length > 0) lastRowsRef.current = rows;
  }, [rows]);

  const displayRows = rows.length > 0 ? rows : busy ? lastRowsRef.current : rows;

  const marketplaceOptions = React.useMemo(
    () => canShowRows ? [
      ...(builtInRows.length > 0 ? [{ id: "jugglework-builtins", name: t("marketplace.builtins_name") }] : []),
      ...(includeCloudMarketplaceRows ? marketplaces.map((marketplace) => ({ id: marketplace.marketplace.id, name: marketplace.marketplace.name })) : []),
      ...(orgMcpRows.length > 0 ? [{ id: "org-mcp-connections", name: t("marketplace.org_mcp_connections") }] : []),
    ] : [],
    [builtInRows.length, canShowRows, includeCloudMarketplaceRows, marketplaces, orgMcpRows.length],
  );

  const visibleRows = React.useMemo(
    () => displayRows.filter((row) => matchesMarketplaceFilters(row, { search, statusFilter, marketplaceFilter })),
    [displayRows, marketplaceFilter, search, statusFilter],
  );

  const refresh = React.useCallback(
    async (quiet = false) => {
      if (!authToken.trim() || !activeOrgId) return;

      setBusy(true);
      if (!quiet) setActionError(null);

      try {
        session.syncCurrentDenSettings();
        await extensions.refreshCloudOrgMarketplaces({ force: true });
        await refreshOrgMcpConnections?.();
        if (!quiet) {
          const count = extensions.cloudOrgMarketplaces().reduce((total, marketplace) => total + marketplace.plugins.length, 0);
          toast.info(
            count > 0
              ? `Loaded ${count} marketplace extension${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No marketplace extensions are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
          );
        }
      } catch (error) {
        if (!quiet) {
          setActionError(error instanceof Error ? error.message : "Failed to load marketplace extensions.");
        }
      } finally {
        setBusy(false);
      }
    },
    [
      extensions,
      activeOrg,
      activeOrgId,
      authToken,
      session.syncCurrentDenSettings,
      refreshOrgMcpConnections,
    ],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refresh(true);
  }, [activeOrgId, refresh, user]);

  React.useEffect(() => {
    if (!detailRow || detailRow.source !== "cloud" || !isSignedIn || !activeOrgId) return;
    if (resolvedPlugins[detailRow.plugin.id]) return;

    let cancelled = false;
    setDetailLoadingId(detailRow.plugin.id);
    setDetailError(null);
    void client.getOrgPluginResolved(activeOrgId, detailRow.plugin)
      .then((resolved) => {
        if (cancelled) return;
        setResolvedPlugins((current) => ({ ...current, [detailRow.plugin.id]: resolved }));
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailError(error instanceof Error ? error.message : "Failed to load extension composition.");
      })
      .finally(() => {
        if (!cancelled) setDetailLoadingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeOrgId, client, detailRow, isSignedIn, resolvedPlugins]);

  const removePlugin = React.useCallback(
    async (pluginId: string, pluginName: string) => {
      if (actionId) return;

      setActionId(pluginId);
      setActionError(null);

      try {
        const result = await extensions.removeCloudOrgPlugin(pluginId);
        if (!result.ok) throw new Error(result.message);
        toast.success(result.message);
        setDetailRow(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to remove ${pluginName}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const installPlugin = React.useCallback(
    async (marketplaceId: string, plugin: DenOrgPlugin) => {
      if (actionId) return;
      setActionId(plugin.id);
      setActionError(null);
      try {
        const result = await extensions.importCloudOrgPlugin(marketplaceId, plugin);
        if (!result.ok) throw new Error(result.message);
        toast.success(result.message);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to install ${plugin.name}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const removedUpstreamPlugins = React.useMemo(
    () => Object.values(importedPlugins).filter((plugin) => pendingChanges[plugin.pluginId] === "removed"),
    [importedPlugins, pendingChanges],
  );

  const content = (
    <SettingsSection>
      {!hideSectionHeader ? (
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>{t("extensions.marketplace_title")}</SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              {t("extensions.marketplace_description")}
            </SettingsSectionHeaderDescription>
          </SettingsSectionHeaderContent>
          <SettingsSectionHeaderActions>
            <RefreshButton
              busy={busy}
              disabled={busy || !canShowRows}
              onRefresh={refresh}
            >
              {t("den.refresh")}
            </RefreshButton>
          </SettingsSectionHeaderActions>
        </SettingsSectionHeader>
      ) : null}

      {!isSignedIn ? (
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("marketplace.signin_hint")}</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("skills.share_team_sign_in")}
            </Button>
          </div>
        </SettingsNotice>
      ) : null}

      {actionError ?? extensions.cloudOrgMarketplacesStatus() ? (
        <SettingsNotice tone="error">{actionError ?? extensions.cloudOrgMarketplacesStatus()}</SettingsNotice>
      ) : null}

      {busy ? (
        <SettingsNotice>{t("marketplace.loading_extensions")}</SettingsNotice>
      ) : null}

      {removedUpstreamPlugins.map((plugin) => (
        <SettingsNotice key={plugin.pluginId}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("extensions.removed_upstream_notice", { name: plugin.name })}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={Boolean(actionId)}
              onClick={() => void removePlugin(plugin.pluginId, plugin.name)}
            >
              {actionId === plugin.pluginId ? t("marketplace.working") : t("extensions.remove_from_workspace_button")}
            </Button>
          </div>
        </SettingsNotice>
      ))}

      <div className="space-y-3">
        {!searchControlled ? (
          <SettingsListSearchInput
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            placeholder={t("marketplace.search_placeholder")}
          />
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {(["all", "available", "installed", "update_available"] as const).map((filter) => (
            <Button
              key={filter}
              variant={statusFilter === filter ? "secondary" : "outline"}
              size="xs"
              onClick={() => setStatusFilter(filter)}
            >
              {filter === "all"
                ? t("marketplace.filter_all")
                : filter === "update_available"
                  ? t("marketplace.filter_updates")
                  : filter === "installed"
                    ? t("marketplace.filter_installed")
                    : t("marketplace.filter_available")}
            </Button>
          ))}
          <details className={hideMarketplaceFilter ? "hidden" : "group relative"}>
            <summary className="flex h-7 cursor-pointer list-none items-center rounded-md border border-dls-border px-2.5 text-xs font-medium text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text">
              {t("marketplace.filters")}
            </summary>
            <div className="absolute right-0 z-20 mt-2 w-72 rounded-xl border border-dls-border bg-dls-surface p-3 shadow-[var(--dls-shell-shadow)]">
              <label className="grid gap-1.5 text-xs text-dls-secondary">
                {t("marketplace.marketplace_label")}
                <select
                  className="rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-xs text-dls-text"
                  value={marketplaceFilter}
                  onChange={(event) => setMarketplaceFilter(event.currentTarget.value)}
                >
                  <option value="all">{t("marketplace.all_marketplaces")}</option>
                  {marketplaceOptions.map((marketplace) => (
                    <option key={marketplace.id} value={marketplace.id}>{marketplace.name}</option>
                  ))}
                </select>
              </label>
            </div>
          </details>
        </div>
      </div>

      {!busy && displayRows.length === 0 ? (
        <SettingsListEmptyState>
          {!isSignedIn
            ? t("marketplace.empty_signin")
            : activeOrgId
              ? t("marketplace.empty_no_extensions")
              : t("marketplace.empty_choose_org")}
        </SettingsListEmptyState>
      ) : null}

      {displayRows.length > 0 && visibleRows.length === 0 ? (
        <SettingsListEmptyState>{t("marketplace.no_match")}</SettingsListEmptyState>
      ) : null}

      {visibleRows.length > 0 ? (
        <div
          className={`grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3${
            // TIPS: 等高模式下固定行高并让卡片撑满，避免描述长短导致条目高低不一。
            uniformCardHeight ? " auto-rows-[7rem] [&>div]:h-full [&>div>button]:h-full [&>div>button]:overflow-hidden" : ""
          }`}
        >
          {visibleRows.map((row) => {
            const pluginName = row.source === "cloud" ? row.plugin.name : row.source === "built-in" ? row.entry.name : row.item.name;
            const isHighlighted = highlightPluginName != null && pluginName === highlightPluginName;
            return (
              <MarketplaceCard
                key={row.source === "cloud" ? `${row.marketplaceId}:${row.plugin.id}` : row.source === "built-in" ? `${row.marketplaceId}:${row.entry.id ?? row.entry.name}` : row.item.id}
                actionId={actionId}
                row={row}
                onOpenDetail={setDetailRow}
                orgMcpConnectingId={orgMcpConnectingId}
                orgMcpDisconnectingId={orgMcpDisconnectingId}
                onDisconnectOrgMcp={onDisconnectOrgMcp}
                builtInDisabled={builtInExtensionsDisabled}
                builtInConnectingName={builtInConnectingName}
                highlighted={isHighlighted}
                plain={plainCards}
              />
            );
          })}
        </div>
      ) : null}

      {detailRow?.source === "cloud" ? (
        <MarketplacePackageDetailModal
          actionId={actionId}
          row={detailRow}
          resolved={resolvedPlugins[detailRow.plugin.id] ?? null}
          resolving={detailLoadingId === detailRow.plugin.id}
          resolveError={detailError}
          orgMcpConnections={orgMcpConnections}
          orgMcpConnectingId={orgMcpConnectingId}
          onClose={() => setDetailRow(null)}
          onConnectOrgMcp={onConnectOrgMcp}
          onRemovePlugin={removePlugin}
          onInstallPlugin={installPlugin}
        />
      ) : detailRow?.source === "built-in" ? (
        <BuiltInMarketplaceDetailModal
          row={detailRow}
          disabled={builtInExtensionsDisabled}
          connecting={builtInConnectingName === detailRow.entry.name}
          configSlot={configSlotForBuiltIn?.(detailRow.entry) ?? null}
          onSetEnabled={setBuiltInEnabled}
          onClose={() => setDetailRow(null)}
        />
      ) : detailRow?.source === "org-mcp" ? (
        <OrgMcpConnectionDetailModal
          row={detailRow}
          connecting={orgMcpConnectingId === detailRow.connection.id}
          disconnecting={orgMcpDisconnectingId === detailRow.connection.id}
          onClose={() => setDetailRow(null)}
          onConnect={onConnectOrgMcp}
          onDisconnect={onDisconnectOrgMcp}
        />
      ) : null}
    </SettingsSection>
  );

  // hideSectionHeader 时宿主（技能弹窗）自带标题与边距，不再套设置页的分隔线容器。
  return embedded || hideSectionHeader ? content : (
    <SettingsStack>
      <Separator />
      {content}
    </SettingsStack>
  );
}

function marketplaceDeliveryLabel(action: ReturnType<typeof resolveMarketplaceDeliveryAction>) {
  switch (action) {
    case "cloud_active_local_copy":
      return t("connect.marketplace_local_copy_badge");
    case "desktop_install_required":
      return t("marketplace.delivery_desktop_required");
    case "mixed_partial_desktop":
      return t("marketplace.delivery_partial_desktop");
    default:
      return t("extensions.marketplace_active_cloud_label");
  }
}

/** 组成明细：`3 MCP · 1 云端 · 2 需本地`，只在含 MCP 组件时展示。 */
function deliveryCompositionSummary(delivery: PluginDeliveryComposition | null) {
  if (!delivery) return null;
  return t("marketplace.delivery_composition", {
    total: delivery.total,
    cloud: delivery.cloudCount,
    desktop: delivery.desktopCount,
  });
}

/** 组件行的承载位置文案。 */
function componentDeliveryLabel(component: DenPluginMcpComponent) {
  return component.delivery === "cloud"
    ? t("marketplace.delivery_component_cloud")
    : t("marketplace.delivery_component_desktop");
}

function MarketplaceCard(props: {
  actionId: string | null;
  row: MarketplaceRow;
  onOpenDetail: (row: MarketplaceRow) => void;
  orgMcpConnectingId: string | null;
  orgMcpDisconnectingId: string | null;
  onDisconnectOrgMcp?: (connectionId: string) => void;
  builtInDisabled: boolean;
  builtInConnectingName: string | null;
  highlighted?: boolean;
  plain?: boolean;
}) {
  const { actionId, row, onOpenDetail } = props;
  const highlightRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (props.highlighted && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [props.highlighted]);

  const highlightClass = props.highlighted
    ? "ring-2 ring-primary ring-offset-2 ring-offset-dls-background rounded-2xl transition-shadow"
    : "";

  if (row.source === "built-in") {
    const actionBusy = props.builtInConnectingName === row.entry.name;
    const entryUrl = typeof row.entry.url === "string" ? row.entry.url : undefined;
    return (
      <div ref={highlightRef} className={highlightClass}>
        <ExtensionCard
          name={row.entry.name}
          description={row.entry.description}
          iconSlug={row.entry.iconSlug}
          iconSrc={row.entry.iconSrc}
          url={entryUrl}
          kind={row.entry.kind ?? "extension"}
          preview={row.entry.preview}
          connected={row.active}
          connectedLabel={row.entry.defaultEnabled ? "Ready" : "Active"}
          connecting={actionBusy}
          disabled={props.builtInDisabled}
          disabledReason={props.builtInDisabled ? "Disabled by organization" : null}
          actionLabel={row.active ? "Manage" : "View setup"}
          plain={props.plain}
          onClick={() => onOpenDetail(row)}
        />
      </div>
    );
  }

  if (row.source === "org-mcp") {
    const actionBusy = props.orgMcpConnectingId === row.connection.id;
    const disconnecting = props.orgMcpDisconnectingId === row.connection.id;
    const canDisconnect = canDisconnectNativeProviderAccount(row.connection);
    const ready = isOrgMcpConnectionReady(row.connection);
    return (
      <div ref={highlightRef} className={`space-y-2 ${highlightClass}`}>
        <ExtensionCard
          name={row.item.name}
          description={row.item.description ?? "Available from your organization."}
          kind="mcp"
          url={row.connection.url}
          connected={ready}
          connectedLabel={orgMcpConnectionActionLabel(row.connection)}
          beta
          connecting={actionBusy}
          actionLabel={actionBusy ? t("mcp.waiting_for_browser") : disconnecting ? t("mcp.org_connection_disconnecting_action") : ready ? t("mcp.view_details") : orgMcpConnectionActionLabel(row.connection)}
          plain={props.plain}
          onClick={() => onOpenDetail(row)}
        />
        {canDisconnect ? (
          <Button
            size="sm"
            variant="destructive"
            className="w-full"
            disabled={disconnecting}
            onClick={() => props.onDisconnectOrgMcp?.(row.connection.id)}
          >
            {disconnecting ? t("mcp.org_connection_disconnecting_action") : t("mcp.org_connection_disconnect_action")}
          </Button>
        ) : null}
      </div>
    );
  }

  const actionBusy = actionId === row.plugin.id;
  const manifest = row.plugin.extension?.manifest;
  const cloudBuiltIn = isCloudBuiltInPlugin(row.plugin);
  const deliveryAction = resolveMarketplaceDeliveryAction({
    importedLocally: Boolean(row.imported),
    composition: row.delivery,
  });
  const deliveryLabel = marketplaceDeliveryLabel(deliveryAction);
  // TIPS: 含 desktop 组件的插件在装到工作区之前用不了，卡片不能呈现为「已就绪」。
  const cloudReady = deliveryAction === "cloud_active" || deliveryAction === "cloud_active_local_copy";
  const compositionSummary = deliveryCompositionSummary(row.delivery);

  return (
    <div ref={highlightRef} className={`flex flex-col gap-2 ${highlightClass}`}>
      <ExtensionCard
        name={row.plugin.name}
        description={row.plugin.description || `Marketplace extension from ${row.marketplaceName}.`}
        iconSlug={manifest?.icon?.simpleIconSlug}
        iconSrc={manifest?.icon?.src}
        kind="extension"
        connected={cloudBuiltIn || cloudReady}
        connectedLabel={cloudBuiltIn ? t("marketplace.built_in") : deliveryLabel}
        connecting={actionBusy}
        actionLabel={cloudBuiltIn
          ? t("mcp.view_details")
          : compositionSummary ?? (deliveryAction === "cloud_active_local_copy"
            ? t("connect.marketplace_local_copy_badge")
            : t("extensions.marketplace_runs_in_cloud"))}
        plain={props.plain}
        onClick={() => onOpenDetail(row)}
      />
    </div>
  );
}

function BuiltInMarketplaceDetailModal(props: {
  row: BuiltInMarketplaceRow;
  disabled: boolean;
  connecting: boolean;
  configSlot: React.ReactNode | null;
  onSetEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
  onClose: () => void;
}) {
  const { row, disabled, connecting, configSlot, onClose, onSetEnabled } = props;
  const entry = row.entry;
  const toggleControlled = isToggleControlledExtension(entry);
  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={entry.name}
      description={entry.description}
      iconSlug={entry.iconSlug}
      iconSrc={entry.iconSrc}
      url={typeof entry.url === "string" ? entry.url : undefined}
      kind={entry.kind ?? "extension"}
      connected={row.active}
      connectedLabel={entry.defaultEnabled ? "Ready" : "Active"}
      disconnectedLabel="Needs setup"
      connecting={connecting}
      preview={entry.preview}
      disabledReason={disabled ? "Disabled by organization" : null}
      setupInstructions={entry.extensionManifest?.setup?.instructions}
      resourceLabels={entry.extensionManifest?.resources.map((resource) => resource.label ?? resource.id) ?? []}
      contributionLabels={entry.extensionManifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? []}
      configSlot={configSlot}
      showEnablementCard={false}
      connectLabel="Enable"
      connectingLabel="Enabling..."
      uninstallLabel="Disable"
      onConnect={!disabled && toggleControlled && !row.active && onSetEnabled ? () => onSetEnabled(entry, true) : undefined}
      onUninstall={!disabled && toggleControlled && row.active && onSetEnabled ? () => onSetEnabled(entry, false) : undefined}
    />
  );
}

function OrgMcpConnectionDetailModal(props: {
  row: OrgMcpMarketplaceRow;
  connecting: boolean;
  disconnecting: boolean;
  onClose: () => void;
  onConnect?: (connectionId: string) => void;
  onDisconnect?: (connectionId: string) => void;
}) {
  const { row, connecting, onClose, onConnect, onDisconnect } = props;
  const ready = isOrgMcpConnectionReady(row.connection);
  const canDisconnect = canDisconnectNativeProviderAccount(row.connection);
  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={row.item.name}
      description={row.item.description ?? "Available from your organization."}
      kind="mcp"
      connected={ready}
      connectedLabel={orgMcpConnectionActionLabel(row.connection)}
      beta
      connecting={connecting || props.disconnecting}
      connectLabel={orgMcpConnectionActionLabel(row.connection)}
      connectingLabel={t("mcp.waiting_for_browser")}
      uninstallLabel={t("mcp.org_connection_disconnect_action")}
      url={row.connection.url}
      oauth={row.connection.authType === "oauth"}
      showEnablementCard={false}
      onConnect={!ready && onConnect ? () => onConnect(row.connection.id) : undefined}
      onUninstall={canDisconnect && onDisconnect ? () => onDisconnect(row.connection.id) : undefined}
      configSlot={(
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <SettingsPill>{t("marketplace.shared_by_org")}</SettingsPill>
            <SettingsPill>{row.connection.credentialMode === "shared" ? "Org account" : "Your account"}</SettingsPill>
            <SettingsPill>MCP</SettingsPill>
          </div>
          <SettingsNotice>
            {t("marketplace.org_signin_note")}
          </SettingsNotice>
        </div>
      )}
    />
  );
}

function MarketplacePackageDetailModal(props: {
  actionId: string | null;
  row: MarketplacePackageRow;
  resolved: DenOrgPluginResolved | null;
  resolving: boolean;
  resolveError: string | null;
  orgMcpConnections: DenExternalMcpConnection[];
  orgMcpConnectingId: string | null;
  onClose: () => void;
  onConnectOrgMcp?: (connectionId: string) => void;
  onRemovePlugin: (pluginId: string, pluginName: string) => void | Promise<void>;
  onInstallPlugin: (marketplaceId: string, plugin: DenOrgPlugin) => void | Promise<void>;
}) {
  const {
    actionId,
    row,
    resolved,
    resolving,
    resolveError,
    orgMcpConnections,
    orgMcpConnectingId,
    onClose,
    onConnectOrgMcp,
    onRemovePlugin,
    onInstallPlugin,
  } = props;
  const actionBusy = actionId === row.plugin.id;
  const cloudBuiltIn = isCloudBuiltInPlugin(row.plugin);
  const manifest = row.plugin.extension?.manifest;
  // 详情里已经拿到 resolved，缺 components 的旧服务端在这里也能推断出承载方式。
  const mcpComponents = resolvePluginMcpComponents(row.plugin, resolved);
  const delivery = aggregatePluginDelivery(mcpComponents);
  const deliveryAction = resolveMarketplaceDeliveryAction({
    importedLocally: Boolean(row.imported),
    composition: delivery,
  });
  const deliveryLabel = marketplaceDeliveryLabel(deliveryAction);
  // 已落盘的组件按 configObjectId 记账，用于逐行判断"这个组件装了没有"。
  const installedConfigObjectIds = new Set(row.imported?.files.map((file) => file.configObjectId) ?? []);
  const importedExternalConnectionIds = row.imported?.files.flatMap((file) => file.externalMcpConnectionId ? [file.externalMcpConnectionId] : []) ?? [];
  const importedConnections = [...new Set(importedExternalConnectionIds)].flatMap((connectionId) => {
    const connection = orgMcpConnections.find((entry) => entry.id === connectionId);
    return connection ? [connection] : [];
  });
  const missingImportedConnectionCount = new Set(importedExternalConnectionIds).size - importedConnections.length;

  return (
    <ExtensionDetailModal
      open
      onClose={onClose}
      name={row.plugin.name}
      description={row.plugin.description || t("marketplace.no_description")}
      iconSlug={manifest?.icon?.simpleIconSlug}
      iconSrc={manifest?.icon?.src}
      kind="extension"
      connected
      connectedLabel={cloudBuiltIn ? t("marketplace.built_in") : deliveryLabel}
      connecting={actionBusy}
      connectLabel={deliveryAction === "cloud_active_local_copy" ? t("connect.marketplace_local_copy_badge") : t("extensions.marketplace_runs_in_cloud")}
      connectingLabel={t("marketplace.working")}
      uninstallLabel={t("marketplace.remove")}
      showEnablementCard={false}
      setupInstructions={manifest?.setup?.instructions}
      resourceLabels={manifest?.resources.map((resource) => resource.label ?? resource.id) ?? []}
      contributionLabels={manifest?.contributions?.map((contribution) => contribution.label ?? contribution.ref ?? contribution.type) ?? []}
      onUninstall={!cloudBuiltIn && row.imported ? () => void onRemovePlugin(row.plugin.id, row.plugin.name) : undefined}
      configSlot={(
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <SettingsPill>
              {cloudBuiltIn ? t("marketplace.built_in") : deliveryLabel}
            </SettingsPill>
            <SettingsPill>{row.marketplaceName}</SettingsPill>
            {row.counts.map((label) => <SettingsPill key={label}>{label}</SettingsPill>)}
          </div>
          {!cloudBuiltIn ? (
            <Button
              size="sm"
              disabled={actionBusy}
              onClick={() => void onInstallPlugin(row.marketplaceId, row.plugin)}
            >
              {actionBusy ? t("marketplace.working") : row.imported ? t("marketplace.sync_to_workspace") : t("marketplace.install_in_workspace")}
            </Button>
          ) : null}
          {deliveryAction === "cloud_active_local_copy" ? (
            <SettingsNotice>{t("connect.marketplace_local_copy_note")}</SettingsNotice>
          ) : null}
          <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-3">
            <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("marketplace.composition")}</div>
            <div className="mt-2 grid gap-2">
              {row.composition.map((entry) => (
                <div key={entry.type} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-card-foreground">{entry.label}</span>
                  <span className="rounded-full bg-dls-surface px-2 py-0.5 text-xs font-medium text-muted-foreground">{entry.count}</span>
                </div>
              ))}
            </div>
          </div>
          {/* TIPS: 混合插件靠整插件一个状态说不清哪一部分不可用，这里按 MCP server 逐行展开，
              云端组件与需要本地安装的组件各自标注，操作入口跟着行走。 */}
          {mcpComponents.length > 0 ? (
            <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t("marketplace.delivery_components_title")}
              </div>
              <div className="mt-2 grid gap-2">
                {mcpComponents.map((component) => {
                  const installed = installedConfigObjectIds.has(component.configObjectId);
                  const needsInstall = component.delivery === "desktop" && !installed;
                  // 云端组件绑定到组织连接、但当前成员还没授权时，给一个定向授权入口。
                  const needsMemberAuth = component.delivery === "cloud"
                    && Boolean(component.connectionId)
                    && component.connectedForMe === false;
                  return (
                    <div
                      key={`${component.configObjectId}:${component.serverName}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dls-border bg-dls-surface px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-card-foreground">
                          {component.serverName || row.plugin.name}
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          {component.url ?? component.command?.join(" ") ?? ""}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <SettingsPill>{componentDeliveryLabel(component)}</SettingsPill>
                        {needsInstall ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={actionBusy}
                            onClick={() => void onInstallPlugin(row.marketplaceId, row.plugin)}
                          >
                            {actionBusy ? t("marketplace.working") : t("marketplace.install_in_workspace")}
                          </Button>
                        ) : component.delivery === "desktop" ? (
                          <SettingsPill>{t("marketplace.delivery_component_installed")}</SettingsPill>
                        ) : needsMemberAuth && onConnectOrgMcp && component.connectionId ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={orgMcpConnectingId === component.connectionId}
                            onClick={() => onConnectOrgMcp(component.connectionId as string)}
                          >
                            {orgMcpConnectingId === component.connectionId
                              ? t("mcp.waiting_for_browser")
                              : t("marketplace.delivery_component_connect")}
                          </Button>
                        ) : component.delivery === "cloud" && component.connectionId && component.connectedForMe ? (
                          <SettingsPill>{t("marketplace.delivery_component_ready")}</SettingsPill>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {resolveError ? (
            <SettingsNotice tone="error">{resolveError}</SettingsNotice>
          ) : null}
          {resolving ? (
            <SettingsNotice>{t("marketplace.loading_contents")}</SettingsNotice>
          ) : null}
          {missingImportedConnectionCount > 0 ? (
            <SettingsNotice tone="error">
              You do not have access to {missingImportedConnectionCount === 1 ? "one required MCP connection" : `${missingImportedConnectionCount} required MCP connections`}. Ask an admin to update the connection sharing settings.
            </SettingsNotice>
          ) : null}
          {importedConnections.length > 0 ? (
            <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-3">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("marketplace.cloud_mcp_connections")}</div>
              <div className="mt-3 grid gap-2">
                {importedConnections.map((connection) => {
                  const ready = isOrgMcpConnectionReady(connection);
                  const needsMemberConnect = connection.credentialMode === "per_member" && !connection.connectedForMe;
                  const connecting = orgMcpConnectingId === connection.id;
                  return (
                    <div key={connection.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dls-border bg-dls-surface px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-card-foreground">{connection.name}</div>
                        <div className="truncate text-xs text-muted-foreground">{connection.url}</div>
                      </div>
                      <div className="flex items-center gap-2">
                        <SettingsPill>{ready ? "Ready" : needsMemberConnect ? "Needs setup" : "Waiting for admin"}</SettingsPill>
                        {needsMemberConnect && onConnectOrgMcp ? (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={connecting}
                            onClick={() => onConnectOrgMcp(connection.id)}
                          >
                            {connecting ? t("mcp.waiting_for_browser") : "Connect account"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {resolved ? (
            <div className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t("marketplace.extension_contents")}</div>
              {resolved.memberships.length > 0 ? resolved.memberships.map((membership) => {
                const object = membership.configObject;
                const version = object?.latestVersion ?? null;
                if (!object) return null;
                const preview = version?.rawSourceText?.trim().slice(0, 600) ?? "";
                return (
                  <details key={membership.id} className="rounded-xl border border-dls-border bg-dls-surface px-3 py-2">
                    <summary className="cursor-pointer text-sm font-medium text-card-foreground">
                      <span className="uppercase text-[10px] tracking-[0.12em] text-muted-foreground">{object.objectType}</span> {object.title}
                    </summary>
                    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                      {object.description ? <div>{object.description}</div> : null}
                      {object.currentRelativePath ? <div className="font-mono">{object.currentRelativePath}</div> : null}
                      {preview ? (
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-dls-hover p-2 font-mono text-[11px] text-card-foreground">
                          {preview}
                        </pre>
                      ) : null}
                    </div>
                  </details>
                );
              }) : (
                <SettingsNotice>{t("marketplace.no_detailed_contents")}</SettingsNotice>
              )}
            </div>
          ) : null}
          {row.imported?.files.length ? (
            <div className="rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-xs text-muted-foreground">
              Installed files: {row.imported.files.map((file) => `${file.title} (${file.objectType})`).join(", ")}
            </div>
          ) : null}
        </div>
      )}
    />
  );
}

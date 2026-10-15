/** @jsxImportSource react */
import * as React from "react";
import { Ellipsis, Loader2, Plus, Power, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/sonner";

import type { McpDirectoryInfo } from "@/app/constants";
import type { CloudImportedPlugin } from "@/app/cloud/import-state";
import type {
  CloudPluginMutationResult,
  WorkspacePluginAccess,
  WorkspacePluginOperationState,
} from "@/react-app/domains/settings/state/extensions-store";
import type { PendingCloudPluginChange } from "@/app/cloud/desktop-cloud-sync";
import { evaluateEnablement, type EnablementContext } from "@/app/enablement";
import type {
  DenExternalMcpConnection,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginMcpComponent,
} from "@/app/lib/den";
import {
  hostMarketplacePackageRequiresExecutableConfirmation,
  hostMarketplacePackageRequiresInstallation,
  JuggleWorkServerError,
  type JuggleWorkHostMarketplaceInstallation,
  type JuggleWorkHostMarketplaceMigrationBlocker,
  type JuggleWorkHostMarketplaceMigrationPlan,
} from "@/app/lib/jugglework-server";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { t } from "@/i18n";
import { canDisconnectNativeProviderAccount } from "@/react-app/domains/connections/native-provider-connections";
import { ExtensionCard } from "@/react-app/design-system/extension-card";
import { ExtensionDetailModal } from "@/react-app/design-system/extension-detail-modal";
import {
  aggregatePluginDelivery,
  resolvePluginMcpComponents,
  type PluginDeliveryComposition,
} from "@/react-app/domains/settings/connect-cloud-readiness";
import {
  isOrgMcpConnectionItem,
  isOrgMcpConnectionReady,
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
import { MarketplacePackageDetailModal } from "@/react-app/domains/settings/pages/marketplace-package-detail-modal";
import { CatalogDetailPage } from "@/react-app/domains/settings/pages/catalog-detail-page";
import {
  canSetJuggleWorkExtensionEnabled,
  isJuggleWorkExtensionEnabled,
} from "@/react-app/domains/settings/extension-state";
import { CatalogHeader, type CatalogSource } from "./catalog-source";
import {
  marketplaceResolvedCacheKey,
  resolveMarketplacePluginComponentAvailability,
  resolveMarketplacePluginDelivery,
  resolveMarketplacePluginActions,
  resolveMarketplaceDetailResolution,
  resolveMarketplaceDetailSelection,
  resolveMarketplacePluginLifecycle,
  resolveMarketplaceResolvedCache,
  type MarketplacePluginLifecycle,
} from "@/react-app/domains/settings/pages/marketplace-plugin-state";
import {
  HostMarketplaceMigrationRequiredError,
  type HostMarketplaceMigrationRequest,
  type HostMarketplacePluginsSnapshot,
} from "@/react-app/domains/settings/state/host-marketplace-plugins";
import {
  drainPendingMarketplacePlugin,
  openMarketplacePluginEvent,
  type OpenMarketplacePluginDetail,
} from "@/react-app/shell/notifications";

type MarketplacePackageStatus = "available" | "installed" | "update_available";
type MarketplaceStatusFilter = "all" | MarketplacePackageStatus;
type CloudMarketplacesSession = Pick<
  ReturnType<typeof useDenSession>,
  "syncCurrentDenSettings"
>;

type DenSettingsExtensionsStore = {
  cloudOrgPlugins: () => DenOrgPlugin[];
  cloudOrgMarketplacesStatus: () => string | null;
  importedCloudPlugins: () => Record<string, CloudImportedPlugin>;
  pendingCloudPluginChanges: () => Record<string, PendingCloudPluginChange>;
  marketplacePluginOperations: () => Record<string, WorkspacePluginOperationState>;
  marketplacePluginAccess: () => WorkspacePluginAccess;
  refreshCloudOrgMarketplaces: (options?: { force?: boolean; refreshImported?: boolean }) => Promise<unknown>;
  importCloudOrgPlugin: (
    marketplaceId: string | null,
    plugin: DenOrgPlugin,
  ) => Promise<CloudPluginMutationResult>;
  removeCloudOrgPlugin: (pluginId: string) => Promise<CloudPluginMutationResult>;
};

function workspacePluginAccessMessage(access: WorkspacePluginAccess) {
  if (access.allowed) return null;
  switch (access.reason) {
    case "read_only":
      return t("marketplace.workspace_gate_read_only");
    case "unauthorized":
      return t("marketplace.workspace_gate_unauthorized");
    default:
      return t("marketplace.workspace_gate_unsupported");
  }
}

function showCloudPluginMutationToast(result: CloudPluginMutationResult) {
  const details = [...result.warnings, ...(result.conflicts?.map((conflict) => conflict.message) ?? [])];
  const description = details.length > 0 ? details.join("\n") : undefined;
  if (result.status === "partial") toast.warning(result.message, { description });
  else if (result.status === "repair_required" || result.status === "failed" || !result.ok) toast.error(result.message, { description });
  else toast.success(result.message, { description });
}

export type MarketplacePackageRow = {
  source: "cloud";
  marketplaceId: string;
  marketplaceName: string;
  /** Null for plugins assigned directly to the organization rather than a collection. */
  sourceMarketplaceId: string | null;
  plugin: DenOrgPlugin;
  imported: CloudImportedPlugin | null;
  hostInstallation: JuggleWorkHostMarketplaceInstallation | null;
  item: ExtensionItem | null;
  status: MarketplacePackageStatus;
  counts: string[];
  composition: Array<{ count: number; label: string; type: string }>;
  /** 逐个 MCP server 的承载明细，服务端下发时带连接绑定。 */
  mcpComponents: DenPluginMcpComponent[];
  /** 按最弱环节聚合出的投递构成；无 MCP 组件时为 null。 */
  delivery: PluginDeliveryComposition | null;
  lifecycle: MarketplacePluginLifecycle;
  searchableText: string;
};

export type ApplicationCatalogHostRegistry = {
  snapshot: HostMarketplacePluginsSnapshot;
  put: (
    marketplaceId: string,
    resolved: DenOrgPluginResolved,
    options?: { confirmExecutable?: boolean },
  ) => Promise<JuggleWorkHostMarketplaceInstallation | null>;
  migrate: (request: HostMarketplaceMigrationRequest) => Promise<JuggleWorkHostMarketplaceInstallation | null>;
  delete: (pluginId: string) => Promise<void>;
  refresh: () => Promise<HostMarketplacePluginsSnapshot>;
};

function hostMigrationBlockerMessage(blocker: JuggleWorkHostMarketplaceMigrationBlocker): string {
  const key = blocker.code === "repair_required" || blocker.code === "host_marketplace_repair_required"
    ? "marketplace.host_migration_blocker_repair"
    : blocker.code === "modified_file"
      ? "marketplace.host_migration_blocker_file"
      : blocker.code === "modified_mcp"
        ? "marketplace.host_migration_blocker_mcp"
        : blocker.code === "unsafe_path" || blocker.code === "host_marketplace_unsafe_path"
          ? "marketplace.host_migration_blocker_path"
          : "marketplace.host_migration_blocker_generic";
  return t(key, { resource: blocker.resource });
}

function hostMigrationWorkspaceLabel(plan: JuggleWorkHostMarketplaceMigrationPlan, workspaceId: string): string {
  return plan.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.label
    ?? t("marketplace.host_migration_host_label");
}

export function hostMarketplaceMigrationBlockersMessage(plan: JuggleWorkHostMarketplaceMigrationPlan): string {
  const blockers = plan.blockers.map((blocker) =>
    `- ${hostMigrationWorkspaceLabel(plan, blocker.workspaceId)}: ${hostMigrationBlockerMessage(blocker)}`);
  return [t("marketplace.host_migration_blocked"), ...blockers].join("\n");
}

export function hostMarketplaceMigrationConfirmation(
  pluginName: string,
  plan: JuggleWorkHostMarketplaceMigrationPlan,
): string {
  const workspaces = plan.workspaces.map((workspace) => t("marketplace.host_migration_workspace", {
    label: workspace.label,
    count: workspace.resources.length,
  }));
  return [
    t("marketplace.host_migration_confirm", { name: pluginName }),
    "",
    ...workspaces,
    "",
    t("marketplace.host_migration_warning"),
  ].join("\n");
}

function hostMarketplaceMigrationFailureMessage(error: unknown): string {
  if (error instanceof JuggleWorkServerError && (
    error.code === "host_marketplace_migration_plan_stale"
    || error.code === "host_marketplace_migration_workspace_set_mismatch"
    || error.code === "workspace_plugin_migration_snapshot_stale"
  )) {
    return t("marketplace.host_migration_stale");
  }
  if (error instanceof JuggleWorkServerError && error.code === "host_marketplace_migration_failed") {
    return t("marketplace.host_migration_failed");
  }
  return t("marketplace.host_migration_uncertain");
}

export type BuiltInMarketplaceRow = {
  source: "built-in";
  marketplaceId: "jugglework-builtins";
  marketplaceName: string;
  entry: McpDirectoryInfo;
  status: MarketplacePackageStatus;
  active: boolean;
  setupReady: boolean;
  unmetRequirements: string[];
  searchableText: string;
};

export type HostRegistryMarketplaceRow = {
  source: "host-registry";
  marketplaceId: string;
  marketplaceName: string;
  installation: JuggleWorkHostMarketplaceInstallation;
  status: "installed";
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

type PersonalMarketplaceRow = {
  source: "personal";
  marketplaceId: "personal-plugins";
  plugin: { id: string; name: string; description?: string | null; spec?: string };
  status: "installed";
  searchableText: string;
};

type MarketplaceRow = MarketplacePackageRow | HostRegistryMarketplaceRow | BuiltInMarketplaceRow | OrgMcpMarketplaceRow | PersonalMarketplaceRow;

const ORGANIZATION_PLUGINS_COLLECTION_ID = "organization-plugins";

export function shouldShowMarketplaceRows(isSignedIn: boolean, activeOrgId: string) {
  return isSignedIn && activeOrgId.trim().length > 0;
}

export function selectMarketplaceRowsBySource<T>(input: {
  source?: CatalogSource;
  isSignedIn: boolean;
  activeOrgId: string;
  builtInRows: T[];
  cloudRows: T[];
  personalRows: T[];
  orgMcpRows: T[];
  skillsOnly?: boolean;
}): T[] {
  if (input.source === "public") return input.builtInRows;
  if (input.source === "personal") return input.personalRows;
  if (!shouldShowMarketplaceRows(input.isSignedIn, input.activeOrgId)) return [];
  if (input.source === "organization" || input.skillsOnly) return input.cloudRows;
  return [...input.builtInRows, ...input.cloudRows, ...input.orgMcpRows];
}

export function shouldIncludeCloudMarketplacePluginRow(input: { embedded?: boolean }) {
  return input.embedded !== true;
}

export function shouldIncludeOrgMcpConnectionMarketplaceRow(_input: { embedded?: boolean }) {
  return false;
}

export function marketplacePluginMayRequireHostInstallation(plugin: DenOrgPlugin): boolean {
  const componentCounts = Object.entries(plugin.componentCounts).filter(([, count]) => count > 0);
  if (componentCounts.some(([type]) => type === "custom")) return false;
  if (componentCounts.some(([type]) => type === "hook" || type === "tool")) return true;
  if (plugin.cloudReadiness?.components?.some((component) => component.delivery === "desktop")) return true;
  if (plugin.cloudReadiness?.state === "desktop_only" || plugin.cloudReadiness?.state === "not_synced") return true;
  const hasInstructional = componentCounts.some(([type]) => ["agent", "command", "context", "skill"].includes(type));
  return hasInstructional && !plugin.cloudReadiness;
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
  detailRequest?: { id: string; nonce: number };
  onDetailOpenChange?: (open: boolean) => void;
  onRefreshLocal?: () => void | Promise<unknown>;
  personalError?: string | null;
  source?: CatalogSource;
  onSourceChange?: (source: CatalogSource) => void;
  organizationName?: string | null;
  /** Environment-installed inventory, including user-enabled built-ins and global local specs. */
  personalPlugins?: Array<{ id: string; name: string; description?: string | null; spec?: string }>;
  onUninstallPersonalPlugin?: (plugin: PersonalMarketplaceRow["plugin"]) => void | Promise<void>;
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
  /** Dedicated catalog surfaces can use a shorter product-facing title. */
  title?: string;
  description?: string;
  /** Non-fatal host integration limitation; organization discovery remains available. */
  errorHint?: string | null;
  /**
   * Standalone catalog presentation. Discovery is application-level, while
   * non-built-in Marketplace mutations target the selected workspace.
   */
  applicationCatalog?: boolean | ApplicationCatalogHostRegistry;
  /** 当前工作区稳定标识，用于隔离详情选择与异步解析结果。 */
  workspaceKey: string;
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

function marketplaceListStatus(lifecycle: MarketplacePluginLifecycle): MarketplacePackageStatus {
  if (lifecycle.state === "not_installed") return "available";
  if (lifecycle.state === "update_available") return "update_available";
  return "installed";
}

function hostMarketplaceLifecycle(input: {
  lifecycle: MarketplacePluginLifecycle;
  plugin: DenOrgPlugin;
  installation: JuggleWorkHostMarketplaceInstallation | null;
  resolved: DenOrgPluginResolved | null;
  operation: "put" | "delete" | null;
}): MarketplacePluginLifecycle {
  const { installation, lifecycle, operation, plugin, resolved } = input;
  const components = resolvePluginMcpComponents(plugin, resolved);
  const availability = resolveMarketplacePluginComponentAvailability(components, null).map((component) => (
    installation && component.delivery === "desktop" ? { ...component, state: "current" as const } : component
  ));
  const delivery = resolveMarketplacePluginDelivery(
    components,
    resolved?.memberships.flatMap((membership) => membership.configObject ? [membership.configObject.id] : []) ?? null,
    plugin.memberCount,
  );
  const requiresHost = resolved
    ? hostMarketplacePackageRequiresInstallation(plugin.marketplaces?.[0]?.id ?? ORGANIZATION_PLUGINS_COLLECTION_ID, resolved)
    : marketplacePluginMayRequireHostInstallation(plugin);
  const state: MarketplacePluginLifecycle["state"] = operation === "delete"
    ? "removing"
    : operation === "put"
      ? "installing"
      : installation?.status === "repair_required"
        ? "repair_required"
        : installation
          ? plugin.updatedAt && installation.packageRevision !== plugin.updatedAt ? "update_available" : "current"
          : requiresHost ? "not_installed" : lifecycle.state;
  return {
    ...lifecycle,
    state,
    delivery,
    components: availability,
    hasLocalLedger: Boolean(installation),
    error: installation?.repair?.cause ?? lifecycle.error,
    failedOperation: installation?.status === "repair_required" ? "install" : lifecycle.failedOperation,
    ...resolveMarketplacePluginActions(state, { hasLocalLedger: Boolean(installation) }),
  };
}

function marketplaceRowKey(row: MarketplaceRow): string {
  if (row.source === "personal") return `personal:${row.plugin.id}`;
  if (row.source === "cloud") return `cloud:${row.marketplaceId}:${row.plugin.id}`;
  if (row.source === "host-registry") return `cloud:${row.marketplaceId}:${row.installation.pluginId}`;
  if (row.source === "built-in") return `built-in:${row.entry.id ?? row.entry.serverName ?? row.entry.name}`;
  return `org-mcp:${row.connection.id}`;
}

export function CloudMarketplacesView({
  detailRequest,
  onDetailOpenChange,
  onRefreshLocal,
  personalError,
  source,
  onSourceChange,
  organizationName,
  personalPlugins = [],
  onUninstallPersonalPlugin,
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
  title,
  description,
  errorHint = null,
  applicationCatalog = false,
  workspaceKey,
}: CloudMarketplacesViewProps) {
  const { activeOrganization: activeOrg, authToken, client, isSignedIn, user } = useCloudSession();
  const [busy, setBusy] = React.useState(false);
  const [actionId, setActionId] = React.useState<string | null>(null);
  const [hostAction, setHostAction] = React.useState<"put" | "delete" | null>(null);
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
  const [detailSelection, setDetailSelection] = React.useState<{
    rowKey: string;
    organizationId: string;
    workspaceKey: string;
  } | null>(null);
  const handledDetailRequest = React.useRef<{ id: string; nonce: number } | null>(null);
  const applicationCatalogMode = Boolean(applicationCatalog);
  const hostRegistry = typeof applicationCatalog === "object" ? applicationCatalog : null;
  const refreshHostRegistry = hostRegistry?.refresh;
  const putHostRegistry = hostRegistry?.put;
  const migrateHostRegistry = hostRegistry?.migrate;
  const deleteHostRegistry = hostRegistry?.delete;
  const inlineDetails = applicationCatalogMode && !embedded;
  const [resolvedPlugins, setResolvedPlugins] = React.useState<Record<string, DenOrgPluginResolved>>({});
  const [detailLoadingKey, setDetailLoadingKey] = React.useState<string | null>(null);
  const [detailError, setDetailError] = React.useState<{ key: string; message: string } | null>(null);
  const [detailRetryRequest, setDetailRetryRequest] = React.useState<{ key: string; sequence: number } | null>(null);
  const detailRequestsRef = React.useRef(new Set<string>());
  const [highlightPluginName, setHighlightPluginName] = React.useState<string | null>(null);
  const activeOrgId = activeOrg?.id ?? "";
  const canShowRows = shouldShowMarketplaceRows(isSignedIn, activeOrgId);
  const showsOrganization = source === undefined || source === "organization";
  const includeCloudMarketplaceRows = source === "organization" || shouldIncludeCloudMarketplacePluginRow({ embedded });
  const includeOrgMcpRows = shouldIncludeOrgMcpConnectionMarketplaceRow({ embedded });
  const refreshRequestRef = React.useRef(0);

  React.useLayoutEffect(() => {
    setBusy(false);
    setActionError(null);
    return () => { refreshRequestRef.current += 1; };
  }, [source, activeOrgId, authToken, isSignedIn, workspaceKey, applicationCatalogMode]);

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

  const plugins = extensions.cloudOrgPlugins();
  const workspaceImportedPlugins = extensions.importedCloudPlugins();
  // Application catalog state must not be inferred from a selected workspace.
  const importedPlugins = applicationCatalogMode ? {} : workspaceImportedPlugins;
  const pendingChanges = applicationCatalogMode ? {} : extensions.pendingCloudPluginChanges();
  const marketplacePluginOperations = applicationCatalogMode ? {} : extensions.marketplacePluginOperations();
  const marketplacePluginAccess = extensions.marketplacePluginAccess();
  const marketplacePluginAccessHint = applicationCatalogMode ? null : workspacePluginAccessMessage(marketplacePluginAccess);
  const extensionItemsByBuiltInId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.builtInEntry ? [[item.builtInEntry.id ?? item.builtInEntry.serverName ?? item.builtInEntry.name, item] as const] : []),
  ), [extensionItems]);
  const extensionItemsByPluginId = React.useMemo(() => new Map(
    extensionItems.flatMap((item) => item.plugin ? [[item.plugin.id, item] as const] : []),
  ), [extensionItems]);
  const hostInstallations = React.useMemo(() => new Map(
    hostRegistry?.snapshot.registry?.installations.map((installation) => [installation.pluginId, installation]) ?? [],
  ), [hostRegistry?.snapshot.registry]);
  const hostCanWrite = Boolean(
    hostRegistry?.snapshot.registry?.active
    && hostRegistry.snapshot.writable,
  );
  const rowContextKey = `${source ?? "legacy"}:${isSignedIn}:${activeOrgId}:${applicationCatalogMode ? "application-catalog" : workspaceKey}`;
  const lastRowsRef = React.useRef<{ contextKey: string; rows: MarketplaceRow[] }>({ contextKey: rowContextKey, rows: [] });
  const cloudRows = React.useMemo<MarketplacePackageRow[]>(() => {
    if (source && (!showsOrganization || !canShowRows)) return [];
    return plugins.flatMap((plugin) => {
      if (!includeCloudMarketplaceRows) return [];
      if (skillsOnly && !pluginHasSkill(plugin)) return [];
      const collection = plugin.marketplaces?.[0] ?? null;
      const marketplaceId = collection?.id ?? ORGANIZATION_PLUGINS_COLLECTION_ID;
      const marketplaceName = collection?.name ?? t("marketplace.organization_plugins");
      const imported = importedPlugins[plugin.id] ?? null;
      const hostInstallation = hostInstallations.get(plugin.id) ?? null;
      const composition = pluginComposition(plugin);
      const counts = pluginCounts(plugin);
      // TIPS: 详情解析完成后列表也立即复用同一发布版本的数据，避免卡片与弹窗投递语义不一致。
      const resolved = resolvedPlugins[marketplaceResolvedCacheKey(activeOrgId, plugin)] ?? null;
      const mcpComponents = resolvePluginMcpComponents(plugin, resolved);
      const item = extensionItemsByPluginId.get(plugin.id);
      const operation = marketplacePluginOperations[plugin.id];
      const lifecycle = resolveMarketplacePluginLifecycle({
        plugin,
        imported,
        pendingChange: pendingChanges[plugin.id],
        components: mcpComponents,
        operation: operation?.state ?? null,
        operationError: operation?.message ?? null,
        failedOperation: operation?.operation ?? null,
        catalogMode: applicationCatalogMode,
        requireInstallRecord: false,
      });
      const status: MarketplacePackageStatus = isCloudBuiltInPlugin(plugin)
        ? "installed"
        : applicationCatalogMode
          ? hostInstallation
            ? plugin.updatedAt && hostInstallation.packageRevision !== plugin.updatedAt ? "update_available" : "installed"
            : "available"
          : marketplaceListStatus(lifecycle);
      return [{
        source: "cloud",
        marketplaceId,
        marketplaceName,
        sourceMarketplaceId: collection?.id ?? null,
        plugin,
        imported,
        hostInstallation,
        item: item ?? null,
        status,
        counts,
        composition,
        mcpComponents,
        delivery: aggregatePluginDelivery(mcpComponents),
        lifecycle,
        searchableText: [
          plugin.name,
          plugin.description ?? "",
          marketplaceName,
          pluginManifestSearchText(plugin),
          ...counts,
          ...(imported?.files.map((file) => `${file.title} ${file.objectType} ${file.path}`) ?? []),
        ].join(" ").toLowerCase(),
      }];
    });
  }, [activeOrgId, applicationCatalogMode, canShowRows, extensionItemsByPluginId, hostInstallations, importedPlugins, includeCloudMarketplaceRows, marketplacePluginOperations, pendingChanges, plugins, resolvedPlugins, showsOrganization, skillsOnly, source]);

  const hostRegistryRows = React.useMemo<HostRegistryMarketplaceRow[]>(() => {
    if (!applicationCatalogMode || !includeCloudMarketplaceRows || !canShowRows || skillsOnly) return [];
    const catalogPluginIds = new Set(plugins.map((plugin) => plugin.id));
    return [...hostInstallations.values()].flatMap((installation) => {
      if (catalogPluginIds.has(installation.pluginId)) return [];
      return [{
        source: "host-registry",
        marketplaceId: installation.marketplaceId || ORGANIZATION_PLUGINS_COLLECTION_ID,
        marketplaceName: t("marketplace.organization_plugins"),
        installation,
        status: "installed",
        searchableText: [
          installation.name,
          installation.description ?? "",
          installation.pluginId,
          installation.packageRevision,
          installation.status,
          ...installation.resources.map((resource) => `${resource.kind} ${resource.componentId} ${resource.target}`),
        ].join(" ").toLowerCase(),
      }];
    });
  }, [applicationCatalogMode, canShowRows, hostInstallations, includeCloudMarketplaceRows, plugins, skillsOnly]);

  const builtInRows = React.useMemo<BuiltInMarketplaceRow[]>(() => {
    return builtInEntries.map((entry) => {
      const item = extensionItemsByBuiltInId.get(entry.id ?? entry.serverName ?? entry.name);
      const enablement = entry.extensionManifest?.enablement && enablementContext
        ? evaluateEnablement(entry.extensionManifest.enablement, enablementContext)
        : null;
      const runtimeReady = isBuiltInConnected?.(entry) ?? false;
      const nonToggleConditions = entry.extensionManifest?.enablement?.filter((condition) => condition.type !== "toggle-enabled") ?? [];
      const nonToggleResults = enablement?.results.filter((result) => result.condition.type !== "toggle-enabled") ?? [];
      const hasToggleCondition = entry.extensionManifest?.enablement?.some((condition) => condition.type === "toggle-enabled") === true;
      const setupReady = item?.setupReady ?? (nonToggleConditions.length > 0
        ? nonToggleResults.length === nonToggleConditions.length && nonToggleResults.every((result) => result.met)
        : hasToggleCondition ? true : runtimeReady);
      const mcpLifecycleManaged = entry.extensionManifest?.resources.some((resource) => resource.type === "mcp") === true &&
        entry.extensionManifest.enablement?.some((condition) => condition.type === "toggle-enabled") !== true;
      const catalogEnabled = mcpLifecycleManaged ? true : isJuggleWorkExtensionEnabled(entry);
      const active = item?.active ?? (catalogEnabled && setupReady);
      const unmetRequirements = nonToggleConditions.flatMap((condition) => {
        const result = nonToggleResults.find((candidate) => candidate.condition.type === condition.type && candidate.condition.ref === condition.ref);
        return result?.met ? [] : [condition.label];
      });
      return {
        source: "built-in",
        marketplaceId: "jugglework-builtins",
        marketplaceName: "JuggleWork Built-ins",
        entry,
        active,
        setupReady,
        unmetRequirements,
        // Public built-ins ship with JuggleWork. Enablement is runtime state,
        // not installation state, so disabled built-ins remain installed.
        status: "installed",
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

  const personalRows: PersonalMarketplaceRow[] = personalPlugins.map((plugin) => ({
    source: "personal",
    marketplaceId: "personal-plugins",
    plugin,
    status: "installed",
    searchableText: `${plugin.name} ${plugin.description ?? ""}`.toLowerCase(),
  }));

  const rows = selectMarketplaceRowsBySource<MarketplaceRow>({
    source, isSignedIn, activeOrgId, builtInRows, cloudRows: [...cloudRows, ...hostRegistryRows], personalRows, orgMcpRows, skillsOnly,
  });

  React.useEffect(() => {
    if (rows.length > 0) lastRowsRef.current = { contextKey: rowContextKey, rows };
  }, [rowContextKey, rows]);

  const displayRows = rows.length > 0
    ? rows
    : !source && canShowRows && busy && lastRowsRef.current.contextKey === rowContextKey ? lastRowsRef.current.rows : rows;

  // TIPS: 详情只保存稳定身份；每次渲染都从当前工作区/组织的最新 rows 派生，安装结果可立即反映。
  const detailRow = React.useMemo(() => resolveMarketplaceDetailSelection(
    rows,
    detailSelection,
    { organizationId: activeOrgId, workspaceKey },
    marketplaceRowKey,
  ), [activeOrgId, detailSelection, rows, workspaceKey]);

  React.useEffect(() => {
    if (!detailSelection) return;
    if (detailSelection.organizationId !== activeOrgId || detailSelection.workspaceKey !== workspaceKey || !detailRow) {
      setDetailSelection(null);
    }
  }, [activeOrgId, detailRow, detailSelection, workspaceKey]);

  React.useEffect(() => {
    if (!inlineDetails || !detailRequest || busy) return;
    if (handledDetailRequest.current?.id === detailRequest.id && handledDetailRequest.current.nonce === detailRequest.nonce) return;
    // Requests use sidebar IDs, not list row keys, and ignore search/status filters.
    const row = rows.find((row) => {
      if (row.source === "cloud") return detailRequest.id === `cloud-plugin:${row.plugin.id}`;
      if (row.source === "host-registry") return detailRequest.id === `cloud-plugin:${row.installation.pluginId}`;
      if (row.source === "personal") return detailRequest.id === row.plugin.id;
      if (row.source === "built-in") {
        const entryId = row.entry.id ?? row.entry.serverName ?? row.entry.name;
        return detailRequest.id === (extensionItemsByBuiltInId.get(entryId)?.id ?? `builtin:${entryId}`);
      }
      return detailRequest.id === row.item.id;
    });
    // Do not consume requests before their source inventory has arrived.
    if (!row) return;
    handledDetailRequest.current = detailRequest;
    setDetailSelection({ rowKey: marketplaceRowKey(row), organizationId: activeOrgId, workspaceKey });
  }, [activeOrgId, busy, detailRequest, extensionItemsByBuiltInId, inlineDetails, rows, workspaceKey]);

  const detailOpen = inlineDetails && Boolean(detailRow);
  const notifyDetailOpenChange = React.useEffectEvent((open: boolean) => onDetailOpenChange?.(open));
  React.useEffect(() => {
    notifyDetailOpenChange(detailOpen);
  }, [detailOpen]);
  React.useEffect(() => () => notifyDetailOpenChange(false), []);

  const marketplaceOptions = React.useMemo(
    () => canShowRows ? [
      ...(builtInRows.length > 0 ? [{ id: "jugglework-builtins", name: t("marketplace.builtins_name") }] : []),
      ...(includeCloudMarketplaceRows ? [...new Map(
        [...cloudRows, ...hostRegistryRows].map((row) => [row.marketplaceId, { id: row.marketplaceId, name: row.marketplaceName }] as const),
      ).values()] : []),
      ...(orgMcpRows.length > 0 ? [{ id: "org-mcp-connections", name: t("marketplace.org_mcp_connections") }] : []),
    ] : [],
    [builtInRows.length, canShowRows, cloudRows, hostRegistryRows, includeCloudMarketplaceRows, orgMcpRows.length],
  );

  const visibleRows = React.useMemo(
    () => displayRows.filter((row) => matchesMarketplaceFilters(row, {
      search,
      statusFilter: source ? "all" : statusFilter,
      marketplaceFilter: source ? "all" : marketplaceFilter,
    })),
    [displayRows, marketplaceFilter, search, source, statusFilter],
  );

  const refresh = React.useCallback(
    async (quiet = false) => {
      if (!showsOrganization || !authToken.trim() || !canShowRows) return;

      const request = ++refreshRequestRef.current;
      const isCurrent = () => refreshRequestRef.current === request;
      setBusy(true);
      if (!quiet) setActionError(null);

      try {
        if (!source) session.syncCurrentDenSettings();
        await extensions.refreshCloudOrgMarketplaces({ force: true, refreshImported: true });
        if (!isCurrent()) return;
        if (refreshHostRegistry) await refreshHostRegistry();
        if (!isCurrent()) return;
        await refreshOrgMcpConnections?.();
        if (isCurrent() && !quiet) {
          const count = extensions.cloudOrgPlugins().length;
          toast.info(
            count > 0
              ? `Loaded ${count} marketplace extension${count === 1 ? "" : "s"} for ${activeOrg?.name ?? t("den.active_org_title")}.`
              : `No marketplace extensions are available for ${activeOrg?.name ?? t("den.active_org_title")}.`,
          );
        }
      } catch (error) {
        if (isCurrent() && !quiet) {
          setActionError(error instanceof Error ? error.message : "Failed to load marketplace extensions.");
        }
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [
      extensions,
      source,
      showsOrganization,
      canShowRows,
      activeOrg,
      activeOrgId,
      authToken,
      session.syncCurrentDenSettings,
      refreshOrgMcpConnections,
      refreshHostRegistry,
    ],
  );

  React.useEffect(() => {
    if (!user || !activeOrgId) return;
    void refresh(true);
  }, [activeOrgId, refresh, user]);

  React.useEffect(() => {
    if (!detailRow || detailRow.source !== "cloud" || !isSignedIn || !activeOrgId) return;
    const cacheKey = marketplaceResolvedCacheKey(activeOrgId, detailRow.plugin);
    const retrySequence = detailRetryRequest?.key === cacheKey ? detailRetryRequest.sequence : 0;
    const requestKey = `${cacheKey}:${retrySequence}`;
    if (resolvedPlugins[cacheKey] && retrySequence === 0) return;
    if (detailRequestsRef.current.has(requestKey)) return;
    detailRequestsRef.current.add(requestKey);

    let cancelled = false;
    setDetailLoadingKey(cacheKey);
    setDetailError((current) => current?.key === cacheKey ? null : current);
    void client.getOrgPluginResolved(activeOrgId, detailRow.plugin)
      .then((resolved) => {
        if (cancelled) return;
        setResolvedPlugins((current) => ({ ...current, [cacheKey]: resolved }));
      })
      .catch((error) => {
        if (cancelled) return;
        setDetailError({
          key: cacheKey,
          message: error instanceof Error ? error.message : t("marketplace.load_contents_failed"),
        });
      })
      .finally(() => {
        if (!cancelled) setDetailLoadingKey(null);
      });
    return () => {
      cancelled = true;
      detailRequestsRef.current.delete(requestKey);
    };
  }, [activeOrgId, client, detailRetryRequest, detailRow, isSignedIn, resolvedPlugins]);

  const retryDetailResolution = React.useCallback((plugin: DenOrgPlugin) => {
    const key = marketplaceResolvedCacheKey(activeOrgId, plugin);
    setDetailRetryRequest((current) => ({
      key,
      sequence: current?.key === key ? current.sequence + 1 : 1,
    }));
  }, [activeOrgId]);

  const removePlugin = React.useCallback(
    async (pluginId: string, pluginName: string) => {
      if (actionId) return;

      setActionId(pluginId);
      setActionError(null);

      try {
        const result = await extensions.removeCloudOrgPlugin(pluginId);
        showCloudPluginMutationToast(result);
        if (!result.ok) {
          setActionError(result.message);
          return;
        }
        setDetailSelection(null);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to remove ${pluginName}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const installPlugin = React.useCallback(
    async (marketplaceId: string | null, plugin: DenOrgPlugin) => {
      if (actionId) return;
      setActionId(plugin.id);
      setActionError(null);
      try {
        const result = await extensions.importCloudOrgPlugin(marketplaceId, plugin);
        showCloudPluginMutationToast(result);
        if (!result.ok) setActionError(result.message);
      } catch (error) {
        setActionError(error instanceof Error ? error.message : `Failed to install ${plugin.name}.`);
      } finally {
        setActionId(null);
      }
    },
    [actionId, extensions],
  );

  const putHostPlugin = React.useCallback(async (marketplaceId: string | null, plugin: DenOrgPlugin) => {
    if (!putHostRegistry || actionId || !activeOrgId) return;
    setActionId(plugin.id);
    setHostAction("put");
    setActionError(null);
    try {
      const resolved = await client.getOrgPluginResolved(activeOrgId, plugin);
      const targetMarketplaceId = marketplaceId ?? ORGANIZATION_PLUGINS_COLLECTION_ID;
      if (!hostMarketplacePackageRequiresInstallation(targetMarketplaceId, resolved)) return;
      const confirmExecutable = hostMarketplacePackageRequiresExecutableConfirmation(targetMarketplaceId, resolved);
      if (confirmExecutable && !window.confirm(t("marketplace.host_executable_confirm", { name: resolved.plugin.name }))) return;
      try {
        await putHostRegistry(targetMarketplaceId, resolved, { confirmExecutable });
      } catch (error) {
        if (!(error instanceof HostMarketplaceMigrationRequiredError)) throw error;
        if (!error.request.plan.migratable) {
          setActionError(hostMarketplaceMigrationBlockersMessage(error.request.plan));
          return;
        }
        if (!migrateHostRegistry || !window.confirm(hostMarketplaceMigrationConfirmation(resolved.plugin.name, error.request.plan))) return;
        try {
          await migrateHostRegistry(error.request);
        } catch (migrationError) {
          setActionError(hostMarketplaceMigrationFailureMessage(migrationError));
          return;
        }
        setResolvedPlugins((current) => ({
          ...current,
          [marketplaceResolvedCacheKey(activeOrgId, resolved.plugin)]: resolved,
        }));
        toast.success(t("marketplace.host_migration_success", { name: resolved.plugin.name }));
        return;
      }
      setResolvedPlugins((current) => ({
        ...current,
        [marketplaceResolvedCacheKey(activeOrgId, resolved.plugin)]: resolved,
      }));
      toast.success(t("marketplace.host_install_success", { name: resolved.plugin.name }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("marketplace.host_install_failed", { name: plugin.name }));
    } finally {
      setHostAction(null);
      setActionId(null);
    }
  }, [actionId, activeOrgId, client, migrateHostRegistry, putHostRegistry]);

  const deleteHostPlugin = React.useCallback(async (pluginId: string, pluginName: string) => {
    if (!deleteHostRegistry || actionId) return;
    const resourceCount = hostInstallations.get(pluginId)?.resources.length ?? 0;
    if (!window.confirm(t("marketplace.host_uninstall_confirm", { name: pluginName, count: resourceCount }))) return;
    setActionId(pluginId);
    setHostAction("delete");
    setActionError(null);
    try {
      await deleteHostRegistry(pluginId);
      setDetailSelection(null);
      toast.success(t("marketplace.host_remove_success", { name: pluginName }));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t("marketplace.host_remove_failed", { name: pluginName }));
    } finally {
      setHostAction(null);
      setActionId(null);
    }
  }, [actionId, deleteHostRegistry, hostInstallations]);

  const removedUpstreamPlugins = React.useMemo(
    // Removed-upstream cleanup belongs to the legacy workspace Extensions
    // surface. The standalone application catalog must not leak the selected
    // workspace's imported-plugin ledger or offer workspace removal actions.
    () => applicationCatalogMode
      ? []
      : Object.values(workspaceImportedPlugins).filter((plugin) => pendingChanges[plugin.pluginId] === "removed"),
    [applicationCatalogMode, pendingChanges, workspaceImportedPlugins],
  );

  const content = (
    <SettingsSection>
      {source ? (
        <CatalogHeader
          title={title ?? t("extensions.marketplace_title")}
          description={description ?? t(`customization.${source}_description`)}
          busy={showsOrganization && busy}
          onRefresh={() => { if (source === "organization") void refresh(); else void onRefreshLocal?.(); }}
          source={source}
          onSourceChange={onSourceChange}
          organizationName={organizationName ?? activeOrg?.name}
          search={!searchControlled ? { value: search, onChange: setSearch, placeholder: t("marketplace.search_placeholder") } : undefined}
        />
      ) : !hideSectionHeader ? (
        <SettingsSectionHeader>
          <SettingsSectionHeaderContent>
            <SettingsSectionHeaderTitle>{title ?? t("extensions.marketplace_title")}</SettingsSectionHeaderTitle>
            <SettingsSectionHeaderDescription>
              {description ?? t("extensions.marketplace_description")}
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

      {source === "personal" && personalError ? <SettingsNotice tone="error">{personalError}</SettingsNotice> : null}
      {showsOrganization && !isSignedIn ? (
        <SettingsNotice>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>{t("marketplace.signin_hint")}</span>
            <Button size="sm" onClick={onOpenAccount}>
              {t("skills.share_team_sign_in")}
            </Button>
          </div>
        </SettingsNotice>
      ) : null}

      {showsOrganization && (actionError ?? extensions.cloudOrgMarketplacesStatus()) ? (
        <SettingsNotice tone="error">{actionError ?? extensions.cloudOrgMarketplacesStatus()}</SettingsNotice>
      ) : null}

      {showsOrganization && errorHint ? (
        <SettingsNotice>{errorHint}</SettingsNotice>
      ) : null}

      {showsOrganization && applicationCatalogMode && hostRegistry?.snapshot.error && !actionError && !errorHint ? (
        <SettingsNotice tone="error">{hostRegistry.snapshot.error.message}</SettingsNotice>
      ) : null}

      {showsOrganization && marketplacePluginAccessHint ? (
        <SettingsNotice>{marketplacePluginAccessHint}</SettingsNotice>
      ) : null}

      {showsOrganization && busy ? (
        <SettingsNotice>{t("marketplace.loading_extensions")}</SettingsNotice>
      ) : null}

      {showsOrganization && removedUpstreamPlugins.map((plugin) => (
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

      {!source ? <div className="space-y-3">
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
      </div> : null}

      <div className={source ? "min-h-[20rem] space-y-3" : "space-y-3"}>
      {!(showsOrganization && busy) && displayRows.length === 0 ? (
        <SettingsListEmptyState>
          {source && (!showsOrganization || canShowRows)
            ? t("customization.empty_source")
            : !isSignedIn
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
            if (row.source === "personal") {
              return (
                <div key={marketplaceRowKey(row)} className="relative min-w-0">
                  <ExtensionCard
                    name={row.plugin.name}
                    description={row.plugin.description ?? ""}
                    kind="plugin"
                    plain={plainCards}
                    onClick={() => setDetailSelection({ rowKey: marketplaceRowKey(row), organizationId: activeOrgId, workspaceKey })}
                  />
                  <PluginCardAction
                    installed
                    busy={actionId === row.plugin.id}
                    canUninstall={Boolean(onUninstallPersonalPlugin && row.plugin.spec)}
                    onUninstall={() => {
                      if (!onUninstallPersonalPlugin || actionId) return;
                      setActionId(row.plugin.id);
                      Promise.resolve(onUninstallPersonalPlugin(row.plugin))
                        .catch((error) => setActionError(error instanceof Error ? error.message : t("marketplace.uninstall_failed")))
                        .finally(() => setActionId(null));
                    }}
                  />
                </div>
              );
            }
            if (row.source === "host-registry") {
              const installation = row.installation;
              return (
                <div key={marketplaceRowKey(row)} className="relative min-w-0">
                  <ExtensionCard
                    name={installation.name}
                    description={installation.description || t("marketplace.no_description")}
                    kind="extension"
                    connected={installation.status === "installed"}
                    connectedLabel={t(installation.status === "installed" ? "marketplace.lifecycle_current" : "marketplace.lifecycle_repair_required")}
                    statusBadge="icon-only"
                    plain={plainCards}
                    onClick={() => setDetailSelection({ rowKey: marketplaceRowKey(row), organizationId: activeOrgId, workspaceKey })}
                  />
                  <PluginCardAction
                    installed
                    busy={actionId === installation.pluginId}
                    disabled={!hostCanWrite}
                    onUninstall={() => void deleteHostPlugin(installation.pluginId, installation.name)}
                  />
                </div>
              );
            }
            const pluginName = row.source === "cloud" ? row.plugin.name : row.source === "built-in" ? row.entry.name : row.item.name;
            const isHighlighted = highlightPluginName != null && pluginName === highlightPluginName;
            return (
              <MarketplaceCard
                key={row.source === "cloud" ? `${row.marketplaceId}:${row.plugin.id}` : row.source === "built-in" ? `${row.marketplaceId}:${row.entry.id ?? row.entry.name}` : row.item.id}
                actionId={actionId}
                row={row}
                onOpenDetail={(selectedRow) => setDetailSelection({
                  rowKey: marketplaceRowKey(selectedRow),
                  organizationId: activeOrgId,
                  workspaceKey,
                })}
                orgMcpConnectingId={orgMcpConnectingId}
                orgMcpDisconnectingId={orgMcpDisconnectingId}
                onDisconnectOrgMcp={onDisconnectOrgMcp}
                builtInDisabled={builtInExtensionsDisabled}
                builtInConnectingName={builtInConnectingName}
                highlighted={isHighlighted}
                plain={plainCards}
                applicationCatalog={applicationCatalogMode}
                hostCanWrite={hostCanWrite}
                resolved={row.source === "cloud" ? resolveMarketplaceResolvedCache(resolvedPlugins, activeOrgId, row.plugin).current : null}
                hostOperation={row.source === "cloud" && actionId === row.plugin.id ? hostAction : null}
                canMutate={applicationCatalogMode ? hostCanWrite : marketplacePluginAccess.allowed}
                onInstallPlugin={applicationCatalogMode ? putHostPlugin : installPlugin}
                onRemovePlugin={applicationCatalogMode ? deleteHostPlugin : removePlugin}
                onSetBuiltInEnabled={setBuiltInEnabled}
              />
            );
          })}
        </div>
      ) : null}

      </div>
    </SettingsSection>
  );

  const cloudDetailContext = detailRow?.source === "cloud" ? (() => {
    const cacheKey = marketplaceResolvedCacheKey(activeOrgId, detailRow.plugin);
    const resolvedCache = resolveMarketplaceResolvedCache(resolvedPlugins, activeOrgId, detailRow.plugin);
    const currentResolveError = detailError?.key === cacheKey ? detailError.message : null;
    const resolving = detailLoadingKey === cacheKey || (!resolvedCache.current && !currentResolveError);
    const resolutionState = resolveMarketplaceDetailResolution({
      hasCurrent: Boolean(resolvedCache.current),
      hasLastKnownGood: Boolean(resolvedCache.lastKnownGood),
      resolving,
      hasError: Boolean(currentResolveError),
    });
    const operation = marketplacePluginOperations[detailRow.plugin.id];
    const lifecycle = resolveMarketplacePluginLifecycle({
      plugin: detailRow.plugin,
      imported: detailRow.imported,
      pendingChange: pendingChanges[detailRow.plugin.id],
      components: resolvePluginMcpComponents(detailRow.plugin, resolvedCache.current),
      resolvedConfigObjectIds: resolvedCache.current
        ?.memberships.flatMap((membership) => membership.configObject ? [membership.configObject.id] : []) ?? null,
      operation: operation?.state ?? null,
      operationError: operation?.message ?? null,
      failedOperation: operation?.operation ?? null,
      catalogMode: applicationCatalogMode,
      requireInstallRecord: false,
    });
    return {
      currentResolveError,
      lifecycle: applicationCatalogMode
        ? hostMarketplaceLifecycle({
            lifecycle,
            plugin: detailRow.plugin,
            installation: detailRow.hostInstallation,
            resolved: resolvedCache.current,
            operation: actionId === detailRow.plugin.id ? hostAction : null,
          })
        : lifecycle,
      resolutionState,
      resolvedCache,
    };
  })() : null;

  const detailContent = detailRow?.source === "cloud" && cloudDetailContext ? (
        <MarketplacePackageDetailModal
          presentation={inlineDetails ? "page" : "modal"}
          row={detailRow}
          lifecycle={cloudDetailContext.lifecycle}
          resolved={cloudDetailContext.resolvedCache.lastKnownGood}
          resolutionState={cloudDetailContext.resolutionState}
          resolveError={cloudDetailContext.currentResolveError}
          orgMcpConnections={orgMcpConnections}
          orgMcpConnectingId={orgMcpConnectingId}
          onClose={() => setDetailSelection(null)}
          onOpenAccount={onOpenAccount}
          onConnectOrgMcp={onConnectOrgMcp}
          onRemovePlugin={applicationCatalogMode ? deleteHostPlugin : removePlugin}
          onInstallPlugin={applicationCatalogMode ? putHostPlugin : installPlugin}
          onRetryResolve={() => retryDetailResolution(detailRow.plugin)}
          accessHint={errorHint ?? marketplacePluginAccessHint}
          canMutate={applicationCatalogMode ? hostCanWrite : marketplacePluginAccess.allowed}
          applicationCatalog={applicationCatalogMode}
          hostInstallation={detailRow.hostInstallation}
        />
      ) : detailRow?.source === "host-registry" ? (
        <HostRegistryMarketplaceDetail installation={detailRow.installation} />
      ) : detailRow?.source === "built-in" ? (
        <BuiltInMarketplaceDetailModal
          presentation={inlineDetails ? "page" : "modal"}
          row={detailRow}
          disabled={builtInExtensionsDisabled}
          connecting={builtInConnectingName === detailRow.entry.name}
          configSlot={configSlotForBuiltIn?.(detailRow.entry) ?? null}
          onSetEnabled={setBuiltInEnabled}
          onClose={() => setDetailSelection(null)}
        />
      ) : detailRow?.source === "org-mcp" ? (
        <OrgMcpConnectionDetailModal
          row={detailRow}
          connecting={orgMcpConnectingId === detailRow.connection.id}
          disconnecting={orgMcpDisconnectingId === detailRow.connection.id}
          onClose={() => setDetailSelection(null)}
          onConnect={onConnectOrgMcp}
          onDisconnect={onDisconnectOrgMcp}
        />
      ) : detailRow?.source === "personal" ? (
        <ExtensionDetailModal
          open
          presentation={inlineDetails ? "page" : "modal"}
          onClose={() => setDetailSelection(null)}
          name={detailRow.plugin.name}
          description={detailRow.plugin.description || t("marketplace.no_description")}
          kind="plugin"
          connected
          showEnablementCard={false}
          configSlot={(
            <div className="space-y-1 text-sm">
              <div className="font-medium">{t("marketplace.technical_plugin_id")}</div>
              <div className="break-all font-mono text-xs text-dls-secondary">{detailRow.plugin.id}</div>
            </div>
          )}
        />
      ) : null;

  const detailActions = inlineDetails && detailRow?.source === "built-in" && setBuiltInEnabled && canSetJuggleWorkExtensionEnabled(detailRow.entry) ? (
    <Button
      variant={detailRow.active ? "destructive" : "default"}
      size="sm"
      disabled={builtInExtensionsDisabled || builtInConnectingName === detailRow.entry.name}
      onClick={() => requestBuiltInEnabled(detailRow, !detailRow.active, setBuiltInEnabled)}
    >
      {builtInConnectingName === detailRow.entry.name ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
      {builtInConnectingName === detailRow.entry.name
        ? t("marketplace.working")
        : t(detailRow.active ? "marketplace.disable_plugin" : "marketplace.enable_plugin")}
    </Button>
  ) : inlineDetails && detailRow?.source === "host-registry" ? (
    <Button
      variant="destructive"
      size="sm"
      disabled={Boolean(actionId) || !hostCanWrite}
      onClick={() => void deleteHostPlugin(detailRow.installation.pluginId, detailRow.installation.name)}
    >
      {actionId === detailRow.installation.pluginId ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
      {actionId === detailRow.installation.pluginId ? t("marketplace.lifecycle_removing") : t("marketplace.uninstall_plugin")}
    </Button>
  ) : inlineDetails && detailRow?.source === "cloud" && cloudDetailContext && (applicationCatalogMode ? detailRow.hostInstallation : detailRow.imported) && !isCloudBuiltInPlugin(detailRow.plugin) ? (
    <Button
      variant="destructive"
      size="sm"
      disabled={Boolean(actionId) || !(applicationCatalogMode ? hostCanWrite : marketplacePluginAccess.allowed) || cloudDetailContext.resolutionState !== "current"}
      onClick={() => void (applicationCatalogMode ? deleteHostPlugin : removePlugin)(detailRow.plugin.id, detailRow.plugin.name)}
    >
      {actionId === detailRow.plugin.id ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
      {actionId === detailRow.plugin.id ? t("marketplace.lifecycle_removing") : t("marketplace.uninstall_plugin")}
    </Button>
  ) : inlineDetails && detailRow?.source === "cloud" && cloudDetailContext && applicationCatalogMode && !detailRow.hostInstallation && hostCanWrite && cloudDetailContext.resolvedCache.current && hostMarketplacePackageRequiresInstallation(detailRow.sourceMarketplaceId ?? ORGANIZATION_PLUGINS_COLLECTION_ID, cloudDetailContext.resolvedCache.current) ? (
    <Button
      size="sm"
      disabled={Boolean(actionId) || cloudDetailContext.resolutionState !== "current"}
      onClick={() => void putHostPlugin(detailRow.sourceMarketplaceId, detailRow.plugin)}
    >
      {actionId === detailRow.plugin.id ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
      {actionId === detailRow.plugin.id ? t("marketplace.lifecycle_installing") : t("marketplace.install_plugin")}
    </Button>
  ) : inlineDetails && detailRow?.source === "personal" && detailRow.plugin.spec && onUninstallPersonalPlugin ? (
    <Button
      variant="destructive"
      size="sm"
      disabled={Boolean(actionId)}
      onClick={() => {
        if (actionId) return;
        setActionId(detailRow.plugin.id);
        setActionError(null);
        Promise.resolve(onUninstallPersonalPlugin(detailRow.plugin))
          .then(() => setDetailSelection(null))
          .catch((error) => setActionError(error instanceof Error ? error.message : t("marketplace.uninstall_failed")))
          .finally(() => setActionId(null));
      }}
    >
      {actionId === detailRow.plugin.id ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
      {actionId === detailRow.plugin.id ? t("marketplace.working") : t("marketplace.uninstall_plugin")}
    </Button>
  ) : null;

  if (inlineDetails && detailRow) {
    const name = detailRow.source === "built-in" ? detailRow.entry.name
      : detailRow.source === "org-mcp" ? detailRow.item.name
        : detailRow.source === "host-registry" ? detailRow.installation.name : detailRow.plugin.name;
    return (
      <CatalogDetailPage
        categoryLabel={title ?? t("extensions.marketplace_title")}
        name={name}
        description={detailRow.source === "cloud"
          ? detailRow.plugin.description || t("marketplace.no_description")
          : detailRow.source === "host-registry"
            ? detailRow.installation.description || t("marketplace.no_description")
            : undefined}
        actions={detailActions}
        onBack={() => setDetailSelection(null)}
      >
        {detailContent}
      </CatalogDetailPage>
    );
  }

  // hideSectionHeader 时宿主（技能弹窗）自带标题与边距，不再套设置页的分隔线容器。
  return source || embedded || hideSectionHeader ? <>{content}{detailContent}</> : (
    <SettingsStack>
      <Separator />
      {content}
      {detailContent}
    </SettingsStack>
  );
}

function HostRegistryMarketplaceDetail({ installation }: { installation: JuggleWorkHostMarketplaceInstallation }) {
  return (
    <div className="min-w-0 space-y-5 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsPill>{t("marketplace.organization_plugins")}</SettingsPill>
        <SettingsPill>{t(installation.status === "installed" ? "marketplace.lifecycle_current" : "marketplace.lifecycle_repair_required")}</SettingsPill>
      </div>
      {installation.status === "repair_required" && installation.repair?.cause ? (
        <SettingsNotice tone="error">{installation.repair.cause}</SettingsNotice>
      ) : null}
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-card-foreground">{t("marketplace.host_recorded_resources")}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("marketplace.host_recorded_resources_description", { count: installation.resources.length })}
          </p>
        </div>
        {installation.resources.length > 0 ? (
          <div className="grid gap-2">
            {installation.resources.map((resource) => (
              <div key={`${resource.kind}:${resource.target}`} className="flex min-w-0 items-start justify-between gap-3 rounded-xl border border-dls-border bg-dls-surface px-4 py-3">
                <div className="min-w-0">
                  <div className="break-all text-sm font-medium text-card-foreground">{resource.target}</div>
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{resource.componentId}</div>
                </div>
                <SettingsPill>{t(`marketplace.host_resource_${resource.kind}`)}</SettingsPill>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-sm text-muted-foreground">
            {t("marketplace.host_recorded_no_resources")}
          </div>
        )}
      </section>
      <details className="rounded-xl border border-dls-border bg-dls-surface px-4 py-3" open>
        <summary className="cursor-pointer text-sm font-semibold text-card-foreground">{t("marketplace.technical_details_title")}</summary>
        <div className="mt-4 grid gap-3 text-xs text-muted-foreground sm:grid-cols-3">
          <div><span className="font-semibold text-card-foreground">{t("marketplace.technical_plugin_id")}</span><div className="mt-1 break-all font-mono">{installation.pluginId}</div></div>
          <div><span className="font-semibold text-card-foreground">{t("marketplace.host_recorded_revision")}</span><div className="mt-1 break-all font-mono">{installation.packageRevision}</div></div>
          <div><span className="font-semibold text-card-foreground">{t("marketplace.host_recorded_status")}</span><div className="mt-1">{t(installation.status === "installed" ? "marketplace.lifecycle_current" : "marketplace.lifecycle_repair_required")}</div></div>
        </div>
      </details>
    </div>
  );
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

export function requestBuiltInEnabled(
  row: BuiltInMarketplaceRow,
  enabled: boolean,
  onSetEnabled: (entry: McpDirectoryInfo, enabled: boolean) => void,
  onSetupRequired?: () => void,
) {
  if (enabled && !row.setupReady) {
    onSetupRequired?.();
    toast.warning(t("marketplace.enable_setup_required", { name: row.entry.name }), {
      description: row.unmetRequirements.length > 0
        ? t("marketplace.enable_setup_missing", { requirements: row.unmetRequirements.join(", ") })
        : t("marketplace.enable_setup_open_detail"),
    });
    return;
  }
  onSetEnabled(row.entry, enabled);
}

function MarketplaceCard(props: {
  actionId: string | null;
  row: Exclude<MarketplaceRow, PersonalMarketplaceRow | HostRegistryMarketplaceRow>;
  onOpenDetail: (row: MarketplaceRow) => void;
  orgMcpConnectingId: string | null;
  orgMcpDisconnectingId: string | null;
  onDisconnectOrgMcp?: (connectionId: string) => void;
  builtInDisabled: boolean;
  builtInConnectingName: string | null;
  highlighted?: boolean;
  plain?: boolean;
  applicationCatalog: boolean;
  hostCanWrite: boolean;
  hostOperation: "put" | "delete" | null;
  resolved: DenOrgPluginResolved | null;
  canMutate: boolean;
  onInstallPlugin: (marketplaceId: string | null, plugin: DenOrgPlugin) => void | Promise<void>;
  onRemovePlugin: (pluginId: string, pluginName: string) => void | Promise<void>;
  onSetBuiltInEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
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
    const canSetEnabled = canSetJuggleWorkExtensionEnabled(row.entry);
    const entryUrl = typeof row.entry.url === "string" ? row.entry.url : undefined;
    return (
      <div ref={highlightRef} className={`relative ${highlightClass}`}>
        <ExtensionCard
          name={row.entry.name}
          description={row.entry.description}
          iconSlug={row.entry.iconSlug}
          iconSrc={row.entry.iconSrc}
          url={entryUrl}
          kind={row.entry.kind ?? "extension"}
          preview={row.entry.preview}
          connected={row.active}
          statusBadge="icon-only"
          connecting={actionBusy}
          disabled={props.builtInDisabled}
          disabledReason={props.builtInDisabled ? "Disabled by organization" : null}
          plain={props.plain}
          onClick={() => onOpenDetail(row)}
        />
        <PluginCardAction
          installed
          busy={actionBusy}
          builtIn
          enabled={row.active}
          disabled={props.builtInDisabled || !canSetEnabled || !props.onSetBuiltInEnabled}
          onToggle={canSetEnabled && props.onSetBuiltInEnabled
            ? () => requestBuiltInEnabled(
                row,
                !row.active,
                props.onSetBuiltInEnabled as NonNullable<typeof props.onSetBuiltInEnabled>,
                () => onOpenDetail(row),
              )
            : undefined}
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
  const lifecycle = props.applicationCatalog
    ? hostMarketplaceLifecycle({
        lifecycle: row.lifecycle,
        plugin: row.plugin,
        installation: row.hostInstallation,
        resolved: props.resolved,
        operation: props.hostOperation,
      })
    : row.lifecycle;
  const compositionSummary = deliveryCompositionSummary(row.delivery);
  const current = lifecycle.state === "current";
  const installed = cloudBuiltIn || Boolean(props.applicationCatalog ? row.hostInstallation : row.imported);
  const requiresHostInstallation = props.resolved
    ? hostMarketplacePackageRequiresInstallation(
        row.sourceMarketplaceId ?? ORGANIZATION_PLUGINS_COLLECTION_ID,
        props.resolved,
      )
    : marketplacePluginMayRequireHostInstallation(row.plugin);
  const canInstall = !props.applicationCatalog || (props.hostCanWrite && requiresHostInstallation);

  return (
    <div ref={highlightRef} className={`relative flex flex-col gap-2 ${highlightClass}`}>
      <ExtensionCard
        name={row.plugin.name}
        description={row.plugin.description || `Marketplace extension from ${row.marketplaceName}.`}
        iconSlug={manifest?.icon?.simpleIconSlug}
        iconSrc={manifest?.icon?.src}
        kind="extension"
        connected={cloudBuiltIn || current}
        statusBadge="icon-only"
        connecting={actionBusy}
        actionLabel={cloudBuiltIn
          ? t("mcp.view_details")
          : props.applicationCatalog
            ? undefined
            : compositionSummary ?? t(`marketplace.delivery_${lifecycle.delivery}`)}
        plain={props.plain}
        onClick={() => onOpenDetail(row)}
      />
      <PluginCardAction
        installed={installed}
        busy={actionBusy}
        builtIn={cloudBuiltIn}
        disabled={!props.canMutate || (!installed && !canInstall)}
        canUninstall={!cloudBuiltIn}
        updateAvailable={props.applicationCatalog && lifecycle.state === "update_available"}
        onInstall={canInstall ? () => void props.onInstallPlugin(row.sourceMarketplaceId, row.plugin) : undefined}
        onUninstall={() => void props.onRemovePlugin(row.plugin.id, row.plugin.name)}
      />
    </div>
  );
}

function PluginCardAction(props: {
  installed: boolean;
  busy: boolean;
  builtIn?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  canUninstall?: boolean;
  updateAvailable?: boolean;
  onInstall?: () => void;
  onUninstall?: () => void;
  onToggle?: () => void;
}) {
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  const buttonClass = "flex size-8 items-center justify-center rounded-lg border border-dls-border bg-dls-surface/95 p-0 text-dls-secondary shadow-sm transition-colors hover:bg-dls-hover hover:text-dls-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

  if (!props.installed) {
    if (!props.onInstall) return null;
    return (
      <div className="absolute right-2.5 top-2.5 z-10 size-8" onClick={stop}>
        <button
          type="button"
          className={buttonClass}
          aria-label={t("marketplace.install_plugin")}
          title={t("marketplace.install_plugin")}
          disabled={props.disabled || props.busy || !props.onInstall}
          onClick={() => props.onInstall?.()}
        >
          {props.busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </button>
      </div>
    );
  }

  return (
    <div className="absolute right-2.5 top-2.5 z-10 size-8" onClick={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={buttonClass}
          aria-label={t("marketplace.plugin_actions")}
          title={t("marketplace.plugin_actions")}
          disabled={props.busy}
        >
          {props.busy ? <Loader2 className="size-4 animate-spin" /> : <Ellipsis className="size-4" />}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          {props.builtIn ? (
            <DropdownMenuItem disabled={props.disabled || !props.onToggle} onClick={props.onToggle}>
              <Power className="size-4" />
              {t(props.enabled ? "marketplace.disable_plugin" : "marketplace.enable_plugin")}
            </DropdownMenuItem>
          ) : (
            <>
              {props.updateAvailable ? (
                <DropdownMenuItem disabled={props.disabled || !props.onInstall} onClick={props.onInstall}>
                  <Plus className="size-4" />
                  {t("marketplace.action_update")}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                variant="destructive"
                disabled={props.disabled || props.canUninstall === false || !props.onUninstall}
                onClick={props.onUninstall}
              >
                <Trash2 className="size-4" />
                {t("marketplace.uninstall_plugin")}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function BuiltInMarketplaceDetailModal(props: {
  presentation?: "modal" | "page";
  row: BuiltInMarketplaceRow;
  disabled: boolean;
  connecting: boolean;
  configSlot: React.ReactNode | null;
  onSetEnabled?: (entry: McpDirectoryInfo, enabled: boolean) => void;
  onClose: () => void;
}) {
  const { row, disabled, connecting, configSlot, onClose, onSetEnabled } = props;
  const entry = row.entry;
  const canSetEnabled = canSetJuggleWorkExtensionEnabled(entry);
  return (
    <ExtensionDetailModal
      presentation={props.presentation}
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
      onConnect={props.presentation !== "page" && !disabled && canSetEnabled && !row.active && onSetEnabled
        ? () => requestBuiltInEnabled(row, true, onSetEnabled)
        : undefined}
      onUninstall={props.presentation !== "page" && !disabled && canSetEnabled && row.active && onSetEnabled
        ? () => requestBuiltInEnabled(row, false, onSetEnabled)
        : undefined}
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

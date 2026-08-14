import type {
  DenExternalMcpConnection,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenOrgSummary,
  DenPluginCloudReadiness,
  DenPluginMcpComponent,
} from "@/app/lib/den";
import { t } from "@/i18n";
import { connectionNeedsReconnect } from "@/react-app/domains/connections/native-provider-connections";

export type ConnectRowGroup = "needs_signin" | "ready" | "needs_admin_setup" | "excluded";
export type ConnectOrgRole = DenOrgSummary["role"] | null | undefined;

const instructionalTypes = new Set(["agent", "command", "context", "custom", "skill"]);
const desktopInstallTypes = new Set(["hook", "tool"]);

/** 插件的投递构成，按最弱环节聚合。 */
export type PluginDeliveryComposition = {
  kind: "cloud" | "desktop" | "mixed";
  cloudCount: number;
  desktopCount: number;
  total: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * 从 MCP 配置对象的 payload 推断承载明细。
 *
 * TIPS: 后端两种下发键名都要认——控制台写入的 `mcp` 与历史数据的 `mcpServers`。
 * 判据只看实际字段：有 url 即云端可承载，只有启动命令则必须由桌面端拉起子进程；
 * `type` 字段由录入方填写，可能与实际字段不符，不作为判据。
 *
 * @param configObjectId 配置对象 ID
 * @param payload 规范化 payload
 */
function inferComponentsFromPayload(configObjectId: string, payload: unknown): DenPluginMcpComponent[] {
  if (!isRecord(payload)) return [];
  const servers = isRecord(payload.mcp)
    ? payload.mcp
    : isRecord(payload.mcpServers) ? payload.mcpServers : null;
  const entries: Array<[string, unknown]> = servers
    ? Object.entries(servers).sort(([left], [right]) => left.localeCompare(right))
    : [["", payload]];
  return entries.flatMap<DenPluginMcpComponent>(([serverName, config]) => {
    if (!isRecord(config)) return [];
    const url = typeof config.url === "string" ? config.url.trim() : "";
    const command = Array.isArray(config.command)
      ? config.command.filter((part): part is string => typeof part === "string")
      : [];
    if (url) return [{ configObjectId, serverName, delivery: "cloud", url }];
    if (command.length > 0) return [{ configObjectId, serverName, delivery: "desktop", command }];
    return [];
  });
}

/**
 * 解析插件的 MCP 承载明细。
 *
 * 服务端下发 `cloudReadiness.components` 时以它为准（它还带连接绑定与授权状态）；
 * 旧服务端不下发时回落到已解析的配置对象 payload 自行推断，展示结果保持一致。
 *
 * @param plugin 插件（可能带 cloudReadiness）
 * @param resolved 已解析的插件内容，缺 components 时用于推断
 */
export function resolvePluginMcpComponents(
  plugin: Pick<DenOrgPlugin, "cloudReadiness">,
  resolved?: DenOrgPluginResolved | null,
): DenPluginMcpComponent[] {
  const provided = plugin.cloudReadiness?.components ?? [];
  if (provided.length > 0) return provided;
  return (resolved?.memberships ?? []).flatMap((membership) => {
    const object = membership.configObject;
    if (!object || object.objectType !== "mcp" || object.status !== "active") return [];
    return inferComponentsFromPayload(object.id, object.latestVersion?.normalizedPayloadJson);
  });
}

/**
 * 聚合插件的投递构成。只要含一个 desktop 组件，插件就不是纯云端可用的。
 *
 * @param components MCP 承载明细
 * @returns 无 MCP 组件时返回 null
 */
export function aggregatePluginDelivery(components: DenPluginMcpComponent[]): PluginDeliveryComposition | null {
  if (components.length === 0) return null;
  const cloudCount = components.filter((component) => component.delivery === "cloud").length;
  const desktopCount = components.length - cloudCount;
  return {
    kind: desktopCount === 0 ? "cloud" : cloudCount === 0 ? "desktop" : "mixed",
    cloudCount,
    desktopCount,
    total: components.length,
  };
}

export function isConnectAdminRole(role: ConnectOrgRole) {
  return role === "owner" || role === "admin";
}

export function pluginHasInstructionalComponents(componentCounts: Record<string, number>) {
  return Object.entries(componentCounts).some(([type, count]) => count > 0 && instructionalTypes.has(type));
}

export function pluginHasDesktopInstallComponents(plugin: Pick<DenOrgPlugin, "componentCounts" | "extension">) {
  if (Object.entries(plugin.componentCounts).some(([type, count]) => count > 0 && desktopInstallTypes.has(type))) return true;
  return plugin.extension?.manifest?.resources.some((resource) => desktopInstallTypes.has(resource.type)) === true;
}

export function isDesktopInstallableMarketplacePlugin(plugin: Pick<DenOrgPlugin, "cloudReadiness" | "componentCounts" | "extension">) {
  const readiness = plugin.cloudReadiness;
  if (!readiness) return pluginHasDesktopInstallComponents(plugin);
  return readiness.state === "desktop_only" || readiness.state === "not_synced";
}

export function resolveConnectRowGroup(
  readiness: DenPluginCloudReadiness | null | undefined,
  role: ConnectOrgRole,
  componentCounts: Record<string, number> = {},
): ConnectRowGroup {
  if (!readiness) return pluginHasInstructionalComponents(componentCounts) ? "ready" : "excluded";
  switch (readiness.state) {
    case "ready":
      return "ready";
    case "needs_signin":
      return "needs_signin";
    case "needs_admin_setup":
      return isConnectAdminRole(role) ? "needs_admin_setup" : "excluded";
    case "desktop_only":
    case "not_synced":
      return "excluded";
  }
}

export function resolveConnectionRowGroup(connection: Pick<DenExternalMcpConnection, "credentialMode" | "connectedForMe" | "needsReconnect" | "missingFeatures" | "reconnectActionOwner">): Exclude<ConnectRowGroup, "excluded"> {
  if (connection.needsReconnect && connection.reconnectActionOwner === "organization_admin") return "needs_admin_setup";
  if (connection.credentialMode === "per_member" && (!connection.connectedForMe || connectionNeedsReconnect(connection))) return "needs_signin";
  return "ready";
}

function componentTypeLabel(type: string, count: number) {
  switch (type) {
    case "agent":
      return t("connect.row_component_agent", { count });
    case "command":
      return t("connect.row_component_command", { count });
    case "context":
      return t("connect.row_component_context", { count });
    case "custom":
      return t("connect.row_component_custom", { count });
    case "mcp":
      return t("connect.row_component_mcp", { count });
    case "skill":
      return t("connect.row_component_skill", { count });
    case "hook":
      return t("connect.row_component_hook", { count });
    case "tool":
      return t("connect.row_component_tool", { count });
    default:
      return type;
  }
}

export function formatPluginComponentMeta(componentCounts: Record<string, number>) {
  const labels = Object.entries(componentCounts)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => t("connect.row_component_count", { count, type: componentTypeLabel(type, count) }));
  return labels.length > 0 ? labels.join(t("connect.row_meta_separator")) : t("connect.row_meta_no_components");
}

export function cloudReadinessConnectableConnectionId(readiness: DenPluginCloudReadiness | null | undefined) {
  return readiness?.connections.find((connection) => connection.id && connection.credentialMode === "per_member" && connection.connectedForMe === false)?.id ?? null;
}

export function cloudReadinessMissingConnectionNames(readiness: DenPluginCloudReadiness | null | undefined) {
  return readiness?.connections.flatMap((connection) => connection.id === null ? [connection.name] : []) ?? [];
}

export function formatPluginConnectRowMeta(plugin: Pick<DenOrgPlugin, "cloudReadiness" | "componentCounts">) {
  if (plugin.cloudReadiness?.state === "needs_admin_setup") {
    const missing = cloudReadinessMissingConnectionNames(plugin.cloudReadiness);
    if (plugin.cloudReadiness.hasInstructional) {
      const setupNames = missing.length > 0 ? `${t("connect.row_meta_separator")}${t("connect.row_meta_needs_setup_names", { names: missing.join(t("connect.row_meta_list_separator")) })}` : "";
      return `${t("connect.row_meta_instructional_needs_setup")}${setupNames}`;
    }
    if (missing.length > 0) return t("connect.row_meta_needs_setup_names", { names: missing.join(t("connect.row_meta_list_separator")) });
  }
  return formatPluginComponentMeta(plugin.componentCounts);
}

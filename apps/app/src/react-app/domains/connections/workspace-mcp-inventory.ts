import type { DenMcpWorkspaceConnectionPolicy } from "@/app/lib/den";
import type { McpServerEntry, McpStatusMap } from "@/app/types";

export const INTERNAL_CLOUD_MCP_TRANSPORT_NAME = "jugglework-cloud";

/** 内部 Cloud capability transport 不属于用户可选择的业务 MCP。 */
export function isInternalCloudMcpTransport(entry: Pick<McpServerEntry, "name">): boolean {
  return entry.name.trim().toLowerCase() === INTERNAL_CLOUD_MCP_TRANSPORT_NAME;
}

/** 从输入栏 Cloud 条目 ID 中读取底层组织 connectionId。 */
export function cloudConnectionIdFromMcpEntry(entry: McpServerEntry): string | null {
  const prefix = "jugglework-connect:connection:";
  return entry.id?.startsWith(prefix) ? entry.id.slice(prefix.length) : null;
}

/**
 * 将会话输入栏 MCP 投影到与右侧连接器一致的工作区真值。
 *
 * @param servers 已聚合的本地/Cloud MCP
 * @param statuses runtime 与 Cloud 状态
 * @param disabledServerNames 普通 MCP 软策略关闭项
 * @param cloudPolicy Cloud connection 工作区策略
 */
export function applyWorkspaceMcpInventoryPolicy(input: {
  servers: McpServerEntry[];
  statuses: McpStatusMap;
  disabledServerNames: string[];
  cloudPolicy: DenMcpWorkspaceConnectionPolicy[];
}): { servers: McpServerEntry[]; statuses: McpStatusMap } {
  const disabled = new Set(input.disabledServerNames);
  const cloudEnabled = new Map(input.cloudPolicy.map((item) => [item.connectionId, item.enabled]));
  const servers = input.servers
    .filter((entry) => !isInternalCloudMcpTransport(entry))
    .map((entry) => {
      const connectionId = cloudConnectionIdFromMcpEntry(entry);
      const workspaceEnabled = connectionId
        ? cloudEnabled.get(connectionId) !== false
        : entry.source === "config.project" || entry.source === "config.remote"
          ? !disabled.has(entry.name)
          : true;
      return { ...entry, workspaceEnabled };
    });
  return { servers, statuses: { ...input.statuses } };
}

/** 输入栏只展示右侧连接器可管理的 Cloud connection，不展开插件包内部 MCP。 */
export function isComposerManageableMcpEntry(entry: McpServerEntry): boolean {
  return entry.origin !== "jugglework-connect" || entry.id?.startsWith("jugglework-connect:connection:") === true;
}

/**
 * 输入栏是能力选择面，不是连接管理面：只保留本工作区允许且当前连接成功的 MCP。
 */
export function selectComposerAvailableMcpEntries(input: {
  servers: McpServerEntry[];
  statuses: McpStatusMap;
}): McpServerEntry[] {
  return input.servers.filter((entry) => {
    if (entry.workspaceEnabled === false) return false;
    return input.statuses[entry.id ?? entry.name]?.status === "connected";
  });
}

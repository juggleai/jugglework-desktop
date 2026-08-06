import type { McpDirectoryInfo } from "@/app/constants";
import { getMcpServerName } from "@/app/constants";
import { getMcpIdentityKey } from "@/app/mcp";
import type { McpServerEntry, McpStatusMap } from "@/app/types";
import { isOrgMcpConnectionReady, type ExtensionItem } from "../../extension-items";
import type { ConnectorRow } from "./types";

/**
 * 连接器聚合的输入：三类来源与对应的连接/断开动作。
 */
export type BuildConnectorsInput = {
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
  quickConnect: McpDirectoryInfo[];
  orgMcpItems: ExtensionItem[];
  mcpConnectingName: string | null;
  orgMcpConnectingId: string | null;
  orgMcpDisconnectingId: string | null;
  connectDirectory: (entry: McpDirectoryInfo) => void;
  authorizeMcp: (entry: McpServerEntry) => void;
  removeMcp: (name: string) => void;
  connectOrg: (connectionId: string) => void;
  disconnectOrg: (connectionId: string) => void;
};

// 已装 MCP 是否处于已连接状态：被显式禁用视为未连接。
function isServerConnected(entry: McpServerEntry, statuses: McpStatusMap): boolean {
  if (entry.config.enabled === false) return false;
  return statuses[entry.name]?.status === "connected";
}

/**
 * 汇总「已装 MCP + 快速连接目录 + 组织下发连接器」为统一的连接器行，按身份去重。
 * 复用既有连接/授权/断开动作，不新造连接逻辑。
 */
export function buildProjectConnectors(input: BuildConnectorsInput): ConnectorRow[] {
  const rows: ConnectorRow[] = [];
  const seen = new Set<string>();

  const push = (row: ConnectorRow, identity: string) => {
    const key = identity.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  // 1) 已装 MCP 服务（优先级最高）。
  for (const server of input.mcpServers) {
    const connected = isServerConnected(server, input.mcpStatuses);
    push(
      {
        key: `installed:${server.name}`,
        name: server.name,
        description: undefined,
        connected,
        source: "installed",
        busy: input.mcpConnectingName === server.name,
        onConnect: connected ? undefined : () => input.authorizeMcp(server),
        onDisconnect: connected ? () => input.removeMcp(server.name) : undefined,
      },
      server.name,
    );
  }

  // 2) 组织下发连接器。
  for (const item of input.orgMcpItems) {
    const connection = item.orgMcpConnection;
    if (!connection) continue;
    const connected = isOrgMcpConnectionReady(connection);
    push(
      {
        key: `org:${connection.id}`,
        name: item.name,
        description: item.description,
        connected,
        source: "org",
        busy: input.orgMcpConnectingId === connection.id || input.orgMcpDisconnectingId === connection.id,
        onConnect: connected ? undefined : () => input.connectOrg(connection.id),
        onDisconnect: connected ? () => input.disconnectOrg(connection.id) : undefined,
      },
      item.name,
    );
  }

  // 3) 快速连接目录中尚未安装的项。
  for (const entry of input.quickConnect) {
    const identity = getMcpIdentityKey(entry);
    const alreadyInstalled = input.mcpServers.some((server) => server.name === identity);
    if (alreadyInstalled) continue;
    push(
      {
        key: `directory:${identity}`,
        name: entry.name || getMcpServerName(entry),
        description: entry.description,
        connected: false,
        source: "directory",
        busy: input.mcpConnectingName === identity,
        onConnect: () => input.connectDirectory(entry),
      },
      identity,
    );
  }

  return rows;
}

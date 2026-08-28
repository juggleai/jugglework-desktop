import type { McpDirectoryInfo } from "@/app/constants";
import { getMcpServerName } from "@/app/constants";
import { extensionResource } from "@/app/extensions";
import type { McpServerEntry, McpStatusMap } from "@/app/types";
import { canDisconnectOrgMcpConnection } from "@/react-app/domains/connections/native-provider-connections";
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
  setMcpEnabled: (name: string, enabled: boolean) => void;
  connectOrg: (connectionId: string) => void;
  disconnectOrg: (connectionId: string) => void;
};

// 已装 MCP 是否处于已连接状态：被显式禁用视为未连接。
function isServerConnected(entry: McpServerEntry, statuses: McpStatusMap): boolean {
  if (entry.config.enabled === false) return false;
  return statuses[entry.name]?.status === "connected";
}

/**
 * 取失败状态下引擎报告的错误原文。
 * @param status 该 server 的运行状态
 *
 * TIPS: 不做任何改写——`Please provide a database URL as a command-line argument`
 * 这类服务器自述的失败原因，比任何「连接失败，请检查配置」都更能指向要补的参数。
 */
export function readConnectorErrorDetail(status: McpStatusMap[string] | undefined): string | undefined {
  if (!status || status.status !== "failed") return undefined;
  const error = "error" in status ? status.error?.trim() : "";
  return error ? error : undefined;
}

/**
 * 判断目录项是否由 MCP 提供能力。
 * @param entry 快速连接目录项
 */
export function isMcpConnectorEntry(entry: McpDirectoryInfo): boolean {
  const kind = entry.kind ?? "mcp";
  if (kind === "mcp" || kind === "ui-control") return true;
  return Boolean(extensionResource(entry.extensionManifest, "mcp"));
}

/**
 * 把不透明的连接失败原因翻译成可行动的提示键。
 * @param detail 引擎报告的错误原文
 * @returns i18n 键；无法归类时返回 undefined
 *
 * TIPS: `-32000 connection closed` 只说明子进程退出了，不说为什么——引擎不透出子进程 stderr。
 * 这类不透明错误配一句「常见原因」比让用户对着错误码干瞪眼有用，但原文仍要照常展示。
 */
export function explainConnectorErrorKey(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const text = detail.toLowerCase();
  if (text.includes("enoent") || text.includes("command not found")) {
    return "mcp.error_hint_command_not_found";
  }
  if (text.includes("-32000") || text.includes("connection closed")) {
    return "mcp.error_hint_process_exited";
  }
  if (text.includes("timed out") || text.includes("timeout")) {
    return "mcp.error_hint_timeout";
  }
  return undefined;
}

/**
 * 汇总「已装 MCP + 快速连接目录 + 组织下发连接器」为统一的连接器行，按身份去重。
 * 复用既有连接/授权/断开动作，不新造连接逻辑。
 */
export function buildProjectConnectors(input: BuildConnectorsInput): ConnectorRow[] {
  const rows: ConnectorRow[] = [];
  const seen = new Set<string>();
  // TIPS: 快速连接目录同时承载插件、Provider 与本地服务；连接器面板只展示 MCP 能力。
  const mcpQuickConnect = input.quickConnect.filter(isMcpConnectorEntry);

  const push = (row: ConnectorRow, identity: string) => {
    const key = identity.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };
  const canonicalIdentity = (value: string) => value.trim().toLowerCase();

  // TIPS: 已装 MCP 大多来自快速连接目录，按身份回查目录项即可复用其图标与描述，
  // 否则列表里只能显示默认占位头像。
  const directoryByIdentity = new Map(
    mcpQuickConnect.map((entry) => [canonicalIdentity(getMcpServerName(entry)), entry] as const),
  );

  // 1) 已装 MCP 服务（优先级最高）。
  for (const server of input.mcpServers) {
    const runtimeConnected = isServerConnected(server, input.mcpStatuses);
    const directory = directoryByIdentity.get(canonicalIdentity(server.name));
    const disabled = server.config.enabled === false;
    const failed = input.mcpStatuses[server.name]?.status === "failed";
    // 已配置且已运行、启动失败或被主动关闭的 MCP 都留在「已连接」。开关表示
    // 是否在本工作区生效，不应因为关闭或一次启动失败就把条目挪到「未连接」。
    const connected = runtimeConnected || disabled || failed;
    const isCustom = !directory;
    push(
      {
        key: `installed:${server.name}`,
        name: directory?.name || server.name,
        description: directory?.description,
        connected,
        source: "installed",
        mcpSource: server.source,
        busy: input.mcpConnectingName === server.name,
        iconSlug: directory?.iconSlug,
        iconSrc: directory?.iconSrc,
        url: server.config.url ?? directory?.url,
        command: server.config.command ?? directory?.command,
        preview: directory?.preview,
        errorDetail: readConnectorErrorDetail(input.mcpStatuses[server.name]),
        disabled,
        // TIPS: 自定义 MCP 没有目录项兜底——删掉就连同命令与环境变量一起消失，且列表里不留痕迹。
        // 所以它的「断开」是停用（配置留着，可一键启用）；目录条目删掉还能从目录一键重加，维持原语义。
        disconnectKind: isCustom ? "disable" : "remove",
        serverName: server.name,
        serverConfig: server.config,
        entry: directory,
        // TIPS: config.global 必须用全局配置专用接口修改。会话面板这里只读展示，
        // 不能误用工作区接口制造一个同名工作区覆盖。
        onConnect: server.source === "config.global" || connected
          ? undefined
          : disabled
            ? () => input.setMcpEnabled(server.name, true)
            : () => input.authorizeMcp(server),
        onDisconnect: server.source === "config.global" || server.source === "config.remote"
          ? undefined
          : connected
          ? isCustom
            ? () => input.setMcpEnabled(server.name, false)
            : () => input.removeMcp(server.name)
          : undefined,
        onRemove: server.source === "config.global" ? undefined : () => input.removeMcp(server.name),
      },
      server.name,
    );
  }

  // 2) 组织下发的 Cloud MCP。它们与本地 MCP 属于不同执行轨道，即使同名也必须
  // 分别展示；工作区策略严格按 connectionId 写入，不能按展示名称去重。
  for (const item of input.orgMcpItems) {
    const connection = item.orgMcpConnection;
    if (!connection) continue;
    const connected = isOrgMcpConnectionReady(connection);
    const policyConnected = connection.credentialMode === "shared"
      ? connection.connected
      : connection.connectedForMe;
    // TIPS: 只有成员凭证（per_member）连接才由成员自己断开；组织共享凭证由管理员维护，
    // 成员侧不出「断开」按钮，避免点击后无任何效果。
    const canDisconnect = canDisconnectOrgMcpConnection(connection);
    push(
      {
        key: `org:${connection.id}`,
        name: item.name,
        description: item.description,
        // 已完成账号授权就属于「已连接」。缺少可选能力或需要重连会继续显示状态/动作，
        // 但不能因此把已授权 MCP 移到未连接分组并让工作区开关消失。
        connected: policyConnected,
        source: "org",
        busy: input.orgMcpConnectingId === connection.id || input.orgMcpDisconnectingId === connection.id,
        url: connection.url,
        onConnect: connected ? undefined : () => input.connectOrg(connection.id),
        onDisconnect: connected && canDisconnect ? () => input.disconnectOrg(connection.id) : undefined,
      },
      `org:${connection.id}`,
    );
  }

  // 3) 快速连接目录中尚未安装的项。
  for (const entry of mcpQuickConnect) {
    const identity = getMcpServerName(entry);
    const alreadyInstalled = input.mcpServers.some((server) => canonicalIdentity(server.name) === canonicalIdentity(identity));
    if (alreadyInstalled) continue;
    push(
      {
        key: `directory:${identity}`,
        name: entry.name || getMcpServerName(entry),
        description: entry.description,
        connected: false,
        source: "directory",
        busy: input.mcpConnectingName === identity,
        iconSlug: entry.iconSlug,
        iconSrc: entry.iconSrc,
        url: entry.url,
        command: entry.command,
        preview: entry.preview,
        entry,
        onConnect: () => input.connectDirectory(entry),
      },
      identity,
    );
  }

  return rows;
}

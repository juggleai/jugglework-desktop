import type {
  DenExternalMcpConnection,
  DenOrgMarketplace,
  DenOrgMarketplaceResolved,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginCloudReadinessConnection,
  DenPluginConfigObject,
  DenPluginMcpComponent,
} from "@/app/lib/den";
import type { McpServerEntry, McpStatus, McpStatusMap, SkillCard, SlashCommandOption } from "@/app/types";
import { isOrgMcpConnectionReady } from "@/react-app/domains/connections/native-provider-connections";

type ConnectCapabilityClient = {
  listOrgMarketplaces: (organizationId: string) => Promise<DenOrgMarketplace[]>;
  listMcpConnections: (
    organizationId: string,
    scope: "usable",
  ) => Promise<DenExternalMcpConnection[]>;
  getOrgMarketplaceResolved: (
    organizationId: string,
    marketplaceId: string,
  ) => Promise<DenOrgMarketplaceResolved>;
  getOrgPluginResolved: (
    organizationId: string,
    plugin: DenOrgPlugin,
  ) => Promise<DenOrgPluginResolved>;
};

export type ConnectCapabilityInventory = {
  commands: ConnectCommandOption[];
  skills: ConnectSkillCard[];
  mcpServers: McpServerEntry[];
  mcpStatuses: McpStatusMap;
};

export type ConnectSkillCard = SkillCard & {
  content?: string;
  connectPluginId: string;
};

export type ConnectCommandOption = SlashCommandOption & {
  origin: "jugglework-connect";
  connectCapabilityName: string;
  connectPluginId: string;
};

export const EMPTY_CONNECT_CAPABILITY_INVENTORY: ConnectCapabilityInventory = {
  commands: [],
  skills: [],
  mcpServers: [],
  mcpStatuses: {},
};

type MarketplacePlugin = {
  marketplace: DenOrgMarketplace;
  plugin: DenOrgPlugin;
};

type RemoteMcpSpec = {
  name: string;
  url: string;
  /** stdio 型 MCP 的启动命令；有值即表示只能在桌面端本地运行。 */
  command?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function marketplaceCapabilityName(kind: "skill" | "command" | "mcp", configObjectId: string) {
  return `${kind}:${configObjectId}`;
}

function skillTrigger(object: DenPluginConfigObject) {
  const path = object.currentRelativePath?.replaceAll("\\", "/");
  return path?.match(/(?:^|\/)skills?\/([^/]+)\/SKILL\.md$/i)?.[1];
}

function commandName(object: DenPluginConfigObject) {
  const path = object.currentRelativePath?.replaceAll("\\", "/") ?? "";
  const fileName = path.match(/(?:^|\/)commands?\/.*\/([^/]+)\.md$/i)?.[1]
    ?? path.match(/(?:^|\/)([^/]+)\.md$/i)?.[1]
    ?? object.currentFileName?.replace(/\.md$/i, "")
    ?? object.title;
  const normalized = fileName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || object.id;
}

/**
 * 解析 MCP 配置对象里的服务清单。
 * TIPS: 后端两种下发形态都要认——`mcpServers`（仅远程 URL）与 opencode 原生的 `mcp`
 * （server 名 → 配置，可能是 `type: "local"` 的 stdio 命令）。只认前者会导致本地型 MCP
 * 拿不到任何信息，最终被当成「未就绪」误报成异常。
 * @param object 插件里的 MCP 配置对象
 * @returns 每个 server 一条，远程带 url，stdio 带 command
 */
function remoteMcpSpecs(object: DenPluginConfigObject): RemoteMcpSpec[] {
  const payload = object.latestVersion?.normalizedPayloadJson;
  if (!payload) return [{ name: object.title, url: "" }];

  const servers = isRecord(payload.mcpServers)
    ? payload.mcpServers
    : isRecord(payload.mcp) ? payload.mcp : null;
  if (servers) {
    const specs = Object.entries(servers).flatMap(([name, config]) => {
      if (!isRecord(config)) return [];
      const url = typeof config.url === "string" ? config.url.trim() : "";
      const command = Array.isArray(config.command)
        ? config.command.filter((part): part is string => typeof part === "string")
        : [];
      if (!url && command.length === 0) return [];
      return [{
        name: name.trim() || object.title,
        url,
        ...(command.length > 0 ? { command } : {}),
      }];
    });
    if (specs.length > 0) return specs;
  }

  return typeof payload.url === "string" && payload.url.trim()
    ? [{ name: object.title, url: payload.url.trim() }]
    : [{ name: object.title, url: "" }];
}

function matchingConnection(
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
  spec: RemoteMcpSpec,
): DenPluginCloudReadinessConnection | undefined {
  const connections = plugin.cloudReadiness?.connections ?? [];
  return connections.find((connection) =>
    connection.configObjectId === object.id && connection.serverName === spec.name
  ) ?? (spec.url ? connections.find((connection) => connection.url === spec.url) : undefined);
}

/**
 * 由组件自身推导云端 MCP 的状态。
 *
 * TIPS: 绝不能拿插件级 state 当组件状态用——混合插件的 state 是 `desktop_only`（由 stdio
 * 组件决定），它对同一插件里的远程组件没有任何含义，照搬会把一个只是"组织没建连接"的
 * 远程能力显示成运行异常。
 *
 * @param component 服务端下发的组件明细
 */
function cloudComponentStatus(component: DenPluginMcpComponent): McpStatus {
  if (component.connectedForMe) return { status: "connected" };
  if (component.connectionId) return { status: "needs_auth" };
  return { status: "not_configured" };
}

function remoteMcpStatus(
  plugin: DenOrgPlugin,
  connection: DenPluginCloudReadinessConnection | undefined,
): McpStatus {
  if (connection?.connectedForMe || plugin.cloudReadiness?.state === "ready") {
    return { status: "connected" };
  }
  if (plugin.cloudReadiness?.state === "needs_signin") {
    return { status: "needs_auth" };
  }
  return {
    status: "failed",
    error: plugin.cloudReadiness?.state === "needs_admin_setup"
      ? "Organization setup is required."
      : plugin.cloudReadiness?.state === "not_synced"
        ? "Marketplace content has not synced yet."
        : "This JuggleWork Connect capability is not ready.",
  };
}

function toSkill(
  marketplace: DenOrgMarketplace,
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
): ConnectSkillCard {
  return {
    name: object.title,
    path: `jugglework-connect://${marketplace.id}/${plugin.id}/${object.id}`,
    description: object.description ?? undefined,
    content: object.latestVersion?.rawSourceText ?? undefined,
    trigger: skillTrigger(object),
    origin: "jugglework-connect",
    marketplaceName: marketplace.name,
    pluginName: plugin.name,
    connectCapabilityName: marketplaceCapabilityName("skill", object.id),
    connectPluginId: plugin.id,
  };
}

function toCommand(
  marketplace: DenOrgMarketplace,
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
): ConnectCommandOption {
  const capability = marketplaceCapabilityName("command", object.id);
  return {
    id: `connect-command:${capability}`,
    name: commandName(object),
    description: object.description ?? undefined,
    source: "command",
    origin: "jugglework-connect",
    marketplaceName: marketplace.name,
    pluginName: plugin.name,
    connectCapabilityName: capability,
    connectPluginId: plugin.id,
  };
}

function toMcpEntries(
  marketplace: DenOrgMarketplace,
  plugin: DenOrgPlugin,
  object: DenPluginConfigObject,
): Array<{ entry: McpServerEntry; status: McpStatus }> {
  const specs = remoteMcpSpecs(object);
  // TIPS: 服务端下发 cloudReadiness.components 时以它为准——它对承载方式的判定与本地
  // 推断同源，但还带连接绑定信息；没有下发时才用 payload 推断（remoteMcpSpecs）。
  const serverComponents = new Map(
    (plugin.cloudReadiness?.components ?? [])
      .filter((component) => component.configObjectId === object.id)
      .map((component) => [component.serverName, component] as const),
  );
  return specs.map((spec) => {
    const id = `jugglework-connect:${plugin.id}:${object.id}:${spec.name}`;
    const displayName = specs.length === 1 ? object.title : `${object.title} · ${spec.name}`;
    // stdio 型 MCP 由桌面端本地进程承载，云端就绪度对它没有意义：先标成「未安装」，
    // 装到工作区后由 mergeConnectLocalMcpServers 并入本地条目。
    const declared = serverComponents.get(spec.name);
    const connection = matchingConnection(plugin, object, spec);
    const localOnly = declared
      ? declared.delivery === "desktop"
      : !spec.url && (spec.command?.length ?? 0) > 0;
    const connectionId = declared?.connectionId ?? connection?.id;
    return {
      entry: {
        id,
        name: displayName,
        config: localOnly
          ? { type: "local", command: spec.command }
          : { type: "remote", url: spec.url },
        origin: "jugglework-connect",
        ...(localOnly ? { localServerName: spec.name } : {}),
        marketplaceName: marketplace.name,
        pluginName: plugin.name,
        connectCapabilityName: connectionId
          ? marketplaceCapabilityName("mcp", connectionId)
          : marketplaceCapabilityName("mcp", object.id),
      },
      // 有组件明细就按组件自身判定；没有（旧服务端）才回落到插件级就绪度。
      status: localOnly
        ? { status: "not_installed" } satisfies McpStatus
        : declared
          ? cloudComponentStatus(declared)
          : remoteMcpStatus(plugin, connection),
    };
  });
}

function sameCommand(left: string[] | undefined, right: string[] | undefined) {
  if (!left?.length || !right?.length || left.length !== right.length) return false;
  return left.every((part, index) => part === right[index]);
}

/**
 * 合并本地 MCP 清单与 Connect 下发的 stdio 能力。
 *
 * TIPS: 插件装到工作区后，同一个 MCP 会在两份清单里各出现一次——Connect 侧是能力目录里的
 * 定义（如「图片识别」），本地侧是安装后写进配置的 server（如 `vision`）。这里按 server 名、
 * 再按启动命令认亲：保留本地那条（只有它有真实运行状态），把插件归属并进去，丢掉 Connect 的
 * 重复条目；没装下来的 Connect 条目保留并标成「未安装」，因为装之前它确实不可用。
 *
 * @param input 本地 MCP、Connect 能力条目与本地运行状态（按 server 名索引）
 * @returns 去重后的清单，以及 Connect 条目需要覆盖的状态
 */
export function mergeConnectLocalMcpServers(input: {
  localServers: McpServerEntry[];
  connectServers: McpServerEntry[];
  localStatuses: McpStatusMap;
}): { servers: McpServerEntry[]; statuses: McpStatusMap } {
  const byName = new Map(input.localServers.map((server) => [server.name.trim().toLowerCase(), server]));
  const provenance = new Map<string, McpServerEntry>();
  const statuses: McpStatusMap = {};
  const remaining: McpServerEntry[] = [];

  for (const entry of input.connectServers) {
    if (entry.config.type !== "local") {
      remaining.push(entry);
      continue;
    }
    const localName = (entry.localServerName ?? entry.name).trim().toLowerCase();
    const installed = byName.get(localName)
      ?? input.localServers.find((server) => sameCommand(server.config.command, entry.config.command));
    if (installed) {
      provenance.set(installed.name, entry);
      continue;
    }
    statuses[entry.id ?? entry.name] = { status: "not_installed" };
    remaining.push(entry);
  }

  const servers = input.localServers.map((server) => {
    const source = provenance.get(server.name);
    if (!source) return server;
    return {
      ...server,
      ...(source.marketplaceName ? { marketplaceName: source.marketplaceName } : {}),
      ...(source.pluginName ? { pluginName: source.pluginName } : {}),
      ...(source.connectCapabilityName ? { connectCapabilityName: source.connectCapabilityName } : {}),
    } satisfies McpServerEntry;
  });

  return { servers: [...servers, ...remaining], statuses };
}

function toOrgMcpEntry(connection: DenExternalMcpConnection): { entry: McpServerEntry; status: McpStatus } {
  const id = `jugglework-connect:connection:${connection.id}`;
  const status: McpStatus = isOrgMcpConnectionReady(connection)
    ? { status: "connected" }
    : connection.credentialMode === "per_member"
      ? { status: "needs_auth" }
      : { status: "failed", error: "Organization setup is required." };
  return {
    entry: {
      id,
      name: connection.name,
      config: { type: "remote", url: connection.url },
      origin: "jugglework-connect",
      connectCapabilityName: marketplaceCapabilityName("mcp", connection.id),
    },
    status,
  };
}

/**
 * 加载当前组织分配给成员的 Connect 能力清单。
 *
 * @param input Connect 客户端与当前组织标识
 * @returns 会话输入框可展示的命令、技能和 MCP 能力
 */
export async function listAssignedConnectCapabilities(input: {
  client: ConnectCapabilityClient;
  organizationId: string;
}): Promise<ConnectCapabilityInventory> {
  const [listedMarketplaces, orgMcpConnections] = await Promise.all([
    input.client.listOrgMarketplaces(input.organizationId),
    input.client.listMcpConnections(input.organizationId, "usable").catch(() => []),
  ]);
  const marketplaces = listedMarketplaces
    .filter((marketplace) => marketplace.status === "active")
    .sort((left, right) => left.name.localeCompare(right.name));
  const resolvedMarketplaces = await Promise.all(
    marketplaces.map((marketplace) =>
      input.client.getOrgMarketplaceResolved(input.organizationId, marketplace.id)
    ),
  );

  const plugins = new Map<string, MarketplacePlugin>();
  for (const resolved of resolvedMarketplaces) {
    for (const plugin of resolved.plugins) {
      if (plugin.status !== "active" || plugins.has(plugin.id)) continue;
      plugins.set(plugin.id, { marketplace: resolved.marketplace, plugin });
    }
  }

  const resolvedPlugins = await Promise.all(
    [...plugins.values()].map(async ({ marketplace, plugin }) => ({
      marketplace,
      resolved: await input.client.getOrgPluginResolved(input.organizationId, plugin),
    })),
  );

  const commands: ConnectCommandOption[] = [];
  const skills: ConnectSkillCard[] = [];
  const mcpServers: McpServerEntry[] = [];
  const mcpStatuses: McpStatusMap = {};
  const representedConnectionIds = new Set(
    resolvedPlugins.flatMap(({ resolved }) =>
      (resolved.plugin.cloudReadiness?.connections ?? []).flatMap((connection) =>
        connection.id ? [connection.id] : []
      )
    ),
  );
  for (const { marketplace, resolved } of resolvedPlugins) {
    for (const membership of resolved.memberships) {
      const object = membership.configObject;
      if (!object || object.status !== "active") continue;
      if (object.objectType === "skill") {
        skills.push(toSkill(marketplace, resolved.plugin, object));
      }
      if (object.objectType === "command") {
        commands.push(toCommand(marketplace, resolved.plugin, object));
      }
      if (object.objectType === "mcp") {
        for (const item of toMcpEntries(marketplace, resolved.plugin, object)) {
          mcpServers.push(item.entry);
          mcpStatuses[item.entry.id ?? item.entry.name] = item.status;
        }
      }
    }
  }

  // TIPS：市场插件中的 MCP 已按配置对象展示；组织连接仅补齐独立连接器，并按连接 ID 去重。
  // 这些条目用于会话能力选择，实际调用仍通过 JuggleWork Connect 的统一能力入口执行。
  for (const connection of orgMcpConnections) {
    if (representedConnectionIds.has(connection.id)) continue;
    const item = toOrgMcpEntry(connection);
    mcpServers.push(item.entry);
    mcpStatuses[item.entry.id ?? item.entry.name] = item.status;
  }

  commands.sort((left, right) => left.name.localeCompare(right.name));
  skills.sort((left, right) => left.name.localeCompare(right.name));
  mcpServers.sort((left, right) => left.name.localeCompare(right.name));
  return { commands, skills, mcpServers, mcpStatuses };
}

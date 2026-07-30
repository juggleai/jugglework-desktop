import type {
  DenOrgMarketplace,
  DenOrgMarketplaceResolved,
  DenOrgPlugin,
  DenOrgPluginResolved,
  DenPluginCloudReadinessConnection,
  DenPluginConfigObject,
} from "@/app/lib/den";
import type { McpServerEntry, McpStatus, McpStatusMap, SkillCard, SlashCommandOption } from "@/app/types";

type ConnectCapabilityClient = {
  listOrgMarketplaces: (organizationId: string) => Promise<DenOrgMarketplace[]>;
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

function remoteMcpSpecs(object: DenPluginConfigObject): RemoteMcpSpec[] {
  const payload = object.latestVersion?.normalizedPayloadJson;
  if (!payload) return [{ name: object.title, url: "" }];
  const servers = isRecord(payload.mcpServers) ? payload.mcpServers : null;
  if (servers) {
    const specs = Object.entries(servers).flatMap(([name, config]) => {
      if (!isRecord(config) || typeof config.url !== "string" || !config.url.trim()) return [];
      return [{ name: name.trim() || object.title, url: config.url.trim() }];
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
  return specs.map((spec) => {
    const id = `jugglework-connect:${plugin.id}:${object.id}:${spec.name}`;
    const displayName = specs.length === 1 ? object.title : `${object.title} · ${spec.name}`;
    return {
      entry: {
        id,
        name: displayName,
        config: { type: "remote", url: spec.url },
        origin: "jugglework-connect",
        marketplaceName: marketplace.name,
        pluginName: plugin.name,
        connectCapabilityName: marketplaceCapabilityName("mcp", object.id),
      },
      status: remoteMcpStatus(plugin, matchingConnection(plugin, object, spec)),
    };
  });
}

export async function listAssignedConnectCapabilities(input: {
  client: ConnectCapabilityClient;
  organizationId: string;
}): Promise<ConnectCapabilityInventory> {
  const marketplaces = (await input.client.listOrgMarketplaces(input.organizationId))
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

  commands.sort((left, right) => left.name.localeCompare(right.name));
  skills.sort((left, right) => left.name.localeCompare(right.name));
  mcpServers.sort((left, right) => left.name.localeCompare(right.name));
  return { commands, skills, mcpServers, mcpStatuses };
}

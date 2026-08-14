import { describe, expect, test } from "bun:test";

import {
  listAssignedConnectCapabilities,
  mergeConnectLocalMcpServers,
} from "../src/react-app/domains/session/surface/connect-capability-inventory";

describe("assigned JuggleWork Connect capability inventory", () => {
  test("returns active marketplace skills and MCPs with Connect provenance", async () => {
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listMcpConnections: async () => [
          {
            id: "connection_1",
            name: "Support search",
            url: "https://support.example.test/mcp",
            authType: "oauth",
            credentialMode: "shared",
            connected: true,
            connectedAt: "2026-08-03T10:00:00.000Z",
            connectedForMe: true,
          },
        ],
        listOrgMarketplaces: async () => [
          {
            id: "marketplace_1",
            name: "Team tools",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
        ],
        getOrgMarketplaceResolved: async () => ({
          marketplace: {
            id: "marketplace_1",
            name: "Team tools",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
          plugins: [
            {
              id: "plugin_1",
              name: "Support kit",
              description: null,
              status: "active",
              memberCount: 2,
              updatedAt: null,
              componentCounts: { skill: 1, command: 1, mcp: 1 },
              cloudReadiness: {
                state: "ready",
                hasInstructional: true,
                connections: [
                  {
                    id: "connection_1",
                    name: "Support search",
                    url: "https://support.example.test/mcp",
                    configObjectId: "mcp_1",
                    serverName: "support",
                    credentialMode: "shared",
                    connectedForMe: true,
                  },
                ],
              },
            },
          ],
        }),
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            {
              id: "membership_skill",
              pluginId: plugin.id,
              configObjectId: "skill_1",
              configObject: {
                id: "skill_1",
                objectType: "skill",
                title: "Escalate ticket",
                description: "Prepare a support escalation.",
                currentFileName: "SKILL.md",
                currentFileExtension: "md",
                currentRelativePath: "skills/escalate-ticket/SKILL.md",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_skill",
                  rawSourceText: "# Escalate ticket",
                  normalizedPayloadJson: null,
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
            {
              id: "membership_command",
              pluginId: plugin.id,
              configObjectId: "command_1",
              configObject: {
                id: "command_1",
                objectType: "command",
                title: "Escalate support ticket",
                description: "Create a support escalation.",
                currentFileName: "escalate-ticket.md",
                currentFileExtension: "md",
                currentRelativePath: ".opencode/commands/support/escalate-ticket.md",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_command",
                  rawSourceText: "Escalate this ticket.",
                  normalizedPayloadJson: null,
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
            {
              id: "membership_mcp",
              pluginId: plugin.id,
              configObjectId: "mcp_1",
              configObject: {
                id: "mcp_1",
                objectType: "mcp",
                title: "Support MCP",
                description: null,
                currentFileName: "support.json",
                currentFileExtension: "json",
                currentRelativePath: "mcp/support.json",
                status: "active",
                updatedAt: null,
                latestVersion: {
                  id: "version_mcp",
                  rawSourceText: null,
                  normalizedPayloadJson: {
                    mcpServers: {
                      support: {
                        url: "https://support.example.test/mcp",
                        headers: { Authorization: "Bearer ${SUPPORT_TOKEN}" },
                      },
                    },
                  },
                  sourceRevisionRef: null,
                  createdAt: null,
                },
              },
            },
          ],
        }),
      },
    });

    expect(inventory.skills).toEqual([
      expect.objectContaining({
        name: "Escalate ticket",
        trigger: "escalate-ticket",
        origin: "jugglework-connect",
        marketplaceName: "Team tools",
        pluginName: "Support kit",
        connectCapabilityName: "skill:skill_1",
        connectPluginId: "plugin_1",
      }),
    ]);
    expect(inventory.commands).toEqual([
      expect.objectContaining({
        name: "escalate-ticket",
        origin: "jugglework-connect",
        marketplaceName: "Team tools",
        pluginName: "Support kit",
        connectPluginId: "plugin_1",
        connectCapabilityName: "command:command_1",
      }),
    ]);
    expect(inventory.mcpServers).toEqual([
      expect.objectContaining({
        name: "Support MCP",
        origin: "jugglework-connect",
        marketplaceName: "Team tools",
        pluginName: "Support kit",
        config: {
          type: "remote",
          url: "https://support.example.test/mcp",
        },
      }),
    ]);
    expect(inventory.mcpStatuses[inventory.mcpServers[0]?.id ?? ""]).toEqual({ status: "connected" });
  });

  test("includes connected standalone organization MCP connections in the session inventory", async () => {
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listMcpConnections: async () => [
          {
            id: "github",
            name: "GitHub",
            url: "https://api.githubcopilot.com/mcp/",
            authType: "oauth",
            credentialMode: "per_member",
            connected: true,
            connectedAt: "2026-08-03T10:00:00.000Z",
            connectedForMe: true,
          },
        ],
        listOrgMarketplaces: async () => [],
        getOrgMarketplaceResolved: async () => {
          throw new Error("No marketplace should be resolved.");
        },
        getOrgPluginResolved: async () => {
          throw new Error("No plugin should be resolved.");
        },
      },
    });

    expect(inventory.mcpServers).toEqual([
      {
        id: "jugglework-connect:connection:github",
        name: "GitHub",
        config: {
          type: "remote",
          url: "https://api.githubcopilot.com/mcp/",
        },
        origin: "jugglework-connect",
      },
    ]);
    expect(inventory.mcpStatuses["jugglework-connect:connection:github"]).toEqual({ status: "connected" });
  });

  test("only uses marketplaces visible to the member and ignores inactive objects", async () => {
    let resolvedMarketplaceIds: string[] = [];
    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listMcpConnections: async () => [],
        listOrgMarketplaces: async () => [
          {
            id: "marketplace_active",
            name: "Assigned",
            description: null,
            status: "active",
            pluginCount: 1,
            updatedAt: null,
          },
          {
            id: "marketplace_archived",
            name: "Archived",
            description: null,
            status: "archived",
            pluginCount: 1,
            updatedAt: null,
          },
        ],
        getOrgMarketplaceResolved: async (_organizationId, marketplaceId) => {
          resolvedMarketplaceIds.push(marketplaceId);
          return {
            marketplace: {
              id: marketplaceId,
              name: "Assigned",
              description: null,
              status: "active",
              pluginCount: 1,
              updatedAt: null,
            },
            plugins: [
              {
                id: "plugin_1",
                name: "Assigned plugin",
                description: null,
                status: "active",
                memberCount: 1,
                updatedAt: null,
                componentCounts: { skill: 1 },
              },
            ],
          };
        },
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            {
              id: "membership_1",
              pluginId: plugin.id,
              configObjectId: "skill_inactive",
              configObject: {
                id: "skill_inactive",
                objectType: "skill",
                title: "Old skill",
                description: null,
                currentFileName: null,
                currentFileExtension: null,
                currentRelativePath: null,
                status: "archived",
                updatedAt: null,
                latestVersion: null,
              },
            },
          ],
        }),
      },
    });

    expect(resolvedMarketplaceIds).toEqual(["marketplace_active"]);
    expect(inventory.skills).toEqual([]);
    expect(inventory.mcpServers).toEqual([]);
  });

  test("reads the opencode-style `mcp` payload and marks stdio servers as desktop only", async () => {
    const marketplace = {
      id: "marketplace_1",
      name: "插件集合",
      description: null,
      status: "active" as const,
      pluginCount: 1,
      updatedAt: null,
    };
    const makeMcp = (id: string, title: string, payload: Record<string, unknown>) => ({
      id: `membership_${id}`,
      pluginId: "plugin_1",
      configObjectId: id,
      configObject: {
        id,
        objectType: "mcp" as const,
        title,
        description: null,
        currentFileName: "component.json",
        currentFileExtension: "json",
        currentRelativePath: `.opencode/mcps/${id}/component.json`,
        status: "active" as const,
        updatedAt: null,
        latestVersion: {
          id: `version_${id}`,
          rawSourceText: "",
          normalizedPayloadJson: payload,
          sourceRevisionRef: null,
          createdAt: null,
        },
      },
    });

    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listMcpConnections: async () => [],
        listOrgMarketplaces: async () => [marketplace],
        getOrgMarketplaceResolved: async () => ({
          marketplace,
          plugins: [
            {
              id: "plugin_1",
              name: "插件1",
              description: null,
              status: "active",
              memberCount: 2,
              updatedAt: null,
              componentCounts: { mcp: 2 },
              // 后端对只含本地 MCP 的插件不下发就绪度。
              cloudReadiness: undefined,
            },
          ],
        }),
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            makeMcp("mcp_local", "图片识别", {
              mcp: {
                vision: {
                  type: "local",
                  enabled: true,
                  command: ["npx", "-y", "jugglework-vision-mcp"],
                },
              },
            }),
            makeMcp("mcp_remote", "远端检索", {
              mcp: {
                search: { type: "remote", url: "https://search.example.test/mcp" },
              },
            }),
          ],
        }),
      },
    });

    const byName = Object.fromEntries(inventory.mcpServers.map((entry) => [entry.name, entry]));
    expect(byName["图片识别"]?.config).toEqual({
      type: "local",
      command: ["npx", "-y", "jugglework-vision-mcp"],
    });
    expect(inventory.mcpStatuses[byName["图片识别"]?.id ?? ""]).toEqual({ status: "not_installed" });

    expect(byName["远端检索"]?.config).toEqual({
      type: "remote",
      url: "https://search.example.test/mcp",
    });
    expect(inventory.mcpStatuses[byName["远端检索"]?.id ?? ""]).toEqual({
      status: "failed",
      error: "This JuggleWork Connect capability is not ready.",
    });
  });

  test("merges an installed stdio Connect capability into its local server instead of listing both", () => {
    const merged = mergeConnectLocalMcpServers({
      localServers: [
        { name: "vision", config: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] }, origin: "local" },
      ],
      connectServers: [
        {
          id: "connect:vision",
          name: "图片识别",
          config: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] },
          origin: "jugglework-connect",
          marketplaceName: "插件集合",
          pluginName: "插件1",
          connectCapabilityName: "mcp:config_1",
          localServerName: "vision",
        },
      ],
      localStatuses: { vision: { status: "connected" } },
    });

    // 只剩本地那一条，并带上插件归属，不再和「图片识别」重复。
    expect(merged.servers).toEqual([
      {
        name: "vision",
        config: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] },
        origin: "local",
        marketplaceName: "插件集合",
        pluginName: "插件1",
        connectCapabilityName: "mcp:config_1",
      },
    ]);
    expect(merged.statuses).toEqual({});
  });

  test("keeps stdio Connect capabilities that the workspace has not installed and marks them not installed", () => {
    const merged = mergeConnectLocalMcpServers({
      localServers: [],
      connectServers: [
        {
          id: "connect:notes",
          name: "笔记",
          config: { type: "local", command: ["npx", "-y", "notes-mcp"] },
          origin: "jugglework-connect",
          localServerName: "notes",
        },
        {
          id: "connect:remote",
          name: "远端检索",
          config: { type: "remote", url: "https://search.example.test/mcp" },
          origin: "jugglework-connect",
        },
      ],
      localStatuses: {},
    });

    expect(merged.servers.map((server) => server.name)).toEqual(["笔记", "远端检索"]);
    expect(merged.statuses["connect:notes"]).toEqual({ status: "not_installed" });
    // 远程能力不参与本地安装判定，沿用云端就绪度。
    expect(merged.statuses["connect:remote"]).toBeUndefined();
  });

  test("falls back to matching the launch command when the local server was renamed", () => {
    const merged = mergeConnectLocalMcpServers({
      localServers: [
        { name: "vision-renamed", config: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] } },
      ],
      connectServers: [
        {
          id: "connect:vision",
          name: "图片识别",
          config: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] },
          origin: "jugglework-connect",
          pluginName: "插件1",
          localServerName: "vision",
        },
      ],
      localStatuses: {},
    });

    expect(merged.servers.map((server) => server.name)).toEqual(["vision-renamed"]);
    expect(merged.servers[0]?.pluginName).toBe("插件1");
    expect(merged.statuses).toEqual({});
  });

  test("derives the trigger from Windows-style skill paths and omits it when the path is not a SKILL.md", async () => {
    const marketplace = {
      id: "marketplace_1",
      name: "Team tools",
      description: null,
      status: "active" as const,
      pluginCount: 1,
      updatedAt: null,
    };
    const makeSkill = (id: string, title: string, currentRelativePath: string | null) => ({
      id: `membership_${id}`,
      pluginId: "plugin_1",
      configObjectId: id,
      configObject: {
        id,
        objectType: "skill" as const,
        title,
        description: null,
        currentFileName: null,
        currentFileExtension: null,
        currentRelativePath,
        status: "active" as const,
        updatedAt: null,
        latestVersion: null,
      },
    });

    const inventory = await listAssignedConnectCapabilities({
      organizationId: "org_1",
      client: {
        listMcpConnections: async () => [],
        listOrgMarketplaces: async () => [marketplace],
        getOrgMarketplaceResolved: async () => ({
          marketplace,
          plugins: [
            {
              id: "plugin_1",
              name: "Support kit",
              description: null,
              status: "active",
              memberCount: 2,
              updatedAt: null,
              componentCounts: { skill: 2 },
            },
          ],
        }),
        getOrgPluginResolved: async (_organizationId, plugin) => ({
          plugin,
          memberships: [
            makeSkill("skill_win", "Windows skill", "skills\\escalate-ticket\\SKILL.md"),
            makeSkill("skill_nomatch", "Loose skill", "docs/escalate-ticket/README.md"),
          ],
        }),
      },
    });

    const byName = Object.fromEntries(inventory.skills.map((skill) => [skill.name, skill]));
    expect(byName["Windows skill"]?.trigger).toBe("escalate-ticket");
    expect(byName["Loose skill"]?.trigger).toBeUndefined();
  });
});

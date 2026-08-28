import { describe, expect, test } from "bun:test";

import {
  aggregatePluginDelivery,
  resolvePluginMcpComponents,
} from "../src/react-app/domains/settings/connect-cloud-readiness";
import type { DenOrgPluginResolved } from "../src/app/lib/den";

function resolvedWithMcp(payload: unknown, objectId = "config_1"): DenOrgPluginResolved {
  return {
    plugin: {
      id: "plugin_1",
      name: "插件1",
      description: null,
      status: "active",
      memberCount: 1,
      updatedAt: null,
      componentCounts: { mcp: 1 },
    },
    memberships: [
      {
        id: "membership_1",
        pluginId: "plugin_1",
        configObjectId: objectId,
        configObject: {
          id: objectId,
          objectType: "mcp",
          title: "图片识别",
          description: null,
          currentFileName: "component.json",
          currentFileExtension: "json",
          currentRelativePath: ".opencode/mcps/1/component.json",
          status: "active",
          updatedAt: null,
          latestVersion: {
            id: "version_1",
            rawSourceText: "",
            normalizedPayloadJson: payload as Record<string, unknown>,
            sourceRevisionRef: null,
            createdAt: null,
          },
        },
      },
    ],
  } as DenOrgPluginResolved;
}

describe("plugin MCP delivery", () => {
  test("prefers the components the server sends over local inference", () => {
    const components = resolvePluginMcpComponents(
      {
        cloudReadiness: {
          state: "desktop_only",
          hasInstructional: false,
          connections: [],
          components: [
            { configObjectId: "config_1", serverName: "vision", delivery: "desktop", command: ["npx", "vision"] },
          ],
        },
      },
      // 服务端已给出明细时不应再看 payload，这里故意放一份会推断成 cloud 的数据。
      resolvedWithMcp({ mcp: { vision: { url: "https://example.test/mcp" } } }),
    );

    expect(components).toEqual([
      { configObjectId: "config_1", serverName: "vision", delivery: "desktop", command: ["npx", "vision"] },
    ]);
  });

  test("infers delivery from the payload when the server sends no components", () => {
    const local = resolvePluginMcpComponents(
      {},
      resolvedWithMcp({ mcp: { vision: { type: "local", command: ["npx", "-y", "jugglework-vision-mcp"] } } }),
    );
    expect(local).toEqual([
      { configObjectId: "config_1", serverName: "vision", delivery: "desktop", command: ["npx", "-y", "jugglework-vision-mcp"] },
    ]);

    const remote = resolvePluginMcpComponents(
      {},
      resolvedWithMcp({ mcpServers: { github: { url: "https://api.githubcopilot.com/mcp/" } } }),
    );
    expect(remote).toEqual([
      { configObjectId: "config_1", serverName: "github", delivery: "cloud", url: "https://api.githubcopilot.com/mcp/" },
    ]);
  });

  test("declared type never overrides the actual payload fields", () => {
    const components = resolvePluginMcpComponents(
      {},
      resolvedWithMcp({ mcp: { mislabelled: { type: "local", url: "https://example.test/mcp" } } }),
    );
    expect(components[0]?.delivery).toBe("cloud");
  });

  test("aggregates to the weakest link", () => {
    const cloud = { configObjectId: "a", serverName: "github", delivery: "cloud" as const, url: "https://example.test/mcp" };
    const desktop = { configObjectId: "b", serverName: "vision", delivery: "desktop" as const, command: ["npx", "vision"] };

    expect(aggregatePluginDelivery([cloud])).toEqual({ kind: "cloud", cloudCount: 1, desktopCount: 0, total: 1 });
    expect(aggregatePluginDelivery([desktop])).toEqual({ kind: "desktop", cloudCount: 0, desktopCount: 1, total: 1 });
    expect(aggregatePluginDelivery([cloud, desktop])).toEqual({ kind: "mixed", cloudCount: 1, desktopCount: 1, total: 2 });
    // 没有 MCP 组件的插件不参与投递表述。
    expect(aggregatePluginDelivery([])).toBeNull();
  });

  test("skips components whose payload has neither url nor command", () => {
    const components = resolvePluginMcpComponents({}, resolvedWithMcp({ mcp: { broken: { type: "local" } } }));
    expect(components).toEqual([]);
  });
});

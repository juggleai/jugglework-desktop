import { describe, expect, test } from "bun:test";

import type { McpDirectoryInfo } from "../src/app/constants";
import type { JuggleWorkExtensionManifest } from "../src/app/extensions";
import {
  buildProjectConnectors,
  explainConnectorErrorKey,
  isMcpConnectorEntry,
  readConnectorErrorDetail,
} from "../src/react-app/domains/settings/pages/project-extensions/connectors-source";

function manifestWithResource(
  type: JuggleWorkExtensionManifest["resources"][number]["type"],
): JuggleWorkExtensionManifest {
  return {
    schemaVersion: 1,
    id: `test-${type}`,
    name: `Test ${type}`,
    description: "Test extension",
    source: { format: "jugglework-builtin", origin: "builtin", trusted: true },
    resources: [{ type, id: `resource-${type}` }],
  };
}

function entry(overrides: Partial<McpDirectoryInfo> = {}): McpDirectoryInfo {
  return {
    name: "Test connector",
    description: "Test connector",
    oauth: false,
    ...overrides,
  };
}

describe("project connector source", () => {
  test("includes MCP and UI control directory entries", () => {
    expect(isMcpConnectorEntry(entry())).toBe(true);
    expect(isMcpConnectorEntry(entry({ kind: "mcp" }))).toBe(true);
    expect(isMcpConnectorEntry(entry({ kind: "ui-control" }))).toBe(true);
  });

  test("includes extensions backed by an MCP resource", () => {
    expect(
      isMcpConnectorEntry(entry({
        kind: "extension",
        extensionManifest: manifestWithResource("mcp"),
      })),
    ).toBe(true);
  });

  test("excludes extensions without an MCP resource", () => {
    expect(
      isMcpConnectorEntry(entry({
        kind: "extension",
        extensionManifest: manifestWithResource("opencode-plugin"),
      })),
    ).toBe(false);
    expect(isMcpConnectorEntry(entry({ kind: "plugin" }))).toBe(false);
    expect(isMcpConnectorEntry(entry({ kind: "skill" }))).toBe(false);
  });

  test("builds connector rows only from MCP directory entries", () => {
    const rows = buildProjectConnectors({
      mcpServers: [],
      mcpStatuses: {},
      quickConnect: [
        entry({ name: "Notion", serverName: "notion", kind: "mcp" }),
        entry({
          name: "Computer Use",
          serverName: "computer-use",
          kind: "extension",
          extensionManifest: manifestWithResource("mcp"),
        }),
        entry({
          name: "Browser",
          serverName: "browser",
          kind: "extension",
          extensionManifest: manifestWithResource("opencode-plugin"),
        }),
      ],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });

    expect(rows.map((row) => row.name)).toEqual(["Notion", "Computer Use"]);
  });

  test("matches installed MCP metadata by serverName instead of a different directory id", () => {
    const rows = buildProjectConnectors({
      mcpServers: [{ name: "Notion-MCP", config: { type: "remote", url: "https://notion.example.test" } }] as never,
      mcpStatuses: { "Notion-MCP": { status: "connected" } } as never,
      quickConnect: [entry({ id: "catalog-notion", serverName: "notion-mcp", name: "Notion" })],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Notion");
    expect(rows[0]?.key).toBe("installed:Notion-MCP");
  });

  test("keeps global and current-workspace MCP entries with their scopes", () => {
    const rows = buildProjectConnectors({
      mcpServers: [
        { name: "global-db", source: "config.global", config: { type: "remote", url: "https://global.example.test" } },
        { name: "project-db", source: "config.project", config: { type: "remote", url: "https://project.example.test" } },
        { name: "runtime-db", source: "config.remote", config: { type: "remote", url: "https://runtime.example.test" } },
      ] as never,
      mcpStatuses: {
        "global-db": { status: "connected" },
        "project-db": { status: "connected" },
        "runtime-db": { status: "connected" },
      } as never,
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });

    expect(rows.map((row) => [row.name, row.mcpSource])).toEqual([
      ["global-db", "config.global"],
      ["project-db", "config.project"],
      ["runtime-db", "config.remote"],
    ]);
  });

  test("does not attach workspace mutation actions to a global MCP", () => {
    const calls: string[] = [];
    const [row] = buildProjectConnectors({
      mcpServers: [{ name: "global-db", source: "config.global", config: { type: "remote", url: "https://global.example.test" } }] as never,
      mcpStatuses: { "global-db": { status: "connected" } } as never,
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => calls.push("authorize"),
      removeMcp: () => calls.push("remove"),
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => calls.push("enable"),
    });

    expect(row?.onConnect).toBeUndefined();
    expect(row?.onDisconnect).toBeUndefined();
    expect(row?.onRemove).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("keeps one effective same-name MCP and lets workspace scope override global", () => {
    const rows = buildProjectConnectors({
      mcpServers: [
        { name: "notion", source: "config.global", config: { type: "remote", url: "https://global.test/mcp" } },
        { name: "notion", source: "config.project", config: { type: "remote", url: "https://workspace.test/mcp" } },
      ] as never,
      mcpStatuses: { notion: { status: "connected" } } as never,
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mcpSource).toBe("config.project");
    expect(rows[0]?.url).toBe("https://workspace.test/mcp");
  });

  test("keeps an authorized organization MCP in the connected group", () => {
    const rows = buildProjectConnectors({
      mcpServers: [],
      mcpStatuses: {},
      quickConnect: [],
      orgMcpItems: [{
        name: "GitHub",
        description: "Organization GitHub MCP",
        orgMcpConnection: {
          id: "connection-github",
          name: "GitHub",
          url: "https://github.example.test/mcp",
          credentialMode: "per_member",
          connectedForMe: true,
          connected: false,
          needsReconnect: true,
          missingFeatures: [],
        },
      }] as never,
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("org");
    expect(rows[0]?.connected).toBe(true);
    expect(rows[0]?.key).toBe("org:connection-github");
  });

  test("does not deduplicate local and cloud MCP rows by display name", () => {
    const rows = buildProjectConnectors({
      mcpServers: [{ name: "github", source: "config.remote", config: { type: "remote", url: "http://localhost/mcp" } }] as never,
      mcpStatuses: { github: { status: "connected" } } as never,
      quickConnect: [],
      orgMcpItems: [{
        name: "github",
        orgMcpConnection: {
          id: "connection-github",
          name: "github",
          url: "https://github.example.test/mcp",
          credentialMode: "shared",
          connected: true,
          connectedForMe: true,
        },
      }] as never,
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });

    expect(rows.map((row) => row.key)).toEqual(["installed:github", "org:connection-github"]);
  });
});

describe("readConnectorErrorDetail", () => {
  test("failed 状态透出引擎报告的原文", () => {
    expect(
      readConnectorErrorDetail({
        status: "failed",
        error: "Please provide a database URL as a command-line argument",
      }),
    ).toBe("Please provide a database URL as a command-line argument");
  });

  test("failed 但 error 为空时不产出详情", () => {
    expect(readConnectorErrorDetail({ status: "failed", error: "" })).toBeUndefined();
    expect(readConnectorErrorDetail({ status: "failed", error: "   " })).toBeUndefined();
  });

  test("非 failed 状态不产出详情", () => {
    expect(readConnectorErrorDetail({ status: "connected" })).toBeUndefined();
    expect(readConnectorErrorDetail({ status: "not_installed" })).toBeUndefined();
    expect(readConnectorErrorDetail(undefined)).toBeUndefined();
  });
});

describe("buildProjectConnectors 失败详情", () => {
  const server = {
    name: "postgres",
    source: "config.remote" as const,
    config: { type: "local" as const, command: ["uvx", "postgres-mcp"], enabled: true },
  };

  function build(mcpStatuses: Record<string, { status: string; error?: string }>) {
    return buildProjectConnectors({
      mcpServers: [server as never],
      mcpStatuses: mcpStatuses as never,
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });
  }

  test("启动失败的已装 MCP 带上 errorDetail", () => {
    const rows = build({ postgres: { status: "failed", error: "Missing DATABASE_URI" } });
    expect(rows[0]?.errorDetail).toBe("Missing DATABASE_URI");
    expect(rows[0]?.connected).toBe(true);
  });

  test("已连接的 MCP 不带 errorDetail", () => {
    const rows = build({ postgres: { status: "connected" } });
    expect(rows[0]?.errorDetail).toBeUndefined();
    expect(rows[0]?.connected).toBe(true);
  });
});

describe("explainConnectorErrorKey", () => {
  test.each([
    ["-32000 connection closed", "mcp.error_hint_process_exited"],
    ["Connection closed", "mcp.error_hint_process_exited"],
    ["spawn npx ENOENT", "mcp.error_hint_command_not_found"],
    ["command not found: uvx", "mcp.error_hint_command_not_found"],
    ["request timed out after 5000ms", "mcp.error_hint_timeout"],
  ])("%s → %s", (detail, key) => {
    expect(explainConnectorErrorKey(detail)).toBe(key);
  });

  test("无法归类时返回 undefined", () => {
    expect(explainConnectorErrorKey("Please provide a database URL")).toBeUndefined();
    expect(explainConnectorErrorKey(undefined)).toBeUndefined();
    expect(explainConnectorErrorKey("")).toBeUndefined();
  });
});

describe("buildProjectConnectors 编辑所需数据", () => {
  test("已装 MCP 带上 serverName 与原始配置", () => {
    const config = {
      type: "local" as const,
      command: ["uvx", "postgres-mcp"],
      environment: { DATABASE_URI: "postgresql://localhost/db" },
      cwd: "packages/api",
      timeout: 60000,
      enabled: true,
    };
    const rows = buildProjectConnectors({
      mcpServers: [{ name: "postgres", config } as never],
      mcpStatuses: {},
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: () => undefined,
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: () => undefined,
    });
    expect(rows[0]?.serverName).toBe("postgres");
    expect(rows[0]?.serverConfig).toEqual(config);
  });
});

describe("工作区 MCP 行基础语义", () => {
  function build(config: Record<string, unknown>, statuses: Record<string, unknown> = {}) {
    const calls = { removed: [] as string[], enabled: [] as Array<[string, boolean]> };
    const rows = buildProjectConnectors({
      mcpServers: [{ name: "mysql", source: "config.remote", config } as never],
      mcpStatuses: statuses as never,
      quickConnect: [],
      orgMcpItems: [],
      mcpConnectingName: null,
      orgMcpConnectingId: null,
      orgMcpDisconnectingId: null,
      connectDirectory: () => undefined,
      authorizeMcp: () => undefined,
      removeMcp: (name) => { calls.removed.push(name); },
      connectOrg: () => undefined,
      disconnectOrg: () => undefined,
      setMcpEnabled: (name, enabled) => { calls.enabled.push([name, enabled]); },
    });
    return { row: rows[0]!, calls };
  }

  const localConfig = { type: "local" as const, command: ["npx", "-y", "x"], enabled: true };

  test("已连接的自定义 MCP 不再暴露旧 enabled 断开动作", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "connected" } });
    expect(row.disconnectKind).toBe("disable");
    expect(row.onDisconnect).toBeUndefined();
    expect(row.workspaceScope).toBeUndefined();
    expect(calls.enabled).toEqual([]);
    expect(calls.removed).toEqual([]);
  });

  test("旧配置停用条目仍在列表里但不复用软策略开关", () => {
    const { row, calls } = build({ ...localConfig, enabled: false });
    expect(row.disabled).toBe(true);
    expect(row.connected).toBe(true);
    expect(row.workspaceScope).toBeUndefined();
    expect(calls.enabled).toEqual([]);
  });

  test("移除是独立动作，仍然真删", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "connected" } });
    row.onRemove?.();
    expect(calls.removed).toEqual(["mysql"]);
  });

  test("启动失败的条目仍在已连接分组并能移除", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "failed", error: "boom" } });
    expect(row.connected).toBe(true);
    row.onRemove?.();
    expect(calls.removed).toEqual(["mysql"]);
  });
});

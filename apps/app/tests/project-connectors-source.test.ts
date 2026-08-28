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
    expect(rows[0]?.connected).toBe(false);
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

describe("断开语义：自定义 MCP 停用而非删除", () => {
  function build(config: Record<string, unknown>, statuses: Record<string, unknown> = {}) {
    const calls = { removed: [] as string[], enabled: [] as Array<[string, boolean]> };
    const rows = buildProjectConnectors({
      mcpServers: [{ name: "mysql", config } as never],
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

  test("已连接的自定义 MCP：断开走停用，配置保留", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "connected" } });
    expect(row.disconnectKind).toBe("disable");
    row.onDisconnect?.();
    expect(calls.enabled).toEqual([["mysql", false]]);
    expect(calls.removed).toEqual([]);
  });

  test("停用后条目仍在列表里，且可一键启用", () => {
    const { row, calls } = build({ ...localConfig, enabled: false });
    expect(row.disabled).toBe(true);
    expect(row.connected).toBe(false);
    row.onConnect?.();
    expect(calls.enabled).toEqual([["mysql", true]]);
  });

  test("移除是独立动作，仍然真删", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "connected" } });
    row.onRemove?.();
    expect(calls.removed).toEqual(["mysql"]);
  });

  test("启动失败的条目也能移除", () => {
    const { row, calls } = build(localConfig, { mysql: { status: "failed", error: "boom" } });
    expect(row.connected).toBe(false);
    row.onRemove?.();
    expect(calls.removed).toEqual(["mysql"]);
  });
});

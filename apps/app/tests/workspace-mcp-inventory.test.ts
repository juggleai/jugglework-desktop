import { describe, expect, test } from "bun:test";

import { applyWorkspaceMcpInventoryPolicy, isComposerManageableMcpEntry, selectComposerAvailableMcpEntries } from "../src/react-app/domains/connections/workspace-mcp-inventory";

describe("shared workspace MCP inventory projection", () => {
  test("hides internal transport and disables local/Cloud rows from workspace policy", () => {
    const result = applyWorkspaceMcpInventoryPolicy({
      servers: [
        { name: "jugglework-cloud", source: "config.remote", config: { type: "remote", url: "https://cloud.test" } },
        { name: "github-local", source: "config.project", config: { type: "remote", url: "https://local.test" } },
        { id: "jugglework-connect:connection:conn_1", name: "Notion", origin: "jugglework-connect", config: { type: "remote", url: "https://notion.test" } },
        { name: "global-db", source: "config.global", config: { type: "remote", url: "https://global.test" } },
      ],
      statuses: {},
      disabledServerNames: ["github-local"],
      cloudPolicy: [{ connectionId: "conn_1", connectionName: "Notion", enabled: false, connectedForMe: true, toolCount: 1 }],
    });

    expect(result.servers.map((entry) => [entry.name, entry.workspaceEnabled])).toEqual([
      ["github-local", false],
      ["Notion", false],
      ["global-db", true],
    ]);
  });

  test("composer keeps independent Cloud connections but hides plugin-internal MCP components", () => {
    expect(isComposerManageableMcpEntry({
      id: "jugglework-connect:connection:conn_1", name: "Notion", origin: "jugglework-connect", config: { type: "remote" },
    })).toBe(true);
    expect(isComposerManageableMcpEntry({
      id: "jugglework-connect:plugin_1:mcp_1:vision", name: "Vision", origin: "jugglework-connect", config: { type: "remote" },
    })).toBe(false);
  });

  test("composer only keeps workspace-enabled and currently connected MCPs", () => {
    const servers = [
      { name: "ready", workspaceEnabled: true, config: { type: "remote" as const } },
      { name: "off", workspaceEnabled: false, config: { type: "remote" as const } },
      { name: "auth", workspaceEnabled: true, config: { type: "remote" as const } },
      { name: "missing", workspaceEnabled: true, config: { type: "local" as const } },
      { name: "failed", workspaceEnabled: true, config: { type: "local" as const } },
    ];
    expect(selectComposerAvailableMcpEntries({
      servers,
      statuses: {
        ready: { status: "connected" },
        off: { status: "connected" },
        auth: { status: "needs_auth" },
        missing: { status: "not_installed" },
        failed: { status: "failed", error: "boom" },
      },
    }).map((entry) => entry.name)).toEqual(["ready"]);
  });
});

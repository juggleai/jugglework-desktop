import { describe, expect, test } from "bun:test";

import type { McpServerEntry, McpStatusMap } from "../src/app/types";
import { applyWorkspaceMcpInventoryPolicy, composerMcpStatus, isComposerManageableMcpEntry, selectComposerAvailableMcpEntries, selectComposerInstalledMcpEntries, selectEffectiveMcpEntries } from "../src/react-app/domains/connections/workspace-mcp-inventory";

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
      { name: "config-off", config: { type: "remote" as const, enabled: false } },
    ];
    expect(selectComposerAvailableMcpEntries({
      servers,
      statuses: {
        ready: { status: "connected" },
        off: { status: "connected" },
        auth: { status: "needs_auth" },
        missing: { status: "not_installed" },
        failed: { status: "failed", error: "boom" },
        "config-off": { status: "connected" },
      },
    }).map((entry) => entry.name)).toEqual(["ready"]);
  });

  test("global MCP follows workspace soft policy", () => {
    const result = applyWorkspaceMcpInventoryPolicy({
      servers: [{ name: "global-db", source: "config.global", config: { type: "remote", url: "https://global.test" } }],
      statuses: { "global-db": { status: "connected" } },
      disabledServerNames: ["global-db"],
      cloudPolicy: [],
    });
    expect(result.servers[0]?.workspaceEnabled).toBe(false);
    expect(selectComposerAvailableMcpEntries(result)).toHaveLength(0);
  });

  test("installed rows stay visible independently of availability without adding directory or plugin rows", () => {
    const servers: McpServerEntry[] = [
      ...["ready", "auth", "registration", "failed", "paused", "pending", "workspace-off", "missing-runtime"].map((name) => ({
        name, source: "config.global" as const, config: { type: "remote" as const },
      })),
      { name: "workspace-local", source: "config.project", config: { type: "local" } },
      { name: "remote-workspace", source: "config.remote", config: { type: "remote" } },
      { name: "Cloud", id: "jugglework-connect:connection:conn_1", origin: "jugglework-connect", config: { type: "remote" } },
      { name: "jugglework-cloud", source: "config.remote", config: { type: "remote" } },
      { name: "Public directory", origin: "local", config: { type: "remote" } },
      { name: "Plugin MCP", id: "jugglework-connect:plugin:mcp:vision", origin: "jugglework-connect", config: { type: "local" } },
    ];
    const inventory = applyWorkspaceMcpInventoryPolicy({
      servers: selectComposerInstalledMcpEntries(servers),
      statuses: {
        ready: { status: "connected" },
        auth: { status: "needs_auth" },
        registration: { status: "needs_client_registration", error: "synthetic-private-detail" },
        failed: { status: "failed", error: "synthetic-private-detail" },
        paused: { status: "disabled" },
        "workspace-off": { status: "connected" },
        "missing-runtime": { status: "not_installed" },
        "jugglework-connect:connection:conn_1": { status: "connected" },
      },
      disabledServerNames: ["workspace-off"],
      cloudPolicy: [{ connectionId: "conn_1", connectionName: "Cloud", enabled: false, connectedForMe: true, toolCount: 1 }],
    });

    expect(inventory.servers.map((entry) => entry.name)).toEqual(servers.slice(0, 11).map((entry) => entry.name));
    expect(selectComposerAvailableMcpEntries(inventory).map((entry) => entry.name)).toEqual(["ready"]);
    expect(inventory.servers.map((entry) => composerMcpStatus(entry, inventory.statuses))).toEqual([
      "connected", "needs_auth", "needs_client_registration", "failed", "disabled", "pending", "disabled", "not_installed",
      "pending", "pending", "disabled",
    ]);
  });

  test("installed selection preserves workspace precedence and distinct organization connection IDs", () => {
    const selected = selectComposerInstalledMcpEntries([
      { name: "notion", source: "config.global", config: { type: "remote" } },
      { name: "notion", source: "config.remote", config: { type: "remote", enabled: false } },
      { name: "Notion", id: "jugglework-connect:connection:one", origin: "jugglework-connect", config: { type: "remote" } },
      { name: "Notion", id: "jugglework-connect:connection:two", origin: "jugglework-connect", config: { type: "remote" } },
    ]);
    expect(selected).toHaveLength(3);
    expect(selected[0]?.source).toBe("config.remote");
    expect(selected.slice(1).map((entry) => entry.id)).toEqual([
      "jugglework-connect:connection:one", "jugglework-connect:connection:two",
    ]);
  });

  test("display status fails closed on missing runtime and prioritizes workspace/config disables", () => {
    const entry: McpServerEntry = { name: "local", config: { type: "local", command: ["synthetic-command"] } };
    expect(composerMcpStatus(entry, {})).toBe("pending");
    const connected: McpStatusMap = { local: { status: "connected" } };
    expect(composerMcpStatus(entry, connected)).toBe("connected");
    expect(composerMcpStatus({ ...entry, workspaceEnabled: false }, connected)).toBe("disabled");
    expect(composerMcpStatus({ ...entry, config: { ...entry.config, enabled: false } }, connected)).toBe("disabled");
    expect(composerMcpStatus({ ...entry, id: "jugglework-connect:connection:other" }, connected)).toBe("pending");
    expect(composerMcpStatus(entry, { local: { status: "failed", error: "synthetic-private-detail" } })).toBe("failed");
  });

  test("workspace entry overrides a same-name global entry", () => {
    const selected = selectEffectiveMcpEntries([
      { name: "notion", source: "config.global", config: { type: "remote", url: "https://global.test" } },
      { name: "notion", source: "config.remote", config: { type: "remote", url: "https://workspace.test" } },
    ]);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.source).toBe("config.remote");
  });
});

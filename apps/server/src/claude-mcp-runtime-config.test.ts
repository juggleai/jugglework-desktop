import { describe, expect, test } from "bun:test";

import {
  createClaudeMcpRuntimeConfiguration,
  inspectClaudeMcpRuntimeConfiguration,
  type ClaudeMcpCredentialBroker,
} from "./claude-mcp-runtime-config.js";
import type { McpItem } from "./types.js";

const now = 1_000_000;

function item(name: string, config: Record<string, unknown>, disabledByTools = false): McpItem {
  return { name, config, source: "config.remote", ...(disabledByTools ? { disabledByTools: true } : {}) };
}

describe("Claude MCP runtime OAuth handoff", () => {
  test("hands off only approved short-lived headers and never exposes broker state in diagnostics", async () => {
    const secret = "oauth-access-token-canary";
    const broker: ClaudeMcpCredentialBroker = {
      lease: async ({ workspaceId, serverName, expiresAt }) => {
        expect({ workspaceId, serverName }).toEqual({ workspaceId: "workspace-a", serverName: "cloud" });
        return { headers: { Authorization: `Bearer ${secret}` }, expiresAt: expiresAt - 1_000 };
      },
    };
    const result = await createClaudeMcpRuntimeConfiguration({
      workspaceId: "workspace-a",
      revision: 1,
      now: () => now,
      credentialBroker: broker,
      items: [item("cloud", { type: "remote", url: "https://mcp.example.test/rpc", oauth: {} })],
    });
    expect(result.configuration.servers.cloud).toMatchObject({
      type: "http",
      headers: { Authorization: `Bearer ${secret}` },
      credentialExpiresAt: now + 3_599_000,
    });
    const diagnostics = JSON.stringify(inspectClaudeMcpRuntimeConfiguration(result));
    expect(diagnostics).not.toContain(secret);
    expect(diagnostics).not.toContain("Authorization");
    expect(diagnostics).not.toContain("mcp.example.test");
  });

  test("fails closed for policy denial, missing OAuth, expired, and overlong credentials", async () => {
    const leases = [
      { headers: { Authorization: "Bearer expired" }, expiresAt: now },
      { headers: { Authorization: "Bearer overlong" }, expiresAt: now + 60 * 60_000 + 1 },
    ];
    const result = await createClaudeMcpRuntimeConfiguration({
      workspaceId: "workspace-a",
      revision: 2,
      now: () => now,
      credentialBroker: { lease: async () => leases.shift() ?? null },
      items: [
        item("denied", { type: "remote", url: "https://denied.example/mcp" }, true),
        item("expired", { type: "remote", url: "https://expired.example/mcp", oauth: {} }),
        item("overlong", { type: "remote", url: "https://long.example/mcp", oauth: {} }),
        item("missing", { type: "remote", url: "https://missing.example/mcp", oauth: {} }),
      ],
    });
    expect(result.configuration.servers).toEqual({});
    expect(result.diagnostics.map(({ serverName, code }) => [serverName, code])).toEqual([
      ["denied", "mcp_policy_denied"],
      ["expired", "mcp_credential_expired"],
      ["overlong", "mcp_credential_expired"],
      ["missing", "mcp_needs_auth"],
    ]);
  });

  test("does not implicitly load project or user MCP configuration", async () => {
    const result = await createClaudeMcpRuntimeConfiguration({
      workspaceId: "workspace-a",
      revision: 3,
      now: () => now,
      items: [
        { ...item("runtime", { type: "remote", url: "https://runtime.example/mcp" }), source: "config.remote" },
        { ...item("project", { type: "remote", url: "https://project.example/mcp" }), source: "config.project" },
        { ...item("global", { type: "remote", url: "https://global.example/mcp" }), source: "config.global" },
      ],
    });
    expect(Object.keys(result.configuration.servers)).toEqual(["runtime"]);
    expect(result.diagnostics.filter(({ state }) => state === "denied").map(({ serverName }) => serverName)).toEqual([
      "project",
      "global",
    ]);
  });

  test("does not hand credentials across workspaces", async () => {
    const seen: string[] = [];
    const broker: ClaudeMcpCredentialBroker = {
      lease: async ({ workspaceId, expiresAt }) => {
        seen.push(workspaceId);
        return { headers: { Authorization: `Bearer ${workspaceId}` }, expiresAt: expiresAt - 1 };
      },
    };
    const [left, right] = await Promise.all(["workspace-a", "workspace-b"].map((workspaceId) =>
      createClaudeMcpRuntimeConfiguration({
        workspaceId,
        revision: 1,
        now: () => now,
        credentialBroker: broker,
        items: [item("cloud", { type: "remote", url: "https://mcp.example/rpc", oauth: {} })],
      })));
    expect(seen.sort()).toEqual(["workspace-a", "workspace-b"]);
    expect(left.configuration.servers.cloud?.headers?.Authorization).toBe("Bearer workspace-a");
    expect(right.configuration.servers.cloud?.headers?.Authorization).toBe("Bearer workspace-b");
  });
});

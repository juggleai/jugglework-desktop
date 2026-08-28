import { describe, expect, test } from "bun:test";

import type { DenMcpWorkspaceConnectionPolicy } from "../src/app/lib/den";
import {
  connectRowConnectionIds,
  resolveConnectRowWorkspaceScope,
} from "../src/react-app/domains/settings/connect-workspace-scope";

function policy(input: Partial<DenMcpWorkspaceConnectionPolicy> & { connectionId: string }): DenMcpWorkspaceConnectionPolicy {
  return {
    name: input.connectionId,
    authType: "oauth",
    credentialMode: "per_member",
    connectedForMe: true,
    enabled: true,
    toolCount: 0,
    ...input,
  };
}

describe("connectRowConnectionIds", () => {
  test("a standalone connection row is its own connection", () => {
    expect(connectRowConnectionIds({ kind: "connection", id: "connection-github" })).toEqual(["connection-github"]);
  });

  test("a plugin row carries every connection it binds, and skips the unbound ones", () => {
    const ids = connectRowConnectionIds({
      kind: "plugin",
      plugin: {
        cloudReadiness: {
          state: "ready",
          hasInstructional: false,
          connections: [
            { id: "connection-notion", name: "Notion", url: "https://mcp.notion.com/mcp", credentialMode: "per_member", connectedForMe: true },
            { id: null, name: "Internal wiki", url: "", credentialMode: "shared", connectedForMe: false },
            { id: "connection-github", name: "GitHub", url: "https://mcp.github.com/mcp", credentialMode: "shared", connectedForMe: true },
          ],
        },
      },
    });

    expect(ids).toEqual(["connection-notion", "connection-github"]);
  });
});

describe("resolveConnectRowWorkspaceScope", () => {
  const items = [
    policy({ connectionId: "connection-github", enabled: true }),
    policy({ connectionId: "connection-notion", enabled: false }),
  ];

  test("reads the switch state of the row's own connection", () => {
    expect(resolveConnectRowWorkspaceScope(["connection-github"], items)).toEqual({
      connectionIds: ["connection-github"],
      enabled: true,
    });
    expect(resolveConnectRowWorkspaceScope(["connection-notion"], items)?.enabled).toBe(false);
  });

  test("a row bound to several connections is off as soon as one of them is off", () => {
    expect(resolveConnectRowWorkspaceScope(["connection-github", "connection-notion"], items)).toEqual({
      connectionIds: ["connection-github", "connection-notion"],
      enabled: false,
    });
  });

  test("drops connections the policy does not know about", () => {
    expect(resolveConnectRowWorkspaceScope(["connection-github", "connection-gone"], items)?.connectionIds)
      .toEqual(["connection-github"]);
  });

  test("no switch at all when the row matches nothing in the policy", () => {
    expect(resolveConnectRowWorkspaceScope([], items)).toBeNull();
    expect(resolveConnectRowWorkspaceScope(["connection-gone"], items)).toBeNull();
  });
});

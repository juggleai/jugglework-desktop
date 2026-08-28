import { beforeEach, describe, expect, test } from "bun:test";

import type { DenMcpToken, DenMcpTokenMintContext } from "../src/app/lib/den";
import { JuggleWorkServerError, type JuggleWorkCloudMcpHealth, type JuggleWorkCloudMcpReconcilePayload } from "../src/app/lib/jugglework-server";
import { __setCloudMcpUserStateStorageForTest } from "../src/react-app/domains/connections/cloud-mcp-user-state";
import { runJuggleWorkCloudMcpReconciler } from "../src/react-app/domains/connections/cloud-mcp-reconciler";
import { resetWorkspaceMcpKeyCacheForTests } from "../src/react-app/domains/connections/workspace-mcp-key";

const NOW = Date.parse("2026-07-09T12:00:00.000Z");
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const WORKSPACE_KEY = "ws_0123456789abcdef0123456789abcdef";

const scope = {
  denBaseUrl: "https://app.jugglework.test",
  serverBaseUrl: "https://worker.jugglework.test",
  orgId: "org_1",
  workspaceId: "ws_1",
};
const context = { ...scope, denAuthToken: "den-session-token" };

function token(workspaceKey: string): DenMcpToken {
  return {
    token: workspaceKey ? "owt_workspace_token" : "owt_catalog_token",
    expiresAt: new Date(NOW + SIX_DAYS_MS).toISOString(),
    organizationId: "org_1",
    scopes: ["mcp:read", "mcp:write"],
    resource: "https://app.jugglework.test/jwork/api/mcp",
    workspaceKey,
  };
}

function health(usable: boolean): JuggleWorkCloudMcpHealth {
  return {
    usable,
    usableByCurrentModel: usable,
    phase: usable ? "ready" : "degraded",
    desired: { present: true, config: null, revision: null, metadata: null },
    tools: {
      checked: true,
      source: "engine",
      expected: [],
      present: [],
      missing: [],
      direct: { checked: false, source: null, expected: [], present: [], missing: [] },
      providerProjection: { checked: false, present: [], missing: [] },
    },
    pluginCanaries: { checked: false, expected: [], present: [], missing: [] },
    compatibility: { toolIdsSupported: true },
    toolDenies: { scope: "none", status: "unavailable", inspectedToolIds: [], deniedToolIds: [] },
    firstFailure: null,
    checkedAt: new Date(NOW).toISOString(),
    durationMs: 1,
  } as unknown as JuggleWorkCloudMcpHealth;
}

type Recorded = {
  mints: DenMcpTokenMintContext[];
  payloads: JuggleWorkCloudMcpReconcilePayload[];
};

function makeClient(recorded: Recorded, options?: { workspaceKey?: string | null }) {
  return {
    baseUrl: scope.serverBaseUrl,
    getJuggleWorkCloudMcpHealth: async () => health(false),
    reconcileJuggleWorkCloudMcp: async (_workspaceId: string, payload: JuggleWorkCloudMcpReconcilePayload) => {
      recorded.payloads.push(payload);
      return health(true);
    },
    ...(options?.workspaceKey === null ? {} : {
      getCloudMcpWorkspaceKey: async (workspaceId: string) => ({
        workspaceId,
        workspaceKey: options?.workspaceKey ?? WORKSPACE_KEY,
      }),
    }),
  };
}

function mintToken(recorded: Recorded) {
  return async (mintContext: DenMcpTokenMintContext) => {
    recorded.mints.push(mintContext);
    return token(mintContext.workspaceKey?.trim() ?? "");
  };
}

async function repair(recorded: Recorded, client: ReturnType<typeof makeClient>) {
  return runJuggleWorkCloudMcpReconciler({
    mode: "repair",
    client,
    context,
    mintToken: mintToken(recorded),
    force: true,
    refreshMarginMs: REFRESH_MARGIN_MS,
    now: NOW,
  });
}

describe("cloud MCP workspace scope", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    __setCloudMcpUserStateStorageForTest({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    });
    resetWorkspaceMcpKeyCacheForTests();
  });

  test("mints a workspace-scoped execution token and an account-level catalog token", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    await repair(recorded, makeClient(recorded));

    expect(recorded.mints.map((mint) => mint.workspaceKey)).toEqual([WORKSPACE_KEY, null]);
    const payload = recorded.payloads[0];
    expect((payload?.config.headers as Record<string, string>).Authorization).toBe("Bearer owt_workspace_token");
    expect((payload?.catalog?.config.headers as Record<string, string>).Authorization).toBe("Bearer owt_catalog_token");
  });

  test("the catalog token is minted once per org, not once per repair", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    const client = makeClient(recorded);
    await repair(recorded, client);
    await repair(recorded, client);

    // 目录令牌整个账号一枚：第二轮只铸执行令牌，否则每工作区每轮都多打一次
    // 铸造接口，正好撞上服务端的每会话铸造限流。
    expect(recorded.mints.map((mint) => mint.workspaceKey)).toEqual([WORKSPACE_KEY, null, WORKSPACE_KEY]);
    expect(recorded.payloads[1]?.catalog).toBeUndefined();
  });

  test("an old JuggleWork server without the workspace-key route falls back to account scope", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    await repair(recorded, makeClient(recorded, { workspaceKey: null }));

    // 与升级前逐字节一致：一枚不带 workspaceKey 的令牌，且不额外铸造目录令牌。
    expect(recorded.mints.map((mint) => mint.workspaceKey)).toEqual([null]);
    expect(recorded.payloads[0]?.catalog).toBeUndefined();
  });

  test("an explicit workspaceKey in the context wins over the server lookup", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    await runJuggleWorkCloudMcpReconciler({
      mode: "repair",
      client: makeClient(recorded),
      context: { ...context, workspaceKey: null },
      mintToken: mintToken(recorded),
      force: true,
      refreshMarginMs: REFRESH_MARGIN_MS,
      now: NOW,
    });

    expect(recorded.mints.map((mint) => mint.workspaceKey)).toEqual([null]);
  });

  test("a transient workspace-key failure does not mint an unscoped execution token", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    const client = {
      ...makeClient(recorded),
      getCloudMcpWorkspaceKey: async () => { throw new JuggleWorkServerError(500, "internal_error", "temporary"); },
    };
    await expect(repair(recorded, client)).rejects.toThrow("temporary");
    expect(recorded.mints).toEqual([]);
    expect(recorded.payloads).toEqual([]);
  });

  test("only an explicit old-server 404 falls back to account scope", async () => {
    const recorded: Recorded = { mints: [], payloads: [] };
    const client = {
      ...makeClient(recorded),
      getCloudMcpWorkspaceKey: async () => { throw new JuggleWorkServerError(404, "not_found", "old server"); },
    };
    await repair(recorded, client);
    expect(recorded.mints.map((mint) => mint.workspaceKey)).toEqual([null]);
  });
});

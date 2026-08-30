import { afterEach, describe, expect, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cloudMcpDeliveryState, reconcileJuggleWorkCloudMcp } from "./cloud-mcp-health.js";
import { readConnectCloudMcp, writeConnectCloudMcp } from "./connect-state.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

const roots: string[] = [];
const previousRuntimeDb = process.env.JUGGLEWORK_RUNTIME_DB;

afterEach(async () => {
  cloudMcpDeliveryState.clear();
  while (roots.length) await rm(roots.pop() ?? "", { recursive: true, force: true });
  if (previousRuntimeDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
  else process.env.JUGGLEWORK_RUNTIME_DB = previousRuntimeDb;
});

const WORKSPACE: WorkspaceInfo = {
  id: "ws_catalog_scope",
  name: "Catalog scope",
  path: "",
  preset: "starter",
  workspaceType: "local",
};

async function setup(): Promise<{ config: ServerConfig; workspace: WorkspaceInfo }> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-catalog-scope-"));
  roots.push(root);
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const workspace = { ...WORKSPACE, path: root };
  return {
    workspace,
    config: {
      host: "127.0.0.1",
      port: 0,
      token: "test",
      hostToken: "host",
      configPath: join(root, "jugglework.json"),
      approval: { mode: "auto", timeoutMs: 1000 },
      corsOrigins: ["*"],
      workspaces: [workspace],
      authorizedRoots: [root],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    },
  };
}

function cloudConfig(token: string): Record<string, unknown> {
  return {
    type: "remote",
    enabled: true,
    url: "https://cloud.example/mcp/agent",
    headers: { Authorization: `Bearer ${token}` },
    oauth: false,
  };
}

/**
 * reconcile 在目录解析失败之前就落盘期望配置，所以传 `directory: null` 足以
 * 观察落盘行为，无需起一个假引擎。
 */
async function reconcile(input: {
  config: ServerConfig;
  workspace: WorkspaceInfo;
  body: Record<string, unknown>;
}) {
  return reconcileJuggleWorkCloudMcp({
    config: input.config,
    workspace: input.workspace,
    directory: null,
    body: input.body,
    createWorkspaceOpencodeClient: () => createOpencodeClient({ baseUrl: "http://127.0.0.1:1" }),
    registerRuntimeMcp: async () => ({ status: "ok" as const, syncedNames: [], failures: [] }),
  });
}

describe("cloud MCP catalog scope", () => {
  test("a workspace execution token is never promoted to the host-level catalog", async () => {
    const { config, workspace } = await setup();
    await reconcile({ config, workspace, body: { config: cloudConfig("workspace_execution") } });

    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    expect(runtime.mcp?.["jugglework-cloud"]).toMatchObject({ url: "https://cloud.example/mcp/agent" });
    // 工作区令牌受该工作区的连接策略过滤，拿它做账号级技能目录会撒谎。
    expect(await readConnectCloudMcp(config)).toBeNull();
  });

  test("only an explicit catalog config reaches host scope", async () => {
    const { config, workspace } = await setup();
    await reconcile({
      config,
      workspace,
      body: {
        config: cloudConfig("workspace_execution"),
        catalog: { config: cloudConfig("account_catalog") },
      },
    });

    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    expect((runtime.mcp?.["jugglework-cloud"] as { headers?: Record<string, string> }).headers?.Authorization)
      .toBe("Bearer workspace_execution");
    expect((await readConnectCloudMcp(config))?.headers).toMatchObject({ Authorization: "Bearer account_catalog" });
  });

  test("a reconcile without a catalog config leaves the existing host-level entry alone", async () => {
    const { config, workspace } = await setup();
    await writeConnectCloudMcp(config, cloudConfig("account_catalog"));

    await reconcile({ config, workspace, body: { config: cloudConfig("workspace_execution") } });

    expect((await readConnectCloudMcp(config))?.headers).toMatchObject({ Authorization: "Bearer account_catalog" });
  });

  test("a malformed catalog config is ignored rather than failing the workspace reconcile", async () => {
    const { config, workspace } = await setup();
    await writeConnectCloudMcp(config, cloudConfig("account_catalog"));

    await reconcile({
      config,
      workspace,
      body: { config: cloudConfig("workspace_execution"), catalog: { config: "not-an-object" } },
    });

    const runtime = await readRuntimeOpencodeConfig(config, workspace.id);
    expect(runtime.mcp?.["jugglework-cloud"]).toBeDefined();
    expect((await readConnectCloudMcp(config))?.headers).toMatchObject({ Authorization: "Bearer account_catalog" });
  });
});

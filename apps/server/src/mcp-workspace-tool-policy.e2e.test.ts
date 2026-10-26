import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AUTOMATION_PERMISSION_PROFILE, type AutomationDefinition } from "@jugglework/types/automation";

import { AutomationRepository } from "./automation/repository.js";
import { startServer } from "./server.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const TOKEN = "owt_mcp_policy_client";
const HOST_TOKEN = "owt_mcp_policy_host";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "jwork-mcp-policy-route-"));
  roots.push(root);
  const staleRoot = join(root, "stale-workspace");
  await mkdir(staleRoot);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: TOKEN, hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" },
      { id: "ws_stale", name: "Stale workspace", path: staleRoot, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  await writeRuntimeOpencodeConfig(config, "ws_1", () => ({
    mcp: { github: { type: "remote", url: "https://github.test/mcp", enabled: true } },
  }));
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, config };
}

describe("MCP workspace soft-policy routes", () => {
  test("updates policy without changing runtime MCP config or emitting reload", async () => {
    const { base, config } = await harness();
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const response = await fetch(`${base}/workspace/ws_1/mcp-tool-policy`, {
      method: "PUT", headers, body: JSON.stringify({ disabledServerNames: ["github"] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ disabledServerNames: ["github"] });
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).mcp?.github?.enabled).toBe(true);
    const events = await fetch(`${base}/workspace/ws_1/events`, { headers });
    expect((await events.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  test("internal check allows ordinary tools and blocks disabled MCP tools", async () => {
    const { base } = await harness();
    const clientHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    await fetch(`${base}/workspace/ws_1/mcp-tool-policy`, {
      method: "PUT", headers: clientHeaders, body: JSON.stringify({ disabledServerNames: ["github"] }),
    });
    const check = (toolId: string) => fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST", headers: clientHeaders, body: JSON.stringify({ directory: roots[0], toolId }),
    }).then((response) => response.json());
    await expect(check("read")).resolves.toMatchObject({ allowed: true });
    await expect(check("github_search")).resolves.toMatchObject({ allowed: false, serverName: "github" });
  });

  test("active automations enforce connector selection even when tool.ids omits MCP tools", async () => {
    const { base, config } = await harness();
    const repository = await AutomationRepository.open(config);
    const now = Date.now();
    const definition: AutomationDefinition = {
      schema: "automation-definition/v1",
      id: "task-connector-scope",
      name: "Connector scope",
      workspace: { id: "ws_1", name: "Workspace", path: roots[0], workspaceType: "local" },
      prompt: { version: 1, parts: [{ type: "text", text: "run" }] },
      trigger: { version: 1, kind: "calendar", frequency: "daily", localTime: "09:00", timezone: "UTC" },
      model: { mode: "auto" },
      skillIds: [],
      connectors: [],
      permission: { profile: AUTOMATION_PERMISSION_PROFILE, acknowledgedAt: now },
      lifecycle: "enabled",
      executorDeviceId: "device",
      revision: 1,
      nextRunAt: now + 86_400_000,
      createdAt: now,
      updatedAt: now,
    };
    repository.createDefinition(definition, definition);
    const queued = repository.createManualRun(definition, "run-connector-scope", now);
    let running = repository.updateRun(queued.id, queued.revision, {
      state: "running",
      workspaceId: "ws_1",
      workspaceName: "Workspace",
      sessionId: "ses_connector_scope",
      connectorIds: [],
    }, now);
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const check = () => fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST",
      headers,
      // 共享 OpenCode 引擎的 tool callback 可能只提供 sessionId；服务端必须从运行记录
      // 解析自动化工作区，不能靠遍历工作区 session.get() 猜归属。
      body: JSON.stringify({ sessionId: "ses_connector_scope", toolId: "github_search" }),
    }).then((response) => response.json());
    try {
      await expect(check()).resolves.toMatchObject({
        allowed: false,
        code: "mcp_disabled_in_automation",
        serverName: "github",
      });
      running = repository.updateRun(running.id, running.revision, { connectorIds: ["github"] }, now + 1);
      await expect(check()).resolves.toMatchObject({ allowed: true, serverName: "github" });
    } finally {
      repository.updateRun(running.id, running.revision, { state: "cancelled", endedAt: now + 2 }, now + 2);
      repository.close();
    }
  });

  test("internal check prefers the execution directory over a conflicting stale workspace ID", async () => {
    const { base } = await harness();
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    await fetch(`${base}/workspace/ws_1/mcp-tool-policy`, {
      method: "PUT", headers, body: JSON.stringify({ disabledServerNames: ["github"] }),
    });
    const response = await fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: roots[0], workspaceId: "ws_stale", toolId: "github_search" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allowed: false, serverName: "github" });
  });

  test("internal check fails closed when a directory conflicts with a stale workspace ID", async () => {
    const { base } = await harness();
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const response = await fetch(`${base}/internal/mcp-tool-policy/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ directory: `${roots[0]}-unregistered`, workspaceId: "ws_1", toolId: "github_search" }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "workspace_not_found" });
  });
});

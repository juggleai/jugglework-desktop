import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

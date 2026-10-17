import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { juggleworkRuntimeConfigFilePath, writeJuggleWorkRuntimeConfigFile } from "./jugglework-runtime-config.js";
import { readPluginWorkspacePolicy, writePluginWorkspacePolicy } from "./plugin-workspace-policy.js";
import { readRuntimeOpencodeConfig, writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { registerTrustedOpencodeProcess, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function harness(managed: boolean) {
  const root = await mkdtemp(join(tmpdir(), "jwork-plugin-policy-"));
  roots.push(root);
  const requests: string[] = [];
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    requests.push(new URL(request.url).pathname);
    return Response.json({ ok: true });
  } });
  stops.push(() => engine.stop());
  const baseUrl = `http://127.0.0.1:${engine.port}`;
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, configPath: join(root, "server.json"), token: "plugin-client", hostToken: "plugin-host",
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "First", path: root, baseUrl, preset: "starter", workspaceType: "local" },
      { id: "ws_2", name: "Second", path: join(root, "second"), baseUrl, preset: "starter", workspaceType: "local" },
    ],
    authorizedRoots: [root], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli",
    logFormat: "pretty", logRequests: false,
  };
  if (managed) registerTrustedOpencodeProcess(config, { baseUrl, identity: "test-managed-engine", isAlive: () => true });
  const server = await startServer(config);
  stops.push(() => server.stop());
  requests.length = 0;
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { authorization: "Bearer plugin-client", "content-type": "application/json" };
  const put = (id: string, body: unknown) => fetch(`${base}/workspace/${id}/plugin-policy`, {
    method: "PUT", headers, body: JSON.stringify(body),
  });
  const get = (id: string) => fetch(`${base}/workspace/${id}/plugin-policy`, { headers });
  return { config, requests, put, get };
}

describe("workspace plugin policy", () => {
  test.each([true, false])("rejects HTTP changes without mutations or reload (managed=%s)", async (managed) => {
    const { config, requests, put, get } = await harness(managed);
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ plugin: ["example@1.0.0"] }));
    await writeJuggleWorkRuntimeConfigFile(config, "ws_1");
    const before = await readPluginWorkspacePolicy(config, "ws_1");
    const runtimeBefore = await readRuntimeOpencodeConfig(config, "ws_1");
    const fileBefore = await readFile(juggleworkRuntimeConfigFilePath(config), "utf8");
    expect(await (await get("ws_1")).json()).toMatchObject({
      enforcementReady: false, controllablePluginSpecs: [], disabledPluginSpecs: [], revision: 0,
    });
    requests.length = 0;
    for (const body of [
      { disabledPluginSpecs: ["example@1.0.0"] },
      { disabledPluginSpecs: [] },
      { disabledPluginSpecs: ["missing"] },
      { disabledPluginSpecs: [23] },
      { disabledPluginSpecs: ["example@1.0.0"], disabledMarketplacePluginIds: ["package"] },
    ]) {
      const response = await put("ws_1", body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "plugin_policy_unavailable" });
    }
    expect(await readPluginWorkspacePolicy(config, "ws_1")).toEqual(before);
    expect(await readRuntimeOpencodeConfig(config, "ws_1")).toEqual(runtimeBefore);
    expect(await readFile(juggleworkRuntimeConfigFilePath(config), "utf8")).toBe(fileBefore);
    expect(requests).toEqual([]);
  });

  test("preserves persisted disables without filtering the shared runtime config", async () => {
    const { config, requests, put, get } = await harness(true);
    for (const id of ["ws_1", "ws_2"]) {
      await writeRuntimeOpencodeConfig(config, id, () => ({ plugin: ["example@1.0.0", "other@2.0.0"] }));
    }
    const persisted = await writePluginWorkspacePolicy(config, "ws_1", ["example@1.0.0", "example@1.0.0"]);
    expect(await (await get("ws_1")).json()).toMatchObject({
      disabledPluginSpecs: ["example@1.0.0"], controllablePluginSpecs: [], revision: 1, enforcementReady: false,
    });
    expect((await (await get("ws_2")).json()).disabledPluginSpecs).toEqual([]);
    for (const id of ["ws_1", "ws_2", "ws_1"]) {
      await writeJuggleWorkRuntimeConfigFile(config, id);
      const parsed = JSON.parse(await readFile(juggleworkRuntimeConfigFilePath(config), "utf8")) as { plugin: string[] };
      expect(parsed.plugin).toContain("example@1.0.0");
      expect(parsed.plugin).toContain("other@2.0.0");
    }
    expect((await put("ws_1", { disabledPluginSpecs: [] })).status).toBe(409);
    expect(await readPluginWorkspacePolicy(config, "ws_1")).toEqual(persisted);
    expect(requests.some((path) => path.includes("instance/dispose"))).toBe(false);
  });

  test("does not offer specs also loaded from user config or auto-discovered plugin directories", async () => {
    const { config, get, put } = await harness(true);
    const root = config.workspaces[0]!.path;
    await mkdir(join(root, ".opencode", "plugins"), { recursive: true });
    const fileSpec = `file://${join(root, ".opencode", "plugins", "demo.ts")}`;
    await writeFile(join(root, "opencode.json"), JSON.stringify({ plugin: ["duplicate@3.0.0"] }));
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ plugin: ["duplicate@2.0.0", fileSpec, "safe@1.0.0"] }));
    expect(await (await get("ws_1")).json()).toMatchObject({ controllablePluginSpecs: [], enforcementReady: false });
    expect((await put("ws_1", { disabledPluginSpecs: ["duplicate@2.0.0"] })).status).toBe(409);
    expect((await put("ws_1", { disabledPluginSpecs: [fileSpec] })).status).toBe(409);
    expect((await put("ws_1", { disabledPluginSpecs: ["safe@1.0.0"] })).status).toBe(409);
    await writeFile(join(root, "opencode.json"), JSON.stringify({ plugin: ["safe@2.0.0"] }));
    await writeJuggleWorkRuntimeConfigFile(config, "ws_1");
    const parsed = JSON.parse(await readFile(juggleworkRuntimeConfigFilePath(config), "utf8")) as { plugin: string[] };
    expect(parsed.plugin).toContain("safe@1.0.0");
    expect(await (await get("ws_1")).json()).toMatchObject({ controllablePluginSpecs: [], enforcementReady: false });
  });
});

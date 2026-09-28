import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import { readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ReloadEvent, ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) {
    const root = roots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReloadEvent(value: unknown): value is ReloadEvent {
  return isRecord(value) && typeof value.reason === "string";
}

function auth(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function createWorkspaceRoot() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-runtime-patch-reload-"));
  roots.push(root);
  return root;
}

async function startJuggleWorkServer(workspaceRoot: string, approvalMode: "auto" | "manual" = "auto") {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(workspaceRoot, "server.json"),
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: approvalMode, timeoutMs: 100 },
    corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Workspace", path: workspaceRoot, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, hostToken: config.hostToken, config };
}

async function patchConfig(base: string, token: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${base}/workspace/ws_1/config`, {
    method: "PATCH",
    headers: auth(token),
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

async function readEvents(base: string, token: string): Promise<ReloadEvent[]> {
  const response = await fetch(`${base}/workspace/ws_1/events`, { headers: auth(token) });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error("Expected reload event response");
  }
  return body.items.filter(isReloadEvent);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("workspace config patch reload events", () => {
  test("host-authorized Cloud provider patches bypass approval without weakening general config patches", async () => {
    const root = await createWorkspaceRoot();
    const { base, token, hostToken, config } = await startJuggleWorkServer(root, "manual");
    const provider = { lpr_example: { name: "Example", models: { test: { name: "Test" } } } };
    const url = `${base}/workspace/ws_1/cloud-provider-config`;
    const request = (headers: Record<string, string>, body: unknown) => fetch(url, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body),
    });

    expect((await request(auth(token), { provider })).status).toBe(401);
    expect((await request({ "x-jugglework-host-token": hostToken }, { provider: { other: {} } })).status).toBe(400);
    expect((await request({ "x-jugglework-host-token": hostToken }, { provider, opencode: { model: "evil" } })).status).toBe(400);
    expect((await request({ "x-jugglework-host-token": hostToken }, { provider })).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).provider).toEqual(provider);
    expect(await readEvents(base, token)).toHaveLength(1);

    expect((await request({ "x-jugglework-host-token": hostToken }, { provider })).status).toBe(200);
    expect(await readEvents(base, token)).toHaveLength(1);

    const general = await fetch(`${base}/workspace/ws_1/config`, {
      method: "PATCH", headers: auth(token), body: JSON.stringify({ opencode: { default_agent: "build" } }),
    });
    expect(general.status).toBe(403);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).default_agent).toBeUndefined();

    expect((await request({ "x-jugglework-host-token": hostToken }, { provider: { lpr_example: null } })).status).toBe(409);
    const baseline = await fetch(`${base}/workspace/ws_1/cloud-provider-imports/lpr_example`, {
      method: "PUT", headers: { "x-jugglework-host-token": hostToken, "content-type": "application/json" },
      body: JSON.stringify({ item: { cloudProviderId: "lpr_example", providerId: "lpr_example" } }),
    });
    expect(baseline.status).toBe(200);
    expect((await request({ "x-jugglework-host-token": hostToken }, { provider: { lpr_example: null } })).status).toBe(200);
    expect((await readRuntimeOpencodeConfig(config, "ws_1")).provider).toBeUndefined();

    const legacyBaseline = await fetch(`${base}/workspace/ws_1/cloud-provider-imports/lpr_legacy`, {
      method: "PUT", headers: { "x-jugglework-host-token": hostToken, "content-type": "application/json" },
      body: JSON.stringify({ item: { cloudProviderId: "lpr_legacy", providerId: "JuggleRouter" } }),
    });
    expect(legacyBaseline.status).toBe(200);
    expect((await request({ "x-jugglework-host-token": hostToken }, { provider: { JuggleRouter: null } })).status).toBe(200);
  });

  test("identical runtime provider patches do not emit another config reload event", async () => {
    const root = await createWorkspaceRoot();
    const { base, token } = await startJuggleWorkServer(root);
    const payload = {
      opencode: {
        provider: {
          p1: {
            id: "openrouter",
            name: "OpenRouter",
            env: ["OPENROUTER_API_KEY"],
            models: {
              "model-a": { id: "model-a", name: "Model A" },
            },
          },
        },
      },
    };

    await patchConfig(base, token, payload);
    const firstEvents = await readEvents(base, token);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0]?.reason).toBe("config");

    await sleep(800);
    await patchConfig(base, token, payload);

    const secondEvents = await readEvents(base, token);
    expect(secondEvents).toHaveLength(1);
  });

  test("compaction patches deep-merge and identical patches do not reload", async () => {
    const root = await createWorkspaceRoot();
    const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
    process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    try {
      const { base, token } = await startJuggleWorkServer(root);
      await patchConfig(base, token, {
        opencode: { compaction: { prune: false, reserved: 30_000 } },
      });
      await patchConfig(base, token, {
        opencode: { compaction: { auto: false } },
      });

      const config = {
        host: "127.0.0.1", port: 0, token, hostToken: "owt_host_token",
        approval: { mode: "auto" as const, timeoutMs: 1000 }, corsOrigins: ["*"],
        workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" as const }],
        authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
        tokenSource: "cli" as const, hostTokenSource: "cli" as const,
        logFormat: "pretty" as const, logRequests: false,
      };
      expect((await readRuntimeOpencodeConfig(config, "ws_1")).compaction).toEqual({
        auto: false,
        prune: false,
        reserved: 30_000,
      });

      const before = await readEvents(base, token);
      await sleep(800);
      await patchConfig(base, token, { opencode: { compaction: { auto: false } } });
      expect(await readEvents(base, token)).toHaveLength(before.length);
    } finally {
      if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
      else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    }
  });

  // 自动压缩已改为全局配置项：客户端必须能清除工作区运行时层的遗留值，否则
  // 工作区级旧值会在配置合并中静默压过全局设置。
  test("explicit null compaction clears the runtime layer without touching other keys", async () => {
    const root = await createWorkspaceRoot();
    const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
    process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
    try {
      const { base, token } = await startJuggleWorkServer(root);
      await patchConfig(base, token, {
        opencode: { default_agent: "build", compaction: { auto: false, reserved: 30_000 } },
      });

      const config = {
        host: "127.0.0.1", port: 0, token, hostToken: "owt_host_token",
        approval: { mode: "auto" as const, timeoutMs: 1000 }, corsOrigins: ["*"],
        workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local" as const }],
        authorizedRoots: [root], readOnly: false, startedAt: Date.now(),
        tokenSource: "cli" as const, hostTokenSource: "cli" as const,
        logFormat: "pretty" as const, logRequests: false,
      };
      expect((await readRuntimeOpencodeConfig(config, "ws_1")).compaction).toEqual({
        auto: false,
        reserved: 30_000,
      });

      await patchConfig(base, token, { opencode: { compaction: null } });
      const cleared = await readRuntimeOpencodeConfig(config, "ws_1");
      expect(cleared.compaction).toBeUndefined();
      expect(cleared.default_agent).toBe("build");
    } finally {
      if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
      else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    }
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function fixture(options: { readOnly?: boolean; stallSessionList?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "toon-text-maintenance-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const requests: string[] = [];
  let markSessionRequested: (() => void) | undefined;
  const sessionRequested = new Promise<void>((resolve) => { markSessionRequested = resolve; });
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (path === "/session") {
        markSessionRequested?.();
        if (options.stallSessionList) await new Promise<void>(() => undefined);
        return Response.json([]);
      }
      return Response.json({});
    },
  });
  cleanups.push(() => engine.stop(true));

  const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const serverPort = portProbe.port!;
  portProbe.stop(true);
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: serverPort,
    token: "maintenance-client",
    hostToken: "maintenance-host",
    configPath: join(root, "config.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws-1",
      name: "Workspace",
      path: workspaceRoot,
      baseUrl: `http://127.0.0.1:${engine.port}`,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: options.readOnly ?? false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  return { config, requests, sessionRequested, base: `http://127.0.0.1:${serverPort}` };
}

describe("Toon text startup maintenance", () => {
  test("listens and serves health while a non-responsive engine is bounded", async () => {
    const fx = await fixture({ stallSessionList: true });
    const startedAt = Date.now();
    const starting = startServer(fx.config, {
      toonTextMaintenance: { timeoutMs: 50, shutdownDrainMs: 30 },
    });

    await fx.sessionRequested;
    expect((await fetch(`${fx.base}/health`)).status).toBe(200);
    const server = await starting;
    cleanups.push(() => server.stop());
    expect(Date.now() - startedAt).toBeLessThan(1_000);

    const stoppedAt = Date.now();
    await server.stop();
    cleanups.pop();
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
  });

  test("returns only after normal cleanup is quiescent", async () => {
    const fx = await fixture();
    const server = await startServer(fx.config, {
      toonTextMaintenance: { timeoutMs: 500, shutdownDrainMs: 30 },
    });
    cleanups.push(() => server.stop());
    expect(fx.requests).toEqual(["/session"]);

    fx.requests.length = 0;
    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    expect(fx.requests).toEqual([]);
  });

  test("read-only startup performs no cleanup request", async () => {
    const fx = await fixture({ readOnly: true });
    const server = await startServer(fx.config, {
      toonTextMaintenance: { timeoutMs: 50, shutdownDrainMs: 30 },
    });
    cleanups.push(() => server.stop());

    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    expect(fx.requests).toEqual([]);
  });
});

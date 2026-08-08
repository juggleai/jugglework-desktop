import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";

import { startEmbeddedServer, type EmbeddedServerHandle, type EmbeddedServerOptions } from "./embedded.js";
import * as managedOpencodeModule from "./managed-opencode.js";
import { juggleworkRuntimeConfigFilePath } from "./jugglework-runtime-config.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import * as serverModule from "./server.js";
import type { ServerConfig } from "./types.js";

const ENV_NAMES = [
  "HOME",
  "JUGGLEWORK_DEV_MODE",
  "JUGGLEWORK_RUNTIME_DB",
  "JUGGLEWORK_OPENCODE_BASE_URL",
  "JUGGLEWORK_LIFECYCLE_LOG",
] as const;

type Fixture = {
  root: string;
  opencodeBin: string;
  logPath: string;
  handles: EmbeddedServerHandle[];
  restore: () => Promise<void>;
};

function restoreProcessEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeFakeOpencode(root: string): Promise<string> {
  const binPath = join(root, "fake-opencode.mjs");
  await writeFile(binPath, [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from 'node:fs';",
    "const portIndex = process.argv.indexOf('--port');",
    "const requestedPort = Number(process.argv[portIndex + 1] ?? 0);",
    "const logPath = process.env.JUGGLEWORK_LIFECYCLE_LOG;",
    "const append = (line) => { if (logPath) appendFileSync(logPath, `${line}\\n`); };",
    "append(`SERVER_URL=${process.env.JUGGLEWORK_SERVER_URL ?? ''}`);",
    "const server = Bun.serve({",
    "  hostname: '127.0.0.1',",
    "  port: requestedPort,",
    "  fetch(request) { append(new URL(request.url).pathname); return Response.json({}); },",
    "});",
    "console.log(`opencode server listening on http://127.0.0.1:${server.port}`);",
    "process.on('SIGTERM', () => { append('SIGTERM'); server.stop(true); process.exit(0); });",
  ].join("\n"));
  await chmod(binPath, 0o755);
  return binPath;
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-embedded-lifecycle-"));
  const previousEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
  const logPath = join(root, "managed-opencode.log");
  const handles: EmbeddedServerHandle[] = [];

  process.env.HOME = join(root, "home");
  process.env.JUGGLEWORK_DEV_MODE = "1";
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  process.env.JUGGLEWORK_LIFECYCLE_LOG = logPath;
  delete process.env.JUGGLEWORK_OPENCODE_BASE_URL;

  return {
    root,
    opencodeBin: await writeFakeOpencode(root),
    logPath,
    handles,
    async restore() {
      const errors: unknown[] = [];
      for (const handle of handles.reverse()) {
        try {
          await handle.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      for (const name of ENV_NAMES) restoreProcessEnv(name, previousEnv.get(name));
      try {
        await rm(root, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) throw new AggregateError(errors, "Failed to clean up embedded lifecycle test");
    },
  };
}

function managedOptions(fixture: Fixture, name: string): EmbeddedServerOptions {
  const workspace = join(fixture.root, `${name}-workspace`);
  return {
    configPath: join(fixture.root, `${name}-server.json`),
    host: "127.0.0.1",
    port: 0,
    token: "server-token",
    hostToken: "host-token",
    workspaces: [workspace],
    manageOpencode: true,
    opencodeBin: fixture.opencodeBin,
    opencodeCwd: workspace,
  };
}

async function startManaged(fixture: Fixture, name: string): Promise<EmbeddedServerHandle> {
  const options = managedOptions(fixture, name);
  await mkdir(options.opencodeCwd ?? "", { recursive: true });
  const handle = await startEmbeddedServer(options);
  fixture.handles.push(handle);
  return handle;
}

function workspaceId(config: ServerConfig): string {
  const id = config.workspaces[0]?.id;
  if (!id) throw new Error("Expected an embedded workspace");
  return id;
}

async function mutateWorkspace(config: ServerConfig, label: string): Promise<void> {
  await writeRuntimeOpencodeConfig(config, workspaceId(config), (current) => ({
    ...current,
    mcp: { [label]: { type: "remote", url: `https://${label}.example.test/mcp` } },
  }));
}

async function runtimeConfigMcp(config: ServerConfig): Promise<Record<string, unknown>> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const content = await readFile(juggleworkRuntimeConfigFilePath(config), "utf8");
  const parsed = JSON.parse(content) as { mcp?: Record<string, unknown> };
  return parsed.mcp ?? {};
}

async function logLines(path: string): Promise<string[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content.split("\n").filter(Boolean);
}

describe("embedded server lifecycle", () => {
  test.serial("injects the authoritative bound Server URL into managed OpenCode", async () => {
    const fixture = await createFixture();
    try {
      const handle = await startManaged(fixture, "authoritative-port");
      expect(handle.port).toBeGreaterThan(0);
      expect(handle.config.port).toBe(handle.port);
      expect(await logLines(fixture.logPath)).toContain(`SERVER_URL=${handle.url}`);
    } finally {
      await fixture.restore();
    }
  });

  test.serial("stop is shared, releases each resource once, and unregisters a non-secret identity", async () => {
    const fixture = await createFixture();
    const originalStartServer = serverModule.startServer;
    let httpStopCalls = 0;
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      const server = await originalStartServer(config);
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
        },
      };
    });
    const registerSpy = spyOn(serverModule, "registerTrustedOpencodeProcess");
    const clearSpy = spyOn(serverModule, "clearTrustedOpencodeProcess");

    try {
      const handle = await startManaged(fixture, "idempotent");
      const registration = registerSpy.mock.calls[0]?.[1];
      if (!registration) throw new Error("Expected trusted process registration");
      expect(registration.identity).toMatch(/^\d+:[0-9a-f-]{36}$/i);
      expect(registration.identity).not.toContain(handle.config.opencodeUsername ?? "missing-username");
      expect(registration.identity).not.toContain(handle.config.opencodePassword ?? "missing-password");

      const firstStop = handle.stop();
      const secondStop = handle.stop();
      expect(secondStop).toBe(firstStop);
      await Promise.all([firstStop, secondStop]);

      expect(httpStopCalls).toBe(1);
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(clearSpy.mock.calls[0]?.[1]).toBe(registration.identity);
      expect((await logLines(fixture.logPath)).filter((line) => line === "SIGTERM")).toHaveLength(1);
      expect(handle.managedOpencode?.isAlive()).toBe(false);
      await expect(fetch(handle.url)).rejects.toThrow();
      await expect(handle.stop()).resolves.toBeUndefined();

      await mutateWorkspace(handle.config, "after-stop");
      expect(await runtimeConfigMcp(handle.config)).not.toHaveProperty("after-stop");
    } finally {
      clearSpy.mockRestore();
      registerSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("managed OpenCode startup failure rolls back the HTTP server and config listener", async () => {
    const fixture = await createFixture();
    const startupError = new Error("forced managed OpenCode startup failure");
    const originalStartServer = serverModule.startServer;
    let failedConfig: ServerConfig | null = null;
    let boundUrl = "";
    let httpStopCalls = 0;
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      failedConfig = config;
      const server = await originalStartServer(config);
      boundUrl = `http://127.0.0.1:${server.port}`;
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
        },
      };
    });
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer")
      .mockRejectedValue(startupError);

    try {
      const options = managedOptions(fixture, "startup-failure");
      await mkdir(options.opencodeCwd ?? "", { recursive: true });
      await expect(startEmbeddedServer(options)).rejects.toBe(startupError);
      if (!failedConfig || !boundUrl) throw new Error("Expected startup to bind the HTTP server");

      const config: ServerConfig = failedConfig;
      await mutateWorkspace(config, "after-startup-failure");
      expect(await runtimeConfigMcp(config)).not.toHaveProperty("after-startup-failure");
      expect(httpStopCalls).toBe(1);
      await expect(fetch(boundUrl)).rejects.toThrow();
    } finally {
      managedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });

  test.serial("shutdown aggregates failures while continuing to release later resources", async () => {
    const fixture = await createFixture();
    const managedError = new Error("forced managed OpenCode shutdown failure");
    const httpError = new Error("forced HTTP shutdown failure");
    const originalCreateManaged = managedOpencodeModule.createManagedOpencodeServer;
    const originalStartServer = serverModule.startServer;
    let managedCloseCalls = 0;
    let httpStopCalls = 0;
    const managedSpy = spyOn(managedOpencodeModule, "createManagedOpencodeServer").mockImplementation(async (options) => {
      const managed = await originalCreateManaged(options);
      return {
        ...managed,
        async close() {
          managedCloseCalls += 1;
          await managed.close();
          throw managedError;
        },
      };
    });
    const startSpy = spyOn(serverModule, "startServer").mockImplementation(async (config) => {
      const server = await originalStartServer(config);
      return {
        ...server,
        async stop() {
          httpStopCalls += 1;
          await server.stop();
          throw httpError;
        },
      };
    });

    try {
      const handle = await startManaged(fixture, "shutdown-failure");
      const firstStop = handle.stop();
      expect(handle.stop()).toBe(firstStop);

      let observed: unknown;
      try {
        await firstStop;
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(AggregateError);
      if (!(observed instanceof AggregateError)) throw new Error("Expected aggregate shutdown failure");
      expect(observed.errors).toEqual([managedError, httpError]);
      expect(managedCloseCalls).toBe(1);
      expect(httpStopCalls).toBe(1);
      await mutateWorkspace(handle.config, "after-failed-stop");
      expect(await runtimeConfigMcp(handle.config)).not.toHaveProperty("after-failed-stop");
      await expect(fetch(handle.url)).rejects.toThrow();
      fixture.handles.splice(fixture.handles.indexOf(handle), 1);
    } finally {
      managedSpy.mockRestore();
      startSpy.mockRestore();
      await fixture.restore();
    }
  });
});

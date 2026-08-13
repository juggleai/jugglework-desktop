import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  commandMatchesPackagedSidecar,
  createRuntimeManager,
  denModelsCatalogUrl,
  embeddedServerImportUrl,
  prioritizeWorkspacePaths,
  resolveJuggleWorkServerConfigPath,
  seedWorkspacePathsForEmbeddedServer,
  selectStickyJuggleWorkPortWorkspace,
  shouldReuseHealthyManagedRuntime,
  snapshotEngineState,
} from "./runtime.mjs";

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("prioritizeWorkspacePaths", () => {
  it("keeps the active runtime workspace first", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current", ["/workspace/other", "/workspace/current"]),
      ["/workspace/current", "/workspace/other"],
    );
  });

  it("dedupes equivalent paths", () => {
    assert.deepEqual(
      prioritizeWorkspacePaths("/workspace/current/../current", ["/workspace/current"]),
      ["/workspace/current/../current"],
    );
  });
});

describe("seedWorkspacePathsForEmbeddedServer", () => {
  it("uses persisted server config instead of Electron workspace state once config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/legacy"], true),
      [],
    );
  });

  it("seeds from Electron workspace state before server config exists", () => {
    assert.deepEqual(
      seedWorkspacePathsForEmbeddedServer(["/workspace/first"], false),
      ["/workspace/first"],
    );
  });
});

describe("selectStickyJuggleWorkPortWorkspace", () => {
  it("uses the requested workspace even when server config owns workspace loading", () => {
    assert.equal(
      selectStickyJuggleWorkPortWorkspace(["/workspace/current"], []),
      "/workspace/current",
    );
  });

  it("falls back to server workspace paths when no requested path is available", () => {
    assert.equal(
      selectStickyJuggleWorkPortWorkspace([], ["/workspace/from-server"]),
      "/workspace/from-server",
    );
  });
});

describe("shouldReuseHealthyManagedRuntime", () => {
  it("reuses one healthy managed engine when the selected workspace changes", () => {
    assert.equal(shouldReuseHealthyManagedRuntime({
      forceRestart: false,
      inProcess: true,
      lifecycleState: "healthy",
      remoteAccessEnabled: false,
      requestedRemoteAccess: false,
      running: true,
      baseUrl: "http://127.0.0.1:4097",
      hasToken: true,
    }), true);
  });

  it("does not reuse when a restart or remote-access change is required", () => {
    const healthy = {
      inProcess: true,
      lifecycleState: "healthy",
      remoteAccessEnabled: false,
      requestedRemoteAccess: false,
      running: true,
      baseUrl: "http://127.0.0.1:4097",
      hasToken: true,
    };
    assert.equal(shouldReuseHealthyManagedRuntime({ ...healthy, forceRestart: true }), false);
    assert.equal(shouldReuseHealthyManagedRuntime({ ...healthy, forceRestart: false, requestedRemoteAccess: true }), false);
  });
});

describe("commandMatchesPackagedSidecar", () => {
  it("matches packaged opencode sidecars with platform suffixes", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/JuggleWork.app/Contents/Resources/sidecars/opencode-aarch64-apple-darwin serve --hostname 127.0.0.1 --port 49174 --cors *",
        ["/Applications/JuggleWork.app/Contents/Resources/sidecars"],
      ),
      true,
    );
  });

  it("does not match unrelated opencode processes outside sidecar directories", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/usr/local/bin/opencode serve --hostname 127.0.0.1 --port 49174",
        ["/Applications/JuggleWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });

  it("does not inspect retired orchestrator processes during runtime cleanup", () => {
    assert.equal(
      commandMatchesPackagedSidecar(
        "/Applications/JuggleWork.app/Contents/Resources/sidecars/jugglework-orchestrator daemon run",
        ["/Applications/JuggleWork.app/Contents/Resources/sidecars"],
      ),
      false,
    );
  });
});

describe("Electron managed runtime", () => {
  it("starts through embedded Server without locating or spawning orchestrator", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jugglework-electron-runtime-"));
    const desktopRoot = path.join(root, "desktop");
    const workspacePath = path.join(root, "workspace");
    const userDataPath = path.join(root, "user-data");
    const homePath = path.join(root, "home");
    const sidecarDir = path.join(desktopRoot, "resources", "sidecars");
    const orchestratorMarker = path.join(root, "orchestrator-spawned");
    const legacyDataDir = path.join(root, "legacy-orchestrator-data");
    const previousDataDir = process.env.JUGGLEWORK_DATA_DIR;
    const previousServerConfig = process.env.JUGGLEWORK_SERVER_CONFIG;
    const servers = [];
    let manager = null;
    /** @type {any} */
    let embeddedStartOptions = null;
    let legacyStateRequests = 0;

    try {
      await mkdir(sidecarDir, { recursive: true });
      await mkdir(workspacePath, { recursive: true });
      await mkdir(homePath, { recursive: true });
      await mkdir(legacyDataDir, { recursive: true });
      await writeFile(path.join(sidecarDir, "opencode"), "#!/bin/sh\nexit 99\n");
      await chmod(path.join(sidecarDir, "opencode"), 0o755);
      await writeFile(
        path.join(sidecarDir, "jugglework-orchestrator"),
        `#!/bin/sh\nprintf spawned > ${JSON.stringify(orchestratorMarker)}\nexit 98\n`,
      );
      await chmod(path.join(sidecarDir, "jugglework-orchestrator"), 0o755);

      const legacyStateServer = http.createServer((_request, response) => {
        legacyStateRequests += 1;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end("{}");
      });
      servers.push(legacyStateServer);
      const legacyPort = await listen(legacyStateServer);
      await writeFile(
        path.join(legacyDataDir, "jugglework-orchestrator-state.json"),
        JSON.stringify({ daemon: { baseUrl: `http://127.0.0.1:${legacyPort}` } }),
      );

      process.env.JUGGLEWORK_DATA_DIR = legacyDataDir;
      process.env.JUGGLEWORK_SERVER_CONFIG = path.join(root, "server.json");
      const app = {
        isPackaged: false,
        getPath(name) {
          if (name === "userData") return userDataPath;
          if (name === "home") return homePath;
          if (name === "exe") return path.join(desktopRoot, "JuggleWork");
          throw new Error(`Unexpected app path: ${name}`);
        },
      };

      manager = createRuntimeManager({
        app,
        desktopRoot,
        listLocalWorkspacePaths: async () => [workspacePath],
        readDenBaseUrl: () => null,
        startEmbeddedServer: async (options) => {
          embeddedStartOptions = options;
          const server = http.createServer((request, response) => {
            response.setHeader("Content-Type", "application/json");
            if (request.url === "/tokens" && request.method === "POST") {
              response.end(JSON.stringify({ token: "owner-token" }));
              return;
            }
            if (request.url === "/workspaces") {
              response.end(JSON.stringify({
                items: [{
                  opencode: {
                    baseUrl: "http://127.0.0.1:43123",
                    directory: workspacePath,
                  },
                }],
              }));
              return;
            }
            response.statusCode = 404;
            response.end("{}");
          });
          servers.push(server);
          const port = await listen(server, options.port);
          return {
            port,
            url: `http://127.0.0.1:${port}`,
            managedOpencodeExecution: null,
            managedOpencode: { pid: 43210, isAlive: () => true },
            stop: () => closeServer(server),
          };
        },
      });

      assert.equal(manager.managedServerAccess(), null);
      const engine = await manager.engineStart(workspacePath, { workspacePaths: [workspacePath] });
      assert.equal(engine.runtime, "direct");
      assert.equal(engine.running, true);
      assert.equal(engine.managedByServer, true);
      assert.equal(embeddedStartOptions.manageOpencode, true);
      assert.equal(embeddedStartOptions.opencodeBin, path.join(sidecarDir, "opencode"));
      assert.equal(embeddedStartOptions.workspaces[0], workspacePath);
      assert.equal(embeddedStartOptions.claudeProfileDataDir, path.join(userDataPath, "claude-agent"));
      assert.deepEqual(manager.managedServerAccess(), {
        baseUrl: `http://127.0.0.1:${embeddedStartOptions.port}`,
        clientToken: embeddedStartOptions.token,
      });
      assert.equal(Object.hasOwn(manager.managedServerAccess(), "ownerToken"), false);
      assert.equal(Object.hasOwn(manager.managedServerAccess(), "hostToken"), false);

      const status = await manager.runtimeStatus();
      assert.equal(status.lifecycleState, "healthy");
      assert.equal(status.juggleworkServer.running, true);
      const activation = await manager.workspaceActivate({ workspacePath, name: "Workspace" });
      assert.equal(activation.path, workspacePath);
      assert.equal(activation.name, "Workspace");
      assert.ok(activation.id);
      assert.equal(await manager.engineDispose(workspacePath), true);
      assert.equal(legacyStateRequests, 0);
      await assert.rejects(readFile(orchestratorMarker, "utf8"), { code: "ENOENT" });
    } finally {
      if (manager) await manager.dispose().catch(() => undefined);
      for (const server of servers) {
        if (server.listening) await closeServer(server).catch(() => undefined);
      }
      if (previousDataDir === undefined) delete process.env.JUGGLEWORK_DATA_DIR;
      else process.env.JUGGLEWORK_DATA_DIR = previousDataDir;
      if (previousServerConfig === undefined) delete process.env.JUGGLEWORK_SERVER_CONFIG;
      else process.env.JUGGLEWORK_SERVER_CONFIG = previousServerConfig;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("delegates sandbox start to the Desktop sandbox runtime", async () => {
    const calls = [];
    const expected = {
      juggleworkUrl: "http://127.0.0.1:43123",
      token: "token",
      hostToken: "host-token",
      port: 43123,
      sandboxBackend: "docker",
      sandboxRunId: "run-1",
      sandboxContainerName: "jugglework-sandbox-run-1",
    };
    const manager = createRuntimeManager({
      app: {
        getPath(name) {
          if (name === "userData") return "/tmp/jugglework-runtime-user-data";
          if (name === "home") return "/tmp";
          if (name === "exe") return "/tmp/JuggleWork";
          throw new Error(`Unexpected app path: ${name}`);
        },
      },
      desktopRoot: "/tmp/jugglework-desktop",
      listLocalWorkspacePaths: async () => [],
      readDenBaseUrl: () => null,
      sandboxRuntime: {
        start: async (options) => { calls.push(options); return expected; },
        doctor: async () => ({ ready: true }),
        stop: async () => ({ ok: true }),
        cleanup: async () => ({ candidates: [], removed: [], errors: [] }),
        debugProbe: async () => ({ ready: true }),
      },
    });

    assert.equal(await manager.sandboxStart({ workspacePath: "/workspace", sandboxBackend: "docker" }), expected);
    assert.deepEqual(calls, [
      { workspacePath: "/workspace", sandboxBackend: "docker" },
    ]);
  });
});

describe("embeddedServerImportUrl", () => {
  it("returns the same file URL for unchanged metadata", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jugglework-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");

      const first = embeddedServerImportUrl(embeddedPath);
      const second = embeddedServerImportUrl(embeddedPath);
      const url = new URL(first);

      assert.equal(first, second);
      assert.equal(url.protocol, "file:");
      assert.equal(fileURLToPath(url), embeddedPath);
      assert.ok(url.searchParams.get("mtimeMs"));
      assert.equal(url.searchParams.get("size"), String("export const value = 1;\n".length));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes when the file metadata changes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "jugglework-runtime-"));
    try {
      const embeddedPath = path.join(dir, "embedded.js");
      await writeFile(embeddedPath, "export const value = 1;\n");
      const first = embeddedServerImportUrl(embeddedPath);

      await writeFile(embeddedPath, "export const value = 12;\n");

      assert.notEqual(embeddedServerImportUrl(embeddedPath), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the plain file URL if stat fails", () => {
    const missingPath = path.join(os.tmpdir(), "jugglework-missing-embedded.js");

    assert.equal(embeddedServerImportUrl(missingPath), pathToFileURL(missingPath).href);
  });
});

describe("resolveJuggleWorkServerConfigPath", () => {
  it("respects explicit server config path", () => {
    assert.equal(
      resolveJuggleWorkServerConfigPath({ JUGGLEWORK_SERVER_CONFIG: "/tmp/jugglework/server.json" }),
      "/tmp/jugglework/server.json",
    );
  });

  it("uses XDG config home on Unix", () => {
    if (process.platform === "win32") return;
    assert.equal(
      resolveJuggleWorkServerConfigPath({ XDG_CONFIG_HOME: "/tmp/xdg" }),
      "/tmp/xdg/jugglework/server.json",
    );
  });
});

describe("snapshotEngineState", () => {
  it("reports server-managed OpenCode liveness and pid without a child handle", () => {
    const snapshot = snapshotEngineState({
      child: null,
      childExited: false,
      runtime: "direct",
      projectDir: "/workspace/current",
      hostname: "127.0.0.1",
      port: 4097,
      baseUrl: "http://127.0.0.1:4097",
      opencodeUsername: null,
      opencodePassword: null,
      opencodeBinPath: null,
      opencodeBinSource: null,
      managedByServer: true,
      managedPid: 12345,
      managedIsAlive: () => true,
      lastStdout: null,
      lastStderr: null,
      execution: null,
    });
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.managedByServer, true);
    assert.equal(snapshot.pid, 12345);
  });
});

describe("denModelsCatalogUrl", () => {
  it("points the engine at the connected deployment's catalog", () => {
    for (const baseUrl of [
      "https://juggle.example.test",
      "https://juggle.example.test/",
      "https://juggle.example.test/jwork",
      "https://juggle.example.test/jwork/api",
    ]) {
      assert.equal(denModelsCatalogUrl(baseUrl), "https://juggle.example.test/jwork/models");
    }
  });

  it("keeps a deployment mounted under a sub-path", () => {
    assert.equal(
      denModelsCatalogUrl("https://host.example/base/api/den"),
      "https://host.example/base/jwork/models",
    );
  });

  it("points the hosted engine at the hosted deployment catalog", () => {
    assert.equal(denModelsCatalogUrl("https://work.juggle.im"), "https://work.juggle.im/jwork/models");
    assert.equal(denModelsCatalogUrl("https://work.juggle.im/api/den"), "https://work.juggle.im/jwork/models");
  });

  it("returns null rather than a broken URL for unusable input", () => {
    for (const value of ["", "   ", "not a url", "ftp://host/path", null, undefined]) {
      assert.equal(denModelsCatalogUrl(value), null);
    }
  });
});

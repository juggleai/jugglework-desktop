#!/usr/bin/env bun

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  createServerLogger,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepJuggleWorkRuntimeConfigFileFresh, writeJuggleWorkRuntimeConfigFile } from "./jugglework-runtime-config.js";
import type { ServeResult } from "./serve-node.js";
import { startWorkerActivityHeartbeat, type WorkerActivityHeartbeatHandle } from "./worker-activity-heartbeat.js";
import pkg from "../package.json" with { type: "json" };

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

const config = await resolveServerConfig(args);
const logger = createServerLogger(config);
const opencodeModelsUrl = process.env.OPENCODE_MODELS_URL?.trim()
  || (process.env.JUGGLEWORK_DEV_MODE === "1"
    ? "http://localhost:8791/models"
    : "https://work.juggle.im/jwork/models");
let managedOpencode: ManagedOpencodeServer | null = null;
let managedOpencodeIdentity: string | null = null;
let stopRuntimeConfigFileRefresh: (() => void) | null = null;
let server: ServeResult | null = null;
let workerActivityHeartbeat: WorkerActivityHeartbeatHandle | null = null;
let shutdownPromise: Promise<void> | null = null;

const shutdown = (): Promise<void> => {
  shutdownPromise ??= (async () => {
    const errors: unknown[] = [];
    if (workerActivityHeartbeat) {
      const heartbeat = workerActivityHeartbeat;
      workerActivityHeartbeat = null;
      try {
        heartbeat.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (managedOpencodeIdentity) {
      const identity = managedOpencodeIdentity;
      managedOpencodeIdentity = null;
      try {
        clearTrustedOpencodeProcess(config, identity);
      } catch (error) {
        errors.push(error);
      }
    }
    if (managedOpencode) {
      const opencode = managedOpencode;
      managedOpencode = null;
      try {
        await opencode.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (server) {
      const httpServer = server;
      server = null;
      try {
        await httpServer.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (stopRuntimeConfigFileRefresh) {
      const unsubscribe = stopRuntimeConfigFileRefresh;
      stopRuntimeConfigFileRefresh = null;
      try {
        unsubscribe();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Failed to stop JuggleWork server");
  })();
  return shutdownPromise;
};

const duringStartup = async <T>(operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (startupError) {
    try {
      await shutdown();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "JuggleWork server startup failed and cleanup was incomplete",
      );
    }
    throw startupError;
  }
};

if (!config.readOnly) {
  await ensureLocalWorkspaceFiles(config.workspaces);
}

// Bind first so managed OpenCode receives the authoritative callback URL even
// when port 0 or the Node adapter's address-in-use fallback selects a new port.
server = await duringStartup(() => startServer(config));
config.port = server.port;
const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`;

if (!config.opencodeBaseUrl && process.env.JUGGLEWORK_MANAGE_OPENCODE === "1") {
  const workspace = findManagedEngineWorkspace(config.workspaces);
  if (workspace) {
    // Server-managed config file: the engine re-reads it from disk on every
    // instance rebuild, and keepJuggleWorkRuntimeConfigFileFresh rewrites it
    // on every runtime-DB write — so disposes always pick up current state.
    const runtimeConfigPath = await writeJuggleWorkRuntimeConfigFile(config, workspace.id);
    stopRuntimeConfigFileRefresh = keepJuggleWorkRuntimeConfigFileFresh(config, workspace.id);
    const managedOpencodeCwd = process.env.JUGGLEWORK_MANAGED_OPENCODE_CWD?.trim() || workspace.path;
    await duringStartup(() => mkdir(managedOpencodeCwd, { recursive: true }));
    managedOpencode = await duringStartup(() => createManagedOpencodeServer({
      bin: process.env.JUGGLEWORK_OPENCODE_BIN,
      cwd: managedOpencodeCwd,
      excludedPorts: [config.port],
      env: {
        ...(process.env.JUGGLEWORK_DEV_MODE ? { JUGGLEWORK_DEV_MODE: process.env.JUGGLEWORK_DEV_MODE } : {}),
        ...(process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY ? { JUGGLEWORK_UI_CONTROL_DISCOVERY: process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY } : {}),
        JUGGLEWORK_SERVER_URL: serverUrl,
        JUGGLEWORK_SERVER_TOKEN: config.token,
        JUGGLEWORK_WORKSPACE_ID: workspace.id,
        OPENCODE_CONFIG: runtimeConfigPath,
        ...(opencodeModelsUrl ? { OPENCODE_MODELS_URL: opencodeModelsUrl } : {}),
      },
    }));
    config.opencodeBaseUrl = managedOpencode.url;
    config.opencodeUsername = managedOpencode.username;
    config.opencodePassword = managedOpencode.password;
    for (const entry of config.workspaces) {
      if (entry.workspaceType === "remote") {
        entry.baseUrl ??= managedOpencode.url;
        entry.opencodeUsername ??= managedOpencode.username;
        entry.opencodePassword ??= managedOpencode.password;
        entry.directory ??= entry.path;
        continue;
      }
      entry.baseUrl = managedOpencode.url;
      entry.opencodeUsername = managedOpencode.username;
      entry.opencodePassword = managedOpencode.password;
      entry.directory = entry.path;
    }
    managedOpencodeIdentity = [
      managedOpencode.pid ?? "unknown",
      randomUUID(),
    ].join(":");
    await duringStartup(async () => {
      registerTrustedOpencodeProcess(config, {
        baseUrl: managedOpencode?.url ?? "",
        identity: managedOpencodeIdentity ?? "",
        isAlive: managedOpencode?.isAlive ?? (() => false),
      });
    });
    logger.log("info", `Managed OpenCode listening on ${managedOpencode.url}`);
  }
}

// The runtime config file above only covers workspaces[0]. Push every
// workspace's runtime-DB MCPs into the engine so they aren't invisible
// until a manual reload. Best-effort.
if (managedOpencode) {
  void syncAllWorkspacesRuntimeMcpToEngine(config);
}

workerActivityHeartbeat = startWorkerActivityHeartbeat(config, logger);

const url = `http://${config.host}:${server.port}`;
logger.log("info", `JuggleWork server listening on ${url}`);

if (config.tokenSource === "generated") {
  logger.log("info", `Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  logger.log("info", `Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  logger.log("info", "No workspaces configured. Add --workspace or update server.json.");
} else {
  logger.log("info", `Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  logger.log("info", `Config path: ${config.configPath ?? "unknown"}`);
  logger.log("info", `Read-only: ${config.readOnly ? "true" : "false"}`);
  logger.log("info", `Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  logger.log("info", `CORS origins: ${config.corsOrigins.join(", ")}`);
  logger.log("info", `Authorized roots: ${config.authorizedRoots.join(", ")}`);
  logger.log("info", `Token source: ${config.tokenSource}`);
  logger.log("info", `Host token source: ${config.hostTokenSource}`);
}

const SHUTDOWN_DEADLINE_MS = 5000;
let signalShutdownPromise: Promise<void> | null = null;
const handleSignal = (): Promise<void> => {
  signalShutdownPromise ??= (async () => {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        shutdown(),
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`JuggleWork server shutdown exceeded ${SHUTDOWN_DEADLINE_MS}ms`)),
            SHUTDOWN_DEADLINE_MS,
          );
        }),
      ]);
      process.exit(0);
    } catch (error) {
      logger.log("error", error instanceof Error ? error.message : String(error));
      process.exit(1);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  })();
  return signalShutdownPromise;
};

process.once("SIGINT", () => void handleSignal());
process.once("SIGTERM", () => void handleSignal());

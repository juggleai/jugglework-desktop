/**
 * Single entry point for embedding the JuggleWork server in-process.
 *
 * Handles config resolution, managed OpenCode spawn, and server start
 * in one call -- mirrors what cli.ts does but returns a handle instead
 * of owning the process lifecycle.
 */
import { mkdir } from "node:fs/promises";
import { resolveServerConfig, type CliArgs } from "./config.js";
import { createManagedOpencodeServer, type ManagedOpencodeServer, type OpencodeExecutionSnapshot } from "./managed-opencode.js";
import {
  clearTrustedOpencodeProcess,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import { ensureLocalWorkspaceFiles } from "./workspace-init.js";
import { findManagedEngineWorkspace } from "./workspaces.js";
import { keepJuggleWorkRuntimeConfigFileFresh, writeJuggleWorkRuntimeConfigFile } from "./jugglework-runtime-config.js";
import { sweepLegacyOpenCodeConfig } from "./legacy-config-sweep.js";
import type { ServeResult } from "./serve-node.js";
import type { ServerConfig } from "./types.js";

export type EmbeddedServerOptions = CliArgs & {
  /** When true, spawn a managed OpenCode child process. */
  manageOpencode?: boolean;
  /** Path to the OpenCode binary. Falls back to JUGGLEWORK_OPENCODE_BIN env. */
  opencodeBin?: string;
  /** Working directory for the managed OpenCode process. */
  opencodeCwd?: string;
  /**
   * Provider catalog the managed OpenCode engine reads (`OPENCODE_MODELS_URL`).
   * The desktop shell points this at the connected private cloud so the
   * engine's provider list matches what that deployment supports; unset falls
   * back to the public JuggleWork mirror.
   */
  modelsUrl?: string;
};

export type EmbeddedServerHandle = {
  /** Bound port the HTTP server is listening on. */
  port: number;
  /** Full base URL, e.g. http://127.0.0.1:48123 */
  url: string;
  /** The resolved server config (with OpenCode URLs populated). */
  config: ServerConfig;
  /** Redacted details for the managed OpenCode child process, when spawned. */
  managedOpencodeExecution: OpencodeExecutionSnapshot | null;
  /** Liveness for the managed OpenCode child process, when spawned. */
  managedOpencode: { pid: number | null; isAlive: () => boolean } | null;
  /** Stop the HTTP server and managed OpenCode (if any). */
  stop: () => Promise<void>;
};

export async function startEmbeddedServer(options: EmbeddedServerOptions): Promise<EmbeddedServerHandle> {
  const config = await resolveServerConfig(options);
  const serverUrl = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
  // The engine's provider catalog comes from the connected deployment
  // (`<origin>/jwork/models`). With no deployment to read it from, the variable
  // is left unset and the engine uses its own built-in catalog source.
  const opencodeModelsUrl = options.modelsUrl?.trim()
    || (process.env.JUGGLEWORK_DEV_MODE === "1" ? "http://localhost:8791/models" : "");

  // Spawn managed OpenCode if requested and no explicit base URL was provided.
  let managedOpencode: ManagedOpencodeServer | null = null;
  let managedOpencodeIdentity: string | null = null;

  if (!config.readOnly) {
    await ensureLocalWorkspaceFiles(config.workspaces);
  }

  if (!config.opencodeBaseUrl && options.manageOpencode) {
    const workspace = findManagedEngineWorkspace(config.workspaces);
    if (workspace) {
      // Server-managed config file: the engine re-reads it from disk on every
      // instance rebuild, and keepJuggleWorkRuntimeConfigFileFresh rewrites it
      // on every runtime-DB write — so disposes always pick up current state.
      const runtimeConfigPath = await writeJuggleWorkRuntimeConfigFile(config, workspace.id);
      keepJuggleWorkRuntimeConfigFileFresh(config, workspace.id);
      const cwd = options.opencodeCwd
        || process.env.JUGGLEWORK_MANAGED_OPENCODE_CWD?.trim()
        || workspace.path;
      await mkdir(cwd, { recursive: true });
      await sweepLegacyOpenCodeConfig(config).catch(() => undefined);

      managedOpencode = await createManagedOpencodeServer({
        bin: options.opencodeBin || process.env.JUGGLEWORK_OPENCODE_BIN,
        cwd,
        excludedPorts: [config.port],
        env: {
          ...(process.env.JUGGLEWORK_DEV_MODE ? { JUGGLEWORK_DEV_MODE: process.env.JUGGLEWORK_DEV_MODE } : {}),
          ...(process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY ? { JUGGLEWORK_UI_CONTROL_DISCOVERY: process.env.JUGGLEWORK_UI_CONTROL_DISCOVERY } : {}),
          JUGGLEWORK_SERVER_URL: serverUrl,
          JUGGLEWORK_SERVER_TOKEN: config.token,
          OPENCODE_CONFIG: runtimeConfigPath,
          ...(opencodeModelsUrl ? { OPENCODE_MODELS_URL: opencodeModelsUrl } : {}),
        },
      });

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
        managedOpencode.username,
        managedOpencode.password,
      ].join(":");
      registerTrustedOpencodeProcess(config, {
        baseUrl: managedOpencode.url,
        identity: managedOpencodeIdentity,
        isAlive: managedOpencode.isAlive,
      });
    }
  }

  const server = await startServer(config);

  // The runtime config file above only covers workspaces[0]. Push every
  // workspace's runtime-DB MCPs into the engine so they aren't invisible
  // until a manual reload. Best-effort.
  if (managedOpencode) {
    void syncAllWorkspacesRuntimeMcpToEngine(config);
  }

  return {
    port: server.port,
    url: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${server.port}`,
    config,
    managedOpencodeExecution: managedOpencode?.execution ?? null,
    managedOpencode: managedOpencode
      ? { pid: managedOpencode.pid ?? null, isAlive: managedOpencode.isAlive }
      : null,
    async stop() {
      if (managedOpencodeIdentity) {
        clearTrustedOpencodeProcess(config, managedOpencodeIdentity);
      }
      await managedOpencode?.close();
      await server.stop();
    },
  };
}

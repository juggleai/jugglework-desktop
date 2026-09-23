import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startEmbeddedServer, type EmbeddedServerHandle } from "jugglework-server";
import type { CliOptions } from "./args.js";
import {
  DISTRIBUTION_MANIFEST,
  hostDistributionTarget,
  parseDistributionManifest,
  REQUIRED_PLUGIN_FILES,
  resolveManifestPath,
  verifyManifestFile,
} from "./distribution.js";

export { REQUIRED_PLUGIN_FILES } from "./distribution.js";

export type RuntimeConnection = {
  url: string;
  token: string;
  hostToken: string | null;
  owned: boolean;
  stop: () => Promise<void>;
};

async function executable(path: string | null | undefined): Promise<string | null> {
  if (!path?.trim()) return null;
  const target = resolve(path.trim());
  try {
    await access(target, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}

function executableOnPath(name: string): string | null {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? null;
}

function sourceRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function installedOpenCodeCandidates(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      "/Applications/JuggleWork.app/Contents/Resources/sidecars/opencode",
      join(home, "Applications", "JuggleWork.app", "Contents", "Resources", "sidecars", "opencode"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return [
      join(local, "Programs", "JuggleWork", "resources", "sidecars", "opencode.exe"),
      join(local, "JuggleWork", "resources", "sidecars", "opencode.exe"),
    ];
  }
  return [
    "/opt/JuggleWork/resources/sidecars/opencode",
    join(home, ".local", "share", "jugglework", "resources", "sidecars", "opencode"),
  ];
}

export type PackagedRuntimeAssets = { opencodeBin: string; pluginDir: string };

export async function resolvePackagedRuntimeAssets(executablePath = process.execPath): Promise<PackagedRuntimeAssets | null> {
  const roots = [dirname(executablePath), resolve(dirname(executablePath), "..")];
  for (const root of roots) {
    const manifestPath = join(root, DISTRIBUTION_MANIFEST);
    try {
      await access(manifestPath, constants.R_OK);
    } catch {
      continue;
    }
    try {
      const manifest = parseDistributionManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      const hostTarget = hostDistributionTarget();
      if (hostTarget && manifest.target !== hostTarget) {
        throw new Error(`manifest target ${manifest.target} does not match host ${hostTarget}`);
      }
      await verifyManifestFile(root, manifest.cli.file, true);
      const opencodeBin = await verifyManifestFile(root, manifest.opencode.file, true);
      for (const file of [...manifest.plugins.files, ...manifest.notices]) await verifyManifestFile(root, file);
      const pluginDir = resolveManifestPath(root, manifest.plugins.directory);
      return { opencodeBin, pluginDir };
    } catch (error) {
      throw new Error(`Incomplete JuggleWork CLI installation (${manifestPath}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

export async function resolveOpenCodeBinary(explicit: string | null): Promise<string | null> {
  if (explicit?.trim()) return executable(explicit);
  if (process.env.JUGGLEWORK_OPENCODE_BIN?.trim()) return executable(process.env.JUGGLEWORK_OPENCODE_BIN);
  const packaged = await resolvePackagedRuntimeAssets();
  if (packaged) return packaged.opencodeBin;
  for (const candidate of [
    executableOnPath(process.platform === "win32" ? "opencode.exe" : "opencode"),
    ...installedOpenCodeCandidates(),
    join(dirname(process.execPath), "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode"),
    join(dirname(process.execPath), "..", "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode"),
    join(sourceRoot(), "apps", "desktop", "resources", "sidecars", process.platform === "win32" ? "opencode.exe" : "opencode"),
  ]) {
    const found = await executable(candidate);
    if (found) return found;
  }
  return null;
}

async function directory(path: string | null | undefined): Promise<string | null> {
  if (!path?.trim()) return null;
  const target = resolve(path.trim());
  try {
    await access(target, constants.R_OK);
    return (await stat(target)).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

async function pluginDirectory(path: string | null | undefined): Promise<string | null> {
  const found = await directory(path);
  if (!found) return null;
  try {
    for (const filename of REQUIRED_PLUGIN_FILES) {
      const asset = join(found, filename);
      await access(asset, constants.R_OK);
      if (!(await stat(asset)).isFile()) return null;
    }
    return found;
  } catch {
    return null;
  }
}

export async function resolvePluginDirectory(explicit: string | null, opencodeBin: string): Promise<string | null> {
  if (explicit?.trim()) return pluginDirectory(explicit);
  if (process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR?.trim()) return pluginDirectory(process.env.JUGGLEWORK_EXTENSIONS_PLUGIN_DIR);
  const packaged = await resolvePackagedRuntimeAssets();
  if (packaged && packaged.opencodeBin === opencodeBin) return packaged.pluginDir;
  const executableDir = dirname(opencodeBin);
  const candidates = [
    join(dirname(executableDir), "opencode-plugins"),
    join(dirname(process.execPath), "opencode-plugins"),
    join(dirname(process.execPath), "..", "opencode-plugins"),
    join(sourceRoot(), "apps", "server", "dist", "opencode-plugins"),
  ];
  for (const candidate of candidates) {
    const found = await pluginDirectory(candidate);
    if (found) return found;
  }
  return null;
}

function cliStorageDir(): string {
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "JuggleWork", "cli");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "jugglework", "cli");
}

export function cliRuntimePaths(workspace: string): { storage: string; config: string; database: string } {
  const workspaceKey = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 16);
  const storage = join(cliStorageDir(), "workspaces", workspaceKey);
  return {
    storage,
    config: join(storage, "server.json"),
    database: join(storage, "runtime.sqlite"),
  };
}

function applyOwnedRuntimeEnv(values: Record<string, string>): () => void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

type RuntimeDependencies = {
  startEmbeddedServer?: typeof startEmbeddedServer;
};

export async function createRuntime(
  options: CliOptions,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeConnection> {
  if (options.serverUrl) {
    if (!options.token) throw new Error("Connected mode requires --token, JUGGLEWORK_TOKEN, or a token in the CLI config file.");
    let serverUrl: URL;
    try { serverUrl = new URL(options.serverUrl); } catch { throw new Error("--server must be a valid http:// or https:// URL."); }
    if (!/^https?:$/.test(serverUrl.protocol) || serverUrl.username || serverUrl.password || serverUrl.search || serverUrl.hash) {
      throw new Error("--server must be an http:// or https:// base URL without credentials, query parameters, or a fragment.");
    }
    return {
      url: serverUrl.toString().replace(/\/$/, ""),
      token: options.token,
      hostToken: options.hostToken,
      owned: false,
      stop: async () => {},
    };
  }

  const opencodeBin = await resolveOpenCodeBinary(options.opencodeBin);
  if (!opencodeBin) {
    if (options.opencodeBin) {
      throw new Error(`Configured OpenCode binary is not an executable file: ${resolve(options.opencodeBin)}`);
    }
    throw new Error(
      "OpenCode was not found. This source/development run can use --opencode-bin or JUGGLEWORK_OPENCODE_BIN; installed releases require their packaged sidecar.",
    );
  }
  const pluginDir = await resolvePluginDirectory(options.pluginDir, opencodeBin);
  if (!pluginDir) {
    if (options.pluginDir) {
      throw new Error(
        `Configured plugin directory is missing one or more required JuggleWork plugin assets: ${resolve(options.pluginDir)}`,
      );
    }
    throw new Error(
      `JuggleWork OpenCode plugins were not found. Build jugglework-server first or pass --plugin-dir to an opencode-plugins directory containing all ${REQUIRED_PLUGIN_FILES.length} required files.`,
    );
  }
  const paths = cliRuntimePaths(options.workspace);
  const { storage } = paths;
  await mkdir(storage, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(storage, 0o700);
  const restoreEnv = applyOwnedRuntimeEnv({
    JUGGLEWORK_EXTENSIONS_PLUGIN_DIR: pluginDir,
    // Always override a Desktop-owned database inherited by a terminal.
    JUGGLEWORK_RUNTIME_DB: paths.database,
  });
  const token = options.token || randomUUID();
  const hostToken = options.hostToken || randomUUID();
  let handle: EmbeddedServerHandle | null = null;
  try {
    handle = await (dependencies.startEmbeddedServer ?? startEmbeddedServer)({
      configPath: paths.config,
      host: "127.0.0.1",
      port: 0,
      token,
      hostToken,
      // Session permission modes are authoritative; keep legacy approvals
      // manual so non-interactive execution cannot silently widen access.
      approvalMode: "manual",
      approvalTimeoutMs: 30_000,
      workspaces: [options.workspace],
      corsOrigins: ["*"],
      manageOpencode: true,
      opencodeBin,
      opencodeCwd: options.workspace,
      logRequests: false,
      // The embedded Server shares stdout with the CLI renderer. Inject a
      // no-op logger rather than mutating process-global logging behavior.
      logger: { log: () => {} },
    });
  } catch (error) {
    restoreEnv();
    throw error;
  }
  if (process.platform !== "win32") {
    await chmod(paths.config, 0o600).catch(() => {});
  }
  return {
    url: handle.url,
    token,
    hostToken,
    owned: true,
    stop: async () => {
      const current = handle;
      handle = null;
      try {
        if (current) await current.stop();
      } finally {
        restoreEnv();
      }
    },
  };
}

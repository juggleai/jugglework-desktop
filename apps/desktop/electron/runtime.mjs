import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { resolveClaudeAgentRollout } from "../dist/runtime/agent-runtime-rollout.js";
import { createSandboxRuntime } from "./sandbox-runtime.mjs";
import { claudeRuntimeEnvironment, resolveClaudeRuntimeAssets } from "./claude-runtime-assets.mjs";

const __runtimeDir = path.dirname(fileURLToPath(import.meta.url));

const DIRECT_RUNTIME = "direct";
const JUGGLEWORK_SERVER_PORT_RANGE_START = 48_000;
const JUGGLEWORK_SERVER_PORT_RANGE_END = 51_000;

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function appendOutput(state, key, chunk) {
  const next = `${state[key] ?? ""}${String(chunk ?? "")}`;
  state[key] = truncateOutput(next);
}

function normalizeWorkspaceKey(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  return path.resolve(trimmed).replace(/\\/g, "/").toLowerCase();
}

export function prioritizeWorkspacePaths(preferredPath, workspacePaths = []) {
  const preferred = String(preferredPath ?? "").trim();
  const paths = [];
  const seen = new Set();
  const add = (value) => {
    const workspacePath = String(value ?? "").trim();
    const key = normalizeWorkspaceKey(workspacePath);
    if (!workspacePath || !key || seen.has(key)) return;
    paths.push(workspacePath);
    seen.add(key);
  };
  add(preferred);
  for (const workspacePath of workspacePaths) add(workspacePath);
  return paths;
}

export function resolveJuggleWorkServerConfigPath(env = process.env) {
  const override = String(env.JUGGLEWORK_SERVER_CONFIG ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const appData = String(env.APPDATA ?? "").trim();
    const root = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(root, "jugglework", "server.json");
  }
  const xdgConfigHome = String(env.XDG_CONFIG_HOME ?? "").trim();
  const root = xdgConfigHome || path.join(os.homedir(), ".config");
  return path.join(root, "jugglework", "server.json");
}

export function seedWorkspacePathsForEmbeddedServer(workspacePaths, serverConfigExists) {
  return serverConfigExists ? [] : workspacePaths;
}

export function selectStickyJuggleWorkPortWorkspace(requestedWorkspacePaths = [], serverWorkspacePaths = []) {
  for (const value of [...requestedWorkspacePaths, ...serverWorkspacePaths]) {
    const workspacePath = String(value ?? "").trim();
    if (workspacePath) return workspacePath;
  }
  return "";
}

export function shouldReuseHealthyManagedRuntime(input) {
  return input.forceRestart !== true &&
    input.inProcess === true &&
    input.lifecycleState === "healthy" &&
    input.remoteAccessEnabled === input.requestedRemoteAccess &&
    input.running === true &&
    Boolean(input.baseUrl) &&
    input.hasToken === true;
}

export function commandMatchesPackagedSidecar(command, sidecarDirs = []) {
  const value = String(command ?? "");
  if (!sidecarDirs.some((dir) => String(dir ?? "").trim() && value.includes(dir))) {
    return false;
  }
  return value.includes("jugglework-server") ||
    /(?:^|[/\\])opencode[^/\\\s]*\s+serve\b/.test(value);
}

export function embeddedServerImportUrl(embeddedPath) {
  const url = pathToFileURL(embeddedPath);
  try {
    const stats = statSync(embeddedPath);
    url.searchParams.set("mtimeMs", String(stats.mtimeMs));
    url.searchParams.set("size", String(stats.size));
  } catch {
    // Fall back to the deterministic file URL if stat fails; startup can continue.
  }
  return url.href;
}

/** Control-plane prefix every JuggleWork server route hangs off (`/jwork`). */
const DEN_CONTROL_PLANE_PATH = "/jwork";
/** Path suffixes a stored Den base URL may already carry. */
const DEN_BASE_PATH_SUFFIXES = [`${DEN_CONTROL_PLANE_PATH}/api`, DEN_CONTROL_PLANE_PATH, "/api/den"];
/**
 * The provider catalog a connected JuggleWork server serves
 * (`<origin>/jwork/models`), used as the engine's `OPENCODE_MODELS_URL` so its
 * provider list matches that deployment's catalog. The hosted control plane
 * serves this catalog too, so every valid deployment URL resolves to its own
 * metadata source. Returns null only for unusable input.
 */
export function denModelsCatalogUrl(denBaseUrl) {
  const raw = String(denBaseUrl ?? "").trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const pathname = url.pathname.replace(/\/+$/, "");
  const suffix = DEN_BASE_PATH_SUFFIXES.find((candidate) => pathname.toLowerCase().endsWith(candidate));
  const root = suffix ? pathname.slice(0, -suffix.length) : pathname;
  url.pathname = `${root}${DEN_CONTROL_PLANE_PATH}/models`.replace(/\/+/g, "/");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function nowMs() {
  return Date.now();
}

function createEngineState() {
  return {
    child: null,
    childExited: true,
    runtime: DIRECT_RUNTIME,
    projectDir: null,
    hostname: null,
    port: null,
    baseUrl: null,
    opencodeUsername: null,
    opencodePassword: null,
    opencodeBinPath: null,
    opencodeBinSource: null,
    managedByServer: false,
    managedPid: null,
    managedIsAlive: null,
    lastStdout: null,
    lastStderr: null,
    execution: null,
  };
}

export function snapshotEngineState(state) {
  const child = state.childExited ? null : state.child;
  let managedRunning = false;
  if (state.managedByServer && typeof state.managedIsAlive === "function") {
    try {
      managedRunning = state.managedIsAlive() === true;
    } catch {
      managedRunning = false;
    }
  }
  const childRunning = Boolean(child && child.exitCode === null && !child.killed);
  return {
    running: managedRunning || childRunning,
    runtime: state.runtime,
    managedByServer: state.managedByServer === true,
    baseUrl: state.baseUrl,
    projectDir: state.projectDir,
    hostname: state.hostname,
    port: state.port,
    opencodeUsername: state.opencodeUsername,
    opencodePassword: state.opencodePassword,
    opencodeBinPath: state.opencodeBinPath,
    opencodeBinSource: state.opencodeBinSource,
    pid: state.managedByServer ? state.managedPid ?? null : child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    execution: state.execution,
  };
}

function createJuggleWorkServerState() {
  return {
    child: null,
    childExited: true,
    inProcess: false,
    remoteAccessEnabled: false,
    host: null,
    port: null,
    baseUrl: null,
    connectUrl: null,
    mdnsUrl: null,
    lanUrl: null,
    clientToken: null,
    ownerToken: null,
    hostToken: null,
    managedOpencodeBinPath: null,
    managedOpencodeBinSource: null,
    lastStdout: null,
    lastStderr: null,
    managedOpencodeExecution: null,
  };
}

function snapshotJuggleWorkServerState(state) {
  const child = state.childExited ? null : state.child;
  const running = state.inProcess || Boolean(child && child.exitCode === null && !child.killed);
  return {
    running,
    remoteAccessEnabled: state.remoteAccessEnabled,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    connectUrl: state.connectUrl,
    mdnsUrl: state.mdnsUrl,
    lanUrl: state.lanUrl,
    clientToken: state.clientToken,
    ownerToken: state.ownerToken,
    hostToken: state.hostToken,
    managedOpencodeBinPath: state.managedOpencodeBinPath,
    managedOpencodeBinSource: state.managedOpencodeBinSource,
    pid: child?.pid ?? null,
    lastStdout: state.lastStdout,
    lastStderr: state.lastStderr,
    managedOpencodeExecution: state.managedOpencodeExecution,
  };
}

const SECRET_ENV_PATTERN = /(TOKEN|PASSWORD|USERNAME|AUTH|SECRET|KEY|CREDENTIAL)/i;

function redactedExecutionSnapshot(command, args, cwd, injectedEnv) {
  return {
    command,
    args: [...args],
    cwd,
    env: Object.entries(injectedEnv ?? {})
      .filter((entry) => typeof entry[1] === "string")
      .map(([name, value]) => ({
        name,
        value: SECRET_ENV_PATTERN.test(name) ? "<redacted>" : value,
        redacted: SECRET_ENV_PATTERN.test(name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function assertJuggleWorkServerReady(snapshot) {
  if (!snapshot?.running) {
    throw new Error("JuggleWork server did not stay running after startup.");
  }
  if (!snapshot.baseUrl) {
    throw new Error("JuggleWork server did not report a base URL after startup.");
  }
  if (!snapshot.ownerToken && !snapshot.clientToken) {
    throw new Error("JuggleWork server did not report an access token after startup.");
  }
  return snapshot;
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(targetPath, fallback) {
  try {
    const raw = await readFile(targetPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function selectLanAddress() {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry && entry.family === "IPv4" && entry.internal === false) {
        return entry.address;
      }
    }
  }
  return null;
}

function buildConnectUrls(port) {
  const hostname = os.hostname().trim();
  const mdnsUrl = hostname ? `http://${hostname.replace(/\.local$/i, "")}.local:${port}` : null;
  const lan = selectLanAddress();
  const lanUrl = lan ? `http://${lan}:${port}` : null;
  return {
    connectUrl: lanUrl ?? mdnsUrl,
    mdnsUrl,
    lanUrl,
  };
}

function targetTriple() {
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
}

function binaryFileNames(baseName) {
  const ext = process.platform === "win32" ? ".exe" : "";
  const triple = targetTriple();
  return [
    triple ? `${baseName}-${triple}${ext}` : null,
    `${baseName}${ext}`,
  ].filter(Boolean);
}

function isDirectory(targetPath) {
  try {
    return statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function nvmVersionBinPaths(home) {
  const base = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, "bin"))
      .filter(isDirectory)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function pathHelperEntries() {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/libexec/path_helper", ["-s"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return [];
  const stdout = String(result.stdout ?? "");
  const match = stdout.match(/PATH="([^"]+)"/) ?? stdout.match(/PATH=([^;\n]+)/);
  return match?.[1]?.split(path.delimiter).filter(Boolean) ?? [];
}

function extraPathEntries() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === "darwin") {
    candidates.push(
      ...pathHelperEntries(),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, "Library", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "linux") {
    candidates.push(
      "/usr/local/bin",
      "/usr/local/sbin",
      path.join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      path.join(home, ".fnm", "current", "bin"),
      path.join(home, ".volta", "bin"),
      path.join(home, ".local", "share", "pnpm"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, ".pyenv", "shims"),
      path.join(home, ".local", "bin"),
    );
  }

  if (process.platform === "win32") {
    candidates.push(
      path.join(home, ".volta", "bin"),
      path.join(home, ".bun", "bin"),
      path.join(home, ".cargo", "bin"),
      process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : null,
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "pnpm") : null,
    );
  }

  return candidates.filter((entry) => entry && isDirectory(entry));
}

function enrichedPath(sidecarDirs, currentPath) {
  const entries = [
    ...sidecarDirs.filter(isDirectory),
    ...extraPathEntries(),
    ...String(currentPath ?? "").split(path.delimiter).filter(Boolean),
  ];
  const deduped = entries.filter((entry, index) => entries.indexOf(entry) === index);
  return deduped.length > 0 ? deduped.join(path.delimiter) : null;
}

async function portAvailable(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a free port.")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttpOk(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed.";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(lastError);
}

async function fetchJson(url, options = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(options.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Resolves ~/.config/jugglework/env.json (or %APPDATA%\jugglework\env.json on
// Windows) — must agree byte-for-byte with apps/server/src/env-file.ts and
// the Server environment loader. Honor JUGGLEWORK_ENV_STORE override.
function resolveUserEnvFilePath() {
  const override = String(process.env.JUGGLEWORK_ENV_STORE ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    const appData = String(process.env.APPDATA ?? "").trim();
    const root = appData || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(root, "jugglework", "env.json");
  }
  return path.join(os.homedir(), ".config", "jugglework", "env.json");
}

const USER_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USER_ENV_RESERVED_PREFIXES = ["JUGGLEWORK_", "OPENCODE_"];

// Synchronous, best-effort; absent or malformed returns {}. Reserved prefixes
// are stripped so a tampered file can never shadow JUGGLEWORK_* / OPENCODE_*.
function loadUserEnvFile() {
  try {
    const raw = readFileSync(resolveUserEnvFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.variables)) return {};
    const out = {};
    for (const entry of parsed.variables) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry;
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!USER_ENV_KEY_PATTERN.test(key)) continue;
      if (USER_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @typedef {Object} RuntimeSystemCaTlsModule
 * @property {(type?: string) => string[]} [getCACertificates]
 */

/**
 * @typedef {Object} ResolveSystemCaEnvOptions
 * @property {RuntimeSystemCaTlsModule} [tlsModule]
 * @property {string} userDataDir
 * @property {NodeJS.ProcessEnv} [parentEnv]
 * @property {(...args: unknown[]) => void} [logInfo]
 */

/**
 * @param {ResolveSystemCaEnvOptions} options
 * @returns {Promise<NodeJS.ProcessEnv>}
 */
export async function resolveSystemCaEnv({
  tlsModule = tls,
  userDataDir,
  parentEnv = process.env,
  logInfo = console.info,
}) {
  const env = parentEnv ?? {};
  if (Object.prototype.hasOwnProperty.call(env, "NODE_EXTRA_CA_CERTS")) {
    if (typeof logInfo === "function") {
      logInfo("JuggleWork runtime: NODE_EXTRA_CA_CERTS is already set; skipping system CA bundle export.");
    }
    return {};
  }

  try {
    if (typeof tlsModule?.getCACertificates !== "function") return {};
    const certs = tlsModule.getCACertificates("system");
    if (!Array.isArray(certs) || certs.length === 0) return {};
    const pem = certs.filter((cert) => typeof cert === "string" && cert.trim()).join("\n");
    if (!pem) return {};
    const bundlePath = path.join(userDataDir, "system-ca-bundle.pem");
    await mkdir(path.dirname(bundlePath), { recursive: true });
    await writeFile(bundlePath, `${pem}\n`, "utf8");
    return { NODE_EXTRA_CA_CERTS: bundlePath };
  } catch {
    return {};
  }
}

/**
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {NodeJS.ProcessEnv} [caEnv]
 * @param {NodeJS.ProcessEnv} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function mergeSystemCaChildEnv(baseEnv = {}, caEnv = {}, extra = {}) {
  return {
    ...baseEnv,
    ...(Object.prototype.hasOwnProperty.call(baseEnv, "NODE_EXTRA_CA_CERTS") ? {} : caEnv),
    ...extra,
  };
}

export function createRuntimeManager({ app, desktopRoot, listLocalWorkspacePaths, readDenBaseUrl, claudeSecretProvider = null, startEmbeddedServer: startEmbeddedServerOverride = null, sandboxRuntime: sandboxRuntimeOverride = null }) {
  const engineState = createEngineState();
  const juggleworkServerState = createJuggleWorkServerState();

  // Serialize engine lifecycle operations. Without this, concurrent renderer
  // invocations of engineStart/engineStop/engineRestart race: each call's
  // stopAllRuntimeChildren kills the previous call's freshly-spawned
  // managed runtime, and the prior call then observes a stopped server.
  /** @type {Promise<unknown>} */
  let runtimeLifecycleQueue = Promise.resolve();
  /** @type {"idle" | "cleaning" | "starting" | "healthy" | "error" | "stopping"} */
  let lifecycleState = "idle";
  /**
   * Serialize engine lifecycle operations; preserves the wrapped function's
   * return type (untyped, this collapsed runtime-manager inference to
   * Promise<void> and blocked tightening the DesktopCommandMap results).
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function withRuntimeLifecycle(fn) {
    const next = runtimeLifecycleQueue.then(fn, fn);
    runtimeLifecycleQueue = next.catch(() => {});
    return next;
  }

  const userDataDir = app.getPath("userData");
  const sandboxRuntime = sandboxRuntimeOverride ?? createSandboxRuntime({ userDataDir });
  const sidecarDirs = [
    path.join(desktopRoot, "resources", "sidecars"),
    process.resourcesPath ? path.join(process.resourcesPath, "sidecars") : null,
    path.join(path.dirname(app.getPath("exe")), "sidecars"),
  ].filter(Boolean);
  let systemCaEnvPromise = null;

  function systemCaEnv() {
    systemCaEnvPromise ??= resolveSystemCaEnv({ tlsModule: tls, userDataDir, parentEnv: process.env });
    return systemCaEnvPromise;
  }

  function juggleworkServerTokenStorePath() {
    return path.join(userDataDir, "jugglework-server-tokens.json");
  }

  function juggleworkServerStatePath() {
    return path.join(userDataDir, "jugglework-server-state.json");
  }

  function managedOpencodeWorkdir() {
    return path.join(userDataDir, "managed-opencode-workdir");
  }

  async function loadTokenStore() {
    return readJsonFile(juggleworkServerTokenStorePath(), { version: 1, workspaces: {} });
  }

  async function saveTokenStore(store) {
    const filePath = juggleworkServerTokenStorePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  }

  async function loadPortState() {
    return readJsonFile(juggleworkServerStatePath(), {
      version: 3,
      workspacePorts: {},
      preferredPort: null,
    });
  }

  async function savePortState(state) {
    const filePath = juggleworkServerStatePath();
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async function loadOrCreateWorkspaceTokens(workspaceKey) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (store.workspaces?.[normalized]) {
      return store.workspaces[normalized];
    }
    const next = {
      clientToken: randomUUID(),
      hostToken: randomUUID(),
      ownerToken: null,
      updatedAt: nowMs(),
    };
    store.workspaces ??= {};
    store.workspaces[normalized] = next;
    await saveTokenStore(store);
    return next;
  }

  async function persistWorkspaceOwnerToken(workspaceKey, ownerToken) {
    const store = await loadTokenStore();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (!store.workspaces?.[normalized]) return;
    store.workspaces[normalized].ownerToken = ownerToken;
    store.workspaces[normalized].updatedAt = nowMs();
    await saveTokenStore(store);
  }

  async function readPreferredJuggleWorkPort(workspaceKey) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    if (normalized && state.workspacePorts?.[normalized]) {
      return state.workspacePorts[normalized];
    }
    return state.preferredPort ?? null;
  }

  async function persistPreferredJuggleWorkPort(workspaceKey, port) {
    const state = await loadPortState();
    const normalized = normalizeWorkspaceKey(workspaceKey);
    state.version = 3;
    state.workspacePorts ??= {};
    if (normalized) {
      state.workspacePorts[normalized] = port;
      state.preferredPort = null;
    } else {
      state.preferredPort = port;
    }
    await savePortState(state);
  }

  async function waitForPortAvailable(host, port, timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await portAvailable(host, port)) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return portAvailable(host, port);
  }

  async function resolveJuggleWorkPort(host, workspaceKey, currentPort = null) {
    const preferredPort = await readPreferredJuggleWorkPort(workspaceKey);
    if (currentPort && (await waitForPortAvailable(host, currentPort))) {
      return { port: currentPort, preferredPort };
    }
    if (preferredPort && (await waitForPortAvailable(host, preferredPort))) {
      return { port: preferredPort, preferredPort };
    }
    return { port: await findFreePort(host), preferredPort };
  }

  async function ensureDevModePaths() {
    const root = path.join(userDataDir, "jugglework-dev-data");
    const paths = {
      homeDir: path.join(root, "home"),
      xdgConfigHome: path.join(root, "xdg", "config"),
      xdgDataHome: path.join(root, "xdg", "data"),
      xdgCacheHome: path.join(root, "xdg", "cache"),
      xdgStateHome: path.join(root, "xdg", "state"),
      opencodeConfigDir: path.join(root, "config", "opencode"),
    };

    for (const dir of Object.values(paths)) {
      await mkdir(dir, { recursive: true });
    }
    await mkdir(path.join(paths.xdgDataHome, "opencode"), { recursive: true });
    return paths;
  }

  async function buildChildEnv(extra = {}) {
    /** @type {NodeJS.ProcessEnv} */
    // User env is layered first so process.env + any caller overrides always
    // win. See apps/server/src/env-file.ts —
    // all loaders must agree on path + reserved-keys policy.
    const baseEnv = {
      ...loadUserEnvFile(),
      ...process.env,
      BUN_CONFIG_DNS_RESULT_ORDER: "verbatim",
    };
    const caEnv = Object.prototype.hasOwnProperty.call(baseEnv, "NODE_EXTRA_CA_CERTS") ? {} : await systemCaEnv();
    // Bun honors Node's NODE_EXTRA_CA_CERTS, so bundled Bun sidecars inherit
    // the exported OS trust store through the same child env variable.
    const env = mergeSystemCaChildEnv(baseEnv, caEnv, extra);
    const pathKey =
      Object.prototype.hasOwnProperty.call(env, "PATH") ||
      !Object.prototype.hasOwnProperty.call(env, "Path")
        ? "PATH"
        : "Path";
    const pathEnv = enrichedPath(sidecarDirs, env[pathKey]);
    if (pathEnv) {
      env[pathKey] = pathEnv;
    }
    if (process.env.JUGGLEWORK_DEV_MODE === "1") {
      const devPaths = await ensureDevModePaths();
      env.JUGGLEWORK_DEV_MODE = "1";
      env.HOME = devPaths.homeDir;
      env.USERPROFILE = devPaths.homeDir;
      env.XDG_CONFIG_HOME = devPaths.xdgConfigHome;
      env.XDG_DATA_HOME = devPaths.xdgDataHome;
      env.XDG_CACHE_HOME = devPaths.xdgCacheHome;
      env.XDG_STATE_HOME = devPaths.xdgStateHome;
      env.OPENCODE_CONFIG_DIR = devPaths.opencodeConfigDir;
      env.OPENCODE_TEST_HOME = devPaths.homeDir;
    }
    return env;
  }

  function resolveBinaryInfo(baseName, extraPaths = []) {
    for (const directory of [...sidecarDirs, ...extraPaths]) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(directory, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "bundled" };
        }
      }
    }

    const pathEntries = (enrichedPath([], process.env.PATH) ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    for (const entry of pathEntries) {
      for (const fileName of binaryFileNames(baseName)) {
        const candidate = path.join(entry, fileName);
        if (existsSync(candidate)) {
          return { path: candidate, source: "path" };
        }
      }
    }

    if (baseName === "opencode") {
      for (const candidate of [
        path.join(app.getPath("home"), ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/opt/homebrew/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/local/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
        path.join("/usr/bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
      ]) {
        if (existsSync(candidate)) {
          return { path: candidate, source: "known-location" };
        }
      }
    }

    return null;
  }

  function resolveBinary(baseName, extraPaths = []) {
    return resolveBinaryInfo(baseName, extraPaths)?.path ?? null;
  }

  function resolveOpencodeBinary(opencodeBinPath) {
    const explicitPath = typeof opencodeBinPath === "string" ? opencodeBinPath.trim() : "";
    return explicitPath ? { path: explicitPath, source: "custom" } : resolveBinaryInfo("opencode");
  }

  async function runShellCommand(program, args, options = {}) {
    const result = spawnSync(program, args, {
      encoding: "utf8",
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    return {
      status: typeof result.status === "number" ? result.status : -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function engineDoctor(options = {}) {
    const resolved = resolveOpencodeBinary(options?.opencodeBinPath);
    if (!resolved?.path) {
      return {
        found: false,
        inPath: false,
        resolvedPath: null,
        resolvedSource: null,
        version: null,
        supportsServe: false,
        notes: ["OpenCode binary not found in bundled sidecars or PATH."],
        serveHelpStatus: null,
        serveHelpStdout: null,
        serveHelpStderr: null,
      };
    }

    const versionResult = spawnSync(resolved.path, ["--version"], { encoding: "utf8" });
    const helpResult = spawnSync(resolved.path, ["serve", "--help"], { encoding: "utf8" });
    const notes = [`Using ${resolved.source}: ${resolved.path}`];
    if (versionResult.status !== 0) {
      notes.push("OpenCode version probe failed.");
    }
    if (helpResult.status !== 0) {
      notes.push("OpenCode serve --help probe failed.");
    }

    return {
      found: true,
      inPath: resolved.source === "path",
      resolvedPath: resolved.path,
      resolvedSource: resolved.source,
      version: versionResult.stdout?.trim() || versionResult.stderr?.trim() || null,
      supportsServe: helpResult.status === 0,
      notes,
      serveHelpStatus: typeof helpResult.status === "number" ? helpResult.status : null,
      serveHelpStdout: helpResult.stdout?.trim() || null,
      serveHelpStderr: helpResult.stderr?.trim() || null,
    };
  }

  async function pinnedOpencodeInstallCommand() {
    const constantsPath = path.resolve(desktopRoot, "../../constants.json");
    const payload = JSON.parse(await readFile(constantsPath, "utf8"));
    const version = String(payload?.opencodeVersion ?? "").trim().replace(/^v/, "");
    if (!version) {
      throw new Error("constants.json is missing opencodeVersion");
    }
    return `curl -fsSL https://opencode.ai/install | bash -s -- --version ${version} --no-modify-path`;
  }

  function spawnManagedChild(state, program, args, options = {}) {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    state.child = child;
    state.childExited = false;
    state.lastStdout = null;
    state.lastStderr = null;

    child.stdout?.on("data", (chunk) => appendOutput(state, "lastStdout", chunk.toString()));
    child.stderr?.on("data", (chunk) => appendOutput(state, "lastStderr", chunk.toString()));
    child.on("exit", (code) => {
      state.childExited = true;
      if (code != null && code !== 0) {
        appendOutput(state, "lastStderr", `Process exited with code ${code}.\n`);
      }
      options.onExit?.(code);
    });
    child.on("error", (error) => {
      state.childExited = true;
      appendOutput(state, "lastStderr", `${error instanceof Error ? error.message : String(error)}\n`);
    });

    return child;
  }

  function processMatchesSidecar(command) {
    return commandMatchesPackagedSidecar(command, sidecarDirs);
  }

  function killProcessId(pid, signal = "SIGTERM") {
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited or is not ours.
    }
  }

  async function cleanupPackagedSidecars() {
    if (!app.isPackaged) return;

    // Safety net: an unclean Electron quit can orphan sidecars. Packaged builds
    // should always own a fresh runtime per app launch, so remove any leftover
    // sidecars from this app bundle before choosing ports for the new runtime.
    const result = spawnSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
    const rows = String(result.stdout ?? "").split(/\r?\n/);
    const pids = [];
    for (const row of rows) {
      const match = row.match(/^\s*(\d+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const command = match[2] ?? "";
      if (processMatchesSidecar(command)) pids.push(pid);
    }
    for (const pid of pids) killProcessId(pid, "SIGTERM");
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      for (const pid of pids) killProcessId(pid, "SIGKILL");
    }
  }

  async function stopChild(state, options = {}) {
    const child = state.child;
    state.child = null;
    state.childExited = true;
    if (!child || child.exitCode != null || child.killed) return;

    if (options.requestShutdown) {
      try {
        const shutdownRequested = await options.requestShutdown();
        if (shutdownRequested) {
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
      } catch {
        // ignore
      }
    }

    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (child.exitCode == null && !child.killed) {
        child.kill("SIGKILL");
      }
    }
  }

  async function ensureOpencodeConfig(projectDir) {
    const jsoncPath = path.join(projectDir, "opencode.jsonc");
    const jsonPath = path.join(projectDir, "opencode.json");
    if ((await fileExists(jsoncPath)) || (await fileExists(jsonPath))) return;
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      jsoncPath,
      `${JSON.stringify({ $schema: "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  function generateManagedCredentials() {
    return [randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, ""), randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")];
  }

  async function issueOwnerToken(baseUrl, hostToken) {
    const payload = await fetchJson(
      `${baseUrl.replace(/\/+$/, "")}/tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-JuggleWork-Host-Token": hostToken,
        },
        body: JSON.stringify({ scope: "owner", label: "JuggleWork desktop owner token" }),
      },
      5000,
    );
    const token = typeof payload?.token === "string" ? payload.token.trim() : "";
    return token || null;
  }

  // In-process server handle. Kept alive across restarts so we can stop it.
  let inProcessServer = null;

  async function startJuggleWorkServer(options) {
    const currentPort = juggleworkServerState.port;
    // Stop any previously running in-process server
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(juggleworkServerState);

    // An embedded-server stop should terminate its managed OpenCode child, but
    // a force-killed or slow child can outlive the handle. Never start a second
    // bundled sidecar while an orphan from this app bundle still exists.
    if (options.manageOpencode === true) {
      await cleanupPackagedSidecars();
    }

    const host = options.remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";

    const managedOpencode = options.manageOpencode ? resolveOpencodeBinary(options.opencodeBinPath) : null;
    juggleworkServerState.managedOpencodeBinPath = managedOpencode?.path ?? null;
    juggleworkServerState.managedOpencodeBinSource = managedOpencode?.source ?? null;
    if (options.manageOpencode) {
      engineState.opencodeBinPath = managedOpencode?.path ?? null;
      engineState.opencodeBinSource = managedOpencode?.source ?? null;
    }

    // Inject user env vars so the server and managed OpenCode inherit them.
    let packagedClaudeEnv = {};
    const claudeRolloutEnabled = resolveClaudeAgentRollout(process.env).enabled;
    if (app.isPackaged || claudeRolloutEnabled) {
      try {
        const resourcesPath = app.isPackaged
          ? process.resourcesPath
          : path.join(desktopRoot, "resources");
        packagedClaudeEnv = claudeRuntimeEnvironment(await resolveClaudeRuntimeAssets({ resourcesPath }));
      } catch (error) {
        if (claudeRolloutEnabled) throw error;
      }
    }
    const serverEnv = await buildChildEnv(packagedClaudeEnv);
    Object.assign(process.env, serverEnv);

    // Once the embedded server has a persisted registry, it is the source of
    // truth. Do not pass Electron's legacy workspace list as CLI workspaces or
    // the server config loader will ignore server.json and lose server-created
    // workspaces after restart.
    const serverConfigPath = resolveJuggleWorkServerConfigPath(process.env);
    const requestedWorkspacePaths = (options.workspacePaths ?? []).filter((value) => value.trim().length > 0);
    const workspacePaths = seedWorkspacePathsForEmbeddedServer(
      requestedWorkspacePaths,
      existsSync(serverConfigPath),
    );
    const activeWorkspace = selectStickyJuggleWorkPortWorkspace(requestedWorkspacePaths, workspacePaths);
    const portSelection = await resolveJuggleWorkPort(host, activeWorkspace, currentPort);
    const tokens = await loadOrCreateWorkspaceTokens(activeWorkspace);

    // One call: resolve config, spawn managed OpenCode, start HTTP server.
    // Dev must prefer apps/server/dist; build output also stages a packaged
    // copy under apps/desktop/server for electron-builder.
    const devPath = path.resolve(__runtimeDir, "..", "..", "server", "dist", "embedded.js");
    const packagedPaths = [
      path.resolve(__runtimeDir, "..", "server", "dist", "embedded.js"),
      ...(process.resourcesPath ? [path.resolve(process.resourcesPath, "server", "dist", "embedded.js")] : []),
    ];
    const candidates = process.env.JUGGLEWORK_DEV_MODE === "1"
      ? [devPath, ...packagedPaths]
      : [...packagedPaths, devPath];
    const embeddedPath = startEmbeddedServerOverride ? null : candidates.find((candidate) => existsSync(candidate));
    if (!startEmbeddedServerOverride && !embeddedPath) {
      throw new Error(`Cannot find JuggleWork embedded server bundle. Checked: ${candidates.join(", ")}`);
    }
    const startEmbeddedServer = startEmbeddedServerOverride
      ?? (await import(embeddedServerImportUrl(embeddedPath))).startEmbeddedServer;
    // startEmbeddedServer falls back to an OS-assigned port if `port` races
    // into EADDRINUSE (see apps/server/src/serve-node.ts), so the bound port
    // below is authoritative.
    const handle = await startEmbeddedServer({
      host,
      port: portSelection.port,
      corsOrigins: ["*"],
      approvalMode: "auto",
      configPath: serverConfigPath,
      workspaces: workspacePaths,
      token: tokens.clientToken,
      hostToken: tokens.hostToken,
      opencodeBaseUrl: options.opencodeBaseUrl ?? undefined,
      opencodeDirectory: activeWorkspace || undefined,
      manageOpencode: options.manageOpencode === true,
      opencodeBin: managedOpencode?.path ?? undefined,
      opencodeCwd: managedOpencodeWorkdir(),
      // Read at spawn time: switching clouds needs an engine restart to take
      // effect, which juggleworkServerRestart already performs.
      modelsUrl: denModelsCatalogUrl(readDenBaseUrl?.()) ?? undefined,
      claudeSecretProvider: claudeSecretProvider ?? undefined,
      claudeProfileDataDir: path.join(userDataDir, "claude-agent"),
    });
    inProcessServer = handle;
    juggleworkServerState.managedOpencodeExecution = handle.managedOpencodeExecution ?? null;
    engineState.managedByServer = Boolean(handle.managedOpencode);
    engineState.managedPid = handle.managedOpencode?.pid ?? null;
    engineState.managedIsAlive = handle.managedOpencode?.isAlive ?? null;

    const boundPort = handle.port;
    const baseUrl = handle.url;

    juggleworkServerState.inProcess = true;
    juggleworkServerState.remoteAccessEnabled = options.remoteAccessEnabled;
    juggleworkServerState.host = host;
    juggleworkServerState.port = boundPort;
    juggleworkServerState.baseUrl = baseUrl;
    juggleworkServerState.clientToken = tokens.clientToken;
    juggleworkServerState.hostToken = tokens.hostToken;

    const connectUrls = options.remoteAccessEnabled ? buildConnectUrls(boundPort) : { connectUrl: null, mdnsUrl: null, lanUrl: null };
    juggleworkServerState.connectUrl = connectUrls.connectUrl;
    juggleworkServerState.mdnsUrl = connectUrls.mdnsUrl;
    juggleworkServerState.lanUrl = connectUrls.lanUrl;

    // No health check needed -- startServer() resolves only after the listener is bound.
    let workspaceList = null;
    let ownerToken = tokens.ownerToken?.trim() || null;
    if (ownerToken) {
      try {
        workspaceList = await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
      } catch {
        ownerToken = null;
      }
    }
    ownerToken ||= await issueOwnerToken(baseUrl, tokens.hostToken);
    juggleworkServerState.ownerToken = ownerToken;
    if (ownerToken) {
      await persistWorkspaceOwnerToken(activeWorkspace, ownerToken);
    }
    if (ownerToken) {
      try {
        const list = workspaceList ?? await fetchJson(`${baseUrl}/workspaces`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }, 5000);
        const first = Array.isArray(list?.items) ? list.items[0] : undefined;
        const opencode = first?.opencode;
        if (opencode?.baseUrl) {
          engineState.runtime = DIRECT_RUNTIME;
          engineState.projectDir = opencode.directory ?? activeWorkspace ?? null;
          engineState.hostname = new URL(opencode.baseUrl).hostname;
          engineState.port = Number(new URL(opencode.baseUrl).port) || null;
          engineState.baseUrl = opencode.baseUrl;
          engineState.opencodeUsername = opencode.username ?? null;
          engineState.opencodePassword = opencode.password ?? null;
          engineState.execution = handle.managedOpencodeExecution ?? null;
          engineState.child = null;
          engineState.childExited = false;
        }
      } catch (error) {
        appendOutput(juggleworkServerState, "lastStderr", `JuggleWork server workspace probe: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    if (!portSelection.preferredPort || boundPort === portSelection.preferredPort) {
      await persistPreferredJuggleWorkPort(activeWorkspace, boundPort);
    }
    return snapshotJuggleWorkServerState(juggleworkServerState);
  }

  async function startDirectRuntime(projectDir, options = {}) {
    const opencodeBinary = resolveOpencodeBinary(options.opencodeBinPath);
    if (!opencodeBinary?.path) {
      throw new Error("Failed to locate opencode.");
    }

    const port = await findFreePort("127.0.0.1");
    const [username, password] = generateManagedCredentials();
    const env = await buildChildEnv({
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    });

    const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--cors", "*"];
    engineState.execution = redactedExecutionSnapshot(opencodeBinary.path, args, projectDir, {
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    });

    spawnManagedChild(
      engineState,
      opencodeBinary.path,
      args,
      {
        cwd: projectDir,
        env,
      },
    );

    engineState.runtime = DIRECT_RUNTIME;
    engineState.projectDir = projectDir;
    engineState.hostname = "127.0.0.1";
    engineState.port = port;
    engineState.baseUrl = `http://127.0.0.1:${port}`;
    engineState.opencodeUsername = username;
    engineState.opencodePassword = password;
    engineState.opencodeBinPath = opencodeBinary.path;
    engineState.opencodeBinSource = opencodeBinary.source;
    engineState.managedByServer = false;
    engineState.managedPid = null;
    engineState.managedIsAlive = null;

    await waitForHttpOk(`${engineState.baseUrl}/health`, 10_000).catch(() => undefined);
    return snapshotEngineState(engineState);
  }

  async function stopAllRuntimeChildren() {
    // Stop the in-process server (and its managed OpenCode child) if running.
    if (inProcessServer) {
      try { await inProcessServer.stop(); } catch { /* ignore */ }
      inProcessServer = null;
    }
    await stopChild(juggleworkServerState);
    await stopChild(engineState);

    Object.assign(engineState, createEngineState());
    Object.assign(juggleworkServerState, createJuggleWorkServerState());
  }

  async function prepareFreshRuntime() {
    lifecycleState = "cleaning";
    await stopAllRuntimeChildren();
    await cleanupPackagedSidecars();
    lifecycleState = "idle";
  }

  async function ensureJuggleWork(options) {
    let juggleworkServer;
    try {
      juggleworkServer = await startJuggleWorkServer({
        workspacePaths: options.workspacePaths,
        opencodeBaseUrl: engineState.baseUrl,
        opencodeUsername: engineState.opencodeUsername,
        opencodePassword: engineState.opencodePassword,
        remoteAccessEnabled: options.remoteAccessEnabled,
        manageOpencode: options.manageOpencode === true,
        opencodeBinPath: options.opencodeBinPath,
      });
    } catch (error) {
      appendOutput(engineState, "lastStderr", `JuggleWork server: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
    }

    assertJuggleWorkServerReady(juggleworkServer);
  }

  async function engineStart(projectDir, options = {}) {
    const safeProjectDir = String(projectDir ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("projectDir is required");
    }

    // Reuse a healthy server instead of tearing it down. During boot the
    // main process kicks off bootRuntimeForSelectedWorkspace while renderer
    // routes independently call ensureDesktopLocalJuggleWorkConnection. Both go
    // through this serialized path; without this guard the second call runs
    // prepareFreshRuntime (killing the freshly bound server) and then rebinds
    // the sticky preferred port, racing the not-yet-released socket into
    // EADDRINUSE and leaving the runtime in error -> boot screen.
    const requestedRemoteAccess = options.juggleworkRemoteAccess === true;
    const existing = snapshotJuggleWorkServerState(juggleworkServerState);
    if (shouldReuseHealthyManagedRuntime({
      forceRestart: options.forceRestart,
      inProcess: juggleworkServerState.inProcess,
      lifecycleState,
      remoteAccessEnabled: juggleworkServerState.remoteAccessEnabled,
      requestedRemoteAccess,
      running: existing.running,
      baseUrl: existing.baseUrl,
      hasToken: Boolean(existing.ownerToken || existing.clientToken),
    })) {
      // One managed engine serves every registered local workspace. Switching
      // the selected directory must not replace that engine (and strand active
      // tasks on its old in-memory provider credential).
      engineState.projectDir = safeProjectDir;
      return snapshotEngineState(engineState);
    }

    await mkdir(safeProjectDir, { recursive: true });
    await ensureOpencodeConfig(safeProjectDir);
    await prepareFreshRuntime();

    const workspacePaths = [safeProjectDir, ...((options.workspacePaths ?? []).filter(Boolean))].filter(
      (value, index, list) => list.indexOf(value) === index,
    );
    const runtime = DIRECT_RUNTIME;

    try {
      lifecycleState = "starting";
      engineState.runtime = runtime;
      engineState.projectDir = safeProjectDir;
      engineState.child = null;
      engineState.childExited = true;

      await ensureJuggleWork({
        projectDir: safeProjectDir,
        workspacePaths,
        remoteAccessEnabled: options.juggleworkRemoteAccess === true,
        manageOpencode: true,
        opencodeBinPath: options.opencodeBinPath,
      });

      lifecycleState = "healthy";
      return snapshotEngineState(engineState);
    } catch (error) {
      lifecycleState = "error";
      throw error;
    }
  }

  async function engineStop() {
    lifecycleState = "stopping";
    await stopAllRuntimeChildren();
    lifecycleState = "idle";
    return snapshotEngineState(engineState);
  }

  async function engineRestart(options = {}) {
    const projectDir = engineState.projectDir;
    if (!projectDir) {
      throw new Error("OpenCode is not configured for a local workspace");
    }
    const juggleworkRemoteAccess = typeof options.juggleworkRemoteAccess === "boolean"
      ? options.juggleworkRemoteAccess
      : juggleworkServerState.remoteAccessEnabled;
    return engineStart(projectDir, {
      runtime: engineState.runtime,
      workspacePaths: [projectDir],
      opencodeEnableExa: options.opencodeEnableExa,
      juggleworkRemoteAccess,
      forceRestart: true,
    });
  }

  async function engineInfo() {
    return { ...snapshotEngineState(engineState), lifecycleState };
  }

  async function runtimeStatus() {
    return {
      lifecycleState,
      engine: await engineInfo(),
      juggleworkServer: snapshotJuggleWorkServerState(juggleworkServerState),
    };
  }

  async function juggleworkServerInfo() {
    return snapshotJuggleWorkServerState(juggleworkServerState);
  }

  /**
   * Returns the Main-private collaborator endpoint used by closed semantic
   * adapters. Do not expose this accessor through IPC or preload bridges.
   */
  function managedServerAccess() {
    const snapshot = snapshotJuggleWorkServerState(juggleworkServerState);
    const baseUrl = typeof snapshot.baseUrl === "string" ? snapshot.baseUrl.trim() : "";
    const clientToken = typeof snapshot.clientToken === "string" ? snapshot.clientToken.trim() : "";
    return snapshot.running && baseUrl && clientToken ? { baseUrl, clientToken } : null;
  }

  async function juggleworkServerRestart(options = {}) {
    const workspacePaths = prioritizeWorkspacePaths(engineState.projectDir, await listLocalWorkspacePaths());
    const shouldManageOpencode = Boolean(
      juggleworkServerState.managedOpencodeBinPath || engineState.opencodeBinPath || !engineState.baseUrl,
    );
    return startJuggleWorkServer({
      workspacePaths,
      opencodeBaseUrl: shouldManageOpencode ? null : engineState.baseUrl,
      opencodeUsername: shouldManageOpencode ? null : engineState.opencodeUsername,
      opencodePassword: shouldManageOpencode ? null : engineState.opencodePassword,
      remoteAccessEnabled: options.remoteAccessEnabled === true,
      manageOpencode: shouldManageOpencode,
      opencodeBinPath: engineState.opencodeBinPath ?? juggleworkServerState.managedOpencodeBinPath,
    });
  }

  async function workspaceActivate(input) {
    const workspacePath = String(input?.workspacePath ?? "").trim();
    if (!workspacePath) {
      throw new Error("workspacePath is required");
    }
    const resolved = path.resolve(workspacePath);
    if (normalizeWorkspaceKey(engineState.projectDir) !== normalizeWorkspaceKey(resolved)) {
      await engineStart(resolved, {
        runtime: DIRECT_RUNTIME,
        workspacePaths: [resolved],
      });
    }
    return {
      id: normalizeWorkspaceKey(resolved),
      path: resolved,
      name: input?.name ?? (path.basename(resolved) || "Workspace"),
    };
  }

  async function engineDispose(workspacePath) {
    if (normalizeWorkspaceKey(engineState.projectDir) === normalizeWorkspaceKey(workspacePath)) {
      return true;
    }
    return true;
  }

  async function engineInstall() {
    if (process.platform === "win32") {
      return {
        ok: false,
        status: -1,
        stdout: "",
        stderr:
          "Guided install is not supported on Windows yet. Install the JuggleWork-pinned OpenCode version manually, then restart JuggleWork.",
      };
    }

    const installDir = path.join(app.getPath("home"), ".opencode", "bin");
    const command = await pinnedOpencodeInstallCommand();
    const result = await runShellCommand("bash", ["-lc", command], {
      env: { ...(await buildChildEnv()), OPENCODE_INSTALL_DIR: installDir },
      timeoutMs: 180_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function opencodeMcpAuth(projectDir, serverName) {
    const safeProjectDir = String(projectDir ?? "").trim();
    const safeServerName = String(serverName ?? "").trim();
    if (!safeProjectDir) {
      throw new Error("project_dir is required");
    }
    if (!safeServerName) {
      throw new Error("server_name is required");
    }

    const program = resolveBinary("opencode");
    if (!program) {
      throw new Error("Failed to locate opencode.");
    }

    const result = await runShellCommand(program, ["mcp", "auth", safeServerName], {
      cwd: safeProjectDir,
      env: await buildChildEnv(),
      timeoutMs: 120_000,
    });
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return {
    engineStart: (projectDir, options) => withRuntimeLifecycle(() => engineStart(projectDir, options)),
    engineStop: () => withRuntimeLifecycle(() => engineStop()),
    engineRestart: (options) => withRuntimeLifecycle(() => engineRestart(options)),
    prepareFreshRuntime: () => withRuntimeLifecycle(() => prepareFreshRuntime()),
    dispose: () => withRuntimeLifecycle(() => stopAllRuntimeChildren()),
    runtimeStatus,
    engineInfo,
    engineDoctor,
    engineInstall,
    juggleworkServerInfo,
    managedServerAccess,
    juggleworkServerRestart: (options) => withRuntimeLifecycle(() => juggleworkServerRestart(options)),
    workspaceActivate: (input) => withRuntimeLifecycle(() => workspaceActivate(input)),
    engineDispose: (workspacePath) => withRuntimeLifecycle(() => engineDispose(workspacePath)),
    sandboxStart: (options) => sandboxRuntime.start(options),
    opencodeMcpAuth,
    sandboxDoctor: () => sandboxRuntime.doctor(),
    sandboxStop: (containerName) => sandboxRuntime.stop(containerName),
    sandboxCleanupJuggleWorkContainers: () => sandboxRuntime.cleanup(),
    sandboxDebugProbe: () => sandboxRuntime.debugProbe(),
  };
}

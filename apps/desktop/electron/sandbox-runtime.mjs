import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const SANDBOX_CONTAINER_PREFIX = "jugglework-sandbox-";
export const DEFAULT_SANDBOX_IMAGE = "jugglework-microsandbox:dev";
export const SANDBOX_SERVER_PORT = 8787;

export const DEFAULT_SANDBOX_BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret",
];

function truncateOutput(value, limit = 8000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function commandError(command, result) {
  const output = `${result.stdout.trim()}\n${result.stderr.trim()}`.trim();
  return output || `docker ${command} failed (status ${result.status})`;
}

function expandTildePath(input, homeDir = os.homedir()) {
  const trimmed = String(input ?? "").trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(homeDir, trimmed.slice(2));
  }
  return trimmed;
}

function matchesBlockedPattern(resolvedPath, patterns) {
  const normalized = resolvedPath.replaceAll("\\", "/").toLowerCase();
  const parts = normalized.split("/").filter(Boolean);
  for (const rawPattern of patterns) {
    const pattern = String(rawPattern ?? "").trim().toLowerCase();
    if (!pattern) continue;
    if (parts.some((part) => part === pattern || part.includes(pattern)) || normalized.includes(pattern)) {
      return rawPattern;
    }
  }
  return null;
}

function isWithinPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeSandboxBackend(value) {
  const backend = String(value ?? "docker").trim().toLowerCase();
  if (backend === "docker" || backend === "microsandbox") return backend;
  throw new Error("sandboxBackend must be one of: docker, microsandbox");
}

export function deriveSandboxContainerName(runId) {
  const sanitized = String(runId ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (!sanitized) throw new Error("runId must contain at least one valid container-name character");
  return `${SANDBOX_CONTAINER_PREFIX}${sanitized}`;
}

export function assertManagedSandboxContainerName(containerName) {
  const name = String(containerName ?? "").trim();
  if (!name) throw new Error("containerName is required");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error("containerName contains invalid characters");
  }
  if (!name.startsWith(SANDBOX_CONTAINER_PREFIX) || name.length === SANDBOX_CONTAINER_PREFIX.length) {
    throw new Error(`Refusing to manage container: expected name starting with '${SANDBOX_CONTAINER_PREFIX}'`);
  }
  return name;
}

export function parseSandboxMountSpec(spec) {
  const value = String(spec ?? "").trim();
  if (!value) throw new Error("Empty sandbox mount entry");

  const hostSeparator = value.indexOf(":", /^[A-Za-z]:[\\/]/.test(value) ? 2 : 0);
  if (hostSeparator <= 0 || hostSeparator >= value.length - 1) {
    throw new Error(`Invalid sandbox mount value: ${spec}. Use hostPath:subpath[:ro|rw].`);
  }

  const hostPath = value.slice(0, hostSeparator).trim();
  const remainder = value.slice(hostSeparator + 1).trim();
  const segments = remainder.split(":");
  if (segments.length > 2) {
    throw new Error(`Invalid sandbox mount value: ${spec}. Use hostPath:subpath[:ro|rw].`);
  }
  const containerSubPath = segments[0]?.trim() ?? "";
  const mode = segments[1]?.trim().toLowerCase() ?? "rw";
  if (!hostPath || !containerSubPath) {
    throw new Error(`Invalid sandbox mount value: ${spec}. Host path and container subpath are required.`);
  }
  if (mode !== "ro" && mode !== "rw") {
    throw new Error(`Invalid sandbox mount mode: ${segments[1]}. Use ro or rw.`);
  }
  if (
    containerSubPath.startsWith("/") ||
    containerSubPath.includes("\\") ||
    containerSubPath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`Invalid sandbox container subpath: "${containerSubPath}". Use a normalized relative path.`);
  }
  return { hostPath, containerSubPath, requestedReadWrite: mode === "rw" };
}

export async function loadSandboxMountAllowlist(options = {}) {
  const homeDir = options.homeDir ?? os.homedir();
  const allowlistPath = path.resolve(
    options.allowlistPath ??
      process.env.JUGGLEWORK_SANDBOX_MOUNT_ALLOWLIST ??
      path.join(homeDir, ".config", "jugglework", "sandbox-mount-allowlist.json"),
  );
  let payload;
  try {
    payload = JSON.parse(await (options.readFileImpl ?? readFile)(allowlistPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Additional sandbox mounts are blocked because the allowlist could not be read at ${allowlistPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.allowedRoots)) {
    throw new Error(`Invalid sandbox mount allowlist at ${allowlistPath}: allowedRoots must be an array`);
  }
  for (const root of payload.allowedRoots) {
    if (!root || typeof root.path !== "string" || !root.path.trim()) {
      throw new Error(`Invalid sandbox mount allowlist at ${allowlistPath}: every allowed root needs a path`);
    }
    if (root.allowReadWrite !== undefined && typeof root.allowReadWrite !== "boolean") {
      throw new Error(`Invalid sandbox mount allowlist at ${allowlistPath}: allowReadWrite must be boolean`);
    }
  }
  return {
    allowedRoots: payload.allowedRoots,
    blockedPatterns: [
      ...new Set([
        ...DEFAULT_SANDBOX_BLOCKED_PATTERNS,
        ...(Array.isArray(payload.blockedPatterns) ? payload.blockedPatterns : []),
      ]),
    ],
  };
}

export async function resolveSandboxMounts(specs, options = {}) {
  const values = Array.isArray(specs)
    ? specs
    : String(specs ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return [];

  const homeDir = options.homeDir ?? os.homedir();
  const realpathImpl = options.realpathImpl ?? realpath;
  const allowlist = options.allowlist ?? await loadSandboxMountAllowlist(options);
  const roots = [];
  for (const root of allowlist.allowedRoots) {
    try {
      roots.push({
        ...root,
        realPath: await realpathImpl(path.resolve(expandTildePath(root.path, homeDir))),
      });
    } catch {
      // Missing allowlist roots cannot authorize a mount.
    }
  }

  const mounts = [];
  for (const value of values) {
    const parsed = parseSandboxMountSpec(value);
    const expanded = path.resolve(expandTildePath(parsed.hostPath, homeDir));
    let hostPath;
    try {
      hostPath = await realpathImpl(expanded);
    } catch {
      throw new Error(`Sandbox mount host path does not exist: ${parsed.hostPath} (expanded: ${expanded})`);
    }
    const blocked = matchesBlockedPattern(hostPath, [
      ...new Set([
        ...DEFAULT_SANDBOX_BLOCKED_PATTERNS,
        ...(allowlist.blockedPatterns ?? []),
      ]),
    ]);
    if (blocked) throw new Error(`Sandbox mount rejected (blocked pattern "${blocked}"): ${hostPath}`);

    const allowedRoot = roots.find((root) => isWithinPath(root.realPath, hostPath));
    if (!allowedRoot) {
      throw new Error(
        `Sandbox mount rejected: ${hostPath} is not under any allowed root. Allowed: ${roots.map((root) => root.realPath).join(", ")}`,
      );
    }
    mounts.push({
      hostPath,
      containerPath: `/workspace/extra/${parsed.containerSubPath}`,
      readonly: parsed.requestedReadWrite ? allowedRoot.allowReadWrite !== true : true,
    });
  }
  return mounts;
}

export function resolveDockerCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.existsSyncImpl ?? existsSync;
  const candidates = [];
  const seen = new Set();
  const add = (candidate, requireExists = true) => {
    const value = String(candidate ?? "").trim();
    if (!value || seen.has(value) || (requireExists && !exists(value))) return;
    seen.add(value);
    candidates.push(value);
  };
  for (const key of ["JUGGLEWORK_DOCKER_BIN", "OPENWRK_DOCKER_BIN", "DOCKER_BIN"]) add(env[key]);
  for (const entry of String(env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    add(path.join(entry, platform === "win32" ? "docker.exe" : "docker"));
  }
  for (const candidate of [
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]) add(candidate);
  add(platform === "win32" ? "docker.exe" : "docker", false);
  return candidates;
}

export function createDockerCommandRunner(options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const candidates = options.dockerCandidates ?? resolveDockerCandidates(options);
  return (args, timeoutMs = 8000, commandEnv) => {
    const errors = [];
    for (const program of candidates) {
      const result = spawnSyncImpl(program, args, {
        encoding: "utf8",
        env: commandEnv,
        timeout: timeoutMs,
        windowsHide: true,
      });
      if (result?.error) {
        errors.push(`${program}: ${result.error.message ?? String(result.error)}`);
        continue;
      }
      return {
        program,
        status: typeof result?.status === "number" ? result.status : -1,
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
      };
    }
    throw new Error(
      `Failed to run docker: ${errors.join("; ")} (Set JUGGLEWORK_DOCKER_BIN to your docker binary if needed)`,
    );
  };
}

export function buildSandboxDockerRunCommand(options) {
  const args = [
    "run",
    "-d",
    "--name",
    assertManagedSandboxContainerName(options.containerName),
    "-p",
    `127.0.0.1:${options.port}:${SANDBOX_SERVER_PORT}`,
    "-v",
    `${options.workspacePath}:/workspace${options.readOnly ? ":ro" : ""}`,
    "-v",
    `${options.persistDir}:/data`,
    "-e",
    "JUGGLEWORK_TOKEN",
    "-e",
    "JUGGLEWORK_HOST_TOKEN",
    "-e",
    "JUGGLEWORK_MANAGE_OPENCODE=1",
    "-e",
    "JUGGLEWORK_OPENCODE_BIN=/usr/local/bin/opencode",
    "-e",
    "JUGGLEWORK_WORKSPACE=/workspace",
    "-e",
    `JUGGLEWORK_PORT=${SANDBOX_SERVER_PORT}`,
    "-e",
    "JUGGLEWORK_SANDBOX_ENABLED=1",
    "-e",
    `JUGGLEWORK_SANDBOX_BACKEND=${options.backend}`,
  ];
  for (const mount of options.extraMounts ?? []) {
    args.push("-v", `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ":ro" : ""}`);
  }
  args.push(
    "--entrypoint",
    "/usr/local/bin/jugglework-server",
    options.image,
    "--workspace",
    "/workspace",
    "--host",
    "0.0.0.0",
    "--port",
    String(SANDBOX_SERVER_PORT),
    "--approval",
    "auto",
    "--cors",
    "*",
    ...(options.readOnly ? ["--read-only"] : []),
  );
  return args;
}

async function allocateFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a sandbox port")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function defaultProbeHttp(url, timeoutMs, fetchImpl = fetch) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "Request did not succeed";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(lastError);
}

export function createSandboxRuntime(options = {}) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const userDataDir = options.userDataDir ?? path.join(homeDir, ".jugglework");
  const runDocker = options.runDocker ?? createDockerCommandRunner({ ...options, env });
  const allocatePort = options.allocatePort ?? allocateFreePort;
  const probeHttp = options.probeHttp ?? ((url, timeoutMs) => defaultProbeHttp(url, timeoutMs, options.fetchImpl));
  const mkdirImpl = options.mkdirImpl ?? mkdir;
  const mkdtempImpl = options.mkdtempImpl ?? mkdtemp;
  const rmImpl = options.rmImpl ?? rm;
  const realpathImpl = options.realpathImpl ?? realpath;
  const statImpl = options.statImpl ?? stat;

  async function doctor() {
    const candidates = options.dockerCandidates ?? resolveDockerCandidates({ ...options, env });
    const debug = { candidates, selectedBin: null, versionCommand: null, infoCommand: null };
    let version;
    try {
      version = runDocker(["--version"], 2000);
    } catch (error) {
      return { installed: false, daemonRunning: false, permissionOk: false, ready: false, clientVersion: null, serverVersion: null, error: error instanceof Error ? error.message : String(error), debug };
    }
    debug.selectedBin = version.program;
    debug.versionCommand = { status: version.status, stdout: truncateOutput(version.stdout, 1200), stderr: truncateOutput(version.stderr, 1200) };
    const clientVersion = String(version.stdout).split(/\r?\n/)[0]?.trim() || null;
    if (version.status !== 0) {
      return { installed: false, daemonRunning: false, permissionOk: false, ready: false, clientVersion: null, serverVersion: null, error: commandError("--version", version), debug };
    }
    let info;
    try {
      info = runDocker(["info"], 8000);
    } catch (error) {
      return { installed: true, daemonRunning: false, permissionOk: false, ready: false, clientVersion, serverVersion: null, error: error instanceof Error ? error.message : String(error), debug };
    }
    debug.infoCommand = { status: info.status, stdout: truncateOutput(info.stdout, 1200), stderr: truncateOutput(info.stderr, 1200) };
    const serverVersion = String(info.stdout).split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("Server Version:"))?.slice("Server Version:".length).trim() || null;
    if (info.status === 0) {
      return { installed: true, daemonRunning: true, permissionOk: true, ready: true, clientVersion, serverVersion, error: null, debug };
    }
    const combined = `${info.stdout}\n${info.stderr}`.toLowerCase();
    return {
      installed: true,
      daemonRunning: !["cannot connect", "daemon running", "connection refused", "no such file"].some((text) => combined.includes(text)),
      permissionOk: !["permission denied", "access is denied"].some((text) => combined.includes(text)),
      ready: false,
      clientVersion,
      serverVersion: null,
      error: commandError("info", info),
      debug,
    };
  }

  async function inspect(containerName) {
    const name = assertManagedSandboxContainerName(containerName);
    const result = runDocker(["inspect", name], 6000);
    return { status: result.status, stdout: truncateOutput(result.stdout, 48_000), stderr: truncateOutput(result.stderr, 48_000) };
  }

  async function logs(containerName) {
    const name = assertManagedSandboxContainerName(containerName);
    const result = runDocker(["logs", "--timestamps", "--tail", "400", name], 8000);
    return { status: result.status, stdout: truncateOutput(result.stdout, 48_000), stderr: truncateOutput(result.stderr, 48_000) };
  }

  async function remove(containerName) {
    const name = assertManagedSandboxContainerName(containerName);
    const result = runDocker(["rm", "-f", name], 20_000);
    return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function stop(containerName) {
    const name = assertManagedSandboxContainerName(containerName);
    const result = runDocker(["stop", name], 15_000);
    return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  async function listManagedContainers() {
    const result = runDocker(["ps", "-a", "--filter", `name=^/${SANDBOX_CONTAINER_PREFIX}`, "--format", "{{.Names}}"], 8000);
    if (result.status !== 0) throw new Error(commandError("ps -a", result));
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((name) => name.startsWith(SANDBOX_CONTAINER_PREFIX)).sort();
  }

  async function cleanup() {
    const candidates = await listManagedContainers();
    const removed = [];
    const errors = [];
    for (const name of candidates) {
      try {
        const result = await remove(name);
        if (result.ok) removed.push(name);
        else errors.push(`${name}: ${commandError("rm -f", result)}`);
      } catch (error) {
        errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { candidates, removed, errors };
  }

  async function collectDiagnostics(containerName) {
    let dockerInspect = null;
    let dockerLogs = null;
    const errors = [];
    try { dockerInspect = await inspect(containerName); } catch (error) { errors.push(`docker inspect failed: ${error instanceof Error ? error.message : String(error)}`); }
    try { dockerLogs = await logs(containerName); } catch (error) { errors.push(`docker logs failed: ${error instanceof Error ? error.message : String(error)}`); }
    return { dockerInspect, dockerLogs, errors };
  }

  async function start(input = {}) {
    const backend = normalizeSandboxBackend(input.sandboxBackend);
    const workspaceInput = String(input.workspacePath ?? "").trim();
    if (!workspaceInput) throw new Error("workspacePath is required");
    const workspacePath = await realpathImpl(path.resolve(expandTildePath(workspaceInput, homeDir)));
    if (!(await statImpl(workspacePath)).isDirectory()) throw new Error("workspacePath must be a directory");

    const runId = String(input.runId ?? randomUUID()).trim();
    const containerName = deriveSandboxContainerName(runId);
    const port = Number(input.port ?? await allocatePort());
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be between 1 and 65535");
    const token = String(input.juggleworkToken ?? randomUUID()).trim();
    const hostToken = String(input.juggleworkHostToken ?? randomUUID()).trim();
    const image = String(input.sandboxImageRef ?? env.JUGGLEWORK_SANDBOX_IMAGE ?? DEFAULT_SANDBOX_IMAGE).trim();
    if (!image || /\s/.test(image)) throw new Error("sandboxImageRef must be a non-empty image reference without whitespace");
    const persistRoot = path.resolve(
      expandTildePath(options.persistRoot ?? env.JUGGLEWORK_SANDBOX_PERSIST_DIR ?? path.join(userDataDir, "sandbox"), homeDir),
    );
    const persistDir = path.join(persistRoot, containerName);
    await mkdirImpl(persistDir, { recursive: true });
    const extraMounts = await resolveSandboxMounts(input.sandboxMounts ?? input.sandboxMount ?? [], {
      allowlist: options.mountAllowlist,
      allowlistPath: options.mountAllowlistPath,
      homeDir,
      realpathImpl,
      readFileImpl: options.readFileImpl,
    });
    const args = buildSandboxDockerRunCommand({
      backend,
      containerName,
      extraMounts,
      hostToken,
      image,
      persistDir,
      port,
      readOnly: input.readOnly === true,
      token,
      workspacePath,
    });
    const childEnv = { ...env, JUGGLEWORK_TOKEN: token, JUGGLEWORK_HOST_TOKEN: hostToken };
    let started = false;
    try {
      const result = runDocker(args, 30_000, childEnv);
      if (result.status !== 0) throw new Error(commandError("run", result));
      started = true;
      const juggleworkUrl = `http://127.0.0.1:${port}`;
      await probeHttp(`${juggleworkUrl}/health`, Number(input.probeTimeoutMs ?? 90_000));
      let ownerToken = null;
      if (options.fetchImpl ?? globalThis.fetch) {
        try {
          const response = await (options.fetchImpl ?? fetch)(`${juggleworkUrl}/tokens`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-JuggleWork-Host-Token": hostToken },
            body: JSON.stringify({ scope: "owner", label: "JuggleWork desktop sandbox owner token" }),
          });
          if (response.ok) ownerToken = String((await response.json())?.token ?? "").trim() || null;
        } catch {
          ownerToken = null;
        }
      }
      return { juggleworkUrl, token, ownerToken, hostToken, port, sandboxBackend: backend, sandboxRunId: runId, sandboxContainerName: containerName };
    } catch (error) {
      const diagnostics = started ? await collectDiagnostics(containerName) : { dockerInspect: null, dockerLogs: null, errors: [] };
      let cleanupError = null;
      try {
        const result = await remove(containerName);
        if (!result.ok) cleanupError = commandError("rm -f", result);
      } catch (removeError) {
        cleanupError = removeError instanceof Error ? removeError.message : String(removeError);
      }
      if (error instanceof Error) {
        throw Object.assign(error, {
          sandboxDiagnostics: diagnostics,
          sandboxCleanupError: cleanupError,
        });
      }
      throw error;
    }
  }

  async function debugProbe() {
    const startedAt = Date.now();
    const runId = `probe-${randomUUID()}`;
    const containerName = deriveSandboxContainerName(runId);
    const workspacePath = await mkdtempImpl(path.join(os.tmpdir(), "jugglework-sandbox-probe-"));
    const doctorResult = await doctor();
    let detachedHost = null;
    let dockerInspect = null;
    let dockerLogs = null;
    let error = null;
    let containerRemoved = false;
    let removeResult = null;
    let workspaceRemoved = false;
    const cleanupErrors = [];
    if (doctorResult.ready) {
      try {
        detachedHost = await start({ workspacePath, sandboxBackend: "docker", runId });
        const diagnostics = await collectDiagnostics(containerName);
        dockerInspect = diagnostics.dockerInspect;
        dockerLogs = diagnostics.dockerLogs;
        cleanupErrors.push(...diagnostics.errors);
      } catch (probeError) {
        error = `Sandbox probe failed to start: ${probeError instanceof Error ? probeError.message : String(probeError)}`;
        dockerInspect = probeError?.sandboxDiagnostics?.dockerInspect ?? null;
        dockerLogs = probeError?.sandboxDiagnostics?.dockerLogs ?? null;
        cleanupErrors.push(...(probeError?.sandboxDiagnostics?.errors ?? []));
        containerRemoved = !probeError?.sandboxCleanupError;
        if (probeError?.sandboxCleanupError) cleanupErrors.push(`docker cleanup failed: ${probeError.sandboxCleanupError}`);
      }
      if (detachedHost) {
        try {
          removeResult = await remove(containerName);
          containerRemoved = removeResult.ok;
        } catch (removeError) {
          cleanupErrors.push(`docker rm -f ${containerName} failed: ${removeError instanceof Error ? removeError.message : String(removeError)}`);
        }
      }
    } else {
      error = doctorResult.error ?? "Docker is not ready for sandbox creation";
    }
    try {
      await rmImpl(workspacePath, { recursive: true, force: true });
      workspaceRemoved = true;
    } catch (workspaceError) {
      cleanupErrors.push(`Failed to remove probe workspace: ${workspaceError instanceof Error ? workspaceError.message : String(workspaceError)}`);
    }
    return {
      startedAt,
      finishedAt: Date.now(),
      runId,
      workspacePath,
      ready: doctorResult.ready && !error,
      doctor: doctorResult,
      detachedHost,
      dockerInspect,
      dockerLogs,
      cleanup: { containerName, containerRemoved, removeResult, workspaceRemoved, errors: cleanupErrors },
      error,
    };
  }

  return { cleanup, debugProbe, doctor, inspect, listManagedContainers, logs, remove, start, stop };
}

import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname } from "node:path";

import {
  CLAUDE_AGENT_RUNTIME_FEATURE_FLAG,
  resolveClaudeAgentRollout,
} from "@jugglework/types/agent-runtime";

import { ClaudeWorkerClient, ClaudeWorkerClientError } from "./claude-worker-client.js";
import type { ClaudeCredentialBroker, ClaudeCredentialLease } from "./claude-credentials.js";
import { buildClaudeWorkerEnvironment, scrubClaudeSecrets } from "./claude-environment.js";
import {
  claudeProfileDataPaths,
  cleanupClaudeTranscripts,
  inspectClaudeProfileData,
  prepareClaudeProfileData,
  type ClaudeProfileDiagnostics,
} from "./claude-profile-data.js";

export { CLAUDE_AGENT_RUNTIME_FEATURE_FLAG };
export const CLAUDE_AGENT_WORKER_PATH_ENV = "JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH";
export const CLAUDE_EXECUTABLE_PATH_ENV = "JUGGLEWORK_CLAUDE_EXECUTABLE_PATH";
export const CLAUDE_AGENT_NODE_PATH_ENV = "JUGGLEWORK_CLAUDE_AGENT_NODE_PATH";

export type ClaudeWorkerManagerStatus =
  | "stopped"
  | "starting"
  | "healthy"
  | "backoff"
  | "circuit_open"
  | "failed"
  | "stopping";

export type ClaudeWorkerManagerSnapshot = {
  status: ClaudeWorkerManagerStatus;
  generation: number | null;
  pid: number | null;
  restartAttempts: number;
  circuitOpen: boolean;
  lastError: string | null;
  credentialProvider: import("./claude-credentials.js").ClaudeCredentialProvider | null;
  credentialAuthMethod: import("./claude-credentials.js").ClaudeCredentialAuthMethod | null;
};

export class ClaudeWorkerProcessError extends Error {
  constructor(
    readonly code:
      | "configuration_invalid"
      | "startup_timeout"
      | "startup_failed"
      | "ownership_lost"
      | "circuit_open"
      | "stopped",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ClaudeWorkerProcessError";
  }
}

type Generation = {
  id: number;
  token: string;
  child: ChildProcess;
  exited: Promise<void>;
  abort: AbortController;
  client: ClaudeWorkerClient | null;
  readyAt: number | null;
  expectedExit: boolean;
  cleanupPromise: Promise<void> | null;
  credentialLease: ClaudeCredentialLease;
};

type ReadinessWaiter = {
  resolve: (client: ClaudeWorkerClient) => void;
  reject: (error: Error) => void;
};

const secretEnvironmentValues = (lease: ClaudeCredentialLease): string[] => Object.entries(lease.environment)
  .filter(([name, value]) => typeof value === "string" && (
    name.includes("KEY") || name.includes("TOKEN") || name.includes("SECRET") || name.includes("CREDENTIAL")
  ))
  .map(([, value]) => value as string);

export type ClaudeWorkerProcessManagerOptions = {
  workerPath: string;
  claudeExecutablePath: string;
  credentialBroker: ClaudeCredentialBroker;
  profileDataDir: string;
  nodePath?: string;
  cwd?: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  env?: NodeJS.ProcessEnv;
  transcriptRetentionDays?: number;
  readinessTimeoutMs?: number;
  requestTimeoutMs?: number;
  gracefulShutdownMs?: number;
  forceKillAfterMs?: number;
  restartBaseDelayMs?: number;
  restartMaxDelayMs?: number;
  maxRestartAttempts?: number;
  restartResetAfterMs?: number;
  onStatusChange?: (snapshot: ClaudeWorkerManagerSnapshot) => void;
};

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function boundedOutput(current: string, chunk: unknown): string {
  const next = current + String(chunk);
  return next.length <= 64 * 1024 ? next : next.slice(next.length - 64 * 1024);
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return String(error).slice(0, 2_000);
}

async function runTaskkill(pid: number, force: boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const child = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
    child.once("error", () => resolve());
    child.once("exit", () => resolve());
  });
}

async function signalProcessTree(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
  if (!pid) return;
  if (process.platform === "win32") {
    await runTaskkill(pid, signal === "SIGKILL");
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Bun on macOS reports EPERM when the leader has exited and its now-empty
    // process group no longer has a signalable member. Cleanup is already done.
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

export class ClaudeWorkerProcessManager {
  private readonly options: Required<Omit<ClaudeWorkerProcessManagerOptions, "env" | "inheritedEnv" | "onStatusChange">>
    & Pick<ClaudeWorkerProcessManagerOptions, "env" | "inheritedEnv" | "onStatusChange">;
  private readonly profilePaths;
  private status: ClaudeWorkerManagerStatus = "stopped";
  private generation: Generation | null = null;
  private nextGeneration = 0;
  private restartAttempts = 0;
  private lastError: string | null = null;
  private desiredRunning = false;
  private startPromise: Promise<ClaudeWorkerClient> | null = null;
  private spawnPromise: Promise<ClaudeWorkerClient> | null = null;
  private stopPromise: Promise<void> | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly readinessWaiters = new Set<ReadinessWaiter>();
  private readonly statusListeners = new Set<(snapshot: ClaudeWorkerManagerSnapshot) => void>();
  private readonly crashListeners = new Set<() => void>();

  constructor(options: ClaudeWorkerProcessManagerOptions) {
    if (!options.workerPath.trim() || !options.claudeExecutablePath.trim() || !options.profileDataDir.trim()) {
      throw new ClaudeWorkerProcessError("configuration_invalid", "Claude worker, executable, and profile data paths are required");
    }
    this.profilePaths = claudeProfileDataPaths(options.profileDataDir);
    this.options = {
      ...options,
      workerPath: options.workerPath,
      claudeExecutablePath: options.claudeExecutablePath,
      nodePath: options.nodePath?.trim() || "node",
      cwd: options.cwd ?? dirname(options.workerPath),
      credentialBroker: options.credentialBroker,
      profileDataDir: options.profileDataDir,
      transcriptRetentionDays: options.transcriptRetentionDays ?? 30,
      readinessTimeoutMs: options.readinessTimeoutMs ?? 15_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 2_000,
      gracefulShutdownMs: options.gracefulShutdownMs ?? 1_000,
      forceKillAfterMs: options.forceKillAfterMs ?? 500,
      restartBaseDelayMs: options.restartBaseDelayMs ?? 250,
      restartMaxDelayMs: options.restartMaxDelayMs ?? 5_000,
      maxRestartAttempts: options.maxRestartAttempts ?? 5,
      restartResetAfterMs: options.restartResetAfterMs ?? 60_000,
    };
  }

  snapshot(): ClaudeWorkerManagerSnapshot {
    return {
      status: this.status,
      generation: this.generation?.id ?? null,
      pid: this.generation?.child.pid ?? null,
      restartAttempts: this.restartAttempts,
      circuitOpen: this.status === "circuit_open",
      lastError: this.lastError,
      credentialProvider: this.generation?.credentialLease.diagnostic?.provider ?? null,
      credentialAuthMethod: this.generation?.credentialLease.diagnostic?.authMethod ?? null,
    };
  }

  subscribeStatus(listener: (snapshot: ClaudeWorkerManagerSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.snapshot());
    return () => this.statusListeners.delete(listener);
  }

  subscribeCrash(listener: () => void): () => void {
    this.crashListeners.add(listener);
    return () => this.crashListeners.delete(listener);
  }

  client(): ClaudeWorkerClient {
    if (this.status !== "healthy" || !this.generation?.client) {
      throw new ClaudeWorkerProcessError("startup_failed", "Claude worker is not ready");
    }
    return this.generation.client;
  }

  diagnostics(): Promise<ClaudeProfileDiagnostics> {
    return inspectClaudeProfileData(this.profilePaths);
  }

  cleanupRetainedTranscripts(now?: number): Promise<{ removedFiles: number; removedBytes: number }> {
    return cleanupClaudeTranscripts({
      paths: this.profilePaths,
      retentionDays: this.options.transcriptRetentionDays,
      now,
    });
  }

  start(): Promise<ClaudeWorkerClient> {
    if (this.status === "healthy" && this.generation?.client) return Promise.resolve(this.generation.client);
    if (this.startPromise) return this.startPromise;
    if (this.status === "stopping" && this.stopPromise) {
      return this.stopPromise.then(() => this.start());
    }
    if (this.status === "circuit_open") {
      return Promise.reject(new ClaudeWorkerProcessError("circuit_open", "Claude worker restart circuit is open"));
    }
    if (this.desiredRunning) return this.waitForHealthyGeneration();
    this.stopPromise = null;
    this.desiredRunning = true;
    this.startPromise = this.startInitialGeneration();
    return this.startPromise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwnedResources();
    return this.stopPromise;
  }

  resetCircuit(): void {
    if (this.generation || this.status !== "circuit_open") return;
    this.restartAttempts = 0;
    this.lastError = null;
    this.setStatus("stopped");
  }

  private async startInitialGeneration(): Promise<ClaudeWorkerClient> {
    this.setStatus("starting");
    try {
      const client = await this.beginSpawnReadyGeneration();
      if (!this.desiredRunning) throw new ClaudeWorkerProcessError("stopped", "Claude worker startup was stopped");
      if (this.generation?.client !== client) {
        throw new ClaudeWorkerProcessError("ownership_lost", "Claude worker generation lost readiness ownership");
      }
      this.setStatus("healthy");
      return client;
    } catch (error) {
      const generation = this.generation;
      if (generation) await this.cleanupGeneration(generation, "startup rollback");
      if (this.desiredRunning) {
        this.desiredRunning = false;
        this.lastError = safeErrorMessage(error);
        this.setStatus("failed");
      }
      throw error;
    } finally {
      this.startPromise = null;
    }
  }

  private beginSpawnReadyGeneration(): Promise<ClaudeWorkerClient> {
    if (this.spawnPromise) return this.spawnPromise;
    const promise = this.spawnReadyGeneration();
    this.spawnPromise = promise;
    promise.then(
      () => { if (this.spawnPromise === promise) this.spawnPromise = null; },
      () => { if (this.spawnPromise === promise) this.spawnPromise = null; },
    );
    return promise;
  }

  private async spawnReadyGeneration(): Promise<ClaudeWorkerClient> {
    const id = ++this.nextGeneration;
    const token = randomBytes(32).toString("base64url");
    await prepareClaudeProfileData(this.profilePaths);
    await this.cleanupRetainedTranscripts();
    const credentialLease = await this.options.credentialBroker.acquire();
    let child: ChildProcess;
    try {
      child = spawn(this.options.nodePath, [this.options.workerPath], {
        cwd: this.options.cwd,
        env: buildClaudeWorkerEnvironment({
          inheritedEnv: this.options.inheritedEnv,
          workerPath: this.options.workerPath,
          claudeExecutablePath: this.options.claudeExecutablePath,
          profileDataDir: this.profilePaths.rootDir,
          claudeConfigDir: this.profilePaths.configDir,
          generationToken: token,
          credentialEnvironment: credentialLease.environment,
          additionalEnvironment: this.options.env,
        }),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      await credentialLease.release();
      throw error;
    }
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    child.once("exit", resolveExit);
    child.once("error", resolveExit);
    const generation: Generation = {
      id,
      token,
      child,
      exited,
      abort: new AbortController(),
      client: null,
      readyAt: null,
      expectedExit: false,
      cleanupPromise: null,
      credentialLease,
    };
    this.generation = generation;
    child.once("exit", (code, signal) => void this.onGenerationExit(generation, code, signal));

    try {
      const url = await this.waitForReadyLine(generation);
      if (
        this.generation !== generation
        || !this.desiredRunning
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        throw new ClaudeWorkerProcessError("ownership_lost", "Claude worker generation lost startup ownership");
      }
      const client = new ClaudeWorkerClient({
        url,
        generationToken: token,
        generation: id,
        requestTimeoutMs: this.options.requestTimeoutMs,
        assertOwnership: () => {
          if (this.generation !== generation) {
            throw new ClaudeWorkerClientError("ownership_lost", "Claude worker generation no longer owns the transport");
          }
        },
      });
      const [health] = await Promise.all([client.health(), client.capabilities()]);
      if (health.status !== "healthy") {
        throw new ClaudeWorkerProcessError("startup_failed", `Claude worker reported ${health.status} during startup`);
      }
      if (
        this.generation !== generation
        || !this.desiredRunning
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        throw new ClaudeWorkerProcessError("ownership_lost", "Claude worker generation lost readiness ownership");
      }
      generation.client = client;
      generation.readyAt = Date.now();
      return client;
    } catch (error) {
      await this.cleanupGeneration(generation, "startup rollback");
      throw error;
    }
  }

  private waitForReadyLine(generation: Generation): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let output = "";
      let stderr = "";
      let settled = false;
      const timeout = setTimeout(() => {
        fail(new ClaudeWorkerProcessError(
          "startup_timeout",
          `Claude worker readiness timed out after ${this.options.readinessTimeoutMs}ms${stderr.trim() ? `: ${scrubClaudeSecrets(stderr.trim(), secretEnvironmentValues(generation.credentialLease))}` : ""}`,
        ));
      }, this.options.readinessTimeoutMs);
      const cleanup = () => {
        clearTimeout(timeout);
        generation.child.stdout?.off("data", onStdout);
        generation.child.stderr?.off("data", onStderr);
        generation.child.off("error", onError);
        generation.child.off("exit", onExit);
        generation.abort.signal.removeEventListener("abort", onAbort);
      };
      const done = (url: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(url);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const parseLines = () => {
        const lines = output.split("\n");
        output = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            if (line.includes("ready")) fail(new ClaudeWorkerProcessError("startup_failed", "Claude worker emitted malformed readiness data"));
            continue;
          }
          if (!value || typeof value !== "object" || (value as { type?: unknown }).type !== "ready") continue;
          const url = (value as { url?: unknown }).url;
          if (typeof url !== "string") {
            fail(new ClaudeWorkerProcessError("startup_failed", "Claude worker readiness payload is invalid"));
            return;
          }
          done(url);
          return;
        }
      };
      const onStdout = (chunk: unknown) => {
        output = boundedOutput(output, chunk);
        parseLines();
      };
      const onStderr = (chunk: unknown) => { stderr = boundedOutput(stderr, chunk); };
      const onError = (error: Error) => fail(new ClaudeWorkerProcessError("startup_failed", "Claude worker failed to spawn", { cause: error }));
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => fail(new ClaudeWorkerProcessError(
        "startup_failed",
        `Claude worker exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})${stderr.trim() ? `: ${scrubClaudeSecrets(stderr.trim(), secretEnvironmentValues(generation.credentialLease))}` : ""}`,
      ));
      const onAbort = () => fail(new ClaudeWorkerProcessError("stopped", "Claude worker startup was stopped"));
      generation.child.stdout?.on("data", onStdout);
      generation.child.stderr?.on("data", onStderr);
      generation.child.once("error", onError);
      generation.child.once("exit", onExit);
      generation.abort.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async onGenerationExit(
    generation: Generation,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (this.generation !== generation || generation.expectedExit || generation.readyAt === null) return;
    this.generation = null;
    generation.client = null;
    for (const listener of this.crashListeners) listener();
    await this.cleanupGeneration(generation, "worker crashed");
    if (!this.desiredRunning) {
      this.setStatus("stopped");
      return;
    }
    this.clearStabilityTimer();
    this.scheduleRestart(new Error(`Claude worker exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"})`));
  }

  private scheduleRestart(error: unknown): void {
    this.lastError = safeErrorMessage(error);
    if (!this.desiredRunning) return;
    if (this.restartAttempts >= this.options.maxRestartAttempts) {
      this.desiredRunning = false;
      this.setStatus("circuit_open");
      return;
    }
    this.restartAttempts += 1;
    const backoff = Math.min(
      this.options.restartBaseDelayMs * (2 ** (this.restartAttempts - 1)),
      this.options.restartMaxDelayMs,
    );
    this.setStatus("backoff");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.desiredRunning) return;
      this.setStatus("starting");
      void this.beginSpawnReadyGeneration().then((client) => {
        if (!this.desiredRunning || this.generation?.client !== client) return;
        this.setStatus("healthy");
        this.clearStabilityTimer();
        this.stabilityTimer = setTimeout(() => {
          this.stabilityTimer = null;
          this.restartAttempts = 0;
          this.emitStatus();
        }, this.options.restartResetAfterMs);
      }).catch((restartError) => {
        if (this.desiredRunning) this.scheduleRestart(restartError);
      });
    }, backoff);
  }

  private async stopOwnedResources(): Promise<void> {
    this.desiredRunning = false;
    this.setStatus("stopping");
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.clearStabilityTimer();
    const generationAtStop = this.generation;
    if (generationAtStop) await this.cleanupGeneration(generationAtStop, "server shutdown");
    const spawning = this.spawnPromise;
    if (spawning) await spawning.catch(() => undefined);
    const generationAfterSpawn = this.generation;
    if (generationAfterSpawn) await this.cleanupGeneration(generationAfterSpawn, "server shutdown");
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    this.generation = null;
    this.restartAttempts = 0;
    this.lastError = null;
    this.setStatus("stopped");
  }

  private cleanupGeneration(generation: Generation, reason: string): Promise<void> {
    generation.cleanupPromise ??= (async () => {
      generation.expectedExit = true;
      generation.abort.abort();
      if (generation.client) {
        await Promise.race([
          generation.client.shutdown(reason).catch(() => undefined),
          delay(this.options.gracefulShutdownMs),
        ]);
      }
      await signalProcessTree(generation.child.pid, "SIGTERM");
      await Promise.race([generation.exited, delay(this.options.forceKillAfterMs)]);
      await signalProcessTree(generation.child.pid, "SIGKILL");
      await Promise.race([generation.exited, delay(this.options.forceKillAfterMs)]);
      await generation.credentialLease.release();
      if (this.generation === generation) this.generation = null;
    })();
    return generation.cleanupPromise;
  }

  private clearStabilityTimer(): void {
    if (!this.stabilityTimer) return;
    clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
  }

  private setStatus(status: ClaudeWorkerManagerStatus): void {
    this.status = status;
    this.emitStatus();
    if (status === "healthy" && this.generation?.client) {
      for (const waiter of this.readinessWaiters) waiter.resolve(this.generation.client);
      this.readinessWaiters.clear();
      return;
    }
    if (status === "circuit_open" || status === "failed" || status === "stopped") {
      const code = status === "circuit_open" ? "circuit_open" : status === "stopped" ? "stopped" : "startup_failed";
      const error = new ClaudeWorkerProcessError(code, `Claude worker became ${status}`);
      for (const waiter of this.readinessWaiters) waiter.reject(error);
      this.readinessWaiters.clear();
    }
  }

  private emitStatus(): void {
    const snapshot = this.snapshot();
    this.options.onStatusChange?.(snapshot);
    for (const listener of this.statusListeners) listener(snapshot);
  }

  private waitForHealthyGeneration(): Promise<ClaudeWorkerClient> {
    return new Promise<ClaudeWorkerClient>((resolve, reject) => {
      this.readinessWaiters.add({ resolve, reject });
    });
  }
}

export function createClaudeWorkerProcessManagerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { credentialBroker?: ClaudeCredentialBroker; profileDataDir?: string } = {},
): ClaudeWorkerProcessManager | null {
  if (!resolveClaudeAgentRollout(env).enabled) return null;
  const workerPath = env[CLAUDE_AGENT_WORKER_PATH_ENV]?.trim();
  const claudeExecutablePath = env[CLAUDE_EXECUTABLE_PATH_ENV]?.trim();
  if (!workerPath || !claudeExecutablePath || !options.credentialBroker || !options.profileDataDir) {
    throw new ClaudeWorkerProcessError(
      "configuration_invalid",
      `Enabled Claude Agent requires ${CLAUDE_AGENT_WORKER_PATH_ENV}, ${CLAUDE_EXECUTABLE_PATH_ENV}, a credential broker, and a profile data directory`,
    );
  }
  return new ClaudeWorkerProcessManager({
    workerPath,
    claudeExecutablePath,
    credentialBroker: options.credentialBroker,
    profileDataDir: options.profileDataDir,
    nodePath: env[CLAUDE_AGENT_NODE_PATH_ENV],
    inheritedEnv: env,
  });
}

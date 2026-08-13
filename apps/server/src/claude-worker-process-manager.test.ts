import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CLAUDE_AGENT_INTERNAL_COHORT_ENV,
  CLAUDE_AGENT_ROLLOUT_STAGE_ENV,
  CLAUDE_AGENT_RUNTIME_FEATURE_FLAG,
  CLAUDE_AGENT_RUNTIME_KILL_SWITCH,
} from "@jugglework/types/agent-runtime";

import { startServer } from "./server.js";
import {
  ClaudeWorkerProcessManager,
  ClaudeWorkerProcessError,
  createClaudeWorkerProcessManagerFromEnv,
} from "./claude-worker-process-manager.js";
import type { ServerConfig } from "./types.js";

const fakeWorkerSource = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const behavior = process.env.FAKE_WORKER_BEHAVIOR || "ready";
const logPath = process.env.FAKE_WORKER_LOG;
const countPath = process.env.FAKE_WORKER_COUNT;
const token = process.env.JUGGLEWORK_CLAUDE_WORKER_TOKEN;
const log = (line) => { if (logPath) appendFileSync(logPath, line + "\\n"); };
let launch = 1;
if (countPath) {
  try { launch = Number(readFileSync(countPath, "utf8")) + 1; } catch {}
  writeFileSync(countPath, String(launch));
}
log("START " + process.pid + " " + launch);
let descendant;
if (behavior === "orphan") {
  descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  log("CHILD " + descendant.pid);
}
process.on("SIGTERM", () => { log("TERM " + process.pid); process.exit(0); });
if (behavior === "secret-error") {
  console.error("ANTHROPIC_API_KEY=" + process.env.ANTHROPIC_API_KEY);
  process.exit(43);
} else if (behavior === "unready") setInterval(() => {}, 1000);
else {
  const server = createServer(async (request, response) => {
    if (request.headers["x-jugglework-worker-token"] !== token) {
      log("UNAUTHORIZED_REQUEST");
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "unauthorized", message: "denied" } }));
      return;
    }
    log("AUTH " + request.url);
    if (request.url === "/v1/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(behavior === "malformed" ? "not-json" : JSON.stringify({
        protocolVersion: 1,
        status: "healthy",
        checkedAt: new Date().toISOString(),
        reasonCode: "worker_ready",
        message: "ready"
      }));
      return;
    }
    if (request.url === "/v1/capabilities") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        protocolVersion: 1,
        sdkVersion: "test",
        cliVersion: "test",
        nodeVersion: process.versions.node,
        transport: "loopback-http",
        limits: { maxHeaderBytes: 16384, maxRequestBytes: 262144, maxEventBytes: 65536, maxRetainedEvents: 1000 },
        operations: { health: true, capabilities: true, events: true, shutdown: true, run: false, abort: false, interactions: false, configurationRefresh: false, currentTurnConfiguration: false, stopSubagent: false, nativeFork: false },
        advanced: { subagentProjection: false, subagentProgress: false, subagentStop: false, planMode: false, fileCheckpointing: false, rewind: false, nativeFork: false, partialFallback: true, filesystemState: "shared-working-tree", prewarm: false, residentSession: false, protocolInterrupt: false, queuedInput: false, steer: false, dynamicModel: false, dynamicEffort: false, dynamicPermissionMode: false },
        sandbox: { supported: true, enabled: true, failClosed: true, allowUnsandboxedCommands: false, backend: "seatbelt", reasonCode: "sandbox_supported" }
      }));
      return;
    }
    if (request.url === "/v1/shutdown") {
      for await (const _ of request) {}
      response.writeHead(202, { "content-type": "application/json" });
      response.end(JSON.stringify({ accepted: true, status: "stopping" }), () => {
        log("SHUTDOWN " + process.pid);
        setTimeout(() => server.close(() => process.exit(0)), behavior === "delayed-shutdown" ? 100 : 0);
      });
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (behavior === "bad-ready") console.log('{"type":"ready"');
    else console.log(JSON.stringify({ type: "ready", url: "http://127.0.0.1:" + address.port }));
    if ((behavior === "crash-once" && launch === 1) || behavior === "always-crash") {
      setTimeout(() => process.exit(42), 50);
    }
  });
}
`;

type Fixture = {
  root: string;
  workerPath: string;
  claudePath: string;
  logPath: string;
  countPath: string;
};

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "jugglework-claude-manager-"));
  const workerPath = join(root, "fake-worker.mjs");
  const claudePath = join(root, "fake-claude");
  const logPath = join(root, "worker.log");
  const countPath = join(root, "count");
  await writeFile(workerPath, fakeWorkerSource);
  await writeFile(claudePath, "#!/bin/sh\nexit 0\n");
  await chmod(claudePath, 0o755);
  return { root, workerPath, claudePath, logPath, countPath };
}

function manager(input: Fixture, behavior: string, overrides: Partial<ConstructorParameters<typeof ClaudeWorkerProcessManager>[0]> = {}) {
  return new ClaudeWorkerProcessManager({
    workerPath: input.workerPath,
    claudeExecutablePath: input.claudePath,
    credentialBroker: {
      readiness: async () => ({ ready: true, reasonCode: "credential_ready" }),
      acquire: async () => ({ environment: { ANTHROPIC_API_KEY: "test-only" }, release() {} }),
    },
    profileDataDir: join(input.root, "profile"),
    nodePath: process.execPath,
    env: {
      PATH: process.env.PATH,
      FAKE_WORKER_BEHAVIOR: behavior,
      FAKE_WORKER_LOG: input.logPath,
      FAKE_WORKER_COUNT: input.countPath,
    },
    readinessTimeoutMs: 500,
    requestTimeoutMs: 500,
    gracefulShutdownMs: 200,
    forceKillAfterMs: 200,
    restartBaseDelayMs: 20,
    restartMaxDelayMs: 40,
    restartResetAfterMs: 5_000,
    ...overrides,
  });
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function serverConfig(root: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("Claude worker process manager", () => {
  test("keeps runtime disabled by default and validates enabled provisioning", () => {
    expect(createClaudeWorkerProcessManagerFromEnv({})).toBeNull();
    expect(createClaudeWorkerProcessManagerFromEnv({
      [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1",
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "internal",
    })).toBeNull();
    expect(createClaudeWorkerProcessManagerFromEnv({
      [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1",
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga",
      [CLAUDE_AGENT_RUNTIME_KILL_SWITCH]: "1",
    })).toBeNull();
    expect(() => createClaudeWorkerProcessManagerFromEnv({
      [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1",
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "internal",
      [CLAUDE_AGENT_INTERNAL_COHORT_ENV]: "1",
    }))
      .toThrow(ClaudeWorkerProcessError);
  });

  test("global kill switch starts Server in OpenCode-only mode without provisioning Claude", async () => {
    const input = await fixture();
    const config = serverConfig(input.root);
    config.workspaces = [{
      id: "workspace-a",
      name: "Workspace",
      path: input.root,
      preset: "starter",
      workspaceType: "local",
    }];
    const env = {
      [CLAUDE_AGENT_RUNTIME_FEATURE_FLAG]: "1",
      [CLAUDE_AGENT_ROLLOUT_STAGE_ENV]: "ga",
      [CLAUDE_AGENT_RUNTIME_KILL_SWITCH]: "1",
    };
    const disabledManager = createClaudeWorkerProcessManagerFromEnv(env);
    expect(disabledManager).toBeNull();

    const server = await startServer(config, { claudeWorkerManager: disabledManager });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace-a/agent/v1/runtimes`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      const text = await response.text();
      expect(response.ok, text).toBe(true);
      const body = JSON.parse(text) as { runtimes: Array<{ id: string; health: { status: string } }> };
      expect(body.runtimes.find(({ id }) => id === "jugglework")?.health.status).not.toBe("disabled");
      expect(body.runtimes.find(({ id }) => id === "claude-agent")?.health.status).toBe("disabled");
      expect(await lines(input.logPath)).toEqual([]);
    } finally {
      await server.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("starts transactionally with authenticated health and supports concurrent idempotent stop", async () => {
    const input = await fixture();
    const managed = manager(input, "ready");
    try {
      const firstStart = managed.start();
      expect(managed.start()).toBe(firstStart);
      const client = await firstStart;
      expect((await client.health()).status).toBe("healthy");
      expect(managed.snapshot().status).toBe("healthy");
      expect((await lines(input.logPath)).filter((line) => line.startsWith("AUTH "))).toEqual([
        "AUTH /v1/health",
        "AUTH /v1/capabilities",
        "AUTH /v1/health",
      ]);

      const firstStop = managed.stop();
      expect(managed.stop()).toBe(firstStop);
      await firstStop;
      expect(managed.snapshot().status).toBe("stopped");
      expect((await lines(input.logPath)).filter((line) => line.startsWith("SHUTDOWN "))).toHaveLength(1);
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("rolls back malformed readiness responses and readiness timeouts", async () => {
    for (const behavior of ["malformed", "unready"]) {
      const input = await fixture();
      const managed = manager(input, behavior, { readinessTimeoutMs: 150 });
      try {
        await expect(managed.start()).rejects.toThrow();
        await waitFor(async () => (await lines(input.logPath)).some((line) => line.startsWith("TERM ")));
        expect(managed.snapshot()).toMatchObject({ status: "failed", pid: null });
      } finally {
        await managed.stop();
        await rm(input.root, { recursive: true, force: true });
      }
    }
  });

  test("scrubs credentials from worker startup failures", async () => {
    const input = await fixture();
    const managed = manager(input, "secret-error");
    try {
      let message = "";
      try {
        await managed.start();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("test-only");
      expect(managed.snapshot().lastError).not.toContain("test-only");
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("serializes stop against an in-flight start and publishes no stale generation", async () => {
    const input = await fixture();
    const managed = manager(input, "unready", { readinessTimeoutMs: 5_000 });
    try {
      const starting = managed.start();
      await waitFor(() => managed.snapshot().pid !== null);
      const stopping = managed.stop();
      await expect(starting).rejects.toMatchObject({ code: "stopped" });
      await stopping;
      expect(managed.snapshot()).toMatchObject({ status: "stopped", generation: null, pid: null });
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("serializes a new start behind an in-flight stop", async () => {
    const input = await fixture();
    const managed = manager(input, "delayed-shutdown");
    try {
      await managed.start();
      const stopping = managed.stop();
      await waitFor(() => managed.snapshot().status === "stopping");
      const restarted = managed.start();
      await stopping;
      expect((await restarted).generation).toBe(2);
      expect(managed.snapshot()).toMatchObject({ status: "healthy", generation: 2 });
      expect((await lines(input.logPath)).filter((line) => line.startsWith("START "))).toHaveLength(2);
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("isolates a crash, invalidates generation ownership, and restarts with bounded backoff", async () => {
    const input = await fixture();
    const statuses: string[] = [];
    const managed = manager(input, "crash-once", {
      onStatusChange: (snapshot) => statuses.push(snapshot.status),
    });
    try {
      const staleClient = await managed.start();
      await waitFor(() => managed.snapshot().status === "backoff");
      const concurrentRecoveryStart = managed.start();
      await waitFor(() => managed.snapshot().status === "healthy" && managed.snapshot().generation === 2);
      expect((await concurrentRecoveryStart).generation).toBe(2);
      expect(managed.snapshot()).toMatchObject({ status: "healthy", generation: 2, restartAttempts: 1 });
      expect(statuses).toContain("backoff");
      await expect(staleClient.health()).rejects.toMatchObject({ code: "ownership_lost" });
      expect((await lines(input.logPath)).filter((line) => line.startsWith("START "))).toHaveLength(2);
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("opens the circuit after the bounded restart limit", async () => {
    const input = await fixture();
    const managed = manager(input, "always-crash", { maxRestartAttempts: 2 });
    try {
      await managed.start();
      await waitFor(() => managed.snapshot().status === "circuit_open");
      expect(managed.snapshot()).toMatchObject({ circuitOpen: true, restartAttempts: 2, pid: null });
      expect(Number(await readFile(input.countPath, "utf8"))).toBe(3);
      await expect(managed.start()).rejects.toMatchObject({ code: "circuit_open" });
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("cleans the owned worker process tree without leaving an orphan", async () => {
    if (process.platform === "win32") return;
    const input = await fixture();
    const managed = manager(input, "orphan");
    try {
      await managed.start();
      await waitFor(async () => (await lines(input.logPath)).some((line) => line.startsWith("CHILD ")));
      const childLine = (await lines(input.logPath)).find((line) => line.startsWith("CHILD "));
      const childPid = Number(childLine?.split(" ")[1]);
      expect(processExists(childPid)).toBe(true);
      await managed.stop();
      await waitFor(() => !processExists(childPid));
      expect(processExists(childPid)).toBe(false);
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("releases one credential lease and process generation on every repeated restart", async () => {
    const input = await fixture();
    let acquired = 0;
    let released = 0;
    const managed = manager(input, "ready", {
      credentialBroker: {
        readiness: async () => ({ ready: true, reasonCode: "credential_ready" }),
        acquire: async () => {
          acquired += 1;
          let done = false;
          return {
            environment: { ANTHROPIC_API_KEY: "restart-fixture-only" },
            release() {
              if (done) throw new Error("credential lease released twice");
              done = true;
              released += 1;
            },
          };
        },
      },
    });
    try {
      for (let generation = 1; generation <= 6; generation += 1) {
        await managed.start();
        expect(managed.snapshot()).toMatchObject({ status: "healthy", generation, restartAttempts: 0 });
        await managed.stop();
        expect(managed.snapshot()).toMatchObject({ status: "stopped", pid: null });
      }
      expect({ acquired, released }).toEqual({ acquired: 6, released: 6 });
      expect((await lines(input.logPath)).filter((line) => line.startsWith("START "))).toHaveLength(6);
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("joins worker startup and shutdown to the Server lifecycle", async () => {
    const input = await fixture();
    const managed = manager(input, "ready");
    const config = serverConfig(input.root);
    config.workspaces = [{
      id: "workspace-a",
      name: "Workspace",
      path: input.root,
      preset: "starter",
      workspaceType: "local",
    }];
    const server = await startServer(config, { claudeWorkerManager: managed });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect(managed.snapshot().status).toBe("healthy");
      const runtimeResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace-a/agent/v1/runtimes`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      const runtimeBody = await runtimeResponse.text();
      expect(runtimeResponse.ok, runtimeBody).toBe(true);
      const runtimes = JSON.parse(runtimeBody) as { runtimes: Array<{ id: string }> };
      expect(runtimes.runtimes.map(({ id }) => id)).toEqual(["jugglework", "claude-agent"]);
      const diagnosticsResponse = await fetch(`http://127.0.0.1:${server.port}/workspace/workspace-a/agent/v1/support-diagnostics`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      const diagnosticsText = await diagnosticsResponse.text();
      expect(diagnosticsResponse.ok, diagnosticsText).toBe(true);
      expect(JSON.parse(diagnosticsText)).toMatchObject({
        diagnostics: {
          schemaVersion: 1,
          worker: { status: "healthy", starts: 1 },
          query: { active: 0 },
        },
      });
      expect(diagnosticsText).not.toContain(input.root);
      expect(diagnosticsText).not.toContain("fixture-secret");
      expect(diagnosticsText).not.toContain("prompt");
      expect(diagnosticsText).not.toContain("transcript");
      await server.stop();
      expect(managed.snapshot()).toMatchObject({ status: "stopped", pid: null });
    } finally {
      await server.stop();
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });

  test("rolls back Server startup resources when worker readiness fails", async () => {
    const input = await fixture();
    const managed = manager(input, "unready", { readinessTimeoutMs: 100 });
    try {
      await expect(startServer(serverConfig(input.root), { claudeWorkerManager: managed })).rejects.toThrow(
        "readiness timed out",
      );
      expect(managed.snapshot()).toMatchObject({ status: "stopped", pid: null });
    } finally {
      await managed.stop();
      await rm(input.root, { recursive: true, force: true });
    }
  });
});

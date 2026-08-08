import { describe, expect, test } from "bun:test";
import {
  buildWorkerActivityHeartbeatPayload,
  postWorkerActivityHeartbeat,
  resolveWorkerActivityHeartbeatConfig,
  startWorkerActivityHeartbeat,
  type WorkerActivityHeartbeatLogger,
} from "./worker-activity-heartbeat.js";
import type { ServerConfig } from "./types.js";

const enabledEnv = {
  DEN_ACTIVITY_HEARTBEAT_ENABLED: "true",
  DEN_RUNTIME_PROVIDER: "daytona",
  DEN_WORKER_ID: "worker-1",
  DEN_ACTIVITY_HEARTBEAT_URL: "https://den.test/heartbeat",
  DEN_ACTIVITY_HEARTBEAT_TOKEN: "secret-token",
};

const heartbeatConfig = (overrides: Record<string, string | undefined> = {}) =>
  resolveWorkerActivityHeartbeatConfig({ ...enabledEnv, ...overrides });

function serverConfig(): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("Daytona worker activity heartbeat", () => {
  for (const [name, override] of [
    ["enabled flag", { DEN_ACTIVITY_HEARTBEAT_ENABLED: "0" }],
    ["runtime provider", { DEN_RUNTIME_PROVIDER: "docker" }],
    ["worker id", { DEN_WORKER_ID: "" }],
    ["heartbeat URL", { DEN_ACTIVITY_HEARTBEAT_URL: "" }],
    ["heartbeat token", { DEN_ACTIVITY_HEARTBEAT_TOKEN: "" }],
  ] as const) {
    test(`disables when ${name} is absent`, () => {
      expect(heartbeatConfig(override).enabled).toBe(false);
    });
  }

  test("uses the latest session timestamp and five-minute defaults", () => {
    const config = heartbeatConfig();
    const now = Date.UTC(2026, 0, 1);
    expect(config.intervalMs).toBe(5 * 60_000);
    expect(buildWorkerActivityHeartbeatPayload([
      { time: { created: now - 360_000 } },
      { time: { updated: now - 60_000 } },
    ], now, config.activeWindowMs)).toEqual({
      sentAt: "2026-01-01T00:00:00.000Z",
      isActiveRecently: true,
      lastActivityAt: "2025-12-31T23:59:00.000Z",
      openSessionCount: 2,
    });
  });

  test("posts the worker payload with bearer authorization", async () => {
    const requests: Request[] = [];
    await postWorkerActivityHeartbeat({
      config: heartbeatConfig(),
      sessions: [],
      now: () => Date.UTC(2026, 0, 1),
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response("ok");
      },
    });
    expect(requests[0]?.headers.get("Authorization")).toBe("Bearer secret-token");
    expect(await requests[0]?.json()).toEqual({
      sentAt: "2026-01-01T00:00:00.000Z",
      isActiveRecently: false,
      lastActivityAt: null,
      openSessionCount: 0,
    });
  });

  test("logs and contains scheduler failures", async () => {
    let resolveWarning: () => void = () => undefined;
    const warned = new Promise<void>((resolve) => { resolveWarning = resolve; });
    const warnings: string[] = [];
    const logger: WorkerActivityHeartbeatLogger = {
      log(level, message, attributes) {
        if (level !== "warn") return;
        warnings.push(`${message}:${attributes?.error}`);
        resolveWarning();
      },
    };
    const handle = startWorkerActivityHeartbeat(serverConfig(), logger, {
      env: { ...enabledEnv, DEN_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS: "60" },
      listSessions: async () => [],
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    try {
      await Promise.race([warned, Bun.sleep(1000).then(() => { throw new Error("heartbeat timeout"); })]);
    } finally {
      handle?.stop();
    }
    expect(warnings).toEqual(["Worker activity heartbeat failed:heartbeat_failed:503"]);
  });
});

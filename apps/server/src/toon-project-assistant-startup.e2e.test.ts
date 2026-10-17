import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runtimeDbPath } from "./runtime-db.js";
import { startServer, type ServerLogger } from "./server.js";
import { ToonWorkspaceRuntimeStore } from "./toon-factory/workspace-runtime-store.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "toon-assistant-startup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });

  let stalled = true;
  let listRequests = 0;
  const waiters = new Set<() => void>();
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/session") {
        listRequests += 1;
        if (stalled) await new Promise<void>((resolve) => waiters.add(resolve));
        return Response.json([{ id: "session-root", metadata: { visibility: "toon_project_assistant" } }]);
      }
      if (url.pathname === "/session/session-root/message") {
        return Response.json([{
          info: {
            id: "assistant-complete",
            sessionID: "session-root",
            role: "assistant",
            parentID: "message-persisted",
            time: { created: 1, completed: 2 },
          },
          parts: [{ id: "part-complete", type: "text", text: "Recovered" }],
        }]);
      }
      if (url.pathname === "/session/status") return Response.json({ "session-root": { type: "idle" } });
      if (url.pathname === "/permission" || url.pathname === "/question") return Response.json([]);
      return Response.json({ code: "not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => engine.stop(true));

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_client",
    hostToken: "owt_host",
    configPath: join(root, "config.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws-1",
      name: "Workspace",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${engine.port}`,
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };

  const runtime = await ToonWorkspaceRuntimeStore.open(config);
  runtime.createConversation({
    workspaceScope: "ws-1",
    projectId: "project-persisted",
    conversationId: "conversation-persisted",
    sessionId: "session-root",
    title: "Persisted",
    model: { kind: "text", providerID: "provider", modelID: "model" },
  });
  runtime.beginTurn("ws-1", "project-persisted", "conversation-persisted", "turn-persisted", "branch-persisted");
  runtime.saveMessage("ws-1", "project-persisted", {
    id: "message-persisted",
    conversationId: "conversation-persisted",
    turnId: "turn-persisted",
    branchId: "branch-persisted",
    role: "user",
    status: "completed",
    parts: [{ type: "text", text: "Accepted before restart" }],
    attachments: [],
    mentions: [],
    contextDiagnostics: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
  });
  runtime.close();

  return {
    config,
    listRequests: () => listRequests,
    recoverEngine() {
      stalled = false;
      for (const resolve of waiters) resolve();
      waiters.clear();
    },
  };
}

function activeTurnId(config: ServerConfig): string | null {
  const database = new Database(runtimeDbPath(config), { readonly: true });
  try {
    return database.query<{ active_turn_id: string | null }, []>("SELECT active_turn_id FROM toon_workspace_conversation_details WHERE conversation_id='conversation-persisted'").get()?.active_turn_id ?? null;
  } finally {
    database.close();
  }
}

describe("Toon project assistant startup reconciliation", () => {
  test("listens before a stalled initial reconcile and retries persisted state after engine recovery", async () => {
    const fx = await fixture();
    const warnings: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
    const logger: ServerLogger = { log: (_level, message, attributes) => warnings.push({ message, attributes }) };

    const startedAt = Date.now();
    const server = await startServer(fx.config, {
      logger,
      projectAssistantReconciliation: { intervalMs: 20, timeoutMs: 80, shutdownDrainMs: 50 },
    });
    cleanups.push(() => server.stop());

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const health = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(health.status).toBe(200);
    await waitUntil(() => warnings.some((entry) => entry.message === "toon-assistant:reconcile-timeout"));
    expect(warnings.find((entry) => entry.message === "toon-assistant:reconcile-timeout")?.attributes).toEqual({ timeoutMs: 80 });
    expect(activeTurnId(fx.config)).toBe("turn-persisted");

    fx.recoverEngine();
    await waitUntil(() => activeTurnId(fx.config) === null);
    expect(fx.listRequests()).toBeGreaterThanOrEqual(2);
  });

  test("stop aborts a never-responding reconcile and returns within the bounded drain", async () => {
    const fx = await fixture();
    const server = await startServer(fx.config, {
      projectAssistantReconciliation: { intervalMs: 60_000, timeoutMs: 30_000, shutdownDrainMs: 50 },
    });
    await waitUntil(() => fx.listRequests() > 0);

    const stoppedAt = Date.now();
    await server.stop();
    expect(Date.now() - stoppedAt).toBeLessThan(1_000);
    expect(activeTurnId(fx.config)).toBe("turn-persisted");
    fx.recoverEngine();
  });

  test("read-only startup never starts assistant reconciliation", async () => {
    const fx = await fixture();
    fx.config.readOnly = true;
    const server = await startServer(fx.config, {
      projectAssistantReconciliation: { intervalMs: 1, timeoutMs: 20, shutdownDrainMs: 20 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect((await fetch(`http://127.0.0.1:${server.port}/health`)).status).toBe(200);
    expect(fx.listRequests()).toBe(0);
    await server.stop();
    expect(activeTurnId(fx.config)).toBe("turn-persisted");
    fx.recoverEngine();
  });
});

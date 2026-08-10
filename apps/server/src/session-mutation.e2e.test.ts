import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function startMockOpencode() {
  const prompts: Array<{ sessionId: string; body: unknown; directory: string | null }> = [];
  const aborts: string[] = [];
  const commands: Array<{ sessionId: string; body: unknown }> = [];
  const shells: Array<{ sessionId: string; body: unknown }> = [];
  const statusRequests: string[] = [];
  const statuses = new Map<string, unknown>();
  const heldPrompts = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldMessageIds = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldAborts = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldCommands = new Map<string, ReturnType<typeof deferred<void>>>();
  const heldShells = new Map<string, ReturnType<typeof deferred<void>>>();
  const failedPrompts = new Set<string>();
  const failedMessageIds = new Set<string>();
  const failedShells = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/session/status") {
        statusRequests.push(request.headers.get("x-opencode-directory") ?? "");
        return Response.json(Object.fromEntries(statuses));
      }

      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1]!);
        const body = await request.json() as { messageID?: string };
        prompts.push({
          sessionId,
          body,
          directory: request.headers.get("x-opencode-directory"),
        });
        const heldPrompt = (body.messageID === undefined ? undefined : heldMessageIds.get(body.messageID)) ?? heldPrompts.get(sessionId);
        await heldPrompt?.promise;
        if (failedPrompts.delete(sessionId) || (body.messageID !== undefined && failedMessageIds.delete(body.messageID))) {
          return Response.json({ name: "PromptFailure" }, { status: 500 });
        }
        return new Response(null, { status: 204 });
      }

      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      if (request.method === "POST" && abortMatch) {
        const sessionId = decodeURIComponent(abortMatch[1]!);
        aborts.push(sessionId);
        await heldAborts.get(sessionId)?.promise;
        return Response.json(true);
      }

      const commandMatch = url.pathname.match(/^\/session\/([^/]+)\/command$/);
      if (request.method === "POST" && commandMatch) {
        const sessionId = decodeURIComponent(commandMatch[1]!);
        commands.push({ sessionId, body: await request.json() });
        await heldCommands.get(sessionId)?.promise;
        return Response.json({ info: { id: "msg_command" }, parts: [] });
      }

      const shellMatch = url.pathname.match(/^\/session\/([^/]+)\/shell$/);
      if (request.method === "POST" && shellMatch) {
        const sessionId = decodeURIComponent(shellMatch[1]!);
        shells.push({ sessionId, body: await request.json() });
        await heldShells.get(sessionId)?.promise;
        if (failedShells.delete(sessionId)) {
          return Response.json({ name: "ShellFailure" }, { status: 500 });
        }
        return Response.json({ info: { id: "msg_shell" }, parts: [] });
      }

      return Response.json({ code: "not_found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    prompts,
    aborts,
    commands,
    shells,
    statusRequests,
    statuses,
    heldPrompts,
    heldMessageIds,
    heldAborts,
    heldCommands,
    heldShells,
    failedPrompts,
    failedMessageIds,
    failedShells,
  };
}

async function startHarness(enginePort: number) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-session-mutation-"));
  roots.push(root);
  await mkdir(join(root, ".opencode"), { recursive: true });
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_collaborator",
    hostToken: "owt_host",
    configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: `http://127.0.0.1:${enginePort}`,
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return {
    base: `http://127.0.0.1:${server.port}`,
    root,
    collaboratorHeaders: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    hostHeaders: { "X-JuggleWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
  };
}

function runPath(base: string, sessionId: string): string {
  return `${base}/workspace/ws_1/sessions/${sessionId}/runs`;
}

describe("authoritative session mutation APIs", () => {
  test("rejects authoritative engine activity without fabricating a run id", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_busy", { type: "busy" });

    const response = await fetch(`${runPath(harness.base, "ses_busy")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_busy",
        prompt: { parts: [{ type: "text", text: "Must not dispatch" }] },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_busy",
      details: { currentRunId: null },
    });
    expect(engine.prompts).toHaveLength(0);
    expect(engine.statusRequests).toEqual([harness.root]);
  });

  test("parses only the target status and starts when it is idle", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("other_session", { type: "future-invalid-status" });
    engine.statuses.set("ses_idle", { type: "idle" });

    const response = await fetch(`${runPath(harness.base, "ses_idle")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Start idle" }] },
      }),
    });

    expect(response.status).toBe(202);
    expect(engine.prompts).toHaveLength(1);
  });

  test("rejects retry and waiting engine states", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.statuses.set("ses_retry", { type: "retry", attempt: 2, message: "later", next: Date.now() + 1_000 });
    engine.statuses.set("ses_waiting", { type: "waiting" });

    for (const sessionId of ["ses_retry", "ses_waiting"]) {
      const response = await fetch(`${runPath(harness.base, sessionId)}/start`, {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({
          origin: "remote-control",
          startCommandCorrelationId: null,
          prompt: { parts: [{ type: "text", text: "Must wait" }] },
        }),
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "session_busy",
        details: { currentRunId: null },
      });
    }
    expect(engine.prompts).toHaveLength(0);
  });

  test("local and remote starts race atomically, dispatch once, and preserve the full local prompt", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldPrompts.set("ses_race", hold);
    const prompt = {
      messageID: "msg_local",
      model: { providerID: "provider", modelID: "model" },
      agent: "jugglework",
      noReply: false,
      tools: { bash: false, read: true },
      format: { type: "json_schema", schema: { type: "object", properties: { answer: { type: "string" } } }, retryCount: 2 },
      system: "System context",
      variant: "high",
      parts: [{ type: "text", text: "Local payload", metadata: { source: "composer" } }],
      reasoning_effort: "high",
    };

    const localRequest = fetch(`${runPath(harness.base, "ses_race")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "cmd_local", prompt }),
    });
    await waitUntil(() => engine.prompts.length === 1);

    const remoteResponse = await fetch(`${runPath(harness.base, "ses_race")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_remote",
        prompt: { parts: [{ type: "text", text: "Remote text" }] },
      }),
    });
    expect(remoteResponse.status).toBe(409);
    const busy = await remoteResponse.json() as { code: string; details: { currentRunId: string } };
    expect(busy.code).toBe("session_busy");
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(engine.prompts).toHaveLength(1);
    expect(engine.statusRequests).toEqual([harness.root, harness.root]);
    expect(engine.prompts[0]).toEqual({ sessionId: "ses_race", body: prompt, directory: harness.root });

    hold.resolve();
    const localResponse = await localRequest;
    expect(localResponse.status).toBe(202);
    const local = await localResponse.json() as { run: Record<string, unknown> };
    expect(local.run).toMatchObject({
      workspaceId: "ws_1",
      sessionId: "ses_race",
      generation: 1,
      origin: "local-renderer",
      startCommandCorrelationId: "cmd_local",
      abortCommandCorrelationId: null,
      status: "running",
      observedActive: false,
    });
    expect(local.run.runId).not.toBe(local.run.startCommandCorrelationId);
    expect(local.run).toHaveProperty("startedAt");
    expect(local.run).toHaveProperty("updatedAt");
  });

  test("prompt failure rolls back only its exact reservation", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.failedPrompts.add("ses_failure");

    const failed = await fetch(`${runPath(harness.base, "ses_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_failed",
        prompt: { parts: [{ type: "text", text: "Fail once" }] },
      }),
    });
    expect(failed.status).toBe(502);

    const retry = await fetch(`${runPath(harness.base, "ses_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "cmd_retry",
        prompt: { parts: [{ type: "text", text: "Retry" }] },
      }),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      run: { generation: 2, origin: "remote-control", startCommandCorrelationId: "cmd_retry" },
    });
    expect(engine.prompts).toHaveLength(2);
  });

  test("proxied command activity reserves the session while preserving immediate acknowledgement", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldCommands.set("ses_command", hold);

    const commandResponse = await fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_command/command`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ command: "review", arguments: "" }),
    });
    expect(commandResponse.status).toBe(200);
    await expect(commandResponse.json()).resolves.toEqual({ ok: true, accepted: true });
    await waitUntil(() => engine.commands.length === 1);

    const remote = await fetch(`${runPath(harness.base, "ses_command")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Do not overlap command" }] },
      }),
    });
    expect(remote.status).toBe(409);
    const busy = await remote.json() as { details: { currentRunId: string | null } };
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(engine.prompts).toHaveLength(0);

    hold.resolve();
    await waitUntil(async () => {
      const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
      return ((await active.json()) as { items: unknown[] }).items.length === 0;
    });
  });

  test("proxied shell activity reserves the session and preserves the upstream response", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldShells.set("ses_shell", hold);

    const shellRequest = fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_shell/shell`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ agent: "build", command: "pwd" }),
    });
    await waitUntil(() => engine.shells.length === 1);

    const remote = await fetch(`${runPath(harness.base, "ses_shell")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Do not overlap shell" }] },
      }),
    });
    expect(remote.status).toBe(409);
    const busy = await remote.json() as { details: { currentRunId: string | null } };
    expect(busy.details.currentRunId).toMatch(/^[0-9a-f-]{36}$/i);

    hold.resolve();
    const shellResponse = await shellRequest;
    expect(shellResponse.status).toBe(200);
    await expect(shellResponse.json()).resolves.toEqual({ info: { id: "msg_shell" }, parts: [] });
    expect(engine.prompts).toHaveLength(0);
  });

  test("proxied execution failure releases its exact reservation", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    engine.failedShells.add("ses_shell_failure");

    const failedShell = await fetch(`${harness.base}/workspace/ws_1/opencode/session/ses_shell_failure/shell`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ agent: "build", command: "exit 1" }),
    });
    expect(failedShell.status).toBe(500);

    const remote = await fetch(`${runPath(harness.base, "ses_shell_failure")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: null,
        prompt: { parts: [{ type: "text", text: "Retry after shell failure" }] },
      }),
    });
    expect(remote.status).toBe(202);
    expect(engine.prompts).toHaveLength(1);
  });

  test("a stale prompt failure cannot roll back a replacement run", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const hold = deferred<void>();
    engine.heldMessageIds.set("msg_first", hold);
    engine.failedMessageIds.add("msg_first");
    const firstRequest = fetch(`${runPath(harness.base, "ses_rollback")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_first",
        prompt: { messageID: "msg_first", parts: [{ type: "text", text: "First" }] },
      }),
    });
    await waitUntil(() => engine.prompts.length === 1);
    const listed = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    const firstRunId = ((await listed.json()) as { items: Array<{ runId: string }> }).items[0]!.runId;
    await fetch(`${runPath(harness.base, "ses_rollback")}/${firstRunId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "failed" }),
    });

    const replacement = await fetch(`${runPath(harness.base, "ses_rollback")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "local-renderer",
        startCommandCorrelationId: "cmd_replacement",
        prompt: { messageID: "msg_replacement", parts: [{ type: "text", text: "Replacement" }] },
      }),
    });
    hold.resolve();
    const replacementRun = (await replacement.json() as { run: { runId: string } }).run;
    expect((await firstRequest).status).toBe(502);

    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({ items: [{ runId: replacementRun.runId }] });
  });

  test("delayed abort remains active until accepted and an exact idle observation clears it", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const started = await fetch(`${runPath(harness.base, "ses_abort")}/start`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "command_start",
        prompt: { parts: [{ type: "text", text: "Run" }] },
      }),
    });
    const { run } = await started.json() as { run: { runId: string } };
    const hold = deferred<void>();
    engine.heldAborts.set("ses_abort", hold);
    const abortRequest = fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/abort`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ abortCommandCorrelationId: "command_abort" }),
    });
    await waitUntil(() => engine.aborts.length === 1);

    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({
      items: [{
        runId: run.runId,
        status: "aborting",
        startCommandCorrelationId: "command_start",
        abortCommandCorrelationId: "command_abort",
      }],
    });
    const earlyIdle = await fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(earlyIdle.json()).resolves.toMatchObject({ cleared: false, run: { status: "aborting" } });

    hold.resolve();
    expect((await abortRequest).status).toBe(202);
    const acceptedIdle = await fetch(`${runPath(harness.base, "ses_abort")}/${run.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(acceptedIdle.json()).resolves.toEqual({ cleared: true, run: null, terminalStatus: "aborted" });
  });

  test("idle and stale observations are fenced, while exact terminals clear", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const start = async (command: string) => {
      const response = await fetch(`${runPath(harness.base, "ses_fence")}/start`, {
        method: "POST",
        headers: harness.collaboratorHeaders,
        body: JSON.stringify({
          origin: "local-renderer",
          startCommandCorrelationId: command,
          prompt: { parts: [{ type: "text", text: command }] },
        }),
      });
      return (await response.json() as { run: { runId: string } }).run;
    };
    const first = await start("cmd_first");
    const prematureIdle = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "idle" }),
    });
    await expect(prematureIdle.json()).resolves.toMatchObject({ cleared: false, run: { observedActive: false } });

    const terminal = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "completed" }),
    });
    await expect(terminal.json()).resolves.toEqual({ cleared: true, run: null, terminalStatus: "completed" });
    const second = await start("cmd_second");

    const stale = await fetch(`${runPath(harness.base, "ses_fence")}/${first.runId}/observations`, {
      method: "POST",
      headers: harness.collaboratorHeaders,
      body: JSON.stringify({ status: "failed" }),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ code: "run_mismatch", details: { currentRunId: second.runId } });
    const active = await fetch(`${harness.base}/workspace/ws_1/session-runs`, { headers: harness.collaboratorHeaders });
    await expect(active.json()).resolves.toMatchObject({ items: [{ runId: second.runId }] });
  });

  test("semantic mutation and active-state APIs require collaborator scope", async () => {
    const engine = startMockOpencode();
    const harness = await startHarness(engine.server.port);
    const issued = await fetch(`${harness.base}/tokens`, {
      method: "POST",
      headers: harness.hostHeaders,
      body: JSON.stringify({ scope: "viewer", label: "test viewer" }),
    });
    const viewer = await issued.json() as { token: string };
    const response = await fetch(`${harness.base}/workspace/ws_1/session-runs`, {
      headers: { Authorization: `Bearer ${viewer.token}` },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    const start = await fetch(`${runPath(harness.base, "ses_forbidden")}/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(start.status).toBe(403);
    expect(engine.prompts).toHaveLength(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function startMockOpenCode() {
  const now = Date.now();
  const sessions = new Map<string, Record<string, unknown>>();
  const prompts: Array<{ sessionId: string; body: unknown }> = [];
  const v2Prompts: Array<{ sessionId: string; body: unknown }> = [];
  const aborts: string[] = [];
  const commands: Array<{ sessionId: string; body: unknown }> = [];
  const permissionReplies: Array<{ id: string; body: unknown }> = [];
  const questionReplies: Array<{ id: string; body: unknown }> = [];
  const statuses = new Map<string, Record<string, unknown>>();
  let nextSession = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)$/);
      const messagesMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
      const todoMatch = url.pathname.match(/^\/session\/([^/]+)\/todo$/);
      const promptMatch = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/);
      const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
      const commandMatch = url.pathname.match(/^\/session\/([^/]+)\/command$/);
      const v2PromptMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/prompt$/);
      const v2PermissionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/permission$/);
      const v2QuestionMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/question$/);

      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json({
          all: [{ id: "provider-a", models: { "model-a": { id: "model-a", name: "Model A", capabilities: { toolcall: true } } } }],
          default: { "provider-a": "model-a" },
          connected: ["provider-a"],
        });
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        return Response.json(Object.fromEntries(statuses));
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await request.json() as { title?: string };
        const id = `backend-${++nextSession}`;
        const session = { id, title: body.title ?? "Untitled", directory: request.headers.get("x-opencode-directory"), time: { created: now, updated: now } };
        sessions.set(id, session);
        statuses.set(id, { type: "idle" });
        return Response.json(session);
      }
      if (request.method === "GET" && url.pathname === "/session") return Response.json([...sessions.values()]);
      if (request.method === "GET" && sessionMatch) {
        const session = sessions.get(decodeURIComponent(sessionMatch[1]!));
        return session ? Response.json(session) : Response.json({ name: "NotFound" }, { status: 404 });
      }
      if (request.method === "PATCH" && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1]!);
        const existing = sessions.get(sessionId);
        if (!existing) return Response.json({ name: "NotFound" }, { status: 404 });
        const body = await request.json() as { title: string };
        const updated = { ...existing, title: body.title, time: { created: now, updated: now + 1 } };
        sessions.set(sessionId, updated);
        return Response.json(updated);
      }
      const forkMatch = url.pathname.match(/^\/session\/([^/]+)\/fork$/);
      if (request.method === "POST" && forkMatch) {
        const source = sessions.get(decodeURIComponent(forkMatch[1]!));
        if (!source) return Response.json({ name: "NotFound" }, { status: 404 });
        const id = `backend-${++nextSession}`;
        const forked = { ...source, id, title: `${source.title} (fork)`, time: { created: now + 1, updated: now + 1 } };
        sessions.set(id, forked);
        statuses.set(id, { type: "idle" });
        return Response.json(forked);
      }
      if (request.method === "GET" && messagesMatch) {
        const sessionId = decodeURIComponent(messagesMatch[1]!);
        return Response.json([{
          info: { id: "message-user", sessionID: sessionId, role: "user", time: { created: now, completed: now } },
          parts: [{ id: "part-user", messageID: "message-user", sessionID: sessionId, type: "text", text: "hello", time: { start: now, end: now } }],
        }]);
      }
      if (request.method === "GET" && todoMatch) return Response.json([]);
      if (request.method === "GET" && url.pathname === "/permission") {
        const backendId = [...sessions.keys()][0];
        return Response.json(backendId ? [{ id: "permission-one", sessionID: backendId, permission: "read", patterns: ["README.md"], metadata: {} }] : []);
      }
      if (request.method === "GET" && url.pathname === "/question") {
        const backendId = [...sessions.keys()][0];
        return Response.json(backendId ? [{
          id: "question-one",
          sessionID: backendId,
          questions: [{ id: "continue", question: "Continue?", options: [{ label: "Yes" }], multiple: false, custom: false }],
        }] : []);
      }
      if (request.method === "GET" && v2PermissionMatch) return Response.json({ data: [] });
      if (request.method === "GET" && v2QuestionMatch) return Response.json({ data: [] });
      if (request.method === "POST" && promptMatch) {
        const sessionId = decodeURIComponent(promptMatch[1]!);
        prompts.push({ sessionId, body: await request.json() });
        statuses.set(sessionId, { type: "busy" });
        return new Response(null, { status: 204 });
      }
      if (request.method === "POST" && v2PromptMatch) {
        const sessionId = decodeURIComponent(v2PromptMatch[1]!);
        const body = await request.json() as { id: string; delivery: string; prompt: unknown };
        v2Prompts.push({ sessionId, body });
        return Response.json({ data: { id: body.id, sessionID: sessionId, delivery: body.delivery, prompt: body.prompt } });
      }
      if (request.method === "POST" && abortMatch) {
        const sessionId = decodeURIComponent(abortMatch[1]!);
        aborts.push(sessionId);
        statuses.set(sessionId, { type: "idle" });
        return Response.json(true);
      }
      if (request.method === "POST" && commandMatch) {
        commands.push({ sessionId: decodeURIComponent(commandMatch[1]!), body: await request.json() });
        return Response.json({ info: { id: "message-command" }, parts: [] });
      }
      const permissionReply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permissionReply) {
        permissionReplies.push({ id: decodeURIComponent(permissionReply[1]!), body: await request.json() });
        return Response.json(true);
      }
      const questionReply = url.pathname.match(/^\/question\/([^/]+)\/reply$/);
      if (request.method === "POST" && questionReply) {
        questionReplies.push({ id: decodeURIComponent(questionReply[1]!), body: await request.json() });
        return Response.json(true);
      }
      if (request.method === "POST" && url.pathname === "/instance/dispose") return Response.json(true);
      return Response.json({ code: "not_found", path: url.pathname }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, sessions, statuses, prompts, v2Prompts, aborts, commands, permissionReplies, questionReplies };
}

async function startHarness(enginePort: number) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-agent-runtime-routes-"));
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
    workspaces: [{ id: "ws_1", name: "Workspace", path: root, preset: "starter", workspaceType: "local", baseUrl: `http://127.0.0.1:${enginePort}` }],
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
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const enabled = await fetch(`http://127.0.0.1:${server.port}/remote-control/pending/enable`, {
    method: "POST",
    headers,
    body: JSON.stringify({ enabled: true, steer: true, enqueue: true }),
  });
  if (!enabled.ok) throw new Error("Failed to enable pending operation fixture");
  return {
    base: `http://127.0.0.1:${server.port}`,
    headers,
    hostHeaders: { "X-JuggleWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
  };
}

describe("canonical agent runtime routes", () => {
  test("discovers runtimes, persists immutable sessions, dispatches runs/interactions, and reconciles cursor events", async () => {
    const engine = startMockOpenCode();
    const harness = await startHarness(engine.server.port);
    const prefix = `${harness.base}/workspace/ws_1/agent/v1`;

    const runtimes = await json(await fetch(`${prefix}/runtimes`, { headers: harness.headers }));
    expect(runtimes.runtimes).toEqual([
      expect.objectContaining({ id: "jugglework", isDefault: true, health: { status: "healthy", checkedAt: expect.any(Number), reasonCode: null, message: null } }),
      expect.objectContaining({ id: "claude-agent", isDefault: false, health: expect.objectContaining({ status: "disabled", reasonCode: "feature_disabled" }) }),
    ]);
    await expect(json(await fetch(`${prefix}/runtimes/jugglework/health`, { headers: harness.headers })))
      .resolves.toMatchObject({ health: { status: "healthy" } });
    await expect(json(await fetch(`${prefix}/runtimes/jugglework/models`, { headers: harness.headers })))
      .resolves.toMatchObject({ items: [{ id: "model-a", providerId: "provider-a", isDefault: true }] });

    const createdResponse = await fetch(`${prefix}/sessions`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ title: "Canonical", configuration: { agentProfile: "jugglework" } }),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await json(createdResponse)).session as { id: string; backendSessionId: string; runtimeId: string; configuration: object };
    expect(created).toMatchObject({ runtimeId: "jugglework", backendSessionId: "backend-1", configuration: { agentProfile: "jugglework" } });
    expect(created.id).not.toBe(created.backendSessionId);

    const invalidConfiguration = await fetch(`${prefix}/sessions`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        title: "Invalid",
        configuration: { model: { providerId: "provider-a", modelId: "missing" } },
      }),
    });
    expect(invalidConfiguration.status).toBe(422);
    await expect(json(invalidConfiguration)).resolves.toMatchObject({
      code: "runtime_configuration_invalid",
      details: { issueCode: "model_unavailable", field: "model" },
    });

    await expect(json(await fetch(`${prefix}/sessions/${created.id}`, { headers: harness.headers })))
      .resolves.toMatchObject({ session: { id: created.id, runtimeId: "jugglework", backendSessionId: "backend-1" } });
    const renamed = await fetch(`${prefix}/sessions/${created.id}`, {
      method: "PATCH",
      headers: harness.headers,
      body: JSON.stringify({ title: "Canonical renamed" }),
    });
    expect(renamed.status).toBe(200);
    await expect(json(renamed)).resolves.toMatchObject({ session: { id: created.id, title: "Canonical renamed" } });
    const forked = await fetch(`${prefix}/sessions/${created.id}/fork`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ title: "Canonical fork" }),
    });
    expect(forked.status).toBe(201);
    await expect(json(forked)).resolves.toMatchObject({ fork: {
      session: { runtimeId: "jugglework", title: "Canonical fork", backendSessionId: "backend-2" },
      filesystemState: { sharedWorkingTree: true, filesRewound: false },
    } });
    const snapshot = await json(await fetch(`${prefix}/sessions/${created.id}/snapshot`, { headers: harness.headers }));
    expect(snapshot.snapshot).toMatchObject({
      session: { id: created.id, runtimeId: "jugglework" },
      messages: [{ id: "message-user", sessionId: created.id, parts: [{ id: "part-user", sessionId: created.id, text: "hello" }] }],
      interactions: expect.arrayContaining([expect.objectContaining({ id: "permission-one", sessionId: created.id, kind: "permission" })]),
    });

    const unavailableContinuation = await fetch(`${prefix}/sessions/${created.id}/continuations/preview`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ targetRuntimeId: "claude-agent" }),
    });
    expect(unavailableContinuation.status).toBe(503);
    await expect(json(unavailableContinuation)).resolves.toMatchObject({ code: "runtime_unavailable" });
    await expect(json(await fetch(`${prefix}/sessions/${created.id}/links`, { headers: harness.headers })))
      .resolves.toMatchObject({ items: [expect.objectContaining({ sourceSessionId: created.id, type: "fork" })] });
    await expect(json(await fetch(`${prefix}/snapshots`, { headers: harness.headers }))).resolves.toMatchObject({
      items: expect.arrayContaining([expect.objectContaining({ session: expect.objectContaining({ id: created.id }) })]),
    });

    const baseline = await json(await fetch(`${prefix}/events?stream=false`, { headers: harness.headers }));
    expect(baseline.requiresSnapshot).toBe(false);
    expect(baseline.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({
      session: expect.objectContaining({ id: created.id }),
    })]));
    const streamController = new AbortController();
    const stream = await fetch(`${prefix}/events`, { headers: harness.headers, signal: streamController.signal });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    const firstFrame = new TextDecoder().decode((await reader.read()).value);
    expect(firstFrame).toContain("event: snapshot");
    expect(firstFrame).toContain(created.id);
    streamController.abort();
    await reader.cancel().catch(() => undefined);

    const startedResponse = await fetch(`${prefix}/sessions/${created.id}/runs`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "command-one", prompt: { parts: [{ type: "text", text: "Run" }] } }),
    });
    expect(startedResponse.status).toBe(202);
    const started = await json(startedResponse);
    expect(started).toMatchObject({ disposition: "started", run: { sessionId: created.id, status: "running" } });
    expect(engine.prompts).toEqual([{ sessionId: "backend-1", body: { agent: "jugglework", parts: [{ type: "text", text: "Run" }] } }]);

    const activeContinuation = await fetch(`${prefix}/sessions/${created.id}/continuations/preview`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ targetRuntimeId: "claude-agent" }),
    });
    expect(activeContinuation.status).toBe(409);
    await expect(json(activeContinuation)).resolves.toMatchObject({ code: "agent_continuation_source_busy" });
    await expect(json(await fetch(`${prefix}/sessions/${created.id}/runs/active`, { headers: harness.headers }))).resolves.toMatchObject({
      run: { runId: started.run.runId, sessionId: created.id, status: "running" },
    });

    const steeredResponse = await fetch(`${prefix}/sessions/${created.id}/runs`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "steer-command",
        whenBusy: "steer",
        prompt: { parts: [{ type: "text", text: "Change direction" }] },
      }),
    });
    expect(steeredResponse.status).toBe(202);
    const steered = await json(steeredResponse);
    expect(steered).toMatchObject({ disposition: "enqueued", position: 1, pendingOperationId: expect.any(String) });
    await waitUntil(() => engine.v2Prompts.length === 1);
    expect(engine.v2Prompts).toEqual([{
      sessionId: "backend-1",
      body: { id: steered.pendingOperationId, delivery: "steer", prompt: { text: "Change direction" } },
    }]);

    const enqueuedResponse = await fetch(`${prefix}/sessions/${created.id}/runs`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "enqueue-command",
        whenBusy: "enqueue",
        prompt: { parts: [{ type: "text", text: "Run later" }] },
      }),
    });
    expect(enqueuedResponse.status).toBe(202);
    const enqueued = await json(enqueuedResponse);
    const enqueuedId = enqueued.pendingOperationId as string;
    expect(enqueued).toMatchObject({ disposition: "enqueued", position: 1, pendingOperationId: expect.any(String) });
    await expect(json(await fetch(`${prefix}/sessions/${created.id}/pending`, { headers: harness.headers }))).resolves.toMatchObject({
      items: [expect.objectContaining({ id: enqueuedId, mode: "enqueue", status: "pending" })],
    });
    const cancelled = await fetch(`${prefix}/sessions/${created.id}/pending/${enqueuedId}/cancel`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ commandCorrelationId: "cancel-enqueue-command" }),
    });
    const cancelledBody = await json(cancelled);
    expect({ status: cancelled.status, body: cancelledBody }).toEqual({
      status: 200,
      body: { pendingOperationId: enqueuedId, status: "cancelled" },
    });

    const delta = await json(await fetch(`${prefix}/events?stream=false&cursor=${encodeURIComponent(baseline.cursorToken as string)}`, { headers: harness.headers }));
    expect(delta.events).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: created.id, data: { type: "session.status", status: { type: "running" } } })]));
    const resumeController = new AbortController();
    const resumed = await fetch(`${prefix}/events`, {
      headers: { ...harness.headers, "Last-Event-ID": baseline.cursorToken as string },
      signal: resumeController.signal,
    });
    const resumedReader = resumed.body!.getReader();
    const resumedFrame = new TextDecoder().decode((await resumedReader.read()).value);
    expect(resumedFrame).toContain("event: event");
    expect(resumedFrame).not.toContain("event: snapshot");
    expect(resumedFrame).toContain('"type":"session.status"');
    resumeController.abort();
    await resumedReader.cancel().catch(() => undefined);
    const staleCursor = Buffer.from(JSON.stringify({ [created.id]: 999 }), "utf8").toString("base64url");
    const stale = await json(await fetch(`${prefix}/events?stream=false&cursor=${staleCursor}`, { headers: harness.headers }));
    expect(stale).toMatchObject({ requiresSnapshot: true, events: [] });
    expect(stale.snapshots).toEqual(expect.arrayContaining([expect.objectContaining({
      session: expect.objectContaining({ id: created.id }),
    })]));

    const permissionResponse = await fetch(`${prefix}/sessions/${created.id}/interactions/permission-one/resolve`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: "permission-command", resolution: { outcome: "allow" } }),
    });
    expect(permissionResponse.status).toBe(200);
    expect(engine.permissionReplies).toEqual([{ id: "permission-one", body: { reply: "once" } }]);
    const duplicate = await fetch(`${prefix}/sessions/${created.id}/interactions/permission-one/resolve`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "duplicate", resolution: { outcome: "deny", reason: "No" } }),
    });
    expect(duplicate.status).toBe(409);
    expect(engine.permissionReplies).toHaveLength(1);

    const aborted = await fetch(`${prefix}/sessions/${created.id}/runs/${started.run.runId}/abort`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ abortCommandCorrelationId: "abort-one" }),
    });
    expect(aborted.status).toBe(202);
    expect(engine.aborts).toEqual(["backend-1"]);
  });

  test("keeps default runtime canonical flows and mounted provider integration while rejecting removed session paths", async () => {
    const engine = startMockOpenCode();
    const harness = await startHarness(engine.server.port);

    const legacyCreate = await fetch(`${harness.base}/workspace/ws_1/sessions`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ title: "Legacy" }),
    });
    expect(legacyCreate.status).toBe(201);
    await expect(json(legacyCreate)).resolves.toMatchObject({ item: { id: "backend-1", title: "Legacy" }, started: false });
    await expect(json(await fetch(`${harness.base}/workspace/ws_1/sessions`, { headers: harness.headers })))
      .resolves.toMatchObject({ items: [{ id: "backend-1", title: "Legacy" }] });

    const mountedModels = await fetch(`${harness.base}/workspace/ws_1/opencode/provider`, { headers: harness.headers });
    expect(mountedModels.status).toBe(200);
    await expect(json(mountedModels)).resolves.toMatchObject({ all: [{ id: "provider-a" }] });

    for (const path of [
      "/workspace/ws_1/opencode/session/backend-1/command",
      "/workspace/ws_1/opencode/event",
      "/workspace/ws_1/opencode/permission",
      "/workspace/ws_1/opencode/question",
      "/workspace/ws_1/opencode/global/event",
    ]) {
      const response = await fetch(`${harness.base}${path}`, { headers: harness.headers });
      expect(response.status).toBe(404);
      await expect(json(response)).resolves.toMatchObject({ code: "not_found" });
    }
    expect(engine.commands).toEqual([]);
  });

  test("allows viewer canonical reads and rejects create, run, enqueue, abort, and interaction mutations", async () => {
    const engine = startMockOpenCode();
    const harness = await startHarness(engine.server.port);
    const prefix = `${harness.base}/workspace/ws_1/agent/v1`;
    const createdResponse = await fetch(`${prefix}/sessions`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ title: "Remote policy", runtimeId: "jugglework" }),
    });
    const created = (await json(createdResponse)).session as { id: string };
    const started = await json(await fetch(`${prefix}/sessions/${created.id}/runs`, {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "remote-control",
        startCommandCorrelationId: "collaborator-start",
        prompt: { parts: [{ type: "text", text: "Run" }] },
      }),
    }));

    const issued = await fetch(`${harness.base}/tokens`, {
      method: "POST",
      headers: harness.hostHeaders,
      body: JSON.stringify({ scope: "viewer", label: "canonical remote viewer" }),
    });
    const viewer = await json(issued) as { token: string };
    const viewerHeaders = { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" };

    for (const path of [
      `${prefix}/sessions`,
      `${prefix}/sessions/${created.id}`,
      `${prefix}/sessions/${created.id}/snapshot`,
      `${prefix}/sessions/${created.id}/pending`,
      `${prefix}/sessions/${created.id}/runs/active`,
      `${prefix}/runs/active`,
    ]) {
      const response = await fetch(path, { headers: viewerHeaders });
      expect(response.status).toBe(200);
    }

    const mutations = [
      fetch(`${prefix}/sessions`, {
        method: "POST", headers: viewerHeaders, body: JSON.stringify({ title: "Denied", runtimeId: "jugglework" }),
      }),
      fetch(`${prefix}/sessions/${created.id}/runs`, {
        method: "POST", headers: viewerHeaders,
        body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "viewer-run", prompt: { parts: [{ type: "text", text: "Denied" }] } }),
      }),
      fetch(`${prefix}/sessions/${created.id}/runs`, {
        method: "POST", headers: viewerHeaders,
        body: JSON.stringify({ origin: "remote-control", startCommandCorrelationId: "viewer-enqueue", whenBusy: "enqueue", prompt: { parts: [{ type: "text", text: "Denied" }] } }),
      }),
      fetch(`${prefix}/sessions/${created.id}/runs/${started.run.runId}/abort`, {
        method: "POST", headers: viewerHeaders, body: JSON.stringify({ abortCommandCorrelationId: "viewer-abort" }),
      }),
      fetch(`${prefix}/sessions/${created.id}/interactions/permission-one/resolve`, {
        method: "POST", headers: viewerHeaders,
        body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "viewer-interaction", resolution: { outcome: "deny", reason: "Denied" } }),
      }),
    ];
    for (const request of mutations) {
      const response = await request;
      expect(response.status).toBe(403);
      await expect(json(response)).resolves.toMatchObject({ code: "forbidden" });
    }
    expect(engine.prompts).toHaveLength(1);
    expect(engine.permissionReplies).toHaveLength(0);
  });
});

async function json(response: Response): Promise<Record<string, any>> {
  return response.json() as Promise<Record<string, any>>;
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

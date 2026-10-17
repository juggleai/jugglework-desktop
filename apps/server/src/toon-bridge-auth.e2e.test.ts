import { createHash } from "node:crypto";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { requireManagedToonBridgeCredential, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

test("real server scopes one managed engine bridge credential to its current local workspaces and exact assistant calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "toon-bridge-auth-"));
  const otherRoot = await mkdtemp(join(tmpdir(), "toon-bridge-auth-other-"));
  const addedRoot = await mkdtemp(join(tmpdir(), "toon-bridge-auth-added-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  cleanups.push(async () => {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
    await rm(addedRoot, { recursive: true, force: true });
  });

  const sessions = new Map<string, Record<string, any>>();
  const messages = new Map<string, any[]>();
  const engine = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/provider") {
        return Response.json({ connected: ["provider"], all: [{ id: "provider", models: { text: { id: "text", capabilities: { output: { text: true } } } } }] });
      }
      if (request.method === "GET" && url.pathname === "/experimental/tool/ids") return Response.json(["toon_workspace_bridge"]);
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await request.json() as Record<string, any>;
        const id = `session-${sessions.size + 1}`;
        const session = { id, title: body.title, metadata: body.metadata, permission: body.permission };
        sessions.set(id, session);
        messages.set(id, []);
        return Response.json(session);
      }
      const sessionId = url.pathname.match(/^\/session\/([^/]+)$/)?.[1];
      if (request.method === "GET" && sessionId) {
        const session = sessions.get(decodeURIComponent(sessionId));
        return session ? Response.json(session) : Response.json({ code: "not_found" }, { status: 404 });
      }
      const messageSessionId = url.pathname.match(/^\/session\/([^/]+)\/message$/)?.[1];
      if (request.method === "GET" && messageSessionId) return Response.json(messages.get(decodeURIComponent(messageSessionId)) ?? []);
      const promptSessionId = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)?.[1];
      if (request.method === "POST" && promptSessionId) return new Response(null, { status: 204 });
      return Response.json({});
    },
  });
  cleanups.push(() => engine.stop(true));
  const engineUrl = `http://127.0.0.1:${engine.port}`;

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "collaborator-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Primary", path: root, preset: "starter", workspaceType: "local", baseUrl: engineUrl, directory: root },
      { id: "ws_2", name: "Other", path: otherRoot, preset: "starter", workspaceType: "local", baseUrl: engineUrl, directory: otherRoot },
    ],
    opencodeBaseUrl: engineUrl,
    authorizedRoots: [root, otherRoot],
    readOnly: false,
    managedRuntime: true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  cleanups.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const clientHeaders = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
  const bridge = requireManagedToonBridgeCredential(config);
  expect(bridge.token).not.toBe(config.token);
  expect(bridge.token).not.toBe(config.hostToken);
  const bridgeHeaders = { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" };
  const hostHeaders = { "X-JuggleWork-Host-Token": config.hostToken, "Content-Type": "application/json" };

  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`
      : JSON.stringify(value);
  const prepareBridgeCall = async (workspaceId: string, suffix: string) => {
    const policyContent = { workspaceId, signedIn: false, policyFresh: true, organizationId: null, userId: null, allowedModels: [], validatedAt: null };
    const policyResponse = await fetch(`${base}/experimental/toon-factory/model-policy`, {
      method: "PUT",
      headers: hostHeaders,
      body: JSON.stringify({ ...policyContent, revision: 1, digest: createHash("sha256").update(canonical(policyContent)).digest("hex") }),
    });
    expect(policyResponse.status).toBe(200);
    const operationId = `bridge-init-${suffix}`;
    const initialize = await fetch(`${base}/workspace/${workspaceId}/toon-factory/v2/projects/initialize`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ operationId, name: `Bridge ${suffix}`, directory: `project-${suffix}`, episodeId: "episode-1" }),
    });
    expect(initialize.status).toBe(201);
    const projectId = `toon-${operationId}`;
    const createdResponse = await fetch(`${base}/workspace/${workspaceId}/toon-factory/v2/projects/${projectId}/assistant/conversations`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ model: { kind: "text", providerID: "provider", modelID: "text" } }),
    });
    if (createdResponse.status !== 201) throw new Error(`Conversation create failed: ${createdResponse.status} ${await createdResponse.text()}`);
    const created = await createdResponse.json() as { item: { id: string } };
    const session = [...sessions.values()].find((candidate) => candidate.metadata?.workspaceId === workspaceId && candidate.metadata?.projectId === projectId);
    if (!session) throw new Error(`Missing OpenCode session for ${workspaceId}/${projectId}`);
    const sessionId = session.id as string;
    const sent = await fetch(`${base}/workspace/${workspaceId}/toon-factory/v2/projects/${projectId}/assistant/conversations/${created.item.id}/messages`, {
      method: "POST",
      headers: clientHeaders,
      body: JSON.stringify({ turnId: `turn-${suffix}`, messageId: `message-${suffix}`, text: "Read the project", model: { kind: "text", providerID: "provider", modelID: "text" } }),
    });
    expect(sent.status).toBe(202);
    const call = { action: "project.read" };
    const toolCallId = `call-${suffix}`;
    messages.get(sessionId)!.push({
      info: { id: `assistant-${suffix}`, sessionID: sessionId, role: "assistant", time: { created: 1 } },
      parts: [{ id: `part-${suffix}`, type: "tool", callID: toolCallId, tool: "toon_workspace_bridge", state: { input: call } }],
    });
    return { workspaceId, projectId, session, body: { workspaceId, sessionId, toolCallId, call } };
  };
  const invokeBridge = (body: Record<string, unknown>) => fetch(`${base}/experimental/toon-factory/assistant-bridge`, { method: "POST", headers: bridgeHeaders, body: JSON.stringify(body) });

  const primary = await prepareBridgeCall("ws_1", "primary");
  const secondary = await prepareBridgeCall("ws_2", "secondary");
  for (const prepared of [primary, secondary]) {
    const accepted = await invokeBridge(prepared.body);
    expect(accepted.status).toBe(200);
    const payload = await accepted.json();
    expect(payload).toMatchObject({ item: { kind: "project.read", project: { metadata: { id: prepared.projectId } } } });
    expect(JSON.stringify(payload)).not.toContain(bridge.token);
  }

  const hostAccepted = await fetch(`${base}/experimental/toon-factory/assistant-bridge`, {
    method: "POST",
    headers: hostHeaders,
    body: JSON.stringify(primary.body),
  });
  expect(hostAccepted.status).toBe(200);

  const collaborator = await fetch(`${base}/experimental/toon-factory/assistant-bridge`, { method: "POST", headers: clientHeaders, body: JSON.stringify(primary.body) });
  expect(collaborator.status).toBe(401);

  const unconfigured = await invokeBridge({ ...primary.body, workspaceId: "ws_unconfigured" });
  expect(unconfigured.status).toBe(403);
  expect(await unconfigured.json()).toMatchObject({ code: "toon_assistant_bridge_scope_mismatch" });

  const crossWorkspaceSession = await invokeBridge({ ...primary.body, workspaceId: "ws_2" });
  expect(crossWorkspaceSession.status).toBe(404);
  expect(await crossWorkspaceSession.json()).toMatchObject({ code: "toon_conversation_not_found" });

  primary.session.metadata.workspaceId = "ws_2";
  const crossWorkspaceMetadata = await invokeBridge(primary.body);
  expect(crossWorkspaceMetadata.status).toBe(403);
  expect(await crossWorkspaceMetadata.json()).toMatchObject({ code: "toon_assistant_session_scope_invalid" });
  primary.session.metadata.workspaceId = "ws_1";
  primary.session.metadata.projectId = secondary.projectId;
  const crossProjectMetadata = await invokeBridge(primary.body);
  expect(crossProjectMetadata.status).toBe(403);
  expect(await crossProjectMetadata.json()).toMatchObject({ code: "toon_assistant_session_scope_invalid" });
  primary.session.metadata.projectId = primary.projectId;

  const forgedCallId = await invokeBridge({ ...primary.body, toolCallId: "call-forged" });
  expect(forgedCallId.status).toBe(403);
  expect(await forgedCallId.json()).toMatchObject({ code: "toon_assistant_tool_call_unverified" });
  const forgedInput = await invokeBridge({ ...primary.body, call: { action: "canvas.read", canvasId: "main" } });
  expect(forgedInput.status).toBe(403);
  expect(await forgedInput.json()).toMatchObject({ code: "toon_assistant_tool_call_unverified" });

  sessions.set("ordinary-session", { id: "ordinary-session", metadata: { visibility: "normal" } });
  const ordinary = await fetch(`${base}/experimental/toon-factory/assistant-bridge`, {
    method: "POST",
    headers: bridgeHeaders,
    body: JSON.stringify({ ...primary.body, sessionId: "ordinary-session" }),
  });
  expect(ordinary.status).toBe(404);

  const remoteCreate = await fetch(`${base}/workspaces/remote`, {
    method: "POST",
    headers: hostHeaders,
    body: JSON.stringify({ baseUrl: engineUrl, remoteType: "opencode", directory: "/remote-project" }),
  });
  expect(remoteCreate.status).toBe(201);
  const remoteId = (await remoteCreate.json() as { activeId: string }).activeId;
  const remoteBridge = await invokeBridge({ ...primary.body, workspaceId: remoteId });
  expect(remoteBridge.status).toBe(403);
  expect(await remoteBridge.json()).toMatchObject({ code: "toon_assistant_bridge_scope_mismatch" });

  const localCreate = await fetch(`${base}/workspaces/local`, {
    method: "POST",
    headers: hostHeaders,
    body: JSON.stringify({ folderPath: addedRoot, name: "Added" }),
  });
  expect(localCreate.status).toBe(201);
  const addedId = (await localCreate.json() as { activeId: string }).activeId;
  const added = await prepareBridgeCall(addedId, "added");
  expect((await invokeBridge(added.body)).status).toBe(200);
  const localDelete = await fetch(`${base}/workspaces/${addedId}`, { method: "DELETE", headers: hostHeaders });
  expect(localDelete.status).toBe(200);
  const removedWorkspace = await invokeBridge(added.body);
  expect(removedWorkspace.status).toBe(403);
  expect(await removedWorkspace.json()).toMatchObject({ code: "toon_assistant_bridge_scope_mismatch" });

  const otherHostRoute = await fetch(`${base}/experimental/toon-factory/model-policy`, {
    method: "PUT",
    headers: bridgeHeaders,
    body: JSON.stringify({}),
  });
  expect(otherHostRoute.status).toBe(401);

  config.readOnly = true;
  const readOnlyMutation = await fetch(`${base}/experimental/toon-factory/assistant-bridge`, {
    method: "POST",
    headers: bridgeHeaders,
    body: JSON.stringify({ ...primary.body, call: { action: "canvas.propose" } }),
  });
  expect(readOnlyMutation.status).toBe(403);
  expect(await readOnlyMutation.json()).toMatchObject({ code: "read_only" });
});

test("managed bridge credentials rotate when the same server config restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "toon-bridge-rotation-"));
  const previousDb = process.env.JUGGLEWORK_RUNTIME_DB;
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "client", hostToken: "host",
    approval: { mode: "auto", timeoutMs: 1_000 }, corsOrigins: ["*"],
    workspaces: [{ id: "ws_1", name: "Primary", path: root, preset: "starter", workspaceType: "local" }],
    authorizedRoots: [root], readOnly: true, managedRuntime: true, startedAt: Date.now(),
    tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  try {
    const first = await startServer(config);
    const firstToken = requireManagedToonBridgeCredential(config).token;
    await first.stop();
    expect(() => requireManagedToonBridgeCredential(config)).toThrow("unavailable");
    const second = await startServer(config);
    const secondToken = requireManagedToonBridgeCredential(config).token;
    expect(secondToken).not.toBe(firstToken);
    const oldCredential = await fetch(`http://127.0.0.1:${second.port}/experimental/toon-factory/assistant-bridge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${firstToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(oldCredential.status).toBe(401);
    const currentCredential = await fetch(`http://127.0.0.1:${second.port}/experimental/toon-factory/assistant-bridge`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secondToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(currentCredential.status).toBe(400);
    await second.stop();
  } finally {
    if (previousDb === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB;
    else process.env.JUGGLEWORK_RUNTIME_DB = previousDb;
    await rm(root, { recursive: true, force: true });
  }
});

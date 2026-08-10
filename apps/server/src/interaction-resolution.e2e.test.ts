import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInteractionResolutionCoordinator } from "./interaction-resolution-coordinator.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

type Served = { port: number; stop: (closeActiveConnections?: boolean) => void | Promise<void> };
type PendingPermission = { id: string; sessionID: string; permission: string; patterns: string[]; metadata: object; always: string[] };
type PendingQuestion = {
  id: string;
  sessionID: string;
  questions: Array<{
    id?: string;
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

function startMockOpencode() {
  const permissions: PendingPermission[] = [];
  const questions: PendingQuestion[] = [];
  const v2Permissions: PendingPermission[] = [];
  const v2Questions: PendingQuestion[] = [];
  const permissionReplies: Array<{ id: string; body: unknown }> = [];
  const questionReplies: Array<{ id: string; body: unknown }> = [];
  let permissionReads = 0;
  const held = new Map<string, ReturnType<typeof deferred>>();
  const failOnce = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/permission") {
        permissionReads += 1;
        return Response.json(permissions);
      }
      if (request.method === "GET" && url.pathname === "/question") return Response.json(questions);

      const v2PermissionList = url.pathname.match(/^\/api\/session\/([^/]+)\/permission$/);
      if (request.method === "GET" && v2PermissionList) {
        const sessionID = decodeURIComponent(v2PermissionList[1]!);
        return Response.json({ data: v2Permissions.filter((item) => item.sessionID === sessionID) });
      }
      const v2QuestionList = url.pathname.match(/^\/api\/session\/([^/]+)\/question$/);
      if (request.method === "GET" && v2QuestionList) {
        const sessionID = decodeURIComponent(v2QuestionList[1]!);
        return Response.json({ data: v2Questions.filter((item) => item.sessionID === sessionID) });
      }

      const v2PermissionReply = url.pathname.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && v2PermissionReply) {
        const id = decodeURIComponent(v2PermissionReply[2]!);
        permissionReplies.push({ id, body: await request.json() });
        const index = v2Permissions.findIndex((item) => item.id === id);
        if (index < 0) return Response.json({ name: "PermissionNotFound" }, { status: 404 });
        v2Permissions.splice(index, 1);
        return new Response(null, { status: 204 });
      }

      const v2QuestionReply = url.pathname.match(/^\/api\/session\/([^/]+)\/question\/([^/]+)\/reply$/);
      if (request.method === "POST" && v2QuestionReply) {
        const id = decodeURIComponent(v2QuestionReply[2]!);
        questionReplies.push({ id, body: await request.json() });
        const index = v2Questions.findIndex((item) => item.id === id);
        if (index < 0) return Response.json({ name: "QuestionNotFound" }, { status: 404 });
        v2Questions.splice(index, 1);
        return new Response(null, { status: 204 });
      }

      const permissionReply = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && permissionReply) {
        const id = decodeURIComponent(permissionReply[1]!);
        permissionReplies.push({ id, body: await request.json() });
        await held.get(id)?.promise;
        if (failOnce.delete(id)) return Response.json({ name: "PermissionFailure" }, { status: 500 });
        const index = permissions.findIndex((item) => item.id === id);
        if (index < 0) return Response.json({ name: "PermissionNotFound" }, { status: 404 });
        permissions.splice(index, 1);
        return Response.json(true);
      }

      const questionReply = url.pathname.match(/^\/question\/([^/]+)\/reply$/);
      if (request.method === "POST" && questionReply) {
        const id = decodeURIComponent(questionReply[1]!);
        questionReplies.push({ id, body: await request.json() });
        if (failOnce.delete(id)) return Response.json({ name: "QuestionFailure" }, { status: 500 });
        const index = questions.findIndex((item) => item.id === id);
        if (index < 0) return Response.json({ name: "QuestionNotFound" }, { status: 404 });
        questions.splice(index, 1);
        return Response.json(true);
      }

      return Response.json({ code: "not_found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return {
    server,
    permissions,
    questions,
    v2Permissions,
    v2Questions,
    permissionReplies,
    questionReplies,
    permissionReadCount: () => permissionReads,
    held,
    failOnce,
  };
}

async function startHarness(enginePort: number, interactionResolutions = createInteractionResolutionCoordinator()) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-interactions-"));
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
  const server = await startServer(config, { interactionResolutions }) as Served;
  stops.push(() => server.stop(true));
  return {
    base: `http://127.0.0.1:${server.port}`,
    headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
    hostHeaders: { "X-JuggleWork-Host-Token": config.hostToken, "Content-Type": "application/json" },
    interactionResolutions,
  };
}

function replyUrl(base: string, sessionId: string, interactionId: string, kind: "permission" | "question") {
  return `${base}/workspace/ws_1/sessions/${sessionId}/interactions/${interactionId}/${kind}/reply`;
}

function permission(id: string, sessionID: string): PendingPermission {
  return { id, sessionID, permission: "bash", patterns: ["secret-resource"], metadata: { path: "/secret" }, always: [] };
}

function question(id: string, sessionID: string): PendingQuestion {
  return {
    id,
    sessionID,
    questions: [
      {
        id: "single",
        question: "Pick one secret prompt",
        header: "Single",
        options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Stop" }],
        multiple: false,
        custom: false,
      },
      {
        id: "many",
        question: "Pick several",
        header: "Many",
        options: [{ label: "A", description: "A" }, { label: "B", description: "B" }],
        multiple: true,
        custom: false,
      },
    ],
  };
}

describe("authoritative interaction reply APIs", () => {
  test("local and remote responders race through one atomic boundary and dispatch once", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("perm-race", "session-a"));
    const harness = await startHarness(engine.server.port);
    const hold = deferred();
    engine.held.set("perm-race", hold);

    const local = fetch(replyUrl(harness.base, "session-a", "perm-race", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: "local", response: "allow_once" }),
    });
    await waitUntil(() => engine.permissionReplies.length === 1);
    const remote = await fetch(replyUrl(harness.base, "session-a", "perm-race", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, response: "reject" }),
    });
    expect(remote.status).toBe(409);
    await expect(remote.json()).resolves.toMatchObject({ code: "already_resolved" });
    expect(engine.permissionReplies).toHaveLength(1);
    hold.resolve();
    expect((await local).status).toBe(200);
    expect(engine.permissionReplies[0]).toEqual({ id: "perm-race", body: { reply: "once" } });

    const terminal = await fetch(replyUrl(harness.base, "session-a", "perm-race", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "later", response: "reject" }),
    });
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toMatchObject({ code: "already_resolved" });
    expect(engine.permissionReplies).toHaveLength(1);
  });

  test("allows local always and rejects remote always before reading or dispatching upstream", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("local-persistent", "session-a"));
    const harness = await startHarness(engine.server.port);
    const local = await fetch(replyUrl(harness.base, "session-a", "local-persistent", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: "local-always", response: "always" }),
    });
    expect(local.status).toBe(200);
    expect(engine.permissionReplies).toEqual([{ id: "local-persistent", body: { reply: "always" } }]);
    expect(engine.permissionReadCount()).toBe(1);

    const remote = await fetch(replyUrl(harness.base, "session-a", "remote-persistent", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, response: "always" }),
    });
    expect(remote.status).toBe(400);
    await expect(remote.json()).resolves.toMatchObject({ code: "unsupported_permission_response" });
    expect(engine.permissionReplies).toHaveLength(1);
    expect(engine.permissionReadCount()).toBe(1);
  });

  test("dispatches v2 permission and question replies with their v2 payloads", async () => {
    const engine = startMockOpencode();
    engine.v2Permissions.push(permission("permission-v2", "session-a"));
    engine.v2Questions.push(question("question-v2", "session-a"));
    const harness = await startHarness(engine.server.port);

    const permissionResponse = await fetch(replyUrl(harness.base, "session-a", "permission-v2", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: "permission-v2", response: "always" }),
    });
    expect(permissionResponse.status).toBe(200);

    const questionResponse = await fetch(replyUrl(harness.base, "session-a", "question-v2", "question"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "local-renderer",
        commandCorrelationId: "question-v2",
        answers: [
          { questionId: "single", values: ["No"] },
          { questionId: "many", values: ["B"] },
        ],
      }),
    });
    expect(questionResponse.status).toBe(200);
    expect(engine.permissionReplies).toEqual([{ id: "permission-v2", body: { reply: "always" } }]);
    expect(engine.questionReplies).toEqual([{ id: "question-v2", body: { answers: [["No"], ["B"]] } }]);
  });

  test("validates question IDs, cardinality, multiple choice, and options against pending schema", async () => {
    const engine = startMockOpencode();
    engine.questions.push(question("question-valid", "session-a"), question("question-invalid", "session-a"));
    const harness = await startHarness(engine.server.port);
    const valid = await fetch(replyUrl(harness.base, "session-a", "question-valid", "question"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "remote-control",
        commandCorrelationId: "question-command",
        answers: [
          { questionId: "single", values: ["Yes"] },
          { questionId: "many", values: ["A", "B"] },
        ],
      }),
    });
    expect(valid.status).toBe(200);
    expect(engine.questionReplies[0]).toEqual({ id: "question-valid", body: { answers: [["Yes"], ["A", "B"]] } });

    for (const answers of [
      [{ questionId: "unknown", values: ["Yes"] }, { questionId: "many", values: ["A"] }],
      [{ questionId: "single", values: ["Yes", "No"] }, { questionId: "many", values: ["A"] }],
      [{ questionId: "single", values: ["Maybe"] }, { questionId: "many", values: ["A"] }],
      [{ questionId: "single", values: ["Yes"] }],
    ]) {
      const invalid = await fetch(replyUrl(harness.base, "session-a", "question-invalid", "question"), {
        method: "POST",
        headers: harness.headers,
        body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, answers }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_question_answers" });
    }
    expect(engine.questionReplies).toHaveLength(1);
  });

  test("returns not found for unknown and cross-session interactions", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("other-session", "session-b"));
    const harness = await startHarness(engine.server.port);
    for (const id of ["unknown", "other-session"]) {
      const response = await fetch(replyUrl(harness.base, "session-a", id, "permission"), {
        method: "POST",
        headers: harness.headers,
        body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, response: "reject" }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: "interaction_not_found" });
    }
    expect(engine.permissionReplies).toHaveLength(0);
  });

  test("upstream failure rolls back the exact reservation so another writer can retry", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("retry", "session-a"));
    engine.failOnce.add("retry");
    const harness = await startHarness(engine.server.port);
    const first = await fetch(replyUrl(harness.base, "session-a", "retry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: "first", response: "allow_once" }),
    });
    expect(first.status).toBe(502);
    const retry = await fetch(replyUrl(harness.base, "session-a", "retry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "retry", response: "reject" }),
    });
    expect(retry.status).toBe(200);
    expect(engine.permissionReplies).toHaveLength(2);
    expect(engine.permissionReplies[1]).toEqual({ id: "retry", body: { reply: "reject" } });
  });

  test("expired pending and tombstones map to interaction_expired, then purge to not found", async () => {
    let now = 1_000;
    let reservation = 0;
    const coordinator = createInteractionResolutionCoordinator({
      now: () => now,
      randomUUID: () => `reservation-${++reservation}`,
      pendingTtlMs: 10,
      tombstoneTtlMs: 10,
      expiredRetentionMs: 10,
    });
    const engine = startMockOpencode();
    engine.permissions.push(permission("pending-expiry", "session-a"), permission("resolved-expiry", "session-a"));
    const harness = await startHarness(engine.server.port, coordinator);
    const pendingScope = { workspaceId: "ws_1", sessionId: "session-a", interactionId: "pending-expiry", kind: "permission" } as const;
    coordinator.observePending(pendingScope);
    now = 1_010;
    const pendingExpired = await fetch(replyUrl(harness.base, "session-a", "pending-expiry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
    });
    expect(pendingExpired.status).toBe(410);
    await expect(pendingExpired.json()).resolves.toMatchObject({ code: "interaction_expired" });

    now = 2_000;
    const resolved = await fetch(replyUrl(harness.base, "session-a", "resolved-expiry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, response: "reject" }),
    });
    expect(resolved.status).toBe(200);
    now = 2_010;
    const tombstoneExpired = await fetch(replyUrl(harness.base, "session-a", "resolved-expiry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
    });
    expect(tombstoneExpired.status).toBe(410);
    now = 2_020;
    const purged = await fetch(replyUrl(harness.base, "session-a", "resolved-expiry", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
    });
    expect(purged.status).toBe(404);
    await expect(purged.json()).resolves.toMatchObject({ code: "interaction_not_found" });
  });

  test("successful tombstones are bounded and contain no interaction content", async () => {
    const coordinator = createInteractionResolutionCoordinator({ maxTerminal: 1 });
    const engine = startMockOpencode();
    engine.permissions.push(permission("first", "session-a"), permission("second", "session-a"));
    const harness = await startHarness(engine.server.port, coordinator);
    for (const id of ["first", "second"]) {
      const response = await fetch(replyUrl(harness.base, "session-a", id, "permission"), {
        method: "POST",
        headers: harness.headers,
        body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
      });
      expect(response.status).toBe(200);
    }
    const tombstones = coordinator.listTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.interactionId).toBe("second");
    expect(JSON.stringify(tombstones)).not.toMatch(/secret|resource|prompt|path|tool|answer/i);
  });

  test("semantic reply APIs require collaborator scope", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("forbidden", "session-a"));
    const harness = await startHarness(engine.server.port);
    const issued = await fetch(`${harness.base}/tokens`, {
      method: "POST",
      headers: harness.hostHeaders,
      body: JSON.stringify({ scope: "viewer", label: "interaction viewer" }),
    });
    const viewer = await issued.json() as { token: string };
    const response = await fetch(replyUrl(harness.base, "session-a", "forbidden", "permission"), {
      method: "POST",
      headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, response: "reject" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    expect(engine.permissionReplies).toHaveLength(0);
  });
});

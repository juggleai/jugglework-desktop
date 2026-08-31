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
type EngineSession = { id: string; parentID?: unknown };

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
  const sessions: EngineSession[] = [];
  const permissions: PendingPermission[] = [];
  const questions: PendingQuestion[] = [];
  const v2Permissions: PendingPermission[] = [];
  const v2Questions: PendingQuestion[] = [];
  const permissionReplies: Array<{ id: string; body: unknown }> = [];
  const questionReplies: Array<{ id: string; body: unknown }> = [];
  let permissionReads = 0;
  let activeV2Reads = 0;
  let maxActiveV2Reads = 0;
  let holdV2Reads = false;
  const legacyFailures = new Map<"permission" | "question", number | "malformed">();
  const v2Failures = new Map<string, number | "malformed" | "ambiguous-404">();
  const held = new Map<string, ReturnType<typeof deferred>>();
  const failOnce = new Set<string>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/session") return Response.json(sessions);
      if (request.method === "GET" && url.pathname === "/permission") {
        permissionReads += 1;
        const failure = legacyFailures.get("permission");
        if (failure === "malformed") return Response.json({ invalid: true });
        if (failure) return Response.json({ code: "failed" }, { status: failure });
        return Response.json(permissions);
      }
      if (request.method === "GET" && url.pathname === "/question") {
        const failure = legacyFailures.get("question");
        if (failure === "malformed") return Response.json({ invalid: true });
        if (failure) return Response.json({ code: "failed" }, { status: failure });
        return Response.json(questions);
      }

      const v2PermissionList = url.pathname.match(/^\/api\/session\/([^/]+)\/permission$/);
      if (request.method === "GET" && v2PermissionList) {
        const sessionID = decodeURIComponent(v2PermissionList[1]!);
        const failure = v2Failures.get(`permission:${sessionID}`);
        if (failure === "malformed") return Response.json({ data: { invalid: true } });
        if (failure === "ambiguous-404") return Response.json({ code: "session_not_found" }, { status: 404 });
        if (failure) return Response.json({ code: failure === 404 ? "not_found" : "failed" }, { status: failure });
        activeV2Reads += 1;
        maxActiveV2Reads = Math.max(maxActiveV2Reads, activeV2Reads);
        if (holdV2Reads) await new Promise((resolve) => setTimeout(resolve, 5));
        activeV2Reads -= 1;
        return Response.json({ data: v2Permissions.filter((item) => item.sessionID === sessionID) });
      }
      const v2QuestionList = url.pathname.match(/^\/api\/session\/([^/]+)\/question$/);
      if (request.method === "GET" && v2QuestionList) {
        const sessionID = decodeURIComponent(v2QuestionList[1]!);
        const failure = v2Failures.get(`question:${sessionID}`);
        if (failure === "malformed") return Response.json({ data: { invalid: true } });
        if (failure === "ambiguous-404") return Response.json({ code: "session_not_found" }, { status: 404 });
        if (failure) return Response.json({ code: failure === 404 ? "not_found" : "failed" }, { status: failure });
        activeV2Reads += 1;
        maxActiveV2Reads = Math.max(maxActiveV2Reads, activeV2Reads);
        if (holdV2Reads) await new Promise((resolve) => setTimeout(resolve, 5));
        activeV2Reads -= 1;
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
    sessions,
    permissions,
    questions,
    v2Permissions,
    v2Questions,
    permissionReplies,
    questionReplies,
    permissionReadCount: () => permissionReads,
    maxActiveV2ReadCount: () => maxActiveV2Reads,
    holdV2Reads: () => { holdV2Reads = true; },
    held,
    failOnce,
    legacyFailures,
    v2Failures,
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

function snapshotUrl(base: string, sessionId: string, includeDescendants = true) {
  return `${base}/workspace/ws_1/sessions/${sessionId}/interactions/snapshot?includeDescendants=${includeDescendants}`;
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
  test("snapshots merge protocols across nested descendants without leaking unrelated or malformed sessions", async () => {
    const engine = startMockOpencode();
    engine.sessions.push(
      { id: "root" },
      { id: "child", parentID: "root" },
      { id: "grandchild", parentID: "child" },
      { id: "other-root" },
      { id: "other-child", parentID: "other-root" },
      { id: "cycle-a", parentID: "cycle-b" },
      { id: "cycle-b", parentID: "cycle-a" },
      { id: "orphan", parentID: "missing" },
    );
    engine.permissions.push(
      permission("root-legacy", "root"),
      permission("merged", "child"),
      permission("unrelated", "other-child"),
      permission("cyclic", "cycle-a"),
      permission("orphaned", "orphan"),
    );
    engine.v2Permissions.push(permission("merged", "child"), permission("grandchild-v2", "grandchild"));
    engine.questions.push(question("child-question", "child"), question("unrelated-question", "other-child"));
    engine.v2Questions.push(question("grandchild-question", "grandchild"));
    const harness = await startHarness(engine.server.port);

    const response = await fetch(snapshotUrl(harness.base, "root"), { headers: harness.headers });
    expect(response.status).toBe(200);
    const body = await response.json() as { item: {
      snapshotStartedAt: number;
      rootSessionId: string;
      includeDescendants: boolean;
      permissions: Array<Record<string, unknown>>;
      questions: Array<Record<string, unknown>>;
    } };
    expect(body.item.snapshotStartedAt).toBeGreaterThan(0);
    expect(body.item.rootSessionId).toBe("root");
    expect(body.item.includeDescendants).toBe(true);
    expect(body.item.permissions.map((item) => item.id).sort()).toEqual(["grandchild-v2", "merged", "root-legacy"]);
    expect(body.item.questions.map((item) => item.id).sort()).toEqual(["child-question", "grandchild-question"]);
    expect(body.item.permissions.find((item) => item.id === "merged")).toMatchObject({
      protocol: "v2",
      sessionID: "child",
      metadata: { path: "/secret" },
      targetSessionId: "child",
      parentSessionId: "root",
      rootSessionId: "root",
    });
    expect(body.item.permissions.find((item) => item.id === "grandchild-v2")).toMatchObject({
      targetSessionId: "grandchild",
      parentSessionId: "child",
      rootSessionId: "root",
      ancestryPath: ["root", "child", "grandchild"],
    });
    const childQuestion = body.item.questions.find((item) => item.id === "child-question");
    expect(childQuestion).toMatchObject({ protocol: "legacy" });
    expect((childQuestion?.questions as Array<{ options: unknown[] }>)[0]?.options).toEqual([
      { label: "Yes", description: "Proceed" },
      { label: "No", description: "Stop" },
    ]);
    expect(engine.permissionReadCount()).toBe(1);
  });

  test("snapshot ancestry is cycle-safe and descendant v2 reads have bounded concurrency", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "root" }, ...Array.from({ length: 20 }, (_, index) => ({
      id: `child-${index}`,
      parentID: index === 0 ? "root" : `child-${index - 1}`,
    })));
    engine.holdV2Reads();
    const harness = await startHarness(engine.server.port);
    const response = await fetch(snapshotUrl(harness.base, "root"), { headers: harness.headers });
    expect(response.status).toBe(200);
    expect(engine.maxActiveV2ReadCount()).toBeGreaterThan(1);
    expect(engine.maxActiveV2ReadCount()).toBeLessThanOrEqual(8);

    engine.sessions.push({ id: "cycle-a", parentID: "cycle-b" }, { id: "cycle-b", parentID: "cycle-a" });
    const malformed = await fetch(snapshotUrl(harness.base, "cycle-a"), { headers: harness.headers });
    expect(malformed.status).toBe(409);
    await expect(malformed.json()).resolves.toMatchObject({ code: "invalid_session_ancestry" });
  });

  test("snapshot fails closed on partial or total v2 5xx and only falls back when every v2 read is unsupported", async () => {
    const partial = startMockOpencode();
    partial.sessions.push({ id: "root" }, { id: "child", parentID: "root" });
    partial.permissions.push(permission("legacy-child", "child"));
    partial.v2Failures.set("permission:child", 500);
    const partialHarness = await startHarness(partial.server.port);
    const partialResponse = await fetch(snapshotUrl(partialHarness.base, "root"), { headers: partialHarness.headers });
    expect(partialResponse.status).toBe(502);

    const unsupported = startMockOpencode();
    unsupported.sessions.push({ id: "root" }, { id: "child", parentID: "root" });
    unsupported.permissions.push(permission("legacy-child", "child"));
    for (const sessionId of ["root", "child"]) {
      unsupported.v2Failures.set(`permission:${sessionId}`, 404);
      unsupported.v2Failures.set(`question:${sessionId}`, 404);
    }
    const unsupportedHarness = await startHarness(unsupported.server.port);
    const fallback = await fetch(snapshotUrl(unsupportedHarness.base, "root"), { headers: unsupportedHarness.headers });
    expect(fallback.status).toBe(200);
    expect((await fallback.json() as { item: { permissions: Array<{ id: string }> } }).item.permissions.map((item) => item.id)).toEqual(["legacy-child"]);
  });

  test("snapshot fails closed when either legacy global read fails even if v2 reads succeed", async () => {
    const cases = [
      { kind: "permission" as const, failure: 500 as const, v2Item: null },
      { kind: "question" as const, failure: "malformed" as const, v2Item: question("v2-question", "root") },
    ];
    for (const { kind, failure, v2Item } of cases) {
      const engine = startMockOpencode();
      engine.sessions.push({ id: "root" });
      engine.legacyFailures.set(kind, failure);
      if (v2Item) engine.v2Questions.push(v2Item);
      const harness = await startHarness(engine.server.port);

      const response = await fetch(snapshotUrl(harness.base, "root"), { headers: harness.headers });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ code: "opencode_request_failed" });
    }
  });

  test("exact replies fail closed on v2 5xx or malformed data and use legacy only when v2 is explicitly unsupported", async () => {
    for (const failure of [500, "malformed", "ambiguous-404"] as const) {
      const engine = startMockOpencode();
      engine.sessions.push({ id: "session-a" });
      engine.permissions.push(permission("legacy-permission", "session-a"));
      engine.v2Failures.set("permission:session-a", failure);
      const harness = await startHarness(engine.server.port);
      const response = await fetch(replyUrl(harness.base, "session-a", "legacy-permission", "permission"), {
        method: "POST",
        headers: harness.headers,
        body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
      });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.not.toMatchObject({ code: "interaction_not_found" });
      expect(engine.permissionReplies).toHaveLength(0);
    }

    const legacy = startMockOpencode();
    legacy.sessions.push({ id: "session-a" });
    legacy.permissions.push(permission("legacy-permission", "session-a"));
    legacy.v2Failures.set("permission:session-a", 404);
    const harness = await startHarness(legacy.server.port);
    const response = await fetch(replyUrl(harness.base, "session-a", "legacy-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "reject" }),
    });
    expect(response.status).toBe(200);
    expect(legacy.permissionReplies).toEqual([{ id: "legacy-permission", body: { reply: "reject" } }]);
  });

  test("exact replies resolve legacy-only interactions while supported v2 lists are empty", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "root" }, { id: "child", parentID: "root" });
    engine.permissions.push(permission("legacy-permission", "child"));
    engine.questions.push(question("legacy-question", "child"));
    const harness = await startHarness(engine.server.port);

    const snapshot = await fetch(snapshotUrl(harness.base, "root"), { headers: harness.headers });
    expect(snapshot.status).toBe(200);
    const body = await snapshot.json() as {
      item: { permissions: Array<{ id: string }>; questions: Array<{ id: string }> };
    };
    expect(body.item.permissions.map((item) => item.id)).toEqual(["legacy-permission"]);
    expect(body.item.questions.map((item) => item.id)).toEqual(["legacy-question"]);

    const permissionResponse = await fetch(replyUrl(harness.base, "child", "legacy-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "allow_once" }),
    });
    expect(permissionResponse.status).toBe(200);
    expect(engine.permissionReplies).toEqual([{ id: "legacy-permission", body: { reply: "once" } }]);

    const questionResponse = await fetch(replyUrl(harness.base, "child", "legacy-question", "question"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "local-renderer",
        commandCorrelationId: null,
        answers: [
          { questionId: "single", values: ["Yes"] },
          { questionId: "many", values: ["A"] },
        ],
      }),
    });
    expect(questionResponse.status).toBe(200);
    expect(engine.questionReplies).toEqual([{ id: "legacy-question", body: { answers: [["Yes"], ["A"]] } }]);
  });

  test("descendant presentation does not change the exact-session reply target", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "root" }, { id: "child", parentID: "root" });
    engine.v2Permissions.push(permission("child-permission", "child"));
    const harness = await startHarness(engine.server.port);
    const snapshot = await fetch(snapshotUrl(harness.base, "root"), { headers: harness.headers });
    expect(snapshot.status).toBe(200);

    const wrongTarget = await fetch(replyUrl(harness.base, "root", "child-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "allow_once" }),
    });
    expect(wrongTarget.status).toBe(404);
    expect(engine.permissionReplies).toHaveLength(0);

    const exactTarget = await fetch(replyUrl(harness.base, "child", "child-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "local-renderer", commandCorrelationId: null, response: "allow_once" }),
    });
    expect(exactTarget.status).toBe(200);
    expect(engine.permissionReplies).toEqual([{ id: "child-permission", body: { reply: "once" } }]);
  });

  test("remote reply rejects a missing or unrelated immutable root binding before dispatch", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "root" }, { id: "child", parentID: "root" }, { id: "other" });
    engine.v2Permissions.push(permission("child-permission", "child"));
    const harness = await startHarness(engine.server.port);

    const missing = await fetch(replyUrl(harness.base, "child", "child-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "missing-root", response: "reject" }),
    });
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ code: "invalid_payload" });

    const response = await fetch(replyUrl(harness.base, "child", "child-permission", "permission"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "bad-root", rootSessionId: "other", response: "reject" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "interaction_not_found" });
    expect(engine.permissionReplies).toHaveLength(0);
  });

  test("local and remote responders race through one atomic boundary and dispatch once", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "session-a" });
    engine.permissions.push(permission("perm-race", "session-a"));
    engine.v2Failures.set("permission:session-a", 404);
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
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, rootSessionId: "session-a", response: "reject" }),
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
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "later", rootSessionId: "session-a", response: "reject" }),
    });
    expect(terminal.status).toBe(409);
    await expect(terminal.json()).resolves.toMatchObject({ code: "already_resolved" });
    expect(engine.permissionReplies).toHaveLength(1);
  });

  test("allows local always and rejects remote always before reading or dispatching upstream", async () => {
    const engine = startMockOpencode();
    engine.permissions.push(permission("local-persistent", "session-a"));
    engine.v2Failures.set("permission:session-a", 404);
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
    engine.sessions.push({ id: "session-a" });
    engine.questions.push(question("question-valid", "session-a"), question("question-invalid", "session-a"));
    engine.v2Failures.set("question:session-a", 404);
    const harness = await startHarness(engine.server.port);
    const valid = await fetch(replyUrl(harness.base, "session-a", "question-valid", "question"), {
      method: "POST",
      headers: harness.headers,
      body: JSON.stringify({
        origin: "remote-control",
        commandCorrelationId: "question-command",
        rootSessionId: "session-a",
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
    engine.sessions.push({ id: "session-a" }, { id: "session-b" });
    engine.permissions.push(permission("other-session", "session-b"));
    engine.v2Failures.set("permission:session-a", 404);
    const harness = await startHarness(engine.server.port);
    for (const id of ["unknown", "other-session"]) {
      const response = await fetch(replyUrl(harness.base, "session-a", id, "permission"), {
        method: "POST",
        headers: harness.headers,
        body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, rootSessionId: "session-a", response: "reject" }),
      });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: "interaction_not_found" });
    }
    expect(engine.permissionReplies).toHaveLength(0);
  });

  test("upstream failure rolls back the exact reservation so another writer can retry", async () => {
    const engine = startMockOpencode();
    engine.sessions.push({ id: "session-a" });
    engine.permissions.push(permission("retry", "session-a"));
    engine.v2Failures.set("permission:session-a", 404);
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
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: "retry", rootSessionId: "session-a", response: "reject" }),
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
    engine.sessions.push({ id: "session-a" });
    engine.permissions.push(permission("pending-expiry", "session-a"), permission("resolved-expiry", "session-a"));
    engine.v2Failures.set("permission:session-a", 404);
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
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, rootSessionId: "session-a", response: "reject" }),
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
    engine.v2Failures.set("permission:session-a", 404);
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
      body: JSON.stringify({ origin: "remote-control", commandCorrelationId: null, rootSessionId: "session-a", response: "reject" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "forbidden" });
    expect(engine.permissionReplies).toHaveLength(0);
  });
});

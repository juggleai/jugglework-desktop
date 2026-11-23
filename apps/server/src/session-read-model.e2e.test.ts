import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function createWorkspaceRoot(folderName?: string) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-session-read-"));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input?: {
  historyEdit?: { tailChanged?: boolean };
  invalidList?: boolean;
  holdCommand?: Promise<void>;
  holdCreate?: Promise<void>;
  createStarted?: () => void;
  config?: Record<string, unknown>;
  statuses?: unknown;
  messagePages?: Record<string, { ids: string[]; olderCursor?: string }>;
  invalidMessageCursor?: string;
}) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string; body?: unknown }> = [];
  let config = input?.config ?? {};
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: { pathname: string; search: string; directory: string | null; method: string; body?: unknown } = {
        pathname: url.pathname,
        search: url.search,
        directory: request.headers.get("x-opencode-directory"),
        method: request.method,
      };
      if (request.method === "POST" || request.method === "PATCH") {
        const raw = await request.text();
        record.body = raw ? JSON.parse(raw) : {};
      }
      requests.push(record);

      if (input?.historyEdit) {
        if (url.pathname.startsWith("/session/ses_1/message/") && request.method === "DELETE") return Response.json(true);
        if (url.pathname === "/session/ses_1/prompt_async") return new Response(null, { status: 204 });
        if (url.pathname === "/session/ses_1/message") {
          const turns = [
            { info: { id: "msg_first", sessionID: "ses_1", role: "user" }, parts: [] },
            { info: { id: "msg_edit", sessionID: "ses_1", role: "user" }, parts: [{ type: "file", url: "file:///example.png", mime: "image/png" }] },
            { info: { id: "msg_last", sessionID: "ses_1", role: "assistant" }, parts: [] },
          ];
          if (url.searchParams.get("limit") === "1" && input.historyEdit.tailChanged) {
            return Response.json([{ info: { id: "msg_new", sessionID: "ses_1", role: "user" }, parts: [] }]);
          }
          return Response.json(url.searchParams.get("limit") === "1" ? turns.slice(-1) : turns);
        }
      }
      if (url.pathname === "/config") {
        if (request.method === "PATCH" && typeof record.body === "object" && record.body !== null) {
          config = record.body as Record<string, unknown>;
        }
        return Response.json(config);
      }

      if (url.pathname === "/session") {
        if (request.method === "POST") {
          input?.createStarted?.();
          await input?.holdCreate;
          const title = typeof record.body === "object" && record.body !== null
            ? Reflect.get(record.body, "title")
            : undefined;
          return Response.json({
            id: "ses_created",
            title: typeof title === "string" ? title : "New session",
            slug: "created-session",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 300, updated: 300 },
          });
        }
        if (input?.invalidList) {
          return Response.json({ nope: true });
        }
        return Response.json([
          {
            id: "ses_1",
            title: "Hostname Check",
            slug: "hostname-check",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 100, updated: 200 },
          },
        ]);
      }

      if (url.pathname === "/session/status") {
        return Response.json(input && "statuses" in input ? input.statuses : { ses_1: { type: "busy" } });
      }

      if (url.pathname === "/session/ses_1") {
        if (request.method === "PATCH") {
          const body = record.body as { title?: string; time?: { archived?: number } };
          return Response.json({
            id: "ses_1",
            title: body.title ?? "Hostname Check",
            slug: "hostname-check",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 100, updated: 201, ...(body.time ?? {}) },
          });
        }
        if (request.method === "DELETE") return Response.json(true);
        return Response.json({
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: request.headers.get("x-opencode-directory"),
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_1/fork" && request.method === "POST") {
        return Response.json({
          id: "ses_forked",
          parentID: "ses_1",
          title: "Hostname Check (fork)",
          directory: request.headers.get("x-opencode-directory"),
          time: { created: 301, updated: 301 },
        });
      }

      if (url.pathname === "/session/ses_1/message/msg_1") {
        return Response.json({ info: { id: "msg_1", sessionID: "ses_1" }, parts: [] });
      }
      if (url.pathname === "/session/ses_1/message") {
        const before = url.searchParams.get("before");
        if (before !== null && before === input?.invalidMessageCursor) {
          return Response.json({ code: "invalid_cursor", message: "Invalid cursor" }, { status: 400 });
        }
        const page = input?.messagePages?.[before ?? ""];
        const ids = page?.ids ?? ["msg_1"];
        return Response.json(ids.map((id, index) => ({
          info: {
            id,
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 200 + index },
          },
          parts: [
            {
              id: `prt_${id}`,
              messageID: id,
              sessionID: "ses_1",
              type: "text",
              text: id === "msg_1" ? "hostname: mock-host" : `message: ${id}`,
            },
          ],
        })), page?.olderCursor ? { headers: { "X-Next-Cursor": page.olderCursor } } : undefined);
      }

      if (url.pathname === "/session/ses_created/prompt_async" && request.method === "POST") {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/session/ses_1/todo") {
        return Response.json([
          {
            content: "Validate session reads",
            status: "completed",
            priority: "high",
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/command" && request.method === "POST") {
        await input?.holdCommand;
        return Response.json({ ok: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startJuggleWorkServer(input: { workspaceRoot: string; opencodeBaseUrl: string; readOnly?: boolean }) {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    configPath: join(input.workspaceRoot, ".jugglework", "config.json"),
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: input.workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: input.opencodeBaseUrl,
      },
    ],
    authorizedRoots: [input.workspaceRoot],
    readOnly: input.readOnly ?? true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token };
}

test("creation proxy continues after client abort and authenticates every replay", async () => {
  const gate = deferred();
  const started = deferred();
  const mock = startMockOpencode({ holdCreate: gate.promise, createStarted: started.resolve });
  const root = await createWorkspaceRoot();
  const { server, token } = await startJuggleWorkServer({ workspaceRoot: root, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
  const url = `http://127.0.0.1:${server.port}/w/ws_1/opencode/session`;
  const headers = { ...auth(token), "Content-Type": "application/json", "X-JuggleWork-Create-Intent": `${Date.now()}.${crypto.randomUUID()}` };
  const controller = new AbortController();
  const first = fetch(url, { method: "POST", headers, body: "{}", signal: controller.signal }).catch(() => null);
  await started.promise;
  controller.abort();
  await first;
  const retry = fetch(url, { method: "POST", headers, body: "{}" });
  gate.resolve();
  expect((await (await retry).json()).id).toBe("ses_created");
  expect((await fetch(url, { method: "POST", headers, body: "{}" })).status).toBe(200);
  expect((await fetch(url, { method: "POST", headers: { ...headers, ...auth("invalid") }, body: "{}" })).status).toBe(401);
  expect((await fetch(url, { method: "POST", headers, body: '{"title":"different"}' })).status).toBe(409);
  expect(mock.requests.filter((r) => r.pathname === "/session" && r.method === "POST")).toHaveLength(1);
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 20; index++) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("workspace session read APIs", () => {
  test("creates an empty session with a valid Unicode scalar title", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    const title = "😀".repeat(120);
    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      method: "POST",
      headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: `  ${title}  ` }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      item: {
        id: "ses_created",
        title,
        slug: "created-session",
        directory: workspaceRoot,
        time: { created: 300, updated: 300 },
      },
      started: false,
    });
    expect(mock.requests.filter((request) => request.pathname === "/session" && request.method === "POST")).toHaveLength(1);
    expect(mock.requests.some((request) => request.pathname.includes("prompt"))).toBe(false);

    for (const invalidTitle of [
      "embedded\u0000nul",
      "next\u0085line",
      "high\ud800surrogate",
      "low\udc00surrogate",
      "😀".repeat(121),
    ]) {
      const rejected = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
        method: "POST",
        headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
        body: JSON.stringify({ title: invalidTitle }),
      });
      expect(rejected.status).toBe(400);
    }

    const formatCharacter = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      method: "POST",
      headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "join\u200dthis" }),
    });
    expect(formatCharacter.status).toBe(201);
    expect(mock.requests.filter((request) => request.pathname === "/session" && request.method === "POST")).toHaveLength(2);
  });

  test("creates a session and starts its prompt without UI navigation", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      method: "POST",
      headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Look into dolphins", prompt: "Research dolphins." }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      item: { id: "ses_created", title: "Look into dolphins", directory: workspaceRoot },
      started: true,
    });
    const createRequest = mock.requests.find((request) => request.pathname === "/session" && request.method === "POST");
    expect(createRequest?.body).toEqual({ title: "Look into dolphins" });
    const promptRequest = mock.requests.find((request) => request.pathname === "/session/ses_created/prompt_async");
    expect(promptRequest?.body).toEqual({ parts: [{ type: "text", text: "Research dolphins." }] });
    expect(promptRequest?.directory).toBe(workspaceRoot);
  });

  test("lists sessions and returns session details, messages, and snapshot", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${jugglework.server.port}`;

    const listResponse = await fetch(`${base}/workspace/ws_1/sessions?roots=true&limit=1&search=host&start=10`, {
      headers: auth(jugglework.token),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toEqual({
      items: [
        {
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: workspaceRoot,
          time: { created: 100, updated: 200 },
          status: { type: "busy" },
        },
      ],
    });

    const detailResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1`, {
      headers: auth(jugglework.token),
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.item.id).toBe("ses_1");
    expect(detailBody.item.directory).toBe(workspaceRoot);

    const messagesResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/messages?limit=5`, {
      headers: auth(jugglework.token),
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expect(messagesBody.items).toHaveLength(1);
    expect(messagesBody.items[0]?.info.id).toBe("msg_1");
    expect(messagesBody.items[0]?.parts[0]?.text).toBe("hostname: mock-host");
    expect(messagesBody.page).toEqual({ olderCursor: null, hasOlder: false });

    const snapshotResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/snapshot?limit=5`, {
      headers: auth(jugglework.token),
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = await snapshotResponse.json();
    expect(snapshotBody.item.session.id).toBe("ses_1");
    expect(snapshotBody.item.messages).toHaveLength(1);
    expect(snapshotBody.item.messagePage).toEqual({ olderCursor: null, hasOlder: false });
    expect(snapshotBody.item.todos).toEqual([
      {
        content: "Validate session reads",
        status: "completed",
        priority: "high",
      },
    ]);
    expect(snapshotBody.item.status).toEqual({ type: "busy" });

    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain("roots=true");
    expect(listRequest?.search).toContain("limit=1");
    expect(listRequest?.search).toContain("search=host");
    expect(listRequest?.search).toContain("start=10");

  });

  test("reads first, middle, final, and exact-full message pages with opaque cursors", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const middleCursor = "opaque+/middle==";
    const finalCursor = "opaque.final";
    const mock = startMockOpencode({
      messagePages: {
        "": { ids: ["msg_5", "msg_6"], olderCursor: middleCursor },
        [middleCursor]: { ids: ["msg_3", "msg_4"], olderCursor: finalCursor },
        [finalCursor]: { ids: ["msg_1", "msg_2"] },
        exact: { ids: ["msg_a", "msg_b"] },
      },
    });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });
    const endpoint = `http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/messages`;
    const read = async (before?: string) => {
      const query = new URLSearchParams({ limit: "2" });
      if (before !== undefined) query.set("before", before);
      const response = await fetch(`${endpoint}?${query}`, { headers: auth(jugglework.token) });
      expect(response.status).toBe(200);
      return response.json();
    };

    await expect(read()).resolves.toMatchObject({
      items: [{ info: { id: "msg_5" } }, { info: { id: "msg_6" } }],
      page: { olderCursor: middleCursor, hasOlder: true },
    });
    await expect(read(middleCursor)).resolves.toMatchObject({
      items: [{ info: { id: "msg_3" } }, { info: { id: "msg_4" } }],
      page: { olderCursor: finalCursor, hasOlder: true },
    });
    await expect(read(finalCursor)).resolves.toMatchObject({
      items: [{ info: { id: "msg_1" } }, { info: { id: "msg_2" } }],
      page: { olderCursor: null, hasOlder: false },
    });
    await expect(read("exact")).resolves.toMatchObject({
      items: [{ info: { id: "msg_a" } }, { info: { id: "msg_b" } }],
      page: { olderCursor: null, hasOlder: false },
    });

    const messageRequests = mock.requests.filter((request) => request.pathname === "/session/ses_1/message");
    expect(messageRequests.map((request) => new URLSearchParams(request.search).get("before"))).toEqual([
      null,
      middleCursor,
      finalCursor,
      "exact",
    ]);
    expect(messageRequests.every((request) => new URLSearchParams(request.search).get("limit") === "2")).toBe(true);
  });

  test("reuses the snapshot message read for pagination metadata and preserves the snapshot limit contract", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ messagePages: { "": { ids: ["msg_1"], olderCursor: "snapshot-cursor" } } });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/snapshot?limit=1500`,
      { headers: auth(jugglework.token) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      item: { messagePage: { olderCursor: "snapshot-cursor", hasOlder: true } },
    });
    const messageRequests = mock.requests.filter((request) => request.pathname === "/session/ses_1/message");
    expect(messageRequests).toHaveLength(1);
    expect(new URLSearchParams(messageRequests[0]!.search).get("limit")).toBe("1500");

    const legacyResponse = await fetch(
      `http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/snapshot`,
      { headers: auth(jugglework.token) },
    );
    expect(legacyResponse.status).toBe(200);
    expect(mock.requests.filter((request) => request.pathname === "/session/ses_1/message")).toHaveLength(2);
    expect(new URLSearchParams(mock.requests.at(-1)!.search).has("limit")).toBe(false);
  });

  test("rejects oversized page inputs locally and maps an upstream invalid cursor to 400", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ invalidMessageCursor: "invalid-upstream" });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });
    const endpoint = `http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/messages`;

    const oversized = await fetch(`${endpoint}?before=${"x".repeat(4097)}`, { headers: auth(jugglework.token) });
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toMatchObject({ code: "invalid_query" });
    expect(mock.requests.filter((request) => request.pathname === "/session/ses_1/message")).toHaveLength(0);

    const oversizedLimit = await fetch(`${endpoint}?limit=1001`, { headers: auth(jugglework.token) });
    expect(oversizedLimit.status).toBe(400);
    await expect(oversizedLimit.json()).resolves.toMatchObject({ code: "invalid_query" });
    expect(mock.requests.filter((request) => request.pathname === "/session/ses_1/message")).toHaveLength(0);

    const upstream = await fetch(`${endpoint}?before=invalid-upstream`, { headers: auth(jugglework.token) });
    expect(upstream.status).toBe(400);
    await expect(upstream.json()).resolves.toMatchObject({ code: "invalid_query" });
    expect(new URLSearchParams(mock.requests.find((request) => request.pathname === "/session/ses_1/message")!.search).get("before"))
      .toBe("invalid-upstream");
  });

  test("treats sessions omitted from the authoritative status map as idle", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ statuses: {} });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      headers: auth(jugglework.token),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      items: [{ id: "ses_1", status: { type: "idle" } }],
    });
  });

  test("rejects a malformed target status but ignores malformed statuses outside the listed page", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const invalidTarget = startMockOpencode({ statuses: { ses_1: { type: "future" } } });
    const firstServer = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${invalidTarget.server.port}`,
    });

    const rejected = await fetch(`http://127.0.0.1:${firstServer.server.port}/workspace/ws_1/sessions`, {
      headers: auth(firstServer.token),
    });
    expect(rejected.status).toBe(502);
    await expect(rejected.json()).resolves.toMatchObject({
      code: "opencode_invalid_response",
      message: "OpenCode returned invalid session status",
    });

    const unrelated = startMockOpencode({
      statuses: { ses_1: { type: "idle" }, ses_other: { type: "future" } },
    });
    const secondWorkspaceRoot = await createWorkspaceRoot();
    const secondServer = await startJuggleWorkServer({
      workspaceRoot: secondWorkspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${unrelated.server.port}`,
    });
    const accepted = await fetch(`http://127.0.0.1:${secondServer.server.port}/workspace/ws_1/sessions`, {
      headers: auth(secondServer.token),
    });
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      items: [{ id: "ses_1", status: { type: "idle" } }],
    });
  });

  test("accepts guest-side rem_ workspace aliases for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/rem_ws_1/sessions`, {
      headers: auth(jugglework.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]?.id).toBe("ses_1");
    expect(body.items[0]?.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/session")?.directory).toBe(workspaceRoot);
  });

  test("encodes non-ASCII workspace directory headers for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      headers: auth(jugglework.token),
    });

    expect(response.status).toBe(200);
    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    const encodedDirectory = encodeURIComponent(workspaceRoot);
    expect(listRequest?.directory).toBe(encodedDirectory);
    expect(listRequest?.search).toContain(`directory=${encodedDirectory}`);
  });

  test("encodes non-ASCII workspace directory headers for opencode proxy requests", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(jugglework.token),
    });

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(proxyRequest?.directory).toBe(encodeURIComponent(workspaceRoot));
  });

  test("does not forward a semantically unchanged config patch to OpenCode", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const currentConfig = {
      model: "demo/model",
      disabled_providers: ["opencode"],
      provider: { demo: { name: "Demo" } },
    };
    const mock = startMockOpencode({ config: currentConfig });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/opencode/config`, {
      method: "PATCH",
      headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: { demo: { name: "Demo" } },
        disabled_providers: ["opencode"],
        model: "demo/model",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(currentConfig);
    expect(mock.requests.filter((request) => request.pathname === "/config" && request.method === "GET")).toHaveLength(1);
    expect(mock.requests.filter((request) => request.pathname === "/config" && request.method === "PATCH")).toHaveLength(0);
  });

  test("still forwards a changed config patch to OpenCode", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ config: { disabled_providers: [] } });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/opencode/config`, {
      method: "PATCH",
      headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
      body: JSON.stringify({ disabled_providers: ["opencode"] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disabled_providers: ["opencode"] });
    expect(mock.requests.filter((request) => request.pathname === "/config" && request.method === "GET")).toHaveLength(1);
    expect(mock.requests.filter((request) => request.pathname === "/config" && request.method === "PATCH")).toHaveLength(1);
  });

  test("returns 404 when the upstream session is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_missing/snapshot`, {
      headers: auth(jugglework.token),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_not_found",
      message: "Session not found",
    });

  });

  test("forwards safe session lifecycle mutations through collaborator routes", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    const headers = { ...auth(jugglework.token), "Content-Type": "application/json" };

    const forked = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/fork`, {
      method: "POST", headers, body: JSON.stringify({}),
    });
    expect(forked.status).toBe(201);
    await expect(forked.json()).resolves.toMatchObject({ item: { id: "ses_forked", parentID: "ses_1" } });

    const forkAt = (messageId: string) => fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1/fork`, {
      method: "POST", headers, body: JSON.stringify({ messageId }),
    });
    expect((await forkAt("msg_1")).status).toBe(201);
    expect((await forkAt("msg_missing")).ok).toBe(false);
    expect(mock.requests.filter((request) => request.pathname.endsWith("/fork")).map((request) => request.body)).toEqual([
      {}, { messageID: "msg_1" },
    ]);

    for (const body of [{ title: "Renamed" }, { archived: true }, { archived: false }]) {
      const updated = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1`, {
        method: "PATCH", headers, body: JSON.stringify(body),
      });
      expect(updated.status).toBe(200);
    }
    expect(mock.requests.filter((request) => request.pathname === "/session/ses_1" && request.method === "PATCH").map((request) => request.body)).toEqual([
      { title: "Renamed" },
      { time: { archived: expect.any(Number) } },
      { time: { archived: 0 } },
    ]);

    const deleted = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions/ses_1`, {
      method: "DELETE", headers,
    });
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true });
  });

  for (const scenario of ["edit", "busy", "stale", "changed before dispatch"] as const) {
    test(`same-session history edit: ${scenario}`, async () => {
      const workspaceRoot = await createWorkspaceRoot();
      const mock = startMockOpencode({ statuses: scenario === "busy" ? { ses_1: { type: "busy" } } : {}, historyEdit: { tailChanged: scenario === "changed before dispatch" } });
      const app = await startJuggleWorkServer({ workspaceRoot, opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`, readOnly: false });
      const result = await fetch(`http://127.0.0.1:${app.server.port}/workspace/ws_1/sessions/ses_1/runs/start`, {
        method: "POST", headers: { ...auth(app.token), "Content-Type": "application/json" },
        body: JSON.stringify({ origin: "local-renderer", startCommandCorrelationId: "cmd_edit",
          editHistory: { messageId: "msg_edit", lastMessageId: scenario === "stale" ? "msg_first" : "msg_last" },
          prompt: { parts: [{ type: "text", text: "replacement" }] } }),
      });
      const deletions = mock.requests.filter(r => r.method === "DELETE").map(r => r.pathname);
      const sent = mock.requests.filter(r => r.pathname.endsWith("/prompt_async"));
      expect(mock.requests.some(r => r.pathname.endsWith("/revert") || r.pathname.endsWith("/abort"))).toBe(false);
      expect(mock.requests.some(r => r.pathname.endsWith("/fork") || r.method === "PATCH")).toBe(false);
      if (scenario !== "edit") {
        expect(result.ok).toBe(false);
        expect(deletions).toEqual([]);
        expect(sent).toHaveLength(0);
        return;
      }
      expect(result.status).toBe(202);

      expect(deletions).toEqual(["/session/ses_1/message/msg_last", "/session/ses_1/message/msg_edit"]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ pathname: "/session/ses_1/prompt_async", body: { parts: [
        { type: "text", text: "replacement" }, { type: "file", url: "file:///example.png", mime: "image/png" },
      ] } });
    });
  }

  test("acknowledges proxied session commands before upstream completion", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const command = deferred();
    const mock = startMockOpencode({ holdCommand: command.promise });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await Promise.race([
      fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/opencode/session/ses_1/command`, {
        method: "POST",
        headers: { ...auth(jugglework.token), "Content-Type": "application/json" },
        body: JSON.stringify({ command: "review", arguments: "" }),
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
    ]);

    expect(response).not.toBe("timeout");
    expect(response instanceof Response ? response.status : 0).toBe(200);
    await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });
    const sawCommand = await waitUntil(() => mock.requests.some((request) => request.pathname === "/session/ses_1/command"));
    command.resolve();
    expect(sawCommand).toBe(true);
    // The command is acknowledged before completion; drain its reservation
    // before teardown closes the journal used by the completion callback.
    expect(await waitUntil(async () => {
      const runs = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/session-runs`, {
        headers: auth(jugglework.token),
      });
      const body = await runs.json() as { items: unknown[] };
      return runs.ok && body.items.length === 0;
    })).toBe(true);
  });

  test("keeps legacy /w workspace opencode proxy alias", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/w/ws_1/opencode/session`, {
      headers: auth(jugglework.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
  });

  test("returns 502 when OpenCode returns an invalid session list payload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ invalidList: true });
    const jugglework = await startJuggleWorkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${jugglework.server.port}/workspace/ws_1/sessions`, {
      headers: auth(jugglework.token),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_invalid_response",
      message: "OpenCode returned invalid session list",
    });

  });
});

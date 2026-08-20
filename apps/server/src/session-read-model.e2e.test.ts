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
  invalidList?: boolean;
  holdCommand?: Promise<void>;
  config?: Record<string, unknown>;
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
      if (request.method === "POST" || request.method === "PATCH") record.body = await request.json();
      requests.push(record);

      if (url.pathname === "/config") {
        if (request.method === "PATCH" && typeof record.body === "object" && record.body !== null) {
          config = record.body as Record<string, unknown>;
        }
        return Response.json(config);
      }

      if (url.pathname === "/session") {
        if (request.method === "POST") {
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
        return Response.json({ ses_1: { type: "busy" } });
      }

      if (url.pathname === "/session/ses_1") {
        return Response.json({
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: request.headers.get("x-opencode-directory"),
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_1/message") {
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: "ses_1",
              role: "assistant",
              time: { created: 200 },
            },
            parts: [
              {
                id: "prt_1",
                messageID: "msg_1",
                sessionID: "ses_1",
                type: "text",
                text: "hostname: mock-host",
              },
            ],
          },
        ]);
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return true;
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

    const snapshotResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/snapshot?limit=5`, {
      headers: auth(jugglework.token),
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = await snapshotResponse.json();
    expect(snapshotBody.item.session.id).toBe("ses_1");
    expect(snapshotBody.item.messages).toHaveLength(1);
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

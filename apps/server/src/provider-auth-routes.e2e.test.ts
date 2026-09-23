import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditLogPath } from "./audit.js";
import { readJuggleWorkWorkspaceConfig } from "./jugglework-workspace-config-store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const HOST_TOKEN = "provider-auth-host-token";
const CLIENT_TOKEN = "provider-auth-client-token";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function boot() {
  const root = await mkdtemp(join(tmpdir(), "jugglework-provider-auth-"));
  roots.push(root);
  const upstreamRequests: Array<{ method: string; path: string; directory: string | null; body: unknown }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/provider") {
        return Response.json({ all: [], default: {}, connected: [] });
      }
      const body = request.method === "PUT" ? await request.json() : null;
      upstreamRequests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        directory: request.headers.get("x-opencode-directory"),
        body,
      });
      if (new URL(request.url).pathname === "/auth/failing") {
        return Response.json({ message: "rejected sk-upstream-secret" }, { status: 400 });
      }
      return Response.json(true);
    },
  });
  stops.push(() => upstream.stop());

  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_1",
      name: "Workspace",
      path: root,
      directory: root,
      baseUrl: `http://127.0.0.1:${upstream.port}`,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { root, config, upstreamRequests, base: `http://127.0.0.1:${server.port}` };
}

function hostHeaders() {
  return { "x-jugglework-host-token": HOST_TOKEN, "content-type": "application/json" };
}

describe("workspace provider auth routes", () => {
  test("preflights host authority and derives provider visibility without claiming execution", async () => {
    const { base } = await boot();
    const preflight = await fetch(`${base}/workspace/ws_1/provider-auth`, { headers: hostHeaders() });
    expect(preflight.status).toBe(200);

    const missing = await fetch(`${base}/workspace/ws_1/provider-auth`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(missing.status).toBe(401);

    const status = await fetch(`${base}/workspace/ws_1/provider-status/unknown-provider`, { headers: hostHeaders() });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({
      providerId: "unknown-provider",
      published: null,
      imported: false,
      loaded: false,
      authenticated: false,
      enabled: null,
      models: [],
    });
  });

  test("atomically reconciles per-provider baselines without losing concurrent providers", async () => {
    const { config, base } = await boot();
    const baseline = (id: string) => ({ cloudProviderId: id, providerId: id, sourceProviderId: "future", name: id, source: null, updatedAt: null, modelIds: [], importedAt: 1, metadataVersion: 8 });
    const write = (id: string) => fetch(`${base}/workspace/ws_1/cloud-provider-imports/${id}`, {
      method: "PUT", headers: hostHeaders(), body: JSON.stringify({ item: baseline(id) }),
    });
    const responses = await Promise.all([write("pub_a"), write("pub_b")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const stored = await readJuggleWorkWorkspaceConfig(config, "ws_1");
    const providers = (stored.cloudImports as { providers: Record<string, unknown> }).providers;
    expect(Object.keys(providers).sort()).toEqual(["pub_a", "pub_b"]);

    const removed = await fetch(`${base}/workspace/ws_1/cloud-provider-imports/pub_a`, { method: "DELETE", headers: hostHeaders() });
    expect(removed.status).toBe(200);
    const remaining = await fetch(`${base}/workspace/ws_1/cloud-provider-imports/pub_b`, { headers: hostHeaders() });
    expect(await remaining.json()).toEqual({ item: baseline("pub_b") });

    const stale = await fetch(`${base}/workspace/ws_1/provider-status/pub_b`, { headers: hostHeaders() });
    expect(await stale.json()).toMatchObject({
      providerId: "pub_b",
      published: null,
      imported: true,
      loaded: false,
      authenticated: false,
      enabled: null,
      models: [],
    });
  });

  test("sets and removes API auth through the workspace OpenCode client without returning or auditing secrets", async () => {
    const { root, upstreamRequests, base } = await boot();
    const secret = "sk-provider-secret";

    const setResponse = await fetch(`${base}/workspace/ws_1/provider-auth/openai`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ type: "api", key: secret, metadata: { account: "test" } }),
    });
    expect(setResponse.status).toBe(200);
    expect(await setResponse.text()).toBe('{"ok":true}');

    const removeResponse = await fetch(`${base}/workspace/ws_1/provider-auth/openai`, {
      method: "DELETE",
      headers: hostHeaders(),
    });
    expect(removeResponse.status).toBe(200);
    expect(await removeResponse.json()).toEqual({ ok: true });
    expect(upstreamRequests).toEqual([
      { method: "PUT", path: "/auth/openai", directory: root, body: { type: "api", key: secret, metadata: { account: "test" } } },
      { method: "DELETE", path: "/auth/openai", directory: root, body: null },
    ]);

    const audit = await readFile(auditLogPath("ws_1"), "utf8").catch(() => "");
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain("provider-auth");
  });

  test("requires the host token and rejects invalid provider IDs and API auth payloads before forwarding", async () => {
    const { upstreamRequests, base } = await boot();
    const path = `${base}/workspace/ws_1/provider-auth/openai`;

    const missingHost = await fetch(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key: "secret" }),
    });
    expect(missingHost.status).toBe(401);

    const invalidId = await fetch(`${base}/workspace/ws_1/provider-auth/Bad%20Provider`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ type: "api", key: "secret" }),
    });
    expect(invalidId.status).toBe(400);
    expect(await invalidId.json()).toMatchObject({ code: "invalid_provider_id" });

    for (const payload of [
      { type: "api", key: "" },
      { type: "oauth", key: "secret" },
      { type: "api", key: "secret", unexpected: true },
      { type: "api", key: "secret", metadata: { account: 42 } },
    ]) {
      const response = await fetch(path, {
        method: "PUT",
        headers: hostHeaders(),
        body: JSON.stringify(payload),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_provider_auth" });
    }
    expect(upstreamRequests).toEqual([]);
  });

  test("does not return an upstream credential-bearing error body", async () => {
    const { base } = await boot();
    const secret = "sk-request-secret";
    const response = await fetch(`${base}/workspace/ws_1/provider-auth/failing`, {
      method: "PUT",
      headers: hostHeaders(),
      body: JSON.stringify({ type: "api", key: secret }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(responseText).not.toContain(secret);
    expect(responseText).not.toContain("sk-upstream-secret");
    expect(JSON.parse(responseText)).toMatchObject({
      code: "opencode_request_failed",
      details: { status: 400 },
    });
  });

  test("blocks client-token proxy bypasses on every OpenCode mount", async () => {
    const { upstreamRequests, base } = await boot();
    const headers = { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
    const paths = [
      "/workspace/ws_1/opencode/auth/openai",
      "/w/ws_1/opencode/auth/openai",
      "/opencode/auth/openai",
    ];

    for (const path of paths) {
      for (const method of ["PUT", "DELETE"]) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers,
          ...(method === "PUT" ? { body: JSON.stringify({ type: "api", key: "secret" }) } : {}),
        });
        expect(response.status).toBe(403);
      }
    }
    expect(upstreamRequests).toEqual([]);
  });
});

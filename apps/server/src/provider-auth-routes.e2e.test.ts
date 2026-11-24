import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { cloudGatewayCredentialEnvName, cloudProviderConfigFingerprint } from "@jugglework/types/provider-credentials";

import { auditLogPath } from "./audit.js";
import { readJuggleWorkWorkspaceConfig } from "./jugglework-workspace-config-store.js";
import { registerTrustedOpencodeProcess, startServer } from "./server.js";
import { writeRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";

const HOST_TOKEN = "provider-auth-host-token";
const CLIENT_TOKEN = "provider-auth-client-token";
const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

const previousEnvStore = process.env.JUGGLEWORK_ENV_STORE;
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousConfigHome = process.env.XDG_CONFIG_HOME;

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  if (previousEnvStore === undefined) delete process.env.JUGGLEWORK_ENV_STORE;
  else process.env.JUGGLEWORK_ENV_STORE = previousEnvStore;
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
});

async function boot(providerCatalog = { all: [] as Array<{ id: string; source?: string; models: Record<string, unknown> }>, default: {} as Record<string, string>, connected: [] as string[] }, respond?: (request: Request) => Response | undefined) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-provider-auth-"));
  roots.push(root);
  // Keep the env store and runtime DB inside the temp root. Without this the
  // server falls back to ~/.config/jugglework and writes the user's real files.
  process.env.JUGGLEWORK_ENV_STORE = join(root, "state", "env.json");
  const upstreamRequests: Array<{ method: string; path: string; directory: string | null; body: unknown }> = [];
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const response = respond?.(request);
      if (response) return response;
      if (request.method === "GET" && new URL(request.url).pathname === "/provider") {
        return Response.json(providerCatalog);
      }
      if (request.method === "GET" && new URL(request.url).pathname === "/config/providers") {
        return Response.json({ providers: providerCatalog.all, default: providerCatalog.default });
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
    configPath: join(root, "state", "server.json"),
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
  test("hides removed global providers even when the managed engine still reports them", async () => {
    const removed = { id: "deleted-local", source: "config", models: { chat: {} } };
    const project = { id: "project-local", source: "config", models: { chat: {} } };
    const independent = { id: "other-local", source: "config", models: { chat: {} } };
    const builtin = { id: "builtin", source: "env", models: { chat: {} } };
    const all = [removed, project, independent, builtin];
    const catalog = { all, connected: all.map(({ id }) => id), default: Object.fromEntries(all.map(({ id }) => [id, "chat"])) };
    const engineGlobal = { provider: { [removed.id]: {}, [project.id]: {}, [builtin.id]: {} } };
    const { base, config, root } = await boot(catalog, (request) =>
      new URL(request.url).pathname === "/global/config" ? Response.json(engineGlobal) : undefined);
    const global = join(root, "global");
    const projectDir = join(root, ".opencode");
    process.env.OPENCODE_CONFIG_DIR = global;
    process.env.XDG_CONFIG_HOME = join(root, "xdg");
    await mkdir(global);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(global, "opencode.jsonc"), JSON.stringify({ provider: { [removed.id]: {} } }));
    await writeFile(join(projectDir, "opencode.json"), JSON.stringify({ provider: { [project.id]: {} } }));
    registerTrustedOpencodeProcess(config, { baseUrl: config.workspaces[0]!.baseUrl!, identity: "provider-catalog", isAlive: () => true });
    const get = async (path: string) => {
      const response = await fetch(`${base}/workspace/ws_1/opencode${path}`, { headers: { authorization: `Bearer ${CLIENT_TOKEN}` } });
      expect(response.status).toBe(200);
      return response.json();
    };

    expect(await get("/provider")).toEqual(catalog);
    await writeFile(join(global, "opencode.jsonc"), "{}");
    const connected = [project.id, independent.id, builtin.id];
    const defaults = Object.fromEntries(connected.map((id) => [id, "chat"]));
    expect(await get("/provider")).toEqual({ all: [project, independent, builtin], connected, default: defaults });
    expect(await get("/config/providers")).toEqual({ providers: [project, independent, builtin], default: defaults });
    await writeFile(join(global, "opencode.jsonc"), JSON.stringify({ provider: { [removed.id]: {} } }));
    expect(await get("/provider")).toEqual(catalog);
  });

  test("fences discovery and dispatch through personal → organization → personal, including late sync results", async () => {
    const id = "lpr_fixture";
    const local = { id: "local", models: { own: {} } };
    const managed = { id, models: { chat: {}, stale: {} } };
    const { base, root, config, upstreamRequests } = await boot({ all: [local, managed], default: { local: "own", [id]: "chat" }, connected: ["local", id] });
    const client = { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" };
    const authority = `${base}/managed-provider-authority`;
    const prefix = `${base}/workspace/ws_1`;
    const gateway = "https://provider.example.test/jwork/api/gateway/v1/lpr_fixture";
    const credential = "synthetic-session-a";
    const providerConfig = { npm: "@ai-sdk/openai-compatible", env: [cloudGatewayCredentialEnvName(id)], options: { baseURL: gateway }, models: { chat: {} } };
    const put = (url: string, body: unknown, headers = hostHeaders()) => fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
    const confirm = (revision: string, organizationId: string) => put(authority, { revision, deployment: "https://cloud.example.test/jwork/api", userId: "user", organizationId, session: "a".repeat(64) });
    const ready = (authorityId: string, isReady: boolean) => put(`${prefix}/managed-provider-readiness`, { authorityId, ready: isReady });
    const visible = async (expected: unknown[]) => {
      const response = await fetch(`${prefix}/opencode/provider`, { headers: client });
      expect(response.status).toBe(200);
      expect((await response.json() as { all: unknown[] }).all).toEqual(expected);
      const configResponse = await fetch(`${prefix}/opencode/config/providers`, { headers: client });
      expect(configResponse.status).toBe(200);
      expect((await configResponse.json() as { providers: unknown[] }).providers).toEqual(expected);
    };
    const allowed = async () => (await (await fetch(`${base}/internal/managed-provider-dispatch`, {
      method: "POST", headers: client, body: JSON.stringify({ directory: root, providerID: id, url: `${gateway}/chat/completions`, digest: createHash("sha256").update(credential).digest("hex") }),
    })).json() as { allowed: boolean }).allowed;
    const fence = async () => (await (await fetch(authority, { method: "DELETE", headers: hostHeaders() })).json() as { revision: string }).revision;
    const submit = (operation: string, body: unknown) => fetch(`${prefix}/opencode/session/scope-fixture/${operation}`, {
      method: "POST", headers: client, body: JSON.stringify(body),
    });

    expect((await fetch(authority, { headers: client })).status).toBe(401);
    expect((await fetch(`${prefix}/managed-provider-inventory`, { headers: client })).status).toBe(401);
    const initial = await fence();
    const personal = await confirm(initial, "personal");
    expect(personal.status).toBe(200);
    const { id: firstId } = await personal.json() as { id: string };
    const { mirror } = await (await put(`${prefix}/cloud-provider-mirror/${id}`, { organizationId: "personal", value: credential })).json() as { mirror: unknown };
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: { [id]: providerConfig } }));
    const importFor = async (authorityId: string) => {
      expect((await put(`${prefix}/cloud-provider-imports/${id}`, { item: { cloudProviderId: id, providerId: id, organizationId: "personal", authorityId, metadataVersion: 10, modelIds: ["chat"], providerConfigFingerprint: cloudProviderConfigFingerprint(providerConfig), gatewayMirror: mirror } })).status).toBe(200);
    };
    await importFor(firstId);
    await visible([local]);
    expect(await allowed()).toBe(false);
    expect((await ready(firstId, true)).status).toBe(200);
    const activeList = [local, { id, models: { chat: {} } }];
    await visible(activeList);
    expect(await allowed()).toBe(true);
    expect((await submit("message", { model: { providerID: id, modelID: "chat" }, parts: [] })).status).toBe(200);
    expect((await ready(firstId, false)).status).toBe(200);
    await visible([local]);
    expect(await allowed()).toBe(false);
    const beforeRejected = upstreamRequests.length;
    for (const [operation, payload] of [
      ["prompt_async", { model: { providerID: id, modelID: "chat" }, parts: [] }],
      ["summarize", { providerID: id, modelID: "chat" }],
      ["command", { model: `${id}/chat`, command: "compact", arguments: "" }],
    ] as const) {
      const response = await submit(operation, payload);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "managed_provider_scope_unavailable" });
    }
    expect(upstreamRequests).toHaveLength(beforeRejected);
    expect((await submit("message", { model: { providerID: "local", modelID: "own" }, parts: [] })).status).toBe(200);
    expect((await ready(firstId, true)).status).toBe(200);

    const orgRevision = await fence();
    expect((await ready(firstId, true)).status).toBe(409);
    const org = await confirm(orgRevision, "organization");
    expect(org.status).toBe(200);
    expect((await ready((await org.json() as { id: string }).id, true)).status).toBe(200);
    await visible([local]);
    expect(await allowed()).toBe(false);
    const returnRevision = await fence();
    expect((await confirm(orgRevision, "organization")).status).toBe(409);
    const again = await confirm(returnRevision, "personal");
    const { id: secondId } = await again.json() as { id: string };
    expect(secondId).not.toBe(firstId);
    expect((await ready(secondId, true)).status).toBe(200);
    await visible([local]);
    expect(await allowed()).toBe(false);
    await importFor(secondId);
    const delayedFailure = await fetch(`${authority}?revision=${encodeURIComponent(firstId)}`, { method: "DELETE", headers: hostHeaders() });
    expect(await delayedFailure.json()).toEqual({ revision: null });
    await visible(activeList);
    expect(await allowed()).toBe(true);
  });

  test("video generation rejects old scope but returns an already submitted job on exact replay", async () => {
    let posts = 0;
    const { base, config } = await boot(undefined, (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/video-fixture/videos" && request.method === "POST") {
        posts++;
        return Response.json({ id: "fixture-upstream-job" });
      }
      if (path === "/video-fixture/videos/fixture-upstream-job") return Response.json({ status: "in_progress" });
    });
    const prefix = `${base}/workspace/ws_1`;
    const authority = `${base}/managed-provider-authority`;
    const put = async (url: string, body: unknown) => {
      const response = await fetch(url, { method: "PUT", headers: hostHeaders(), body: JSON.stringify(body) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const { revision } = await (await fetch(authority, { headers: hostHeaders() })).json() as { revision: string };
    const { id: authorityId } = await put(authority, { revision, deployment: "https://cloud.example.test", userId: "user", organizationId: "org", session: "a".repeat(64) }) as { id: string };
    const providerID = "lpr_video_fixture", modelID = "video";
    const provider = { npm: "@ai-sdk/openai-compatible", env: [cloudGatewayCredentialEnvName(providerID)],
      options: { baseURL: `${config.workspaces[0]!.baseUrl}/video-fixture` }, models: { [modelID]: { mediaGeneration: { textToVideo: true } } } };
    await writeRuntimeOpencodeConfig(config, "ws_1", () => ({ provider: { [providerID]: provider } }));
    const { mirror } = await put(`${prefix}/cloud-provider-mirror/${providerID}`, { organizationId: "org", value: "fixture-only" }) as { mirror: unknown };
    await put(`${prefix}/cloud-provider-imports/${providerID}`, { item: { cloudProviderId: providerID, providerId: providerID, organizationId: "org", authorityId,
      metadataVersion: 10, modelIds: [modelID], providerConfigFingerprint: cloudProviderConfigFingerprint(provider), gatewayMirror: mirror } });
    const call = (action: string, args: unknown) => fetch(`${base}/experimental/extensions/call`, {
      method: "POST", headers: { authorization: `Bearer ${CLIENT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ extensionId: "media-generation", action, args, context: { workspaceId: "ws_1" } }),
    });
    const input = { prompt: "waves", mode: "text-to-video", model: { providerID, modelID }, clientRequestId: "submitted-before-switch" };
    await put(`${prefix}/managed-provider-readiness`, { authorityId, ready: true });
    const started = await (await call("video_generate", input)).json() as { result: { job: { id: string } } };
    expect(started.result.job).toMatchObject({ providerJobId: "fixture-upstream-job" });
    await fetch(authority, { method: "DELETE", headers: hostHeaders() });

    expect(await (await call("video_models_list", { mode: input.mode })).json()).toMatchObject({ result: { ok: false, error: "no_video_model_available" } });
    expect(await (await call("video_generate", { ...input, clientRequestId: "new-after-switch" })).json()).toMatchObject({ result: { ok: false, error: "no_video_model_available" } });
    expect(await (await call("video_generate", input)).json()).toMatchObject({ result: { job: { id: started.result.job.id } } });
    expect((await call("video_generate", { ...input, prompt: "different request" })).status).toBe(409);
    expect(await (await call("video_job_get", { jobId: started.result.job.id })).json()).toMatchObject({ result: { job: { id: started.result.job.id } } });
    expect(posts).toBe(1);
  });

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

  test("keeps the shared credentials while another workspace still imports the provider", async () => {
    const { config, upstreamRequests, base } = await boot();
    const otherRoot = await mkdtemp(join(tmpdir(), "jugglework-provider-auth-other-"));
    roots.push(otherRoot);
    config.workspaces.push({ ...config.workspaces[0]!, id: "ws_2", name: "Other", path: otherRoot, directory: otherRoot });
    config.authorizedRoots.push(otherRoot);

    const mirrorPath = (workspaceId: string) => `${base}/workspace/${workspaceId}/cloud-provider-mirror/lpr_codex`;
    const written = await fetch(mirrorPath("ws_1"), {
      method: "PUT", headers: hostHeaders(), body: JSON.stringify({ organizationId: "org_1", value: "jwgw_shared" }),
    });
    const { mirror } = await written.json() as { mirror: Record<string, unknown> };
    expect(mirror.workspaceId).toBeUndefined();
    const baseline = { cloudProviderId: "lpr_codex", providerId: "lpr_codex", organizationId: "org_1", gatewayMirror: mirror };
    for (const workspaceId of ["ws_1", "ws_2"]) {
      const stored = await fetch(`${base}/workspace/${workspaceId}/cloud-provider-imports/lpr_codex`, {
        method: "PUT", headers: hostHeaders(), body: JSON.stringify({ item: baseline }),
      });
      expect(stored.status).toBe(200);
    }

    // ws_1 leaving must not strip what ws_2 is still running on.
    const retainedMirror = await fetch(mirrorPath("ws_1"), { method: "DELETE", headers: hostHeaders() });
    expect(await retainedMirror.json()).toEqual({ ok: true, retained: true });
    const retainedAuth = await fetch(`${base}/workspace/ws_1/provider-auth/lpr_codex`, { method: "DELETE", headers: hostHeaders() });
    expect(await retainedAuth.json()).toEqual({ ok: true, retained: true });
    expect(upstreamRequests).toEqual([]);

    // Once the last importer is gone, both are really removed.
    await fetch(`${base}/workspace/ws_2/cloud-provider-imports/lpr_codex`, { method: "DELETE", headers: hostHeaders() });
    const removedMirror = await fetch(mirrorPath("ws_1"), { method: "DELETE", headers: hostHeaders() });
    expect(await removedMirror.json()).toEqual({ ok: true, retained: false });
    const removedAuth = await fetch(`${base}/workspace/ws_1/provider-auth/lpr_codex`, { method: "DELETE", headers: hostHeaders() });
    expect(await removedAuth.json()).toEqual({ ok: true });
    expect(upstreamRequests.map((request) => `${request.method} ${request.path}`)).toEqual(["DELETE /auth/lpr_codex"]);
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

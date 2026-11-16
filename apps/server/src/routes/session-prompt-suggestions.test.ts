import { afterEach, expect, spyOn, test } from "bun:test";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { matchRoute, type RequestContext, type Route } from "./registry.js";
import { registerSessionRoutes } from "./sessions.js";
import { startServer } from "../server.js";
import { Database } from "bun:sqlite";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "prompt-suggestions-route-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const previous = { config: process.env.OPENCODE_CONFIG_DIR, db: process.env.JUGGLEWORK_RUNTIME_DB };
  process.env.OPENCODE_CONFIG_DIR = join(root, "global");
  process.env.JUGGLEWORK_RUNTIME_DB = join(root, "absent.sqlite");
  await mkdir(join(root, "global"));
  cleanups.push(() => {
    if (previous.config === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previous.config;
    if (previous.db === undefined) delete process.env.JUGGLEWORK_RUNTIME_DB; else process.env.JUGGLEWORK_RUNTIME_DB = previous.db;
  });
  const state = { idle: true, hostBusy: false, pending: false, permission: false, question: false, directory: root,
    turnKey: "msg_user", finish: "stop", source: "user", metadata: {} as Record<string, unknown>, modelID: "text", revision: 0,
    revert: undefined as { messageID: string } | undefined, compacting: false, unsupported: false,
    inferred: 0, credentialReads: 0, mutateOnInference: undefined as (() => Promise<void> | void) | undefined,
    upstreamModelId: "text", protocol: "chat" as "chat" | "responses" | "anthropic", liveModels: {} as Record<string, unknown>, expectedHeaders: {} as Record<string, string>,
    diagnostics: {} as NonNullable<RequestContext["requestDiagnostics"]>,
    requests: [] as Array<{ path: string; method: string; query: string; body?: any }> };
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() : undefined;
    state.requests.push({ path: url.pathname, method: request.method, query: url.search, body });
    if (url.pathname === "/session/ses") return Response.json({ id: "ses", directory: state.directory,
      model: { providerID: "test-provider", id: state.modelID }, time: { created: 1, updated: 50, ...(state.compacting ? { compacting: 40 } : {}) }, revert: state.revert });
    if (url.pathname === "/session/status") return Response.json(state.idle ? {} : { ses: { type: "busy" } });
    if (url.pathname === "/permission") return Response.json(state.permission ? [{ id: "perm", sessionID: "ses" }] : []);
    if (url.pathname === "/question") return Response.json(state.question ? [{ id: "q", sessionID: "ses" }] : []);
    if (/^\/api\/session\/ses\/(permission|question)$/.test(url.pathname)) return Response.json({ data: [] });
    if (url.pathname === "/provider") return Response.json({ all: [{ id: "test-provider", models: state.liveModels }], connected: ["test-provider"] });
    if (url.pathname === "/session/ses/message") return Response.json([
      { info: { id: state.turnKey, sessionID: "ses", role: "user", time: { created: 10 }, model: { providerID: "test-provider", modelID: "text" } },
        parts: [{ id: "p1", messageID: state.turnKey, sessionID: "ses", type: "text", text: "只分析，不修改", metadata: { composerTextSource: state.source, ...state.metadata } }] },
      { info: { id: "msg_assistant", parentID: state.turnKey, sessionID: "ses", role: "assistant", finish: state.finish, time: { created: 11, completed: 12 } },
        parts: [{ id: "p2", messageID: "msg_assistant", sessionID: "ses", type: "text", text: "分析完成" }] },
    ]);
    if (["/v1/chat/completions", "/v1/responses", "/v1/messages"].includes(url.pathname)) {
      state.inferred++;
      expect(request.headers.get(state.protocol === "anthropic" ? "x-api-key" : "authorization")).toBe(state.protocol === "anthropic" ? "fake-route-key" : "Bearer fake-route-key");
      expect(body).toMatchObject({ model: state.upstreamModelId, stream: false });
      expect(body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens).toBe(512);
      if (state.protocol === "anthropic") expect(body.thinking).toEqual({ type: "disabled" });
      if (state.upstreamModelId === "gpt-6.1-sol" && state.protocol === "chat") {
        expect(body.max_completion_tokens).toBe(512); expect(body.max_tokens).toBeUndefined();
      }
      for (const [name, value] of Object.entries(state.expectedHeaders)) expect(request.headers.get(name)).toBe(value);
      expect(body).not.toHaveProperty("tools");
      await state.mutateOnInference?.();
      if (state.protocol === "anthropic") return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: "请进一步分析这些风险" }] });
      if (state.protocol === "responses") return Response.json({ status: "completed", output: [
        { type: "reasoning", summary: [] }, { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "请进一步分析这些风险" }] },
      ] });
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "请进一步分析这些风险" } }] });
    }
    return Response.json({ code: "not_found" }, { status: 404 });
  } });
  cleanups.push(() => engine.stop(true));
  const provider = { npm: "@ai-sdk/openai-compatible", env: ["SUGGESTION_FAKE_TEST_KEY"], options: { baseURL: `http://127.0.0.1:${engine.port}/v1` }, models: { text: { name: "Text" } } };
  const writeConfig = (patch: Record<string, unknown> = {}) => writeFile(join(root, "opencode.jsonc"), JSON.stringify({ enabled_providers: ["test-provider"], provider: { "test-provider": provider }, ...patch }));
  await writeConfig();
  const workspace = { id: "ws", name: "test", path: root, baseUrl: `http://127.0.0.1:${engine.port}`, workspaceType: "local" as const, preset: "starter" };
  const config = { readOnly: false, workspaces: [workspace] } as ServerConfig;
  const routes: Route[] = [];
  const unexpected = () => { throw new Error("Unexpected write/bootstrap/repair/run/admission"); };
  const options: Parameters<typeof registerSessionRoutes>[0] = {
    routes, config,
    env: { list: async () => { state.credentialReads++; return [{ key: "SUGGESTION_FAKE_TEST_KEY", value: "fake-route-key" }]; } } as any,
    jsonResponse: (value, status = 200) => Response.json(value, { status }),
    ensureWritable: () => { if (config.readOnly) throw new ApiError(403, "read_only", "Read only"); },
    requireClientScope: ctx => { if (ctx.actor?.scope !== "collaborator") throw new ApiError(403, "forbidden", "Forbidden"); },
    resolveWorkspace: unexpected,
    resolveWorkspaceWithoutBootstrap: async (_config, id) => { if (id !== "ws") throw new ApiError(404, "workspace_not_found", "Unknown workspace"); return workspace; },
    createWorkspaceOpencodeClient: () => createOpencodeClient({ baseUrl: `http://127.0.0.1:${engine.port}` }),
    unwrapOpencodeResult: ((result: any) => { if (!result.response.ok || result.error) throw new ApiError(502, "opencode_request_failed", "Upstream unavailable"); return result.data; }) as any,
    sessionMutations: { getActive: () => state.hostBusy ? {} : null } as any,
    sessionPendingOperations: { list: () => state.pending ? [{ state: "pending" }] : [] } as any,
    sessionModelPreferences: { get: () => ({ model: null, revision: state.revision }) } as any,
    parseOptionalBoolean: unexpected, parseOptionalPositiveInteger: unexpected, parseOptionalNonNegativeInteger: unexpected,
    readJsonBody: unexpected, dispatchSessionPromptAsync: unexpected, dispatchSessionAbort: unexpected,
    preparePromptAdmission: unexpected, sessionPendingOperationPump: {} as any,
  };
  registerSessionRoutes(options);
  const request = async (payload: unknown = { turnKey: "msg_user", model: { providerID: "test-provider", modelID: "text" } }, scope = "collaborator", workspaceId = "ws", signal?: AbortSignal) => {
    const url = new URL(`http://server/workspace/${workspaceId}/sessions/ses/prompt-suggestions`);
    const route = matchRoute(routes, "POST", url.pathname)!;
    expect(route.auth).toBe("client");
    state.diagnostics = {};
    return route.handler({ url, params: route.params, request: new Request(url, { method: "POST", body: JSON.stringify(payload), signal }),
      actor: { scope }, config, requestDiagnostics: state.diagnostics } as RequestContext);
  };
  return { root, state, config, request, writeConfig, provider };
}

test("dedicated route reads only and leaves workspace/session/run state untouched", async () => {
  const f = await fixture(); const before = await readdir(f.root);
  expect(await (await f.request()).json()).toEqual({ turnKey: "msg_user", suggestion: "请进一步分析这些风险" });
  expect(f.state.inferred).toBe(1); expect(f.state.credentialReads).toBe(2);
  expect(await readdir(f.root)).toEqual(before); // In particular no runtime database/bootstrap is created.
  expect(f.state.requests.filter(item => item.method !== "GET").map(item => item.path)).toEqual(["/v1/chat/completions"]);
  for (const page of f.state.requests.filter(item => item.path.endsWith("/message"))) expect(new URLSearchParams(page.query).get("limit")).toBe("60");
});

test("existing runtime database reads do not initialize config or credential schemas", async () => {
  const f = await fixture();
  const database = new Database(join(f.root, "absent.sqlite"));
  try {
    database.exec("CREATE TABLE existing_marker (value TEXT)");
    const before = database.query("SELECT name FROM sqlite_master ORDER BY name").all();
    expect((await (await f.request()).json()).suggestion).toBe("请进一步分析这些风险");
    expect(database.query("SELECT name FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(database.query("SELECT * FROM existing_marker").all()).toEqual([]);
  } finally { database.close(); }
});

test("suggestion resolver sends config/live aliases and effective tenant/model headers without changing public ref", async () => {
  const f = await fixture();
  f.state.upstreamModelId = "synthetic-config-deployment";
  f.state.liveModels = { text: { id: "text", api: { id: f.state.upstreamModelId }, headers: { "x-inherited": "inherited-value", "x-route": "live-route" } } };
  f.state.expectedHeaders = { "x-tenant": "tenant-value", "x-route": "model-route", "x-inherited": "inherited-value" };
  await f.writeConfig({ provider: { "test-provider": { ...f.provider,
    options: { ...f.provider.options, headers: { "X-Tenant": "tenant-value", "X-Route": "provider-route" } },
    models: { text: { id: f.state.upstreamModelId, headers: { "x-route": "model-route" } } },
  } } });
  const first = await (await f.request()).json();
  expect(first).toEqual({ turnKey: "msg_user", suggestion: "请进一步分析这些风险" });
  expect(JSON.stringify(first)).not.toContain("tenant-value");
  f.state.upstreamModelId = "synthetic-live-deployment";
  f.state.liveModels = { text: { id: "text", api: { id: f.state.upstreamModelId }, headers: { "x-route": "live-route" } } };
  f.state.expectedHeaders = { "x-route": "live-route" };
  await f.writeConfig();
  expect((await (await f.request()).json()).suggestion).not.toBeNull();
  expect(f.state.inferred).toBe(2);
});

test("suggestion skips stale aliases, unresolved headers and changed gateway routing", async () => {
  const f = await fixture();
  f.state.liveModels = { text: { api: { id: "old-deployment" } } };
  await f.writeConfig({ provider: { "test-provider": { ...f.provider, models: { text: { id: "new-deployment" } } } } });
  expect((await (await f.request()).json()).reason).toBe("model_unavailable");
  f.state.liveModels = {};
  await f.writeConfig({ provider: { "test-provider": { ...f.provider, options: { ...f.provider.options, headers: { "x-tenant": "{env:SYNTHETIC_TENANT}" } } } } });
  expect((await (await f.request()).json()).reason).toBe("model_unavailable");
  expect(f.state.inferred).toBe(0);
  await f.writeConfig();
  f.state.mutateOnInference = () => f.writeConfig({ provider: { "test-provider": { ...f.provider, options: { ...f.provider.options, headers: { "x-tenant": "changed-tenant" } } } } });
  expect((await (await f.request()).json()).reason).toBe("model_unavailable");
});

test("route rejects strict payload, readOnly, collaborator and workspace/session ownership before inference", async () => {
  const f = await fixture();
  await expect(f.request({ turnKey: "msg_user", model: { providerID: "test-provider", modelID: "text" }, history: [] })).rejects.toMatchObject({ status: 400 });
  await expect(f.request(undefined, "viewer")).rejects.toMatchObject({ status: 403 });
  await expect(f.request(undefined, "collaborator", "other")).rejects.toMatchObject({ status: 404 });
  f.config.readOnly = true; await expect(f.request()).rejects.toMatchObject({ status: 403 });
  f.config.readOnly = false; f.state.directory = join(f.root, "other"); await expect(f.request()).rejects.toMatchObject({ status: 404 });
  expect(f.state.inferred).toBe(0); expect(f.state.credentialReads).toBe(0);
});

test("route skips waiting/busy/queued/compacting/stale/non-success/unknown-source/bound turns", async () => {
  const f = await fixture();
  for (const [field, value] of Object.entries({ idle: false, hostBusy: true, pending: true, permission: true, question: true,
    compacting: true, turnKey: "new_user", finish: "tool-calls", source: "unknown", modelID: "different", revert: { messageID: "msg_user" } })) {
    const key = field as keyof typeof f.state; const old = f.state[key];
    const credentialReads = f.state.credentialReads;
    Object.assign(f.state, { [field]: value });
    expect((await (await f.request()).json()).suggestion).toBeNull();
    if (["idle", "hostBusy", "pending", "permission", "question", "compacting", "modelID"].includes(field)) expect(f.state.credentialReads).toBe(credentialReads);
    Object.assign(f.state, { [field]: old });
  }
  for (const key of ["officeSelectionGroup", "cloudDocSourceText"]) {
    f.state.metadata = { [key]: "private" }; expect((await (await f.request()).json()).suggestion).toBeNull();
  }
  expect(f.state.inferred).toBe(0);
});

test("route rechecks latest turn, idle and model configuration after generation", async () => {
  const f = await fixture();
  f.state.mutateOnInference = () => { f.state.turnKey = "new_user"; };
  expect((await (await f.request()).json()).reason).toBe("ineligible_turn");
  f.state.turnKey = "msg_user";
  f.state.mutateOnInference = () => { f.state.hostBusy = true; };
  expect((await (await f.request()).json()).reason).toBe("ineligible_turn");
  f.state.hostBusy = false;
  f.state.mutateOnInference = () => f.writeConfig({ disabled_providers: ["test-provider"] });
  expect((await (await f.request()).json()).reason).toBe("model_unavailable");
  expect(f.state.inferred).toBe(3);
});

test("disabled/blacklisted/non-text/unsupported/credentialless models do not fall back", async () => {
  const f = await fixture();
  const variants = [
    { disabled_providers: ["test-provider"] }, { enabled_providers: [] },
    ...[{ blacklist: ["text"] }, { whitelist: ["other"] }, { npm: "@ai-sdk/google" }, { env: [] },
      { models: { text: { imageGeneration: { textToImage: true } } } }, { models: { text: { reasoning: true, options: { thinking: { type: "enabled", budgetTokens: 1024 } } } } },
      { models: { text: { capabilities: { output: { text: false } } } } }].map(patch => ({ provider: { "test-provider": { ...f.provider, ...patch } } })),
  ];
  for (const patch of variants) {
    await f.writeConfig(patch);
    expect((await (await f.request()).json()).reason).toBe("model_unavailable");
  }
  expect(f.state.inferred).toBe(0);
});

test.each([
  ["anthropic", "@ai-sdk/anthropic", "claude-sonnet-4-5"],
  ["responses", "@ai-sdk/openai", "gpt-6.1-sol"],
  ["chat", "@ai-sdk/openai-compatible", "gpt-6.1-sol"],
] as const)("%s: real SDK capability shape reaches one bounded request on the selected model", async (protocol, npm, upstreamModelId) => {
  const f = await fixture();
  f.state.protocol = protocol; f.state.upstreamModelId = upstreamModelId;
  f.state.liveModels = { text: { id: "text", api: { id: upstreamModelId }, capabilities: { reasoning: true, output: { text: true } } } };
  await f.writeConfig({ provider: { "test-provider": { ...f.provider, npm, models: { text: { id: upstreamModelId, reasoning: true } } } } });
  expect(await (await f.request()).json()).toEqual({ turnKey: "msg_user", suggestion: "请进一步分析这些风险" });
  expect(f.state.inferred).toBe(1);
  expect(f.state.diagnostics).toMatchObject({ promptSuggestionReason: "suggestion_ready", promptSuggestionTimings: {
    state: expect.any(Number), context: expect.any(Number), model: expect.any(Number), inference: expect.any(Number), revalidate: expect.any(Number),
  } });
});

test("route diagnostics identify silent skips without body, model config, credentials or headers", async () => {
  const f = await fixture();
  for (const [patch, reason, detail] of [
    [{ hostBusy: true }, "ineligible_turn", "host_busy_or_pending"],
    [{ modelID: "different" }, "ineligible_turn", "session_model_mismatch"],
    [{ source: "unknown" }, "ineligible_turn", "context_unknown_text_source"],
    [{ finish: "tool-calls" }, "ineligible_turn", "context_assistant_not_successful"],
    [{ permission: true }, "ineligible_turn", "interaction_waiting"],
    [{ liveModels: { text: { reasoning: true } } }, "model_unavailable", "model_reasoning_protocol"],
  ] as const) {
    const previous = { ...f.state };
    Object.assign(f.state, patch);
    expect((await (await f.request()).json()).reason).toBe(reason);
    expect(f.state.diagnostics).toMatchObject({ promptSuggestionReason: reason, promptSuggestionDetail: detail });
    Object.assign(f.state, previous);
  }
  expect(f.state.inferred).toBe(0);
});

test("server advertises additive capability and wires authenticated readOnly route", async () => {
  const f = await fixture();
  const previousEnvStore = process.env.JUGGLEWORK_ENV_STORE;
  process.env.JUGGLEWORK_ENV_STORE = join(f.root, "absent-env.json");
  cleanups.push(() => { if (previousEnvStore === undefined) delete process.env.JUGGLEWORK_ENV_STORE; else process.env.JUGGLEWORK_ENV_STORE = previousEnvStore; });
  Object.assign(f.config, { host: "127.0.0.1", port: 0, token: "test-client-token", hostToken: "test-host-token", readOnly: true,
    configPath: join(f.root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], authorizedRoots: [f.root],
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false });
  const server = await startServer(f.config);
  cleanups.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const headers = { Authorization: `Bearer ${f.config.token}` };
  expect((await (await fetch(`${base}/capabilities`, { headers })).json()).sessions).toEqual({ promptSuggestions: false });
  const url = `${base}/workspace/ws/sessions/ses/prompt-suggestions`;
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(401);
  expect((await fetch(url, { method: "POST", body: "{}", headers })).status).toBe(403);
  f.config.readOnly = false;
  expect((await (await fetch(`${base}/capabilities`, { headers })).json()).sessions).toEqual({ promptSuggestions: true });
  expect((await fetch(url, { method: "POST", body: "{}", headers })).status).toBe(400);
  f.state.source = "unknown";
  f.config.logRequests = true;
  const lines: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation(((value: string | Uint8Array) => { lines.push(String(value)); return true; }) as typeof process.stdout.write);
  try {
    for (const format of ["pretty", "json"] as const) {
      f.config.logFormat = format;
      lines.length = 0;
      const result = await fetch(url, { method: "POST", headers, body: JSON.stringify({ turnKey: "msg_user", model: { providerID: "test-provider", modelID: "text" } }) });
      expect((await result.json()).reason).toBe("ineligible_turn");
      const log = lines.join("");
      expect(log).toContain("prompt_suggestion=ineligible_turn detail=context_unknown_text_source");
      expect(log).toMatch(/state_ms=\d+/); expect(log).toMatch(/context_ms=\d+/);
      expect(log).not.toContain("只分析"); expect(log).not.toContain("fake-route-key"); expect(log).not.toContain("test-client-token");
      if (format === "json") {
        const attributes = JSON.parse(log).attributes;
        for (const [key, value] of Object.entries(attributes)) if (/^prompt_suggestion\..+_ms$/.test(key)) {
          expect(typeof value).toBe("number"); expect(Number.isFinite(value)).toBe(true); expect(value as number).toBeGreaterThanOrEqual(0);
        }
        expect(attributes).toMatchObject({
          "prompt_suggestion.reason": "ineligible_turn", "prompt_suggestion.detail": "context_unknown_text_source",
          "prompt_suggestion.state_ms": expect.any(Number), "prompt_suggestion.context_ms": expect.any(Number),
        });
      }
    }
  } finally { stdout.mockRestore(); }
  expect(f.state.inferred).toBe(0);
});

test("route's single eight-second deadline includes slow engine reads", async () => {
  const f = await fixture();
  const held = new Promise<never>(() => {});
  const client = createOpencodeClient({ baseUrl: "http://unused", fetch: (async () => held) as unknown as typeof fetch });
  const routes: Route[] = [];
  // Reuse the real route options from registration through a fixture-independent narrow setup.
  registerSessionRoutes({ routes, config: f.config, env: {} as any, jsonResponse: (value: unknown) => Response.json(value),
    ensureWritable: () => {}, requireClientScope: () => {},
    resolveWorkspaceWithoutBootstrap: async () => f.config.workspaces[0], createWorkspaceOpencodeClient: () => client,
    sessionMutations: { getActive: () => null }, sessionPendingOperations: { list: () => [] },
    sessionModelPreferences: { get: () => ({ model: null, revision: 0 }) },
  } as any);
  const url = new URL("http://server/workspace/ws/sessions/ses/prompt-suggestions");
  const route = matchRoute(routes, "POST", url.pathname)!;
  const started = Date.now();
  await expect(route.handler({ params: route.params, url, request: new Request(url, { method: "POST", body: JSON.stringify({ turnKey: "msg_user", model: { providerID: "p", modelID: "m" } }) }) } as RequestContext)).rejects.toMatchObject({ status: 504 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
  expect(Date.now() - started).toBeLessThan(10_000);
}, 12_000);

// Isolated Bun child: source Server + existing schema; optional managed real
// engine with loopback synthetic provider, otherwise original protocol fixture.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { syntheticProvider, configureSyntheticProvider } from "./real-engine-acceptance-provider";
import { consumeSse, streamHealth, roundSseEvidence, isTerminalEvent } from "./real-engine-acceptance-helpers.mjs";

const root = process.env.JUGGLEWORK_SESSION_ACCEPTANCE_ROOT!;
assert.ok(root && process.env.HOME === path.join(root, "home"));
assert.equal(process.env.JUGGLEWORK_RUNTIME_DB, path.join(root, "runtime.sqlite"));
const workspaceRoot = path.join(root, "workspace");
await mkdir(path.join(workspaceRoot, ".opencode"), { recursive: true });
await writeFile(path.join(workspaceRoot, "fixture.md"), "Synthetic acceptance preview\n");
// All server fetches, including accidental Cloud/telemetry, fail before egress.
const originalFetch = globalThis.fetch;
const blocked: string[] = [];
const allowedOrigins = new Set<string>();
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
  if (!allowedOrigins.has(url.origin)) {
    blocked.push(url.origin + url.pathname);
    throw new Error(`Non-loopback server request blocked: ${url.origin}${url.pathname}`);
  }
  return originalFetch(input, init);
}) as typeof fetch;

const realEngine = process.env.SESSION_REAL_ENGINE === "1";
assert.equal(process.env.REAL_ENGINE_DOTENV_CANARY, undefined, "Bun loaded dotenv");
let engine: Awaited<ReturnType<typeof import("../../server/src/managed-opencode").createManagedOpencodeServer>> | undefined;
let provider: ReturnType<typeof syntheticProvider> | undefined;
let sessionId = "smoke-session";
if (realEngine) {
  provider = syntheticProvider();
  await configureSyntheticProvider(provider.server.port);
  const version = spawnSync(process.env.REAL_ENGINE_BIN!, ["--version"], { cwd: workspaceRoot, env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(version.status, 0, version.stderr); assert.equal(version.stdout.trim(), "1.19.3");
  const { createManagedOpencodeServer } = await import("../../server/src/managed-opencode");
  engine = await createManagedOpencodeServer({ bin: process.env.REAL_ENGINE_BIN, cwd: workspaceRoot, timeoutMs: 15000 });
  allowedOrigins.add(engine.url);
  const headers = { authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`, "content-type": "application/json", "x-opencode-directory": workspaceRoot };
  const read = async (route: string, body?: object) => {
    const response = await fetch(engine.url + route, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `engine ${route}: ${response.status}`); return response.json() as any;
  };
  assert.equal((await read("/global/health")).version, "1.19.3");
  assert.deepEqual((await read("/provider")).connected, ["fixture"]);
  assert.deepEqual((await read("/config")).plugin ?? [], []);
  sessionId = (await read("/session", { title: "Real engine dual renderer acceptance" })).id;
  assert.ok(sessionId.startsWith("ses_"));
  console.info("PASS managed OpenCode 1.19.3 health/provider/config/real session");
}
const session = { id: sessionId, slug: "isolated", title: "Real Server acceptance", directory: workspaceRoot,
  version: "1", time: { created: Date.now(), updated: Date.now() } };
const model = { id: "synthetic", providerID: "fixture", name: "Synthetic fixture", family: "fixture", status: "active", release_date: "2026-01-01",
  capabilities: { temperature: false, reasoning: false, attachment: false, toolcall: true, input: { text: true }, output: { text: true } },
  cost: { input: 0, output: 0 }, limit: { context: 32000, output: 4096 }, variants: {} };
const providers = { all: [{ id: "fixture", name: "Fixture", source: "config", models: { synthetic: model } }], connected: ["fixture"], default: { fixture: "synthetic" } };
const streams = new Set<ReadableStreamDefaultController>();
const encoder = new TextEncoder();
const requests: any[] = [], prompts: any[] = [], aborts: any[] = [];
const messages: any[] = [];
let busy = false;
const emit = (type: string, properties: any) => {
  for (const stream of streams) {
    try { stream.enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties })}\n\n`)); } catch { streams.delete(stream); }
  }
};
function addMessage(text: string, role: string, id?: string) {
  const info = { id: id ?? `msg_fixture_${messages.length}`, sessionID: sessionId, role, time: { created: Date.now() },
    ...(role === "user" ? { agent: "build", model: { providerID: "fixture", modelID: "synthetic" } } : {
      parentID: messages.at(-1)?.info.id, providerID: "fixture", modelID: "synthetic", mode: "build", agent: "build",
      path: { cwd: workspaceRoot, root: workspaceRoot }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }) };
  const part = { id: `prt_${info.id}`, sessionID: sessionId, messageID: info.id, type: "text", text };
  messages.push({ info, parts: [part] });
  emit("message.updated", { info }); emit("message.part.updated", { part });
}
addMessage("fixture-initial-message", "user");
let server: Awaited<ReturnType<typeof import("../../server/src/server").startServer>>;
const events: any[] = [], health = streamHealth(), streamAbort = new AbortController();
let streamTask: Promise<void> | undefined, droppedTerminalEvents = 0;
const rounds: any[] = [];
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
  const url = new URL(req.url), p = url.pathname;
  if (realEngine && p.startsWith("/__control/")) {
    health.check();
    if (p === "/__control/mode/complete" || p === "/__control/mode/stall") { provider!.setMode(p.endsWith("stall") ? "stall" : "complete"); return Response.json(true); }
    if (p === "/__control/round") { rounds.push({ ...Object.fromEntries(url.searchParams), startIndex: events.length }); return Response.json(true); }
    if (p === "/__control/abort-index") { rounds.at(-1).abortIndex = events.length; return Response.json(true); }
    if (p === "/__control/evidence") return Response.json({ rounds: rounds.map(r => ({ ...r, evidence: roundSseEvidence(events, { ...r, sessionId, answer: provider!.answer }) })), droppedTerminalEvents,
      errors: events.flatMap((e, index) => {
        const info = e.properties?.info, error = e.type === "session.error" ? e.properties?.error : info?.error;
        return error ? [{ index, type: e.type, errorName: error.name, messageId: info?.id }] : [];
      }) });
    if (p === "/__control/metrics") return Response.json({ requests, prompts: provider!.requests, aborts: Array.from({ length: provider!.cancelled }), blocked, unexpected: provider!.unexpected });
  }
  if (p === "/__control/metrics") return Response.json({ requests, prompts, aborts, busy, connections: streams.size, blocked });
  if (p === "/__control/journal") {
    const db = new Database(path.join(root, "runtime.sqlite"), { readonly: true });
    try { return Response.json(db.query("SELECT run_id, event, status, terminal_reason, occurred_at FROM session_run_journal ORDER BY id").all()); }
    finally { db.close(); }
  }
  // The account/control origin must never stand in for real engine responses.
  if (realEngine && !p.startsWith("/jwork/api/v1/")) return Response.json({ code: "fixture_not_found", path: p }, { status: 404 });
  requests.push({ path: p, method: req.method, directory: req.headers.get("x-opencode-directory") });
  if (p === "/event" || p === "/global/event") {
    let controller: ReadableStreamDefaultController;
    return new Response(new ReadableStream({ start(c) { controller = c; streams.add(c); c.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)); },
      cancel() { streams.delete(controller); } }), { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (p === "/provider") return Response.json(providers);
  if (p === "/provider/auth") return Response.json({});
  if (p === "/config" || p === "/global/config") return Response.json({ model: "fixture/synthetic", provider: {}, mcp: {} });
  if (p === "/config/providers") return Response.json({ providers: providers.all, default: providers.default });
  if (p === "/agent") return Response.json([{ name: "build", mode: "primary", native: true, hidden: false, permission: [], options: {} }]);
  if (p === "/session/status") return Response.json(busy ? { [sessionId]: { type: "busy" } } : {});
  if (p === `/api/session/${sessionId}/permission` || p === `/api/session/${sessionId}/question`) return Response.json({ data: [] });
  if (p === "/session") return Response.json([session]);
  if (p === `/session/${sessionId}`) return Response.json(session);
  if (p === `/session/${sessionId}/message`) return Response.json(messages);
  if (p === `/session/${sessionId}/prompt_async` && req.method === "POST") {
    const body = await req.json() as any; prompts.push(body); busy = true;
    for (const part of body.parts ?? []) if (part.type === "text" && !part.synthetic) addMessage(part.text, "user", body.messageID);
    emit("session.status", { sessionID: sessionId, status: { type: "busy" } });
    addMessage(`real-server-answer-${prompts.length}`, "assistant");
    return new Response(null, { status: 204 });
  }
  if (p === `/session/${sessionId}/abort` && req.method === "POST") {
    aborts.push({ sessionId }); busy = false;
    emit("session.status", { sessionID: sessionId, status: { type: "idle" } }); emit("session.idle", { sessionID: sessionId });
    return Response.json(true);
  }
  if (p === "/permission" || p === "/question" || p === "/command" || p === "/skill" || p === "/tool/ids" || p.endsWith("/todo") || p === "/file" || p === "/find/file") return Response.json([]);
  if (p === "/mcp" || p === "/lsp" || p === "/formatter") return Response.json({});
  if (p === "/path") return Response.json({ home: path.join(root, "home"), directory: workspaceRoot, worktree: workspaceRoot, config: path.join(root, "config"), state: root });
  if (p === "/global/health") return Response.json({ healthy: true, version: "synthetic" });
  // Minimal synthetic account service; real DenAuthProvider and signin gate use it.
  if (p.endsWith("/v1/me")) return Response.json({ user: { id: "synthetic-user", name: "Synthetic", email: "synthetic@example.invalid" } });
  if (p.endsWith("/v1/me/orgs")) return Response.json({ orgs: [], activeOrgId: null, activeOrgSlug: null });
  if (p.endsWith("/v1/me/desktop-config")) return Response.json({ connectEnabled: false });
  if (p.endsWith("/v1/resources")) return Response.json({ providers: [], skills: [], mcps: [], plugins: [] });
  return Response.json({ code: "fixture_not_found", path: p }, { status: 404 });
} });
const controlOrigin = `http://127.0.0.1:${upstream.port}`;
const engineOrigin = engine?.url ?? controlOrigin;
allowedOrigins.add(controlOrigin);
const heartbeat = setInterval(() => emit("server.heartbeat", {}), 1000);
const { startServer } = await import("../../server/src/server");
server = await startServer({ host: "127.0.0.1", port: 0, token: "synthetic-fixture-only", hostToken: "synthetic-host-only",
  configPath: path.join(root, "server.json"), approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"],
  workspaces: [{ id: "smoke-workspace", name: "Isolated workspace", path: workspaceRoot, preset: "starter", workspaceType: "local", baseUrl: engineOrigin,
    ...(engine ? { opencodeUsername: engine.username, opencodePassword: engine.password } : {}) }],
  authorizedRoots: [workspaceRoot], readOnly: false, startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false });
const origin = `http://127.0.0.1:${server.port}`;
allowedOrigins.add(origin);
if (realEngine) {
  const response = await fetch(`${origin}/workspace/smoke-workspace/opencode/event`, { headers: { authorization: "Bearer synthetic-fixture-only" }, signal: streamAbort.signal });
  assert.equal(response.status, 200);
  streamTask = consumeSse(response.body!, streamAbort.signal, (event: any) => {
    if (process.env.SESSION_DROP_TERMINAL_EVENTS === "1" && isTerminalEvent(event)) { droppedTerminalEvents++; return; }
    events.push(event);
  }, health);
}
console.info(`ACCEPTANCE_READY ${JSON.stringify({ origin, engineOrigin, controlOrigin, sessionId, workspaceRoot,
  ...(engine ? { engineAuthorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}` } : {}) })}`);
let closing = false;
async function close() {
  if (closing) return; closing = true;
  const force = setTimeout(() => process.exit(1), 5000);
  clearInterval(heartbeat);
  let failure; try { health.check(); } catch (error) { failure = error; }
  streamAbort.abort(); await streamTask;
  for (const c of streams) { try { c.close(); } catch {} } streams.clear();
  await server.stop(true); await engine?.close(); await provider?.server.stop(true); await upstream.stop(true);
  clearTimeout(force); if (failure) { console.error(failure); process.exit(1); } process.exit(0);
}
process.on("SIGTERM", close); process.on("SIGINT", close);
setTimeout(() => { console.error("Fixture lifetime exceeded 210s"); void close(); }, 210000).unref();

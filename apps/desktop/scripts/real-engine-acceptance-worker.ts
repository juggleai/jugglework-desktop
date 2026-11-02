// Bun worker: only the provider HTTP protocol is synthetic. Engine/Server/DB are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Database } from "bun:sqlite";
import { consumeSse, streamHealth, roundSseEvidence, isTerminalEvent } from "./real-engine-acceptance-helpers.mjs";
import { syntheticProvider, configureSyntheticProvider } from "./real-engine-acceptance-provider";

const root = process.env.REAL_ENGINE_ACCEPTANCE_ROOT!;
assert.ok(root && path.isAbsolute(root));
assert.equal(process.cwd(), root);
assert.equal(process.env.HOME, path.join(root, "home"));
assert.equal(process.env.REAL_ENGINE_DOTENV_CANARY, undefined, "Bun auto-loaded dotenv");
const workspace = path.join(root, "workspace");
// Defense in depth for in-process Server fetches; native sidecar is confined by
// inherited Seatbelt, not this wrapper. No Cloud request even reaches the OS.
const nativeFetch = globalThis.fetch;
const blockedFetches: string[] = [];
const allowedOrigins = new Set<string>();
globalThis.fetch = ((input: any, init?: any) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  if (!allowedOrigins.has(url.origin)) {
    blockedFetches.push(url.origin + url.pathname);
    throw Error("Acceptance denied unexpected Server fetch origin");
  }
  return nativeFetch(input, init);
}) as typeof fetch;
const providerFixture = syntheticProvider();
const { server: provider, requests, unexpected, answer } = providerFixture;

let engine: Awaited<ReturnType<typeof import("../../server/src/managed-opencode").createManagedOpencodeServer>> | undefined;
let server: Awaited<ReturnType<typeof import("../../server/src/embedded").startEmbeddedServer>> | undefined;
const streamAbort = new AbortController();
let streamTask: Promise<void> | undefined;
const events: any[] = [];
const healthOfStream = streamHealth();
const dropTerminalEvents = process.argv.slice(2).includes("--drop-terminal-events");
let droppedTerminalEvents = 0;
let stage = "synthetic configuration";
const deadline = setTimeout(() => { console.error(`FAIL worker deadline at ${stage}`); process.exit(1); }, 100000);
const wait = async (label: string, predicate: () => any | Promise<any>, timeout = 18000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    healthOfStream.check();
    const value = await predicate();
    healthOfStream.check();
    if (value) return value;
    await Bun.sleep(100);
  }
  healthOfStream.check();
  throw Error(`Timeout: ${label}`);
};
try {
  await configureSyntheticProvider(provider.port);
  stage = "bundled --version";
  const version = spawnSync(process.env.REAL_ENGINE_BIN!, ["--version"], { cwd: workspace, env: process.env, encoding: "utf8", timeout: 10000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), process.env.REAL_ENGINE_EXPECTED_VERSION);
  console.info(`PASS bundled --version ${version.stdout.trim()}`);
  stage = "managed engine startup";
  const { createManagedOpencodeServer } = await import("../../server/src/managed-opencode");
  engine = await createManagedOpencodeServer({ bin: process.env.REAL_ENGINE_BIN, cwd: workspace, timeoutMs: 15000 });
  assert.ok(engine.pid && engine.isAlive());
  allowedOrigins.add(engine.url);
  const engineHeaders = { Authorization: `Basic ${Buffer.from(`${engine.username}:${engine.password}`).toString("base64")}`, "x-opencode-directory": workspace, "content-type": "application/json" };
  async function engineJson(p: string, body?: object) {
    const res = await fetch(engine!.url + p, { headers: engineHeaders, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
    assert.ok(res.ok, `engine ${p}: ${res.status} ${await res.clone().text()}`); return res.json() as Promise<any>;
  }
  stage = "engine health/provider/session";
  const health = await engineJson("/global/health");
  assert.equal(health.healthy, true); assert.equal(health.version, process.env.REAL_ENGINE_EXPECTED_VERSION);
  const catalog = await engineJson("/provider");
  assert.deepEqual(catalog.connected, ["fixture"]);
  assert.ok(catalog.all.find((p: any) => p.id === "fixture")?.models.synthetic);
  const effectiveConfig = await engineJson("/config");
  assert.deepEqual(effectiveConfig.plugin ?? [], [], "engine loaded configured/default plugins");
  assert.equal(effectiveConfig.model, "fixture/synthetic");
  const session = await engineJson("/session", { title: "Isolated real engine acceptance" });
  assert.ok(session.id.startsWith("ses_")); assert.equal(session.directory, workspace);
  console.info("PASS real engine startup/health/provider catalog/session create");
  stage = "embedded Server startup";
  await writeFile(process.env.JUGGLEWORK_SERVER_CONFIG!, JSON.stringify({ workspaces: [{ id: "acceptance", name: "Synthetic", path: workspace }], authorizedRoots: [workspace] }));
  const { startEmbeddedServer } = await import("../../server/src/embedded");
  server = await startEmbeddedServer({ workspaces: [], configPath: process.env.JUGGLEWORK_SERVER_CONFIG,
    host: "127.0.0.1", port: 0, token: "synthetic-server-only", hostToken: "synthetic-host-only", approvalMode: "auto", logRequests: false,
    opencodeBaseUrl: engine.url, opencodeDirectory: workspace, opencodeUsername: engine.username, opencodePassword: engine.password });
  allowedOrigins.add(server.url);
  const headers = { Authorization: "Bearer synthetic-server-only", "content-type": "application/json" };
  const prefix = "/workspace/acceptance";
  async function api(p: string, body?: object) {
    const res = await fetch(server!.url + prefix + p, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
    const text = await res.text(); assert.ok(res.ok, `Server ${p}: ${res.status} ${text}`); return JSON.parse(text);
  }
  stage = "Server SSE subscription";
  const response = await fetch(server.url + prefix + "/opencode/event", { headers, signal: streamAbort.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  streamTask = consumeSse(response.body!, streamAbort.signal, (event: any) => {
    // Negative control changes only this observer, never engine/Server/provider.
    if (dropTerminalEvents && isTerminalEvent(event)) { droppedTerminalEvents++; return; }
    events.push(event);
  }, healthOfStream);
  await wait("real SSE connected", () => events.some(e => e.type === "server.connected"));
  const journal = () => {
    const db = new Database(process.env.JUGGLEWORK_RUNTIME_DB!, { readonly: true });
    try { return db.query("SELECT run_id,event,status,terminal_reason FROM session_run_journal ORDER BY id").all() as any[]; }
    finally { db.close(); }
  };
  const terminal = async (runId: string, reason: string) => wait(`journal terminal ${reason}`, async () => {
    // Production read endpoint reconciles from actual engine status/messages;
    // never send observations or write fixture runs/journal rows.
    await api("/session-runs");
    return journal().some(r => r.run_id === runId && r.event === "run_terminal" && r.terminal_reason === reason);
  });
  stage = "Server start + provider SSE + completion journal";
  const sessionPath = `/sessions/${session.id}`;
  const start = async (text: string, correlation: string) => api(sessionPath + "/runs/start", {
    origin: "local-renderer", startCommandCorrelationId: correlation,
    prompt: { model: { providerID: "fixture", modelID: "synthetic" }, agent: "build", parts: [{ type: "text", text }] },
  });
  const completeStartIndex = events.length;
  const completed = await start("COMPLETE_SYNTHETIC_REQUEST", "complete-request");
  assert.equal(completed.disposition, "started");
  await wait("actual provider completion request", () => requests.some(r => JSON.stringify(r.body.messages).includes("COMPLETE_SYNTHETIC_REQUEST")));
  await terminal(completed.run.runId, "completed");
  console.info("PASS completed journal reconciliation (independent of SSE terminal assertion)");
  stage = "current completion SSE busy -> final -> idle";
  const completionSse = await wait("current completion Server SSE busy/final/idle", () => roundSseEvidence(events, {
    startIndex: completeStartIndex, sessionId: session.id, prompt: "COMPLETE_SYNTHETIC_REQUEST", answer,
  }));
  console.info(`SSE COMPLETE ${JSON.stringify(completionSse)}`);
  const messages = await api(sessionPath + "/messages");
  assert.ok(JSON.stringify(messages).includes(answer));
  console.info("PASS Server runs/start -> real engine -> actual provider HTTP/SSE -> Server SSE/messages -> completed journal");
  stage = "stalled provider + Server abort";
  providerFixture.setMode("stall");
  const abortStartIndex = events.length;
  const aborted = await start("STALL_SYNTHETIC_REQUEST", "abort-request");
  await wait("actual stalled provider request", () => requests.some(r => r.mode === "stall" && JSON.stringify(r.body.messages).includes("STALL_SYNTHETIC_REQUEST")));
  await wait("current abort round busy SSE", () => events.slice(abortStartIndex).some(e => e.type === "session.status"
    && e.properties?.sessionID === session.id && e.properties.status?.type === "busy"));
  const abortIndex = events.length;
  const abort = await api(sessionPath + `/runs/${aborted.run.runId}/abort`, { abortCommandCorrelationId: "abort-command" });
  assert.equal(abort.abortRequested, true);
  await terminal(aborted.run.runId, "aborted");
  await wait("provider transport cancelled by real engine", () => providerFixture.cancelled > 0);
  stage = "current abort SSE busy -> abort -> idle";
  const abortSse = await wait("current abort Server SSE busy/idle", () => roundSseEvidence(events, {
    startIndex: abortStartIndex, sessionId: session.id, prompt: "STALL_SYNTHETIC_REQUEST", abortIndex,
  }));
  assert.notEqual(completionSse.userMessageId, abortSse.userMessageId, "abort reused previous turn evidence");
  console.info(`SSE ABORT ${JSON.stringify({ ...abortSse, providerCancelled: providerFixture.cancelled > 0 })}`);
  const rows = journal();
  for (const run of [completed.run, aborted.run]) for (const event of ["run_reserved", "run_started", "run_terminal"])
    assert.ok(rows.some(r => r.run_id === run.runId && r.event === event), `${event} missing`);
  for (const event of ["abort_requested", "abort_accepted"])
    assert.ok(rows.some(r => r.run_id === aborted.run.runId && r.event === event));
  assert.deepEqual(unexpected, []); assert.deepEqual(blockedFetches, [], "Server attempted a non-fixture fetch");
  assert.equal(requests.length, 2, "unexpected extra model requests");
  assert.ok((await stat(process.env.OPENCODE_DB!)).size > 0, "real engine DB missing");
  assert.equal(JSON.parse(await readFile(process.env.OPENCODE_CONFIG!, "utf8")).plugin.length, 0);
  console.info("PASS run-ID abort -> real engine cancellation -> provider disconnect -> aborted journal");
  healthOfStream.check();
  console.info(`EVIDENCE ${JSON.stringify({ engineVersion: health.version, completionSse, abortSse, effectivePlugins: effectiveConfig.plugin ?? [], blockedServerFetches: blockedFetches.length, providerRequests: requests.map(r => ({ path: r.path, mode: r.mode })), eventTypes: [...new Set(events.map(e => e.type))], journal: rows })}`);
  stage = "graceful shutdown";
} catch (error) {
  console.error(`FAIL boundary: ${stage}; droppedTerminalEvents=${droppedTerminalEvents}`); throw error;
} finally {
  // A fault before cleanup cannot be converted to an expected abort by cleanup.
  let streamFailure;
  try { healthOfStream.check(); } catch (error) { streamFailure = error; }
  streamAbort.abort();
  const cleanup = await Promise.allSettled([streamTask, server?.stop(), engine?.close(), provider.stop(true)]);
  clearTimeout(deadline);
  const errors = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (streamFailure) errors.push(streamFailure);
  if (errors.length) throw new AggregateError(errors, "real-engine acceptance cleanup failed");
}
assert.equal(engine?.isAlive(), false);
console.info("PASS real-engine acceptance complete (engine + Server API only; synthetic upstream; no production provider/UI claim)");
process.exit(0);

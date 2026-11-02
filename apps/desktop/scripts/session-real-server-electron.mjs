import { app, BrowserWindow, ipcMain, session } from "electron";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFileWindows } from "../electron/file-windows.mjs";
import { createFileEditor } from "../electron/file-editor.mjs";
import { mainProcessFetchBody, mainProcessFetchResponse } from "../electron/main-fetch.mjs";
import { buildFileWindowPreload } from "./build-file-window-preload.mjs";
import { trackFixtureChild } from "./session-real-server-child.mjs";

const root = process.env.JUGGLEWORK_SESSION_ACCEPTANCE_ROOT;
const realEngine = process.env.SESSION_REAL_ENGINE === "1";
assert.ok(root && process.env.HOME === path.join(root, "home"), "use the isolated Node launcher");
const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const appRoot = path.resolve(desktopRoot, "../app");
app.setPath("home", process.env.HOME); app.setPath("appData", path.join(root, "data"));
app.setPath("userData", path.join(root, "userData")); app.setPath("sessionData", path.join(root, "sessionData"));
app.commandLine.appendSwitch("disable-background-networking");
if (realEngine) app.commandLine.appendSwitch("use-mock-keychain");
app.on("window-all-closed", () => {});

let stage = "fixture startup", main, files, vite, child, fixtureChild, cleaning = false;
const checks = [], errors = [], blockedNetwork = [], commands = [], wire = [], rendererSse = [];
let fileSseConnected = false;
let backend, conflictArmed = false, stopObservation, sessionId = "smoke-session";
const pass = (label) => { checks.push(label); console.info(`PASS ${label}`); };
const mark = (label) => { stage = label; console.info(`STAGE ${label}`); };
const evaluate = (window, expression) => window.webContents.executeJavaScript(expression, true);
const wait = async (label, predicate, timeout = 20000) => {
  stage = label; const end = Date.now() + timeout;
  while (Date.now() < end) { fixtureChild?.check(); if (await predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
};
const body = (window) => evaluate(window, "document.body.innerText");
const has = async (window, text) => (await body(window)).includes(text);
const selector = '[data-session-surface-id] [contenteditable="true"]';
const draft = (window) => evaluate(window, `document.querySelector(${JSON.stringify(selector)})?.textContent`);
const type = async (window, text) => {
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).focus()`);
  window.webContents.selectAll(); await window.webContents.insertText(text);
  await wait(`type ${text}`, async () => await draft(window) === text);
};
const click = async (window, title) => {
  if (realEngine) await wait(`enabled ${title}`, () => evaluate(window, `(() => {const b=document.querySelector('button[title=${JSON.stringify(title)}]');return !!b && !b.disabled;})()`));
  return evaluate(window, `(() => { const b = document.querySelector('button[title=${JSON.stringify(title)}]'); if (!b || b.disabled) throw Error('Unavailable: ${title}'); b.click(); })()`);
};
const store = (expr) => `import('/src/react-app/domains/session/surface/composer-state-store.ts').then(({useComposerStateStore:s})=>(${expr.replaceAll("smoke-session", sessionId)}))`;
const state = (window) => evaluate(window, `import('/src/react-app/infra/query-client.ts').then(({getReactQueryClient})=>{
  const q=getReactQueryClient();return {status:q.getQueryData(['react-session-status','smoke-workspace',${JSON.stringify(sessionId)}]),
  messages:q.getQueryData(['react-session-transcript','smoke-workspace',${JSON.stringify(sessionId)}])?.map(m=>({id:m.id,role:m.role,parts:m.parts.filter(p=>p.type==='text').map(p=>p.text)}))};})`);
const control = async (name) => {
  const r = await fetch(`${backend.controlOrigin ?? backend.engineOrigin}/__control/${name}`, { signal: AbortSignal.timeout(5000) });
  assert.ok(r.ok); return r.json();
};
const beginRound = (prompt) => control(`round?prompt=${encodeURIComponent(prompt)}`);
const sseEvidence = async () => {
  mark("current-round SSE terminal evidence (HTTP/journal cannot substitute)");
  await wait(stage, async () => (await control("evidence")).rounds.every(r => r.evidence));
  const result = await control("evidence");
  assert.equal(new Set(result.rounds.map(r => r.evidence.userMessageId)).size, result.rounds.length);
  console.info(`SSE EVIDENCE ${JSON.stringify(result)}`);
};
async function cleanup(code) {
  if (cleaning) return; cleaning = true;
  const force = setTimeout(() => app.exit(1), 8000);
  try {
    files?.dispose(); if (main && !main.isDestroyed()) main.destroy();
    await vite?.close();
    await fixtureChild?.close();
  } catch (e) { console.error("CLEANUP FAILED", e); code = 1; }
  clearTimeout(force); app.exit(code);
}
setTimeout(() => { console.error(`ACCEPTANCE TIMEOUT: ${stage}`); void cleanup(1); }, 220000);

async function run() {
try {
  const fixture = fileURLToPath(new URL("./session-real-server-fixture.ts", import.meta.url));
  child = spawn(realEngine ? "/usr/bin/sandbox-exec" : "bun", realEngine ? ["-f", process.env.SESSION_ENGINE_PROFILE,
    process.env.SESSION_ENGINE_BUN, "--no-env-file", `--config=${path.join(root, "bunfig.toml")}`, "--no-install", fixture] : ["--no-env-file", `--config=${path.join(root, "bunfig.toml")}`, "--no-install", fixture],
    { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  fixtureChild = trackFixtureChild(child);
  backend = await new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => reject(new Error("Real Server startup timeout")), 20000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (line.startsWith("ACCEPTANCE_READY ")) { clearTimeout(timeout); resolve(JSON.parse(line.slice(17))); }
        else if (line.startsWith("PASS ")) console.info(line);
      }
    });
    child.stderr.on("data", (chunk) => console.error(`fixture: ${chunk.toString().trim()}`));
    child.once("exit", (code) => { clearTimeout(timeout); if (!cleaning) reject(new Error(`Fixture exited: ${code}`)); });
    child.once("error", reject);
  });
  sessionId = backend.sessionId;
  mark("Electron ready"); await app.whenReady();
  const req = createRequire(path.join(appRoot, "package.json"));
  const { createServer } = await import(req.resolve("vite"));
  const { default: react } = await import(req.resolve("@vitejs/plugin-react"));
  const { default: tailwindcss } = await import(req.resolve("@tailwindcss/vite"));
  const entry = fileURLToPath(new URL("./session-real-server-main.tsx", import.meta.url));
  mark("isolated Vite create");
  vite = await createServer({ root: appRoot, configFile: false, envFile: false, envPrefix: "JUGGLEWORK_SESSION_ACCEPTANCE_PUBLIC_",
    resolve: { alias: { "@": path.join(appRoot, "src") } }, cacheDir: path.join(root, "vite-cache"),
    server: { host: "127.0.0.1", port: 0, fs: { allow: [path.resolve(appRoot, "../..")] } },
    plugins: [tailwindcss(), react(), { name: "real-server-acceptance-entry", configureServer(server) {
      server.middlewares.use("/__real-server.html", async (req, res, next) => {
        try { const html = await server.transformIndexHtml(req.originalUrl, `<!doctype html><html lang="en"><body><div id="root" style="height:100vh"></div><script type="module" src="/@fs/${entry}"></script></body></html>`);
          res.setHeader("content-type", "text/html"); res.end(html); } catch (e) { next(e); }
      });
    } }],
  });
  assert.equal(vite.config.configFile, undefined);
  assert.deepEqual(Object.keys(vite.config.env).filter(k => k.startsWith("VITE_")), []);
  mark("isolated Vite listen"); await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  const confine = (partition) => partition.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (url.origin === backend.origin && url.pathname.endsWith("/opencode/event")) rendererSse.push(details.webContentsId);
    const allowed = [origin, backend.origin, backend.engineOrigin, backend.controlOrigin].includes(url.origin) || ["data:", "blob:", "devtools:"].includes(url.protocol) || (url.protocol === "ws:" && url.host === new URL(origin).host);
    if (!allowed) blockedNetwork.push(url.origin + url.pathname);
    callback({ cancel: !allowed });
  });
  confine(session.defaultSession); app.on("session-created", confine);
  mark("build restricted preload");
  const preloadPath = await buildFileWindowPreload({ output: path.join(root, "file-window-preload.cjs") });
  const bootstrap = { baseUrl: backend.controlOrigin, requireSignin: true };
  const workspace = { id: "smoke-workspace", path: backend.workspaceRoot, name: "Isolated workspace", workspaceType: "local", preset: "starter" };
  const list = { selectedId: workspace.id, activeId: workspace.id, workspaces: [workspace] };
  const serverInfo = { running: true, baseUrl: backend.origin, clientToken: "synthetic-fixture-only", ownerToken: "synthetic-fixture-only", hostToken: "synthetic-host-only", port: new URL(backend.origin).port, remoteAccessEnabled: false };
  const engine = { running: true, baseUrl: backend.engineOrigin, managedByServer: false, projectDir: backend.workspaceRoot, runtime: "direct" };
  ipcMain.on("jugglework:desktop-bootstrap-sync", (e) => { e.returnValue = bootstrap; });
  ipcMain.handle("jugglework:system:architecture", () => ({ mismatch: false, appArch: process.arch, systemArch: process.arch, platform: process.platform, version: "0.0.0" }));
  ipcMain.handle("jugglework:migration:read", () => null);
  ipcMain.handle("jugglework:pet:state", () => null);
  ipcMain.handle("jugglework:updater:getChannel", () => "stable");
  main = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: {
    preload: path.join(desktopRoot, "electron/preload.mjs"), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  const watch = (window, host) => {
    window.webContents.on("preload-error", (_e, _p, error) => errors.push(`${host} preload: ${error.message}`));
    window.webContents.on("render-process-gone", (_e, detail) => errors.push(`${host} crash: ${detail.reason}`));
    window.webContents.on("console-message", (_e, ...args) => {
      const message = typeof args[0] === "object" ? args[0].message : args[1];
      if (/Uncaught|does not provide an export|Failed to resolve|Error:/.test(message ?? "")) errors.push(`${host}: ${message}`);
    });
  };
  watch(main, "main");
  const client = {
    getJson: async (route) => { const r = await fetch(`${backend.origin}${route}`, { headers: { authorization: "Bearer synthetic-fixture-only" }, signal: AbortSignal.timeout(5000) }); assert.ok(r.ok, `${route} ${r.status}`); return r.json(); },
    postJson: async (route, input) => { const r = await fetch(`${backend.origin}${route}`, { method: "POST", headers: { authorization: "Bearer synthetic-fixture-only", "content-type": "application/json" }, body: JSON.stringify(input), signal: AbortSignal.timeout(5000) }); assert.ok(r.ok, `${route} ${r.status}`); return r.json(); },
  };
  const editor = createFileEditor({ client, getWindows: () => [main, ...files.windows()], authorizeFileEditor: (...a) => files.authorizeFileEditor(...a), canReceiveFileEditor: (...a) => files.canReceiveFileEditor(...a) });
  files = createFileWindows({ client, getAccess: async () => ({ baseUrl: backend.origin, clientToken: "synthetic-fixture-only" }), office: {}, fileEditor: editor,
    fetcher: async (url, init) => {
      assert.equal(new URL(url).origin, backend.origin, "file Main SSE fetch confined");
      const response = await fetch(url, init);
      if (new URL(url).pathname.endsWith("/opencode/event") && response.ok && response.headers.get("content-type")?.includes("text/event-stream")) fileSseConnected = true;
      return response;
    },
    getMainWindow: () => main, getDesktopConfig: async () => ({}), getAppearance: async () => ({ lang: "en", theme: "light" }),
    preloadPath, recentPath: path.join(root, "recent.json"), loadWindow: (window) => { watch(window, "file"); return window.loadURL(`${origin}/file-window.html`); } });
  files.registerIpc(ipcMain); editor.registerIpc(ipcMain);
  // Only desktop runtime discovery is synthetic. HTTP/SSE, run admission,
  // session snapshots, authorization, journal and abort are the real Server.
  ipcMain.handle("jugglework:desktop", async (event, command, ...args) => {
    commands.push(command);
    if (command === "__fetch") {
      const [url, init = {}] = args;
        assert.ok([backend.origin, backend.engineOrigin, backend.controlOrigin].includes(new URL(url).origin), "desktop fetch confined");
      const host = event.sender === main.webContents ? "main" : "file";
      const record = { host, path: new URL(url).pathname, method: init.method ?? "GET" }; wire.push(record);
      if (realEngine && record.path.endsWith("/observations")) {
        record.observationStatus = JSON.parse(mainProcessFetchBody(init)).status;
        record.requestedAt = Date.now();
      }
      if (record.path.endsWith("/runs/start") && conflictArmed) {
        conflictArmed = false;
        const contender = await client.postJson(`/workspace/smoke-workspace/sessions/${sessionId}/runs/start`, {
          origin: "local-renderer", startCommandCorrelationId: "synthetic-race-winner", whenBusy: "reject", prompt: { model: { providerID: "fixture", modelID: "synthetic" }, agent: "build", parts: [{ type: "text", text: "external-race-winner" }] },
        });
        assert.equal(contender.disposition, "started");
      }
      if (host === "file") {
        const response = await files.fetch(event, url, init, async (target, options) => {
          // Observe at the actual network boundary, after production ownership
          // checks and beforeAbort -> Main ACK, never before files.fetch itself.
          if (/\/runs\/[^/]+\/abort$/.test(new URL(target).pathname)) {
            if (realEngine) await control("abort-index");
            stopObservation = { queue: await evaluate(main, store(`s.getState().queuedDrafts[${JSON.stringify(sessionId)}]?.length ?? 0`)),
              claims: await evaluate(main, store("s.getState().queueClaims")), mainDraft: await draft(main), fileDraft: await draft(files.windows()[0]) };
          }
          return fetch(target, options);
        });
        record.status = response.status; return response;
      }
      const headers = new Headers(init.headers);
      if (realEngine && /\/runs\/[^/]+\/abort$/.test(record.path)) await control("abort-index");
      if (new URL(url).origin === backend.engineOrigin && backend.engineAuthorization) headers.set("authorization", backend.engineAuthorization);
      if (new URL(url).origin === backend.origin && !headers.has("authorization")) headers.set("authorization", "Bearer synthetic-fixture-only");
      const response = await fetch(url, { method: init.method, headers, body: mainProcessFetchBody(init), signal: AbortSignal.timeout(10000) });
      record.status = response.status;
      if (realEngine && record.observationStatus) record.respondedAt = Date.now();
      return mainProcessFetchResponse(response);
    }
    if (command === "workspaceBootstrap" || command === "workspaceSetSelected" || command === "workspaceSetRuntimeActive") return list;
    if (command === "juggleworkServerInfo" || command === "juggleworkServerRestart") return serverInfo;
    if (command === "engineInfo") return engine;
    if (command === "runtimeBootstrap") return { ok: true, engine, juggleworkServer: serverInfo };
    if (command === "getDesktopBootstrapConfig") return bootstrap;
    if (command === "setDesktopBootstrapConfig") return Object.assign(bootstrap, args[0]);
    if (command === "migrationSnapshotRead" || command === "migrationReadSnapshot") return null;
    if (command === "drainPendingDeepLinks") return [];
    if (command === "getBuildInfo") return { version: "0.0.0", os: "darwin", arch: process.arch };
    return null;
  });
  mark("load Main entry");
  await main.loadURL(`${origin}/__real-server.html?backend=${encodeURIComponent(backend.origin)}&root=${encodeURIComponent(backend.workspaceRoot)}&session=${sessionId}#/workspace/smoke-workspace/session/${sessionId}`);
  mark("open file window");
  await files.open({ workspaceId: workspace.id, sessionId, path: "fixture.md", conversationOptions: { model: { providerID: "fixture", modelID: "synthetic" }, agent: "build" } });
  const file = files.windows()[0];
  await wait("FileWindowApp toggle", () => has(file, "AI conversation"), 60000);
  await evaluate(file, `([...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='AI conversation')).click()`);
  await wait("full AppRoot/SessionRoute hydration", async () => realEngine ? (await draft(main)) !== undefined && (await draft(file)) !== undefined && !!(await state(main)).status && !!(await state(file)).status : await has(main, "fixture-initial-message") && await has(file, "fixture-initial-message"), 60000);
  assert.notEqual(main.webContents.getProcessId(), file.webContents.getProcessId());
  assert.notEqual(main.webContents.session, file.webContents.session);
  assert.equal(file.webContents.session.isPersistent(), false);
  assert.equal(file.webContents.getLastWebPreferences().sandbox, true);
  assert.ok(commands.includes("workspaceBootstrap") && commands.includes("runtimeBootstrap"));
  const initialMetrics = await control("metrics");
  assert.ok(initialMetrics.requests.some(r => r.path.endsWith("/v1/me")), "actual DenAuthProvider validated synthetic session");
  if (!realEngine) assert.ok(initialMetrics.connections >= 2, "both renderers have actual proxied SSE connections");
  else await wait("Main network SSE + File production Main IPC SSE bridge connected", () => rendererSse.includes(main.webContents.id) && fileSseConnected);
  assert.ok(!await has(main, "Sign in to continue"));
  pass("normal index/AppProviders/DenSigninGate/AppRoot/full SessionRoute + FileWindowApp, two actual isolated renderers");
  const promptCount = async () => (await control("metrics")).prompts.length - (realEngine ? 2 : 0);
  if (realEngine) {
    for (const [window, text] of [[main, "COMPLETE_MAIN"], [file, "COMPLETE_FILE"]]) {
      await beginRound(text); await type(window, text); await click(window, "Run task");
      await wait(`both transcripts contain ${text} and authoritative idle`, async () => await has(main, text) && await has(file, text)
        && (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
      // Existing production read endpoint owns terminal reconciliation.
      await wait("completed journal reconciliation", async () => {
        await client.getJson("/workspace/smoke-workspace/session-runs");
        return (await control("journal")).filter(r => r.event === "run_terminal" && r.terminal_reason === "completed").length === (text === "COMPLETE_MAIN" ? 1 : 2);
      });
      await sseEvidence(); assert.deepEqual(await state(main), await state(file));
    }
    pass("same real session: Main and File each complete via actual provider SSE; distinct parent-linked final + idle; completed journals");
    await control("mode/stall"); await beginRound("file-real-start");
  }
  await type(main, "main-private-draft"); await type(file, "file-real-start");
  await click(file, "Run task");
  await wait("file start real server busy and answer in both", async () => await has(main, realEngine ? "file-real-start" : "real-server-answer-1") && await has(file, realEngine ? "file-real-start" : "real-server-answer-1") && await promptCount() === 1 && (await state(main)).status?.type === "busy" && (await state(file)).status?.type === "busy");
  assert.equal(await promptCount(), 1);
  assert.equal(await draft(main), "main-private-draft"); assert.equal(await draft(file), "");
  assert.deepEqual(await state(main), await state(file));
  pass(`file production sender -> real Server reserve/dispatch/start -> ${realEngine ? "real engine/loopback provider" : "synthetic engine"}; both transcripts/status agree`);
  await click(main, "Stop");
  await wait("Main abort file run", async () => (await control("metrics")).aborts.length === 1 && (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
  pass("Main Stop -> real run-ID abort -> upstream abort + authoritative idle");
  if (realEngine) { await sseEvidence(); await beginRound("external-race-winner"); }
  await type(file, "busy-conflict-keeps-draft");
  conflictArmed = true;
  // Another client wins at the dispatch boundary, after the UI guard, before
  // the real server's authoritative status check. No response is fabricated.
  await click(file, "Run task");
  await wait("actual 409 preserves file draft", () => has(file, "Your draft is kept here."));
  assert.equal(await draft(file), "busy-conflict-keeps-draft");
  await wait("only race winner reaches provider", async () => await promptCount() === 2);
  assert.ok(!(await control("metrics")).prompts.some(p=>JSON.stringify(realEngine ? p.body.messages : p.parts).includes("busy-conflict-keeps-draft")));
  assert.equal(await evaluate(file, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)), 0);
  pass("real Server session_busy/409 after UI admission guard: original draft kept; no upstream dispatch/queue");
  await click(file, "Stop");
  await wait("external busy clears", async () => (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
  if (realEngine) { await sseEvidence(); await beginRound("main-private-draft"); }
  await click(main, "Run task");
  await wait("Main real sender started", async () => await has(file, realEngine ? "main-private-draft" : "real-server-answer-3") && await promptCount() === 3 && (await state(main)).status?.type === "busy" && (await state(file)).status?.type === "busy");
  await type(main, "main-stop-preserved-draft");
  await evaluate(main, store(`s.getState().appendQueuedDraft('smoke-session',{text:'must-not-restart',parts:[{type:'text',text:'must-not-restart'}],attachments:[],mode:'prompt'})`));
  assert.equal(await evaluate(main, store(`s.getState().queuedDrafts['smoke-session']?.length`)), 1);
  await click(file, "Stop");
  await wait("file abort Main run", async () => (await control("metrics")).aborts.length === 3 && (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
  assert.deepEqual(stopObservation, { queue: 0, claims: {}, mainDraft: "main-stop-preserved-draft", fileDraft: "busy-conflict-keeps-draft" });
  await delay(3000);
  assert.equal(await promptCount(), 3);
  assert.equal(await evaluate(main, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)), 0);
  assert.equal(await draft(main), "main-stop-preserved-draft"); assert.equal(await draft(file), "busy-conflict-keeps-draft");
  assert.deepEqual(await state(main), await state(file));
  pass("file Stop clears Main pending queue/claims before actual server abort; no idle restart; both drafts retained");
  if (realEngine) {
    await sseEvidence();
    await wait("all aborted journals reconciled", async () => { await client.getJson("/workspace/smoke-workspace/session-runs");
      return (await control("journal")).filter(r => r.event === "run_terminal" && r.terminal_reason === "aborted").length === 3; });
  }
  const journal = await control("journal");
  const runIds = [...new Set(journal.map(e => e.run_id))]; assert.equal(runIds.length, realEngine ? 5 : 3);
  for (const id of runIds) for (const event of ["run_reserved", "run_started", "run_terminal", ...(realEngine && journal.some(e => e.run_id === id && e.terminal_reason === "completed") ? [] : ["abort_requested", "abort_accepted"])]) assert.ok(journal.some(e => e.run_id === id && e.event === event), `${id}: ${event}`);
  pass(`real temporary runtime.sqlite: all ${runIds.length} run lifecycles persisted through existing journal schema`);
  const metrics = await control("metrics");
  assert.ok(metrics.prompts.every(p => realEngine ? p.body.model === "synthetic" : (p.agent === undefined || p.agent === "build") && p.model.providerID === "fixture" && p.model.modelID === "synthetic"));
  if (realEngine) { assert.deepEqual(metrics.unexpected, []); assert.equal(metrics.prompts.length, 5); }
  if (realEngine) console.info(`ABORT EVIDENCE ${JSON.stringify({
    errors: (await control("evidence")).errors,
    observations: wire.filter(r => r.observationStatus),
    journal: journal.filter(r => ["abort_requested", "abort_accepted", "run_terminal"].includes(r.event)),
  })}`);
  assert.deepEqual(metrics.blocked, []); assert.deepEqual(blockedNetwork, []); assert.deepEqual(errors, []);
  assert.equal(wire.filter(r => r.host === "file" && r.path.endsWith("/runs/start") && r.status === 409).length, 1);
  console.info(JSON.stringify({ mode: realEngine ? "real-engine-full-app" : "full-app", checks, journalEvents: journal.map(e => ({ event: e.event, reason: e.terminal_reason })),
    upstreamPrompts: metrics.prompts.length, upstreamAborts: metrics.aborts.length, rendererRunRequests: wire.filter(r => /\/runs\//.test(r.path)),
    synthetic: ["desktop runtime/bootstrap discovery", "Den account HTTP", realEngine ? "loopback provider complete/stall/no tools" : "OpenCode engine/provider protocol"], rendererSse, blockedNetwork, errors }, null, 2));
  await cleanup(0);
} catch (error) {
  console.error(`ACCEPTANCE FAILED at ${stage}`, error);
  if (main && !main.isDestroyed()) console.error("MAIN", await body(main).catch(() => "unavailable"));
  if (files?.windows()[0]) console.error("FILE", await body(files.windows()[0]).catch(() => "unavailable"));
  const metrics = backend ? await control("metrics").catch(() => null) : null;
  console.error(JSON.stringify({ checks, commands: [...new Set(commands)], errors, blockedNetwork, rendererSse, wire: wire.filter(r=>r.method !== "GET"),
    fileSseConnected, evidence: realEngine && backend ? await control("evidence").catch(() => null) : undefined,
    journal: realEngine && backend ? await control("journal").catch(() => null) : undefined,
    metrics: metrics && { ...metrics, ...(realEngine ? { prompts: metrics.prompts.map(p => ({ path: p.path, mode: p.mode, model: p.body.model,
      userMessages: p.body.messages.filter(m => m.role === "user") })) } : {}), requests: [...new Set(metrics.requests.map(r=>`${r.method} ${r.path}`))] } }, null, 2));
  await cleanup(1);
}
}
void run();

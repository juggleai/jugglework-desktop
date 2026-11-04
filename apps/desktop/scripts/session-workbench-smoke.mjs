// Run from repo root: apps/desktop/node_modules/.bin/electron apps/desktop/scripts/session-workbench-smoke.mjs
// Actual Electron renderers + production modules, synthetic HTTP/SSE only.
import { app, BrowserWindow, ipcMain, session } from "electron";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createFileWindows } from "../electron/file-windows.mjs";
import { createFileEditor } from "../electron/file-editor.mjs";
import { mainProcessFetchBody, mainProcessFetchResponse } from "../electron/main-fetch.mjs";
import { buildFileWindowPreload } from "./build-file-window-preload.mjs";
import { createSessionSmokeFixture } from "./session-workbench-smoke-fixture.mjs";

const desktopRoot = fileURLToPath(new URL("../", import.meta.url));
const appRoot = path.resolve(desktopRoot, "../app");
const dropBusinessEvents = process.argv.includes("--drop-business-events");
const fileAgent = process.argv.includes("--namespaced-agent") ? "team/reviewer" : "build";
const root = mkdtempSync(path.join(tmpdir(), "juggle-session-smoke-"));
app.setPath("userData", path.join(root, "userData"));
app.setPath("sessionData", path.join(root, "sessionData"));
app.commandLine.appendSwitch("disable-background-networking");
app.on("window-all-closed", () => {});

async function run() {
  let stage = "ready", main, files, fixture, vite, failed = false;
  const checks = [], errors = [], blockedNetwork = [];
  const deadline = setTimeout(() => { console.error(`SMOKE TIMEOUT: ${stage}`); void cleanup(1); }, 180000);
  let cleaning = false;
  async function cleanup(code) {
    if (cleaning) return; cleaning = true;
    // Hard bound also covers a stuck close() or Chromium storage handle.
    const forceExit = setTimeout(() => app.exit(1), 10000);
    try {
      files?.dispose(); if (main && !main.isDestroyed()) main.destroy();
      await fixture?.close(); await vite?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
      console.info(`SMOKE CLEANUP: removed ${root}`);
    } catch (error) { console.error("SMOKE CLEANUP FAILED", error); code = 1; }
    clearTimeout(deadline); clearTimeout(forceExit); app.exit(code);
  }
  const evaluate = (window, expression) => window.webContents.executeJavaScript(expression, true);
  const wait = async (label, predicate, timeout = 20000) => {
    stage = label;
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await predicate()) return; await delay(100); }
    throw new Error(`Timed out: ${label}`);
  };
  const pass = (label) => { checks.push(label); console.info(`PASS ${label}`); };
  const bodyHas = (window, text) => evaluate(window, `document.body.innerText.includes(${JSON.stringify(text)})`);
  const clickText = (window, text) => evaluate(window, `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw Error('Button unavailable: ${text}'); b.click(); })()`);
  const clickTitle = (window, title) => evaluate(window, `(() => { const b = document.querySelector('button[title=${JSON.stringify(title)}]'); if (!b || b.disabled) throw Error('Button unavailable: ${title}'); b.click(); })()`);
  const draft = (window) => evaluate(window, `document.querySelector('[data-session-surface-id] [contenteditable="true"]')?.textContent`);
  const type = async (window, text) => {
    await evaluate(window, `document.querySelector('[data-session-surface-id] [contenteditable="true"]').focus()`);
    window.webContents.selectAll(); await window.webContents.insertText(text);
    await wait(`typed ${text}`, async () => (await draft(window)) === text);
  };
  // Use Vite's canonical app URL; /@fs aliases can instantiate another Zustand
  // module and would make a queue non-consumption assertion meaningless.
  const moduleUrl = (name) => `/src/${name}`;
  const store = (expression) => `import(${JSON.stringify(moduleUrl("react-app/domains/session/surface/composer-state-store.ts"))}).then(({useComposerStateStore:s}) => (${expression}))`;
  const state = (window) => evaluate(window, `import(${JSON.stringify(moduleUrl("react-app/infra/query-client.ts"))}).then(({getReactQueryClient}) => {
    const q = getReactQueryClient(); return { status: q.getQueryData(['react-session-status','smoke-workspace','smoke-session']),
      messages: q.getQueryData(['react-session-transcript','smoke-workspace','smoke-session'])?.map(m=>({id:m.id,role:m.role,parts:m.parts.map(p=>({type:p.type,text:p.text}))})) };
  })`);
  const reads = (host, suffix) => fixture.requests.filter((r) => r.host === host && r.path.endsWith(suffix)).length;
  let sseOnlyDiagnostics;
  let observeAbort;
  try {
    await app.whenReady();
    fixture = await createSessionSmokeFixture(root, {
      // Only the synthetic wire is filtered; real SSE/IPC/preload/sync remain mounted.
      eventFilter: (host, event) => !dropBusinessEvents || host !== "file" || ["server.connected", "server.heartbeat"].includes(event.type),
      onAbort: async (input) => observeAbort?.(input),
    });
    const requireApp = createRequire(path.join(appRoot, "package.json"));
    const { createServer } = await import(requireApp.resolve("vite"));
    const { default: react } = await import(requireApp.resolve("@vitejs/plugin-react"));
    const { default: tailwindcss } = await import(requireApp.resolve("@tailwindcss/vite"));
    stage = "Vite production-module entry";
    const entry = fileURLToPath(new URL("./session-workbench-smoke-main.tsx", import.meta.url));
    // Do not load app config (it reads .env.migration-release) or expose inherited
    // VITE_* variables. Only this dedicated prefix is reserved for nonsecret data.
    // Annotation-only React Compiler optimization is outside this smoke's scope.
    vite = await createServer({ root: appRoot, configFile: false, envFile: false,
      envPrefix: "JUGGLEWORK_SESSION_SMOKE_PUBLIC_",
      resolve: { alias: { "@": path.join(appRoot, "src") } },
      cacheDir: path.join(root, "vite-cache"), server: { host: "127.0.0.1", port: 0, strictPort: false, fs: { allow: [path.resolve(appRoot, "../..")] } },
      plugins: [tailwindcss(), react(), { name: "isolated-session-smoke-entry", configureServer(server) {
        server.middlewares.use("/__session-smoke.html", async (req, res, next) => {
          try {
            const html = await server.transformIndexHtml(req.originalUrl, `<!doctype html><html lang="en"><head></head><body><div id="root" style="height:100vh"></div><script type="module" src="/@fs/${entry}"></script></body></html>`);
            res.setHeader("content-type", "text/html"); res.end(html);
          } catch (error) { next(error); }
        });
      } }],
    });
    assert.equal(vite.config.configFile, undefined);
    assert.deepEqual(Object.keys(vite.config.env).filter((key) => key.startsWith("VITE_")), []);
    pass("isolated Vite config/env: app config disabled; inherited VITE_* not exposed");
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    // Only loopback fixture + ephemeral Vite ports. Applies to both real sessions.
    const confine = (partition) => partition.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const allowed = [origin, fixture.origin].includes(url.origin) || ["data:", "blob:", "devtools:"].includes(url.protocol) || (url.protocol === "ws:" && url.host === new URL(origin).host);
      if (!allowed) blockedNetwork.push(details.url);
      callback({ cancel: !allowed });
    });
    confine(session.defaultSession);
    app.on("session-created", confine);
    const preloadPath = await buildFileWindowPreload({ output: path.join(root, "file-window-preload.cjs") });
    ipcMain.on("jugglework:desktop-bootstrap-sync", (event) => { event.returnValue = null; });
    main = new BrowserWindow({ show: false, width: 1280, height: 900,
      webPreferences: { preload: path.join(desktopRoot, "electron/preload.mjs"), sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const watch = (window, host) => {
      window.webContents.on("preload-error", (_event, _path, error) => errors.push(`${host} preload: ${error.message}`));
      window.webContents.on("render-process-gone", (_event, details) => errors.push(`${host} renderer: ${details.reason}`));
      window.webContents.on("console-message", (_event, ...args) => {
        const message = typeof args[0] === "object" ? args[0].message : args[1];
        if (/Uncaught|Error:|does not provide an export|Failed to resolve/.test(message ?? "")) errors.push(`${host}: ${message}`);
      });
    };
    watch(main, "main");
    const client = {
      getJson: async (route) => { const response = await fetch(`${fixture.origin}${route}`); assert.ok(response.ok, route); return response.json(); },
      postJson: async (route, input) => { const response = await fetch(`${fixture.origin}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) }); return response.json(); },
    };
    const editor = createFileEditor({ client, getWindows: () => [main, ...files.windows()], authorizeFileEditor: (...args) => files.authorizeFileEditor(...args), canReceiveFileEditor: (...args) => files.canReceiveFileEditor(...args) });
    files = createFileWindows({ client, getAccess: async () => ({ baseUrl: fixture.origin, clientToken: "synthetic-fixture-only" }),
      office: {}, fileEditor: editor, getMainWindow: () => main, getDesktopConfig: async () => ({}), getAppearance: async () => ({ lang: "en", theme: "light" }),
      preloadPath, recentPath: path.join(root, "recent.json"), loadWindow: (window) => { watch(window, "file"); return window.loadURL(`${origin}/file-window.html`); } });
    files.registerIpc(ipcMain); editor.registerIpc(ipcMain);
    ipcMain.handle("jugglework:desktop", async (event, command, url, init = {}) => {
      if (cleaning) return { status: 503, statusText: "Cleanup", headers: [], body: new ArrayBuffer(0) };
      if (command !== "__fetch") return null;
      assert.equal(new URL(url).origin, fixture.origin, "all desktop HTTP stays in fixture");
      if (event.sender !== main.webContents) return files.fetch(event, url, init, fetch);
      return mainProcessFetchResponse(await fetch(url, { method: init.method, headers: init.headers, body: mainProcessFetchBody(init), signal: AbortSignal.timeout(10000) }));
    });
    await main.loadURL(`${origin}/__session-smoke.html?backend=${encodeURIComponent(fixture.origin)}&root=${encodeURIComponent(root)}`);
    await files.open({ workspaceId: "smoke-workspace", sessionId: "smoke-session", path: "fixture.md", conversationOptions: { model: { providerID: "fixture", modelID: "synthetic" }, agent: fileAgent } });
    const file = files.windows()[0];
    await wait("real FileWindowApp AI toggle", () => bodyHas(file, "AI conversation"), 60000);
    await clickText(file, "AI conversation");
    await wait("two actual shared surfaces hydrated", async () => (await bodyHas(main, "fixture-initial-message")) && (await bodyHas(file, "fixture-initial-message")) && fixture.connections === 2, 60000);
    assert.notEqual(file.webContents.getProcessId(), main.webContents.getProcessId());
    assert.notEqual(file.webContents.session, main.webContents.session);
    assert.equal(file.webContents.session.isPersistent(), false);
    assert.equal(file.webContents.getLastWebPreferences().sandbox, true);
    assert.ok((await evaluate(file, `Object.keys(window.__JUGGLEWORK_ELECTRON__)`)).includes("fileWindow"));
    pass("real-two-renderers / FileWindowApp / sandbox-CJS-preload / createFileWindows / shared-surface-runtime");

    const sseOnly = fixture.beginSseOnlyPhase();
    sseOnlyDiagnostics = { committed: false, beforeFileSnapshots: reads("file", "/sessions/smoke-session/snapshot"), fileSnapshotProbeReads: 0, ...sseOnly };
    const hasSseText = async (window, text) => {
      const current = await state(window);
      return current.messages?.some((message) => message.id === sseOnly.messageId && message.parts.some((part) => part.type === "text" && part.text === text))
        && await bodyHas(window, text);
    };
    const assertSseOnlyHiddenFromHttp = async () => {
      for (const host of ["main", "file"]) {
        for (const route of ["sessions/smoke-session/snapshot", "sessions/smoke-session/messages", "session-runs"]) {
          const response = await fetch(`${fixture.origin}/workspace/smoke-workspace/${route}`, {
            headers: host === "file" ? { authorization: "Bearer synthetic-fixture-only" } : {}, signal: AbortSignal.timeout(5000),
          });
          assert.ok(response.ok);
          const value = await response.json();
          if (host === "file" && route.endsWith("/snapshot")) sseOnlyDiagnostics.fileSnapshotProbeReads++;
          assert.ok(!JSON.stringify(value).includes(sseOnly.messageId), `${host} ${route} must withhold the SSE-only message/delta`);
          if (route.endsWith("/snapshot")) assert.equal(value.item.status.type, "idle");
          if (route === "session-runs") assert.deepEqual(value.items, []);
        }
      }
    };
    // HTTP recovery remains enabled, but cannot supply pending SSE-only data.
    await assertSseOnlyHiddenFromHttp();
    await wait("SSE-only message reaches both renderers", async () => await hasSseText(main, sseOnly.prefix) && await hasSseText(file, sseOnly.prefix), 12000);
    fixture.sendSseOnlyDelta(sseOnly.delta);
    await wait("SSE-only delta reaches both renderers", async () => await hasSseText(main, sseOnly.text) && await hasSseText(file, sseOnly.text), 12000);
    fixture.sendSseOnlyBusy();
    await wait("SSE-only busy reaches both renderers", async () => (await state(main)).status?.type === "busy" && (await state(file)).status?.type === "busy", 12000);
    await assertSseOnlyHiddenFromHttp();
    assert.deepEqual(await state(main), await state(file));
    sseOnlyDiagnostics.fileRendererSnapshotReads = reads("file", "/sessions/smoke-session/snapshot") - sseOnlyDiagnostics.beforeFileSnapshots - sseOnlyDiagnostics.fileSnapshotProbeReads;
    fixture.commitSseOnlyPhase();
    sseOnlyDiagnostics.committed = true;
    pass("SSE-only message + delta + busy: HTTP snapshots/messages/runs withheld until assertions");
    fixture.finishSseOnlyPhase();
    await wait("SSE-only phase returns to idle", async () => (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");

    await type(main, "main-private-draft"); await type(file, "file-private-draft");
    assert.equal(await draft(main), "main-private-draft");
    pass("per-renderer drafts do not leak for same workspace/session");
    await clickTitle(file, "Run task");
    await wait("file send visible in both windows", async () => (await bodyHas(main, "fixture-answer-1")) && (await bodyHas(file, "fixture-answer-1")));
    await wait("busy status equality", async () => (await state(main)).status?.type === "busy" && (await state(file)).status?.type === "busy");
    assert.deepEqual(await state(main), await state(file));
    assert.equal(await draft(file), ""); assert.equal(await draft(main), "main-private-draft");
    assert.equal(fixture.starts[0].host, "file"); assert.equal(fixture.starts[0].input.whenBusy, "reject");
    assert.equal(fixture.starts[0].input.prompt.agent, fileAgent);
    pass(`file production sender (${fileAgent}) + messages/status equal on both renderers`);
    await clickTitle(main, "Stop");
    await wait("main stops file-origin run", async () => (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
    assert.equal(fixture.aborts[0].host, "main");
    pass("cross-window stop: Main stops file-origin task");

    // Server becomes busy before either renderer knows: exercise actual HTTP 409,
    // not the easier already-busy UI guard.
    await type(file, "busy-conflict-keeps-draft"); fixture.hiddenBusy();
    await clickTitle(file, "Run task");
    await wait("409 busy reply keeps original draft", async () => fixture.starts.length === 2 && await bodyHas(file, "Your draft is kept here."));
    assert.equal(await draft(file), "busy-conflict-keeps-draft");
    assert.equal(await draft(main), "main-private-draft");
    assert.equal(await evaluate(file, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)), 0);
    pass("HTTP busy conflict preserves draft and does not queue");
    await clickTitle(file, "Stop");
    await wait("file stops externally started run", async () => fixture.aborts.length === 2 && (await state(file)).status?.type === "idle" && (await state(main)).status?.type === "idle");
    assert.equal(fixture.aborts.at(-1).host, "file");
    await clickTitle(main, "Run task");
    await wait("main production sender accepted and busy in both", async () => fixture.starts.length === 3 && await bodyHas(file, "fixture-answer-3")
      && (await state(main)).status?.type === "busy" && (await state(file)).status?.type === "busy");
    await type(main, "main-stop-preserved-draft");
    const stopDrafts = { main: await draft(main), file: await draft(file) };
    const startsBeforeFileStop = fixture.starts.length;
    await evaluate(main, store(`s.getState().appendQueuedDraft('smoke-session', { text:'must-not-restart-after-file-stop', parts:[{type:'text',text:'must-not-restart-after-file-stop'}], attachments:[], mode:'prompt' })`));
    assert.equal(await evaluate(main, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)), 1);
    assert.equal((await state(main)).status?.type, "busy");
    assert.equal(fixture.starts.length, startsBeforeFileStop);
    // Read-only probe at the real backend abort boundary: cleanup is performed
    // exclusively by the installed production helper through the preload ack.
    observeAbort = async ({ host, run }) => ({
      host, runId: run?.runId,
      mainQueue: await evaluate(main, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)),
      mainClaims: await evaluate(main, store(`s.getState().queueClaims`)),
      drafts: { main: await draft(main), file: await draft(file) },
    });
    await clickTitle(file, "Stop");
    await wait("file stops main-origin run", async () => fixture.aborts.length === 3 && (await state(main)).status?.type === "idle" && (await state(file)).status?.type === "idle");
    observeAbort = undefined;
    const stopped = fixture.aborts.at(-1);
    assert.equal(stopped.host, "file");
    assert.equal(stopped.observation.runId, stopped.path.split("/").at(-2));
    assert.equal(stopped.observation.mainQueue, 0, "production stop handshake clears Main queue before backend abort");
    assert.deepEqual(stopped.observation.mainClaims, {});
    assert.deepEqual(stopped.observation.drafts, stopDrafts);
    // Covers multiple 750ms active-run/queue ticks after the idle transition.
    await delay(3000);
    assert.equal(fixture.starts.length, startsBeforeFileStop, "idle must not restart the cleared pending task");
    assert.equal(await evaluate(main, store(`s.getState().queuedDrafts['smoke-session']?.length ?? 0`)), 0);
    assert.deepEqual(await evaluate(main, store(`s.getState().queueClaims`)), {});
    assert.deepEqual({ main: await draft(main), file: await draft(file) }, stopDrafts);
    assert.equal((await state(main)).status?.type, "idle");
    assert.equal((await state(file)).status?.type, "idle");
    pass("cross-window stop: file stops Main-origin task");
    pass("Main busy + pending queue + file Stop: production ack clears queue before abort; no idle restart; both drafts retained");

    fixture.childInteraction("permission");
    await wait("new-child permission shown in both", async () => await bodyHas(main, "smoke-permission-path") && await bodyHas(file, "smoke-permission-path"));
    await clickText(file, "Allow once");
    await wait("child permission resolved in both", async () => fixture.replies.length === 1 && !await bodyHas(main, "smoke-permission-path") && !await bodyHas(file, "smoke-permission-path"));
    assert.equal(fixture.replies[0].target, "new-permission-child");
    assert.equal(fixture.replies[0].input.response, "allow_once");
    pass("new child permission snapshot proof + file reply synchronizes both");
    fixture.childInteraction("question");
    await wait("new-child question shown in both", async () => await bodyHas(main, "smoke-child-question") && await bodyHas(file, "smoke-child-question"));
    await clickText(main, "Smoke answerSynthetic answer");
    await wait("child question resolved in both", async () => fixture.replies.length === 2 && !await bodyHas(main, "smoke-child-question") && !await bodyHas(file, "smoke-child-question"));
    assert.equal(fixture.replies[1].target, "new-question-child");
    assert.deepEqual(fixture.replies[1].input.answers, [{ questionId: "smoke-question-id", values: ["Smoke answer"] }]);
    pass("new child question + Main reply synchronizes both");

    const beforeReconnect = Object.fromEntries(["main", "file"].map((host) => [host, {
      snapshots: reads(host, "/sessions/smoke-session/snapshot"), streams: reads(host, "/opencode/event"),
    }]));
    fixture.disconnectAndAddSnapshotMessage();
    await wait("SSE reconnect fills snapshot-only message", async () => fixture.connections === 2 && await bodyHas(main, "fixture-offline-snapshot-only") && await bodyHas(file, "fixture-offline-snapshot-only"), 20000);
    for (const host of ["main", "file"]) {
      assert.ok(reads(host, "/opencode/event") > beforeReconnect[host].streams, `${host} established a new SSE connection`);
      assert.ok(reads(host, "/sessions/smoke-session/snapshot") > beforeReconnect[host].snapshots, `${host} read a recovery snapshot`);
    }
    assert.deepEqual(await state(main), await state(file));
    pass("disconnect/reconnect recovers missed message via snapshot on both");

    const count = fixture.starts.length;
    await evaluate(file, store(`s.getState().appendQueuedDraft('smoke-session', { text:'must-not-be-consumed', parts:[{type:'text',text:'must-not-be-consumed'}], attachments:[], mode:'prompt' })`));
    await delay(2500);
    assert.equal(await evaluate(file, store(`s.getState().queuedDrafts['smoke-session'].length`)), 1);
    assert.deepEqual(await evaluate(file, store(`s.getState().queueClaims`)), {});
    assert.equal(fixture.starts.length, count);
    assert.equal(await draft(file), "busy-conflict-keeps-draft");
    await evaluate(main, store(`s.getState().appendQueuedDraft('smoke-session', { text:'main-queue-positive-control', parts:[{type:'text',text:'main-queue-positive-control'}], attachments:[], mode:'prompt' })`));
    await wait("Main queue positive control consumes through production sender", async () => fixture.starts.length === count + 1 && await bodyHas(file, "main-queue-positive-control"));
    assert.equal(fixture.starts.at(-1).host, "main");
    assert.equal(await evaluate(file, store(`s.getState().queuedDrafts['smoke-session'].length`)), 1);
    assert.deepEqual(await evaluate(file, store(`s.getState().queueClaims`)), {});
    await clickTitle(main, "Stop");
    await wait("Main queue task stopped; file queue still untouched", async () => fixture.aborts.length === 4 && (await state(file)).status?.type === "idle");
    assert.equal(await evaluate(file, store(`s.getState().queuedDrafts['smoke-session'].length`)), 1);
    assert.equal(fixture.starts.length, count + 1);
    pass("file has no queue consumer across idle/busy/stop; Main queue positive control sends");
    assert.deepEqual(errors, [], "no renderer/preload errors");
    assert.deepEqual(blockedNetwork, [], "no attempted external network");
    assert.equal(dropBusinessEvents, false, "drop-business negative control must fail at the SSE-only phase");
    console.info(JSON.stringify({ result: "pass", electron: process.versions.electron, checks, fileAgent,
      limitations: ["Main is a smoke-only production-module composition, not full SessionRoute/application bootstrap", "Synthetic backend verifies client/IPC/SSE contracts, not real server/provider behavior", "Queue absence observed for bounded idle/busy/stop transitions; no background app queue coordinator mounted", "Office editor acceptance is out of scope"] }, null, 2));
  } catch (error) {
    failed = true;
    console.error(`SMOKE FAILED at ${stage}`, error);
    console.error(JSON.stringify({ checks, errors, blockedNetwork, dropBusinessEvents, fileAgent, sseOnlyDiagnostics,
      fileRendererSnapshotReadsDuringSse: sseOnlyDiagnostics && (sseOnlyDiagnostics.fileRendererSnapshotReads ?? reads("file", "/sessions/smoke-session/snapshot") - sseOnlyDiagnostics.beforeFileSnapshots - sseOnlyDiagnostics.fileSnapshotProbeReads),
      fileSnapshotReads: fixture && reads("file", "/sessions/smoke-session/snapshot"), droppedEvents: fixture?.droppedEvents,
      requests: fixture?.requests.slice(-25) }, null, 2));
    for (const [host, window] of [["main", main], ["file", files?.windows()[0]]]) {
      if (window && !window.isDestroyed()) console.error(`${host} DOM:`, await evaluate(window, `document.body.innerText.slice(-6000)`).catch(String));
    }
  } finally { await cleanup(failed ? 1 : 0); }
}
void run();

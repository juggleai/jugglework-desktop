// Independent host; never import product main or launch the candidate executable.
// node apps/desktop/scripts/verify-toon-media-packaged.mjs --app /path/Candidate.app
import assert from "node:assert/strict";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const requiredChecks = [
  "candidate modules and signed resources", "isolated packaged runtime", "catalog and renderer boundary",
  "directory permission denial", "video actions UI", "source decode and playback",
  "UI trim", "UI extractAudio", "UI separate", "frameAnalysis UI and real analyze",
  "analysis undo redo", "analysis rebuild idempotence", "save reload", "project switch",
  "real export", "output decode and playback", "no overwrite", "negative media permissions",
  "active export cancellation", "active separate cancellation", "active analyze cancellation",
  "UI cancellation", "project switch during processing", "grant revocation during processing",
  "no external model requests", "cleanup and no orphan processes",
];

function argument(name, fallback) {
  const inline = process.argv.find(value => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

async function bounded(promise, label, milliseconds = 25_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timeout (${milliseconds}ms)`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

async function waitFor(check, label, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`${label}: timeout${last ? `: ${last.message}` : ""}`);
}

async function launch() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node verify-toon-media-packaged.mjs --app candidate.app [--expected-version 1.2.32] [--timeout-seconds 420] [--keep-temp]\nOutputs: JSON report + failure screenshots under a unique temporary directory. Exit 1 for any missing/failed check. macOS native architecture only.");
    return;
  }
  assert.equal(process.platform, "darwin", "This acceptance host requires macOS");
  const candidate = argument("--app");
  assert.ok(candidate && candidate.endsWith(".app"), "--app candidate.app is required");
  const appPath = await realpath(candidate);
  const resources = path.join(appPath, "Contents", "Resources");
  const asar = path.join(resources, "app.asar");
  assert.ok((await stat(asar)).isFile(), "candidate app.asar is missing");
  const seconds = Number(argument("--timeout-seconds", "420"));
  assert.ok(Number.isInteger(seconds) && seconds >= 60 && seconds <= 900, "timeout must be 60–900 seconds");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "toon-media-packaged-")));
  console.log(`Acceptance evidence: ${root}`);
  // A crash, failed extraction or forced termination must leave an explicit FAIL,
  // not an absent/stale success report. The worker replaces this only at shutdown.
  await writeFile(path.join(root, "report.json"), JSON.stringify({ schemaVersion: 1, ok: false, candidate: appPath, checks: Object.fromEntries(requiredChecks.map(name => [name, { status: "FAIL", error: "Host has not completed this check" }])) }, null, 2));
  const require = createRequire(import.meta.url);
  const { extractFile } = require("@electron/asar");
  // Explicit closure only. No product main, updater, ShipIt, profile or defaults modules.
  const modules = ["toonFactoryRuntime.mjs", "toonFactoryBundle.mjs", "toonFactoryVideoEdit.mjs", "mediaTools.mjs", "mediaToolsSources.json"];
  await mkdir(path.join(root, "modules"));
  const hashes = {};
  for (const name of modules) {
    const bytes = extractFile(asar, `electron/${name}`);
    await writeFile(path.join(root, "modules", name), bytes, { flag: "wx" });
    hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const metadata = JSON.parse(extractFile(asar, "package.json").toString());
  assert.equal(metadata.version, argument("--expected-version", "1.2.32"), "candidate package version mismatch");
  await mkdir(path.join(root, "node_modules"));
  await symlink(path.dirname(require.resolve("electron/package.json")), path.join(root, "node_modules", "electron"), "dir");
  for (const name of ["home", "tmp", "userData", "sessionData", "logs", "cache"]) await mkdir(path.join(root, name));
  await writeFile(path.join(root, "config.json"), JSON.stringify({ root, appPath, resources, hashes, version: metadata.version, seconds }, null, 2));
  // Only a small public environment allowlist; no provider credentials inherited.
  const environment = Object.fromEntries(["PATH", "LANG", "LC_ALL", "DISPLAY", "__CF_USER_TEXT_ENCODING"].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(environment, { HOME: path.join(root, "home"), TMPDIR: `${path.join(root, "tmp")}/`, XDG_CONFIG_HOME: path.join(root, "home"), XDG_CACHE_HOME: path.join(root, "cache") });
  const child = spawn(require("electron"), [script, "--toon-media-worker", root], { env: environment, stdio: "inherit", detached: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    console.error("FAIL: independent host exceeded outer deadline");
    child.kill("SIGTERM");
    setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 10_000).unref();
  }, (seconds + 20) * 1000);
  const [code, signal] = await once(child, "exit");
  clearTimeout(timer);
  let report;
  try { report = JSON.parse(await readFile(path.join(root, "report.json"), "utf8")); } catch {}
  const success = code === 0 && !signal && !timedOut && report?.ok === true;
  if (!report) console.error("FAIL: no terminal report; acceptance is incomplete");
  console.log(`${success ? "PASS" : "FAIL"}: ${path.join(root, "report.json")}`);
  // Evidence always survives; profiles/projects/media may be large and are removed only on success.
  if (success && !process.argv.includes("--keep-temp")) {
    for (const name of ["home", "tmp", "userData", "sessionData", "logs", "cache", "projects", "modules", "node_modules"]) await rm(path.join(root, name), { recursive: true, force: true });
  }
  process.exitCode = success ? 0 : 1;
}

async function worker(root) {
  const { default: electron } = await import("electron");
  const { app, BrowserWindow } = electron;
  app.setName("Toon Media Acceptance Host");
  for (const name of ["userData", "sessionData", "logs"]) app.setPath(name, path.join(root, name));
  app.commandLine.appendSwitch("disk-cache-dir", path.join(root, "cache"));
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  app.on("window-all-closed", () => {});
  const config = JSON.parse(await readFile(path.join(root, "config.json"), "utf8"));
  const results = new Map();
  const diagnostics = [];
  const children = [];
  let runtime, window, host, editor, tools, view;
  let closing = false, fatal = false;
  const externalRequests = [];
  const moduleUrl = name => pathToFileURL(path.join(root, "modules", name)).href;
  const project = path.join(root, "projects", "project-a");
  const secondProject = path.join(root, "projects", "project-b");
  const denied = path.join(root, "projects", "not-authorized");
  const canvasPath = path.join(project, "验收画布.json");
  const moduleRoot = path.join(config.resources, "toonFactoryV2");
  const mediaToolsRoot = path.join(config.resources, "mediaTools");
  const selectors = {
    source: '.canvasPanel:not(.backgroundPanel) .vue-flow__node[data-id="acceptance-source"]',
    nodes: '.canvasPanel:not(.backgroundPanel) .vue-flow__node',
    analysis: '.canvasPanel:not(.backgroundPanel) .vue-flow__node-remote-frameAnalysisNode',
  };
  const source = JSON.stringify(selectors.source), nodes = JSON.stringify(selectors.nodes), analysis = JSON.stringify(selectors.analysis);

  // Observe actual children without substituting spawn/argv/signatures. Also covers
  // ffmpeg spawned inside the unmodified candidate module's closed-over imports.
  const originalSpawn = ChildProcess.prototype.spawn;
  ChildProcess.prototype.spawn = function(options) {
    const result = originalSpawn.call(this, options);
    const record = { child: this, file: options.file, args: options.args, pid: this.pid, detached: options.detached, closed: false };
    children.push(record);
    this.once("close", () => { record.closed = true; });
    return result;
  };
  const alive = record => {
    if (!record.pid) return false;
    try { process.kill(record.pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
  };
  const mediaChildren = () => children.filter(record => [tools?.ffmpeg, tools?.ffprobe].includes(record.file));
  async function remainingSidecarGroupProcesses() {
    const groups = new Set(children.filter(record => record.detached && record.file === path.join(moduleRoot, "bun") && record.pid > 1).map(record => record.pid));
    if (!groups.size) return [];
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { timeout: 2000 });
    return stdout.split("\n").flatMap(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
      return match && groups.has(Number(match[3])) ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
    });
  }
  const page = expression => {
    assert.ok(view && !view.webContents.isDestroyed(), "candidate view is unavailable");
    return bounded(view.webContents.executeJavaScript(expression, true), "renderer evaluation");
  };
  const count = () => page(`document.querySelectorAll(${nodes}).length`);
  const saved = () => readFile(canvasPath, "utf8").then(JSON.parse);
  const clickText = async (label, scope = "document") => {
    assert.equal(await page(`(() => { const button = [...${scope}.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled && b.getClientRects().length); if (!button) return false; button.click(); return true; })()`), true, `missing enabled UI button: ${label}`);
  };
  const selectSource = async () => {
    await page(`(() => { const e = document.querySelector(${source}); if (!e) throw Error('source node missing'); e.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); e.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 })); e.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 })); })()`);
    await waitFor(() => page(`!!document.querySelector(${source} + '.selected') || document.querySelector(${source})?.classList.contains('selected')`), "source selected");
  };
  const assertNoStaging = async () => assert.ok(!(await readdir(project)).some(name => name.startsWith(".videoEdit-")), "leaked .videoEdit staging");
  async function assetFiles(directory = path.join(project, "assets"), prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    const result = [];
    for (const entry of entries) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) result.push(...await assetFiles(path.join(directory, entry.name), `${relative}/`));
      else result.push(relative);
    }
    return result.sort();
  }
  async function check(name, action) {
    if (closing) throw new Error("host is shutting down");
    const started = Date.now();
    try {
      const detail = await bounded(Promise.resolve().then(action), name, 60_000);
      results.set(name, { status: "PASS", milliseconds: Date.now() - started, ...(detail === undefined ? {} : { detail }) });
      console.log(`PASS: ${name}`);
      return true;
    } catch (error) {
      results.set(name, { status: "FAIL", milliseconds: Date.now() - started, error: error.stack || String(error) });
      console.error(`FAIL: ${name}: ${error.message}`);
      if (view && !view.webContents.isDestroyed()) {
        try { await writeFile(path.join(root, `${name.replace(/[^a-z0-9]+/gi, "-")}.png`), (await bounded(view.webContents.capturePage(), "failure screenshot", 2000)).toPNG()); } catch {}
      }
      // Promise.race cannot cancel arbitrary work. Do not continue the suite with
      // a timed-out action still mutating the project in the background.
      if (error.message === `${name}: timeout (60000ms)`) throw error;
      return false;
    }
  }
  async function finish(reason) {
    if (closing) return;
    closing = true;
    if (reason) { fatal = true; diagnostics.push(String(reason.stack || reason)); }
    const cleanupErrors = [];
    for (const task of [() => editor?.stop(), () => runtime?.dispose()]) {
      try { await bounded(Promise.resolve().then(task), "cleanup", 10_000); } catch (error) { cleanupErrors.push(error.message); }
    }
    if (window && !window.isDestroyed()) window.destroy();
    host?.closeAllConnections();
    if (host) await bounded(new Promise(resolve => host.close(resolve)), "catalog close", 2000).catch(error => cleanupErrors.push(error.message));
    try { await waitFor(() => children.every(record => !alive(record)), "all owned processes exit", 5000); } catch (error) { cleanupErrors.push(error.message); }
    const orphans = children.filter(alive).map(record => ({ pid: record.pid, file: record.file }));
    let sidecarGroupOrphans = [];
    try { sidecarGroupOrphans = await remainingSidecarGroupProcesses(); } catch (error) { cleanupErrors.push(error.message); }
    // Kill only this host's still-attached ChildProcess objects, never pid-by-name or current app.
    for (const record of children.filter(alive)) { try { record.child.kill("SIGKILL"); } catch {} }
    for (const group of new Set(sidecarGroupOrphans.map(record => record.pgid))) { try { process.kill(-group, "SIGKILL"); } catch {} }
    results.set("cleanup and no orphan processes", { status: cleanupErrors.length || orphans.length || sidecarGroupOrphans.length ? "FAIL" : "PASS", cleanupErrors, orphans, sidecarGroupOrphans });
    for (const name of requiredChecks) if (!results.has(name)) results.set(name, { status: "FAIL", error: "Not executed/completed; acceptance coverage missing" });
    const report = { schemaVersion: 1, ok: !fatal && [...results.values()].every(result => result.status === "PASS"), candidate: config.appPath, version: config.version,
      electron: process.versions.electron, arch: process.arch, packaged: true, extractedModuleHashes: config.hashes,
      limitations: ["Independent current Electron host, not the candidate executable/main, updater, notarization or release gate.", "UI automation uses candidate DOM events and Electron executeJavaScript; fixture canvas is seeded on disk, not imported through a file picker.", "Scene detector is exercised on a short synthetic testsrc2 fixture; many-shot/10-minute limits and publication-await races require separate tests.", "Cancellation timing requires observing a real active ffmpeg child; missing observation is a failure, never a skip."],
      checks: Object.fromEntries(results), diagnostics, externalRequests, evidence: root };
    await writeFile(path.join(root, "report.json"), JSON.stringify(report, null, 2));
    console.log(`${report.ok ? "PASS" : "FAIL"}: ${[...results.values()].filter(value => value.status === "PASS").length}/${requiredChecks.length} acceptance checks`);
    ChildProcess.prototype.spawn = originalSpawn;
    app.exit(report.ok ? 0 : 1);
  }
  const hardTimer = setTimeout(() => {
    void finish(new Error(`Host hard deadline ${config.seconds}s exceeded`));
    setTimeout(() => app.exit(1), 25_000).unref();
  }, config.seconds * 1000);
  process.once("SIGTERM", () => { void finish(new Error("Host terminated")); });
  process.once("SIGINT", () => { void finish(new Error("Host interrupted")); });

  // Use only candidate-owned tools for fixture creation and full decode, bounded per call.
  const runTool = (file, args) => execute(file, args, { timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { PATH: "", LANG: "C", LC_ALL: "C" } });
  const probeFile = async file => JSON.parse((await runTool(tools.ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file])).stdout);
  const decodeFile = file => runTool(tools.ffmpeg, ["-v", "error", "-nostdin", "-i", file, "-f", "null", "-"]);
  const editorInput = (operation, outputDirectory) => ({ operation, directory: project, path: "input.mp4", outputDirectory });
  const exportInput = output => ({ operation: "export", directory: project, clips: [{ path: "input.mp4", start: 0.2, end: 1.2 }, { path: "input.mp4", start: 1.5, end: 2.5 }], output, width: 160, height: 128, fps: 24 });
  const api = input => page(`(async () => { const r = await fetch('/api/media/process', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-toonflow-workspace': '1' }, body: JSON.stringify(${JSON.stringify(input)}) }); return { status: r.status, body: await r.json() }; })()`);
  async function activeRender(startIndex) {
    return waitFor(() => children.slice(startIndex).find(record => record.file === tools.ffmpeg && !record.closed && alive(record)), "real active ffmpeg observed", 15_000);
  }
  async function playback(relative, kind = "video") {
    // Read bytes through the authenticated candidate workspace API, then decode/play
    // in Chromium. A successful ffprobe alone is not browser playback evidence.
    return page(`(async () => {
      const response = await fetch('/api/workspaces/files/read?' + new URLSearchParams({ directory: ${JSON.stringify(project)}, path: ${JSON.stringify(relative)} }), { headers: { 'x-toonflow-workspace': '1' } });
      if (!response.ok) throw Error('media read ' + response.status);
      const url = URL.createObjectURL(await response.blob());
      const media = document.createElement(${JSON.stringify(kind)}); media.muted = true; media.preload = 'auto'; document.body.append(media);
      try {
        await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('metadata timeout')), 8000); media.onloadeddata = () => { clearTimeout(t); resolve(); }; media.onerror = () => { clearTimeout(t); reject(Error('decode error ' + media.error?.code)); }; media.src = url; });
        const duration = media.duration;
        await media.play();
        await new Promise((resolve, reject) => { const deadline = Date.now() + 5000; const poll = () => { if (media.currentTime > 0.12) resolve(); else if (Date.now() > deadline || media.error) reject(Error('playback did not advance')); else setTimeout(poll, 40); }; poll(); });
        return { duration, currentTime: media.currentTime, width: media.videoWidth || null, height: media.videoHeight || null, readyState: media.readyState };
      } finally { media.pause(); media.removeAttribute('src'); media.load(); media.remove(); URL.revokeObjectURL(url); }
    })()`);
  }
  async function uiOperation(operation, label, increment) {
    await selectSource();
    const before = await count();
    const originalIds = new Set(await page(`[...document.querySelectorAll(${nodes})].map(element => element.getAttribute('data-id'))`));
    await clickText(label, `document.querySelector(${source})`);
    await waitFor(() => page(`!![...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)`), `${operation} dialog`);
    if (operation === "trim") {
      await waitFor(() => page(`!![...document.querySelectorAll('.videoActionPanel button')].find(e => e.textContent.trim() === '截取片段' && !e.disabled)`), "trim real probe");
      await page(`(() => { const inputs = document.querySelectorAll('.videoActionPanel input'); if (inputs.length !== 2) throw Error('trim inputs missing'); [0.25, 1.25].forEach((v, i) => { inputs[i].value = String(v); inputs[i].dispatchEvent(new Event('input', { bubbles: true })); inputs[i].dispatchEvent(new Event('change', { bubbles: true })); inputs[i].blur(); }); })()`);
    }
    await clickText(label, "[...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)");
    await waitFor(async () => await count() === before + increment, `${operation} result nodes`, 30_000);
    const data = await waitFor(async () => { const value = await saved(); return value.nodes.length === before + increment ? value : null; }, `${operation} disk save`);
    const sourceNode = data.nodes.find(node => node.id === "acceptance-source");
    assert.equal(sourceNode.data.outputs.video.value.url, "input.mp4");
    const artifactNodes = data.nodes.filter(node => !originalIds.has(node.id));
    assert.equal(artifactNodes.length, increment, "result nodes must contain real artifact references");
    for (const node of artifactNodes) {
      const output = Object.values(node.data.outputs)[0].value.url;
      assert.ok((await stat(path.join(project, output))).size > 0);
      await decodeFile(path.join(project, output));
      const info = await probeFile(path.join(project, output));
      assert.ok(Math.abs(Number(info.format.duration) - (operation === "trim" ? 1 : 3)) < 0.5, "unexpected artifact duration");
      if (node.type === "remote-audioNode") assert.ok(info.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac"));
      if (operation === "separate" && node.type === "remote-videoNode") assert.equal(info.streams.some(stream => stream.codec_type === "audio"), false, "separated video must be silent");
    }
    await assertNoStaging();
    return artifactNodes.map(node => Object.values(node.data.outputs)[0].value.url);
  }

  try {
    const ready = await check("candidate modules and signed resources", async () => {
      const media = await import(moduleUrl("mediaTools.mjs"));
      media.mediaRun("/usr/bin/codesign", ["--verify", "--strict", "-R", 'anchor apple generic and certificate leaf[subject.OU] = "H7PDHSK3C7" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', config.appPath]);
      tools = media.verifyMediaTools(mediaToolsRoot, process, { phase: "signed", team: "H7PDHSK3C7" });
      media.verifyMediaExecutables(tools);
      for (const directory of [project, secondProject, denied]) await mkdir(directory, { recursive: true });
      await runTool(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x128:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(project, "input.mp4")]);
      await writeFile(canvasPath, JSON.stringify({ toonflowCanvas: true, nodes: [{ id: "acceptance-source", type: "remote-videoNode", position: { x: 150, y: 200 }, data: { label: "视频", outputs: { video: { dataType: "VIDEO", value: { url: "input.mp4", mimeType: "video/mp4" } } } } }], edges: [], viewport: { x: 0, y: 0, zoom: 0.8 } }));
      await writeFile(path.join(secondProject, "空画布.json"), JSON.stringify({ toonflowCanvas: true, nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }));
      const { createToonFactoryVideoEditor } = await import(moduleUrl("toonFactoryVideoEdit.mjs"));
      editor = createToonFactoryVideoEditor({ isDirectoryGranted: directory => directory === project, mediaToolsRoot, packaged: true });
      return { version: config.version, candidateResources: config.resources };
    });
    if (!ready) throw new Error("Candidate/signature/fixture prerequisite failed");
    const runtimeReady = await check("isolated packaged runtime", async () => {
      await bounded(app.whenReady(), "Electron ready");
      const token = "acceptance-local-catalog-only";
      host = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end('{}'); return; }
        if (request.method === "GET" && /^\/workspace\/[^/]+\/toonflow\/models$/.test(request.url)) {
          response.end(JSON.stringify({ models: [{ providerId: "acceptance", providerLabel: "Local catalog only", modelId: "text", label: "Non-executable fake model", type: "text", protocol: "openai-completions" }] }));
        } else { externalRequests.push({ method: request.method, url: request.url }); response.writeHead(503).end(JSON.stringify({ error: "No model execution allowed in acceptance" })); }
      });
      host.listen(0, "127.0.0.1"); await once(host, "listening");
      window = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const { createToonFactoryRuntime } = await import(moduleUrl("toonFactoryRuntime.mjs"));
      const selections = [project, secondProject];
      runtime = createToonFactoryRuntime({ app, moduleRoot, packaged: true, getWindow: () => window,
        getAccess: () => ({ baseUrl: `http://127.0.0.1:${host.address().port}`, clientToken: token }),
        dependencies: { dialog: { showOpenDialog: async () => { const directory = selections.shift(); assert.ok(directory, "unexpected native directory picker"); return { filePaths: [directory] }; }, showSaveDialog: async () => ({ canceled: true }) }, shell: { openExternal: async url => { externalRequests.push({ external: url }); throw new Error("external navigation denied"); } } } });
      assert.equal((await runtime.open("packaged-media-acceptance")).running, true);
      view = window.contentView.children[0]?.children[0];
      assert.ok(view);
      view.webContents.on("console-message", (_event, _level, message) => { if (/error|fail/i.test(String(message))) diagnostics.push(String(message).slice(0, 2000)); });
      runtime.layout({ x: 48, y: 0, width: 1392, height: 1000 });
      assert.equal((await runtime.enter()).currentDirectory, null);
      assert.ok(app.getPath("userData").startsWith(root));
      // Runtime installs its own session header hook. Network requests are denied
      // separately without replacing that hook or changing candidate authorization.
      view.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const url = new URL(details.url);
        const allowed = ["blob:", "data:"].includes(url.protocol) || (["http:", "ws:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
        if (!allowed) externalRequests.push({ blocked: details.url });
        callback({ cancel: !allowed });
      });
    });
    if (!runtimeReady) throw new Error("Candidate runtime prerequisite failed");
    await check("catalog and renderer boundary", async () => {
      assert.equal(await page("typeof require"), "undefined");
      const origin = new URL(view.webContents.getURL()).origin;
      assert.equal((await fetch(`${origin}/health`)).status, 403);
      const catalog = await page("(async () => (await (await fetch('/api/settings/get', { headers: { 'x-toonflow-workspace': '1' } })).json()).data)()");
      assert.equal(catalog.juggleworkManaged, true);
      assert.ok(catalog.customProviders.some(provider => provider.id === "acceptance"));
      assert.equal(JSON.stringify(catalog).includes("acceptance-local-catalog-only"), false);
    });
    await check("directory permission denial", async () => {
      const result = await api({ operation: "probe", directory: denied, path: "input.mp4" });
      assert.equal(result.status, 403, JSON.stringify(result));
      assert.equal(result.body.data.code, "DIRECTORY_GRANT_REQUIRED");
    });
    assert.equal((await runtime.chooseProject()).currentDirectory, project);
    await waitFor(() => page(`!!document.querySelector(${source} + ' video') || !!document.querySelector(${source})?.querySelector('video')`), "candidate video plugin render");
    await check("video actions UI", async () => {
      await selectSource();
      for (const label of ["提取音轨", "分离音视频", "截取片段", "逐帧拉片"]) assert.equal(await page(`[...document.querySelector(${source}).querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled && b.getClientRects().length > 0)`), true, label);
    });
    await check("source decode and playback", async () => { await decodeFile(path.join(project, "input.mp4")); return playback("input.mp4"); });
    await check("UI trim", () => uiOperation("trim", "截取片段", 1));
    await check("UI extractAudio", () => uiOperation("extractAudio", "提取音轨", 1));
    await check("UI separate", () => uiOperation("separate", "分离音视频", 2));
    let analysisResult, beforeAnalysis, afterAnalysis;
    await check("frameAnalysis UI and real analyze", async () => {
      await selectSource();
      await clickText("逐帧拉片", `document.querySelector(${source})`);
      await waitFor(() => page(`!!document.querySelector(${analysis})?.querySelector('.analysisPanel')`), "frameAnalysis plugin render");
      assert.equal(await page(`document.querySelector(${analysis}).innerText.includes('已连接视频')`), true);
      beforeAnalysis = await count();
      await clickText("开始拉片", `document.querySelector(${analysis})`);
      await waitFor(async () => {
        const data = await saved();
        analysisResult = data.nodes.find(node => node.type === "remote-frameAnalysisNode")?.data.result;
        return analysisResult?.scenes?.length > 0;
      }, "real analysis and saved manifest", 35_000);
      assert.deepEqual(JSON.parse(await readFile(path.join(project, analysisResult.manifest), "utf8")), analysisResult);
      const data = await saved(), owner = data.nodes.find(node => node.type === "remote-frameAnalysisNode").id;
      const outputs = data.nodes.filter(node => node.data.frameAnalysisOwner === owner);
      assert.equal(outputs.length, analysisResult.scenes.length * 2 + (analysisResult.audio ? 1 : 0));
      for (const scene of analysisResult.scenes) {
        await decodeFile(path.join(project, scene.video));
        assert.ok((await stat(path.join(project, scene.image))).size > 0);
        assert.ok(scene.end > scene.start);
      }
      afterAnalysis = await count();
      await assertNoStaging();
      return { scenes: analysisResult.scenes.length, resultNodes: outputs.length };
    });
    await check("analysis undo redo", async () => {
      assert.ok(analysisResult && afterAnalysis > beforeAnalysis, "analysis prerequisite failed");
      const historyKey = async shiftKey => page(`(() => { document.activeElement?.blur(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: ${shiftKey}, bubbles: true, cancelable: true })); document.body.dispatchEvent(new KeyboardEvent('keyup', { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: ${shiftKey}, bubbles: true })); })()`);
      await historyKey(false);
      await waitFor(async () => await count() === beforeAnalysis, "analysis batch undo");
      assert.ok((await stat(path.join(project, analysisResult.manifest))).isFile(), "undo must retain media");
      await historyKey(true);
      await waitFor(async () => await count() === afterAnalysis, "analysis batch redo");
    });
    await check("analysis rebuild idempotence", async () => {
      assert.ok(analysisResult, "analysis prerequisite failed");
      const before = await count();
      await clickText("重建结果节点", `document.querySelector(${analysis})`);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(await count(), before);
    });
    await check("save reload", async () => {
      assert.ok(analysisResult, "analysis prerequisite failed");
      const before = await saved();
      await page(`document.querySelector(${analysis}).querySelector('[aria-label="刷新节点"]').click()`);
      await waitFor(() => page(`!!document.querySelector(${analysis})?.innerText.includes('个镜头')`), "node refresh retained result");
      const loaded = once(view.webContents, "did-finish-load");
      view.webContents.reload();
      await bounded(loaded, "page reload");
      await waitFor(() => page(`document.querySelectorAll(${nodes}).length === ${before.nodes.length} && !!document.querySelector(${analysis})?.innerText.includes('个镜头')`), "page reload persistence", 30_000);
      const after = await saved();
      assert.deepEqual(after.nodes.map(node => node.id).sort(), before.nodes.map(node => node.id).sort());
      assert.deepEqual(after.nodes.find(node => node.type === "remote-frameAnalysisNode").data.result, analysisResult);
    });
    await check("project switch", async () => {
      const before = await saved();
      assert.equal((await runtime.chooseProject()).currentDirectory, secondProject);
      await waitFor(async () => await count() === 0, "second project empty canvas");
      assert.equal((await runtime.openProject(project)).currentDirectory, project);
      await waitFor(async () => await count() === before.nodes.length, "project A restored");
      assert.equal((await saved()).nodes.find(node => node.id === "acceptance-source").data.outputs.video.value.url, "input.mp4");
      assert.equal(JSON.parse(await readFile(path.join(secondProject, "空画布.json"), "utf8")).nodes.length, 0);
    });
    await mkdir(path.join(project, "exports"));
    await check("real export", async () => {
      const result = await editor.execute(exportInput("exports/result.mp4"));
      assert.ok(result.bytes > 0 && Math.abs(result.duration - 2) < 0.5);
      const probe = await probeFile(path.join(project, result.path));
      assert.ok(probe.streams.some(stream => stream.codec_type === "video" && stream.codec_name === "h264" && stream.width === 160 && stream.height === 128));
      assert.ok(probe.streams.some(stream => stream.codec_type === "audio" && stream.codec_name === "aac"));
      await decodeFile(path.join(project, result.path));
      await assertNoStaging();
      return result;
    });
    await check("output decode and playback", async () => {
      assert.ok(analysisResult, "analysis prerequisite failed");
      const disk = await saved();
      const paths = disk.nodes.flatMap(node => Object.values(node.data.outputs || {}).filter(output => ["VIDEO", "AUDIO"].includes(output.dataType)).map(output => ({ url: output.value.url, kind: output.dataType === "VIDEO" ? "video" : "audio" })));
      paths.push({ url: "exports/result.mp4", kind: "video" });
      const evidence = [];
      for (const item of paths) evidence.push({ ...item, ...await playback(item.url, item.kind) });
      for (const scene of analysisResult.scenes) assert.equal(await page(`(async () => { const r = await fetch('/api/workspaces/files/read?' + new URLSearchParams({ directory: ${JSON.stringify(project)}, path: ${JSON.stringify(scene.image)} }), { headers: { 'x-toonflow-workspace': '1' } }); if (!r.ok) throw Error('image read failed'); const bitmap = await createImageBitmap(await r.blob()); const ok = bitmap.width > 0 && bitmap.height > 0; bitmap.close(); return ok; })()`), true);
      return evidence;
    });
    await check("no overwrite", async () => {
      const existing = path.join(project, "exports", "result.mp4"), before = await readFile(existing);
      await assert.rejects(editor.execute(exportInput("exports/result.mp4")), /已存在|EEXIST/);
      assert.deepEqual(await readFile(existing), before);
      await mkdir(path.join(project, "collision"));
      const sentinel = Buffer.from("owned existing manifest");
      await writeFile(path.join(project, "collision", "manifest.json"), sentinel);
      await assert.rejects(editor.execute(editorInput("separate", "collision")), /EEXIST|已存在/);
      assert.deepEqual(await readdir(path.join(project, "collision")), ["manifest.json"]);
      assert.deepEqual(await readFile(path.join(project, "collision", "manifest.json")), sentinel);
      await assertNoStaging();
    });
    await check("negative media permissions", async () => {
      await assert.rejects(editor.execute({ operation: "probe", directory: denied, path: "input.mp4" }), /未经.*授权/);
      await symlink(denied, path.join(project, "escape"), "dir");
      for (const input of [
        { operation: "probe", directory: project, path: "../not-authorized/input.mp4" },
        { operation: "probe", directory: project, path: path.join(project, "input.mp4") },
        { ...exportInput("escape/escaped.mp4") },
        { ...exportInput("exports/invalid.mp4"), args: ["-y"] },
      ]) await assert.rejects(editor.execute(input), /路径|符号链接|参数/);
      const result = await api({ operation: "probe", directory: project, path: "input.mp4", executable: "/bin/sh" });
      assert.equal(result.status, 400);
      assert.deepEqual(await readdir(denied), []);
      await assertNoStaging();
    });
    for (const operation of ["export", "separate", "analyze"]) await check(`active ${operation} cancellation`, async () => {
      const directory = `cancel-${operation}`; await mkdir(path.join(project, directory));
      const start = children.length;
      const input = operation === "export" ? exportInput(`${directory}/cancelled.mp4`) : { ...editorInput(operation, directory), ...(operation === "analyze" ? { threshold: 0.3, minSceneSeconds: 0.5 } : {}) };
      const controller = new AbortController();
      const outcome = editor.execute(input, controller.signal).then(value => ({ value }), error => ({ error }));
      try {
        const child = await activeRender(start);
        assert.equal(child.closed, false);
        controller.abort(new Error("acceptance active render cancellation"));
        await editor.stop();
        assert.ok((await outcome).error, "cancelled operation unexpectedly succeeded");
      } finally { await editor.stop(); await outcome; }
      await waitFor(() => children.slice(start).every(record => !alive(record)), "cancelled children exited");
      assert.deepEqual(await readdir(path.join(project, directory)), []);
      await assertNoStaging();
      assert.ok((await editor.execute({ operation: "probe", directory: project, path: "input.mp4" })).duration > 0);
    });
    await check("UI cancellation", async () => {
      await selectSource(); const before = await count(), start = children.length, filesBefore = await assetFiles();
      await clickText("分离音视频", `document.querySelector(${source})`);
      await waitFor(() => page("!![...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)"), "separate dialog");
      await clickText("分离音视频", "[...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)");
      await activeRender(start);
      await clickText("取消处理", "[...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)");
      await waitFor(() => children.slice(start).every(record => !alive(record)), "UI cancellation children exit");
      await waitFor(() => page("![...document.querySelectorAll('.videoActionPanel [role=status]')].some(e => e.getClientRects().length)"), "UI cancellation settled");
      assert.equal(await count(), before);
      assert.deepEqual(await assetFiles(), filesBefore, "UI cancellation published files");
      await clickText("关闭", "[...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)");
      await assertNoStaging();
    });
    await check("project switch during processing", async () => {
      await selectSource(); const before = await saved(), start = children.length, filesBefore = await assetFiles();
      await clickText("分离音视频", `document.querySelector(${source})`);
      await waitFor(() => page("!![...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)"), "switch cancellation dialog");
      await clickText("分离音视频", "[...document.querySelectorAll('.videoActionPanel')].find(e => e.getClientRects().length)");
      await activeRender(start);
      await runtime.openProject(secondProject);
      await waitFor(() => children.slice(start).every(record => !alive(record)), "switch cancelled media children");
      await waitFor(async () => await count() === 0, "B isolated from A job");
      assert.equal(JSON.parse(await readFile(path.join(secondProject, "空画布.json"), "utf8")).nodes.length, 0);
      await runtime.openProject(project);
      await waitFor(async () => await count() === before.nodes.length, "A no stale result nodes");
      assert.deepEqual(await assetFiles(), filesBefore, "project switch left published cancelled media");
      await assertNoStaging();
    });
    await check("grant revocation during processing", async () => {
      await mkdir(path.join(project, "revoked"));
      const start = children.length;
      const outcome = api(editorInput("separate", "revoked")).then(value => ({ value }), error => ({ error }));
      await activeRender(start);
      await runtime.clearProjectGrants();
      const result = await outcome;
      assert.ok(result.error || result.value.status >= 400, JSON.stringify(result));
      await waitFor(() => children.slice(start).every(record => !alive(record)), "revoked media children exit");
      assert.deepEqual(await readdir(path.join(project, "revoked")), []);
      await assertNoStaging();
    });
    await check("no external model requests", async () => { assert.deepEqual(externalRequests, []); });
    // Include successful lifecycle shutdown (not just cancellation) in orphan check.
    await runtime.dispose();
    assert.equal(runtime.state().running, false);
    await waitFor(() => mediaChildren().every(record => !alive(record)), "all media children exit");
  } catch (error) {
    fatal = true; diagnostics.push(error.stack || String(error)); console.error(error);
  } finally {
    clearTimeout(hardTimer);
    await finish();
  }
}

if (process.argv.includes("--toon-media-worker")) {
  void worker(argument("--toon-media-worker")).catch(error => { console.error(error); process.exitCode = 1; void import("electron").then(({ default: electron }) => electron.app.exit(1)); });
} else {
  void launch().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}

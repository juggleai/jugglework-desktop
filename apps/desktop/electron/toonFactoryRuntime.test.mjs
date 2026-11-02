import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";

import { createToonFactoryMediaRequests, createToonFactoryRuntime, terminateSidecarProcess, TOON_FACTORY_IDLE_TIMEOUT_MS, toonFactoryWorkspaceScopeKey } from "./toonFactoryRuntime.mjs";
import { mediaRun, verifyMediaTools } from "./mediaTools.mjs";

const mainSource = await readFile(new URL("./main.mjs", import.meta.url), "utf8");

describe("restricted media request ownership", () => {
  it("records cancellation before start, rejects reuse and never cancels a different ID or directory", async () => {
    const directory = await realpath(os.tmpdir());
    let started = 0, aborted = false, release = () => {};
    const requests = createToonFactoryMediaRequests(async (_input, signal) => {
      started++;
      await new Promise(resolve => { release = () => resolve(undefined); signal.addEventListener("abort", () => { aborted = true; }, { once: true }); });
      signal.throwIfAborted();
    }, value => value === directory);
    const early = { requestId: randomUUID(), directory };
    assert.deepEqual(await requests.cancel(early), { settled: true });
    await assert.rejects(requests.execute({ ...early, operation: "probe" }), /已取消/);
    assert.equal(started, 0);
    const input = { requestId: randomUUID(), directory, operation: "probe" };
    const outcome = requests.execute(input).catch(error => error);
    while (!started) await new Promise(resolve => setImmediate(resolve));
    await requests.cancel(early);
    assert.equal(aborted, false);
    await assert.rejects(requests.cancel({ requestId: input.requestId, directory: path.join(directory, "other") }), /不属于/);
    assert.equal(aborted, false);
    let settled = false;
    const cancelling = requests.cancel({ requestId: input.requestId, directory }).then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(aborted, true);
    assert.equal(settled, false, "acknowledgement waits for execute cleanup");
    release();
    await cancelling;
    assert.match((await outcome).message, /已取消/);
    await assert.rejects(requests.execute(input), /不可复用/);
    await requests.close();
    await assert.rejects(requests.execute({ ...input, requestId: randomUUID() }), /已关闭/);
  });

  it("registers before canonicalization and isolates runtime generations", async () => {
    const directory = await realpath(os.tmpdir());
    let started = 0;
    const execute = async () => { started++; return true; };
    const old = createToonFactoryMediaRequests(execute, () => true);
    const current = createToonFactoryMediaRequests(execute, () => true);
    const input = { requestId: randomUUID(), directory };
    const outcome = old.execute(input).catch(error => error);
    await old.cancel(input);
    assert.match((await outcome).message, /已取消/);
    assert.equal(started, 0);
    assert.equal(await current.execute(input), true);
    await old.close();
    await assert.rejects(old.cancel(input), /已关闭/);
    await current.close();
  });

  it("does not acknowledge cancellation or project cleanup when staging cleanup fails", async () => {
    const directory = await realpath(os.tmpdir());
    for (const externalAbort of [false, true]) {
      let started = false;
      const failure = new Error("staging cleanup failed");
      const controller = new AbortController();
      const requests = createToonFactoryMediaRequests(async (_input, signal) => {
        started = true;
        await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
        throw failure;
      }, () => true);
      const input = { requestId: randomUUID(), directory };
      const outcome = requests.execute(input, controller.signal).catch(error => error);
      while (!started) await new Promise(resolve => setImmediate(resolve));
      if (externalAbort) controller.abort();
      else await assert.rejects(requests.cancelAll(), error => error === failure);
      assert.equal(await outcome, failure);
      await assert.rejects(requests.cancel(input), error => error === failure);
      await assert.rejects(requests.cancelAll(), error => error === failure);
      await assert.rejects(requests.close(), error => error === failure);
      await assert.rejects(requests.close(), error => error === failure);
    }
  });

  it("bounds non-reusable IDs and rejects malformed or noncanonical identities", async () => {
    const directory = await realpath(os.tmpdir());
    const requests = createToonFactoryMediaRequests(async () => true, () => true);
    await assert.rejects(requests.cancel({ requestId: "stale", directory }), /无效/);
    await assert.rejects(requests.cancel({ requestId: randomUUID(), directory, pid: 1 }), /无效/);
    await assert.rejects(requests.execute({ requestId: randomUUID(), directory: `${directory}/../${path.basename(directory)}` }), /无效/);
    for (let i = 0; i < 4096; i++) await requests.cancel({ requestId: randomUUID(), directory });
    await assert.rejects(requests.cancel({ requestId: randomUUID(), directory }), /上限/);
    await requests.close();
  });
});

function commandHandlerSource(name, nextName) {
  const start = mainSource.indexOf(`  "${name}":`);
  const end = mainSource.indexOf(`  "${nextName}":`, start);
  assert.notEqual(start, -1, `${name} handler is missing`);
  assert.notEqual(end, -1, `${nextName} handler is missing`);
  return mainSource.slice(start, end);
}

class FakeChild extends EventEmitter {
  constructor(port, onReady) {
    super();
    this.exitCode = null;
    this.pid = 12345;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    setImmediate(async () => {
      await onReady?.(this);
      this.stdout.write(`TOONFLOW_READY=${port}\n`);
    });
  }

  kill(signal) {
    this.killedWith = signal;
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0);
    return true;
  }
}

class ShutdownChild extends EventEmitter {
  constructor(pid, exitOnKill) {
    super();
    this.pid = pid;
    this.exitCode = /** @type {number | null} */ (null);
    this.killedWith = /** @type {string | undefined} */ (undefined);
    this.exitOnKill = exitOnKill;
  }

  kill(signal) {
    this.killedWith = signal;
    if (this.exitOnKill) {
      this.exitCode = 0;
      this.emit("exit", 0);
    }
    return true;
  }
}

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.executeJavaScriptResult = /** @type {unknown} */ (undefined);
    this.executedJavaScripts = [];
  }

  isDestroyed() { return this.destroyed; }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  async loadURL(url) { this.url = url; }
  async executeJavaScript(source) {
    this.executedJavaScript = source;
    this.executedJavaScripts.push(source);
    if (this.executeJavaScriptResult instanceof Error) throw this.executeJavaScriptResult;
    return this.executeJavaScriptResult;
  }
  async capturePage() {
    return { isEmpty: () => false, toDataURL: () => "data:image/png;base64,dG9vbmZsb3c=" };
  }
  close() { this.destroyed = true; }
  openDevTools() {}
}

class FakeView {
  constructor(options) {
    this.options = options;
    this.webContents = new FakeWebContents();
  }

  setVisible(visible) { this.visible = visible; }
  setBounds(bounds) { this.bounds = bounds; }
  setBorderRadius(radius) { this.borderRadius = radius; }
  setBackgroundColor(color) { this.backgroundColor = color; }
  addChildView(view) { (this.children ??= []).push(view); }
  removeChildView(view) { this.children = (this.children ?? []).filter((candidate) => candidate !== view); }
}

async function createHarness(onReady, pageFailed = false, platform = process.platform, verifyBundle) {
  const root = await mkdtemp(path.join(os.tmpdir(), "toon-factory-runtime-"));
  const moduleRoot = path.join(root, "module");
  const userData = path.join(root, "user-data");
  const selectedDirectory = path.join(root, "selected");
  await mkdir(path.join(moduleRoot, "server"), { recursive: true });
  await mkdir(selectedDirectory, { recursive: true });
  await writeFile(path.join(moduleRoot, "server", "jugglework.js"), "");
  const bundledBun = path.join(moduleRoot, platform === "win32" ? "bun.exe" : "bun");
  await writeFile(bundledBun, "");
  await writeFile(path.join(moduleRoot, "build-manifest.json"), "{}");

  const spawns = [];
  const partitions = [];
  const sessions = [];
  const views = [];
  const clipViews = [];
  const children = [];
  const processKills = [];
  const activeGroups = new Set();
  const idleTimers = [];
  const integrity = { verifications: 0 };
  const contentView = {
    children: [],
    addChildView(view) { this.children.push(view); },
    removeChildView(view) { this.children = this.children.filter((candidate) => candidate !== view); },
  };
  const window = { contentView, getContentSize: () => [1200, 800], webContents: { getZoomFactor: () => 1 } };
  let nextPort = 43000;
  const dependencies = {
    View: class extends FakeView {
      constructor(options) {
        super(options);
        clipViews.push(this);
      }
    },
    WebContentsView: class extends FakeView {
      constructor(options) {
        super(options);
        this.webContents.loadURL = async (url) => {
          this.webContents.url = url;
          const env = spawns.at(-1).options.env;
          const response = await fetch(`${env.TOONFLOW_BRIDGE_URL}/desktop/ready`, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ args: [pageFailed] }),
          });
          assert.equal(response.status, 200);
        };
        views.push(this);
      }
    },
    clipboard: { readText: () => "", writeText() {} },
    dialog: { showOpenDialog: async () => ({ filePaths: [path.join(selectedDirectory, "..", "selected")] }) },
    shell: { openExternal() {} },
    fetch: async () => ({ ok: true }),
    setTimeout(callback, delay) {
      const timer = { callback, cleared: false, delay };
      idleTimers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
    platform,
    verifyToonFactoryBundle(root, expected) {
      integrity.verifications += 1;
      if (verifyBundle) return verifyBundle(root, expected);
      return { executablePath: bundledBun };
    },
    processKill(pid, signal) {
      if (signal === 0) {
        if (!activeGroups.has(-pid)) throw Object.assign(new Error("process group not found"), { code: "ESRCH" });
        return;
      }
      processKills.push({ pid, signal });
      const target = children.find((candidate) => candidate.pid === -pid);
      if (target) {
        target.kill(signal);
        activeGroups.delete(target.pid);
      }
    },
    session: {
      fromPartition(partition) {
        partitions.push(partition);
        const webRequest = {
          calls: [],
          onBeforeSendHeaders(...args) { this.calls.push(args); },
        };
        const isolatedSession = {
          permissionHandlers: [],
          webRequest,
          setPermissionRequestHandler(handler) { this.permissionHandlers.push(handler); },
        };
        sessions.push(isolatedSession);
        return isolatedSession;
      },
    },
    spawn(program, args, options) {
      spawns.push({ program, args, options });
      const child = new FakeChild(nextPort++, onReady);
      children.push(child);
      if (options.detached) activeGroups.add(child.pid);
      return child;
    },
  };
  const runtime = createToonFactoryRuntime({
    app: { getPath: (name) => name === "userData" ? userData : root },
    getWindow: () => window,
    getAccess: async () => null,
    moduleRoot,
    dependencies,
  });
  return { children, clipViews, contentView, dialog: dependencies.dialog, idleTimers, integrity, partitions, processKills, root, runtime, selectedDirectory, sessions, spawns, userData, views, window };
}

it("authenticates restricted media HTTP cancellation and rejects stale generations/project starts", async () => {
  const h = await createHarness();
  try {
    await h.runtime.open("media-http");
    const first = h.spawns.at(-1).options.env;
    const post = (route, input, headers = {}, env = first) => fetch(`${env.TOONFLOW_BRIDGE_URL}${route}`, {
      method: "POST", headers: { Authorization: `Bearer ${env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
    });
    await callDesktopBridge(h.spawns.at(-1), "selectDirectory");
    const directory = await realpath(h.selectedDirectory), requestId = randomUUID();
    assert.equal((await post("/videoEditCancel", { directory, requestId }, { Origin: "http://hostile.invalid" })).status, 403);
    assert.equal((await post("/videoEditCancel", { directory, requestId }, { Authorization: "Bearer invalid" })).status, 403);
    assert.deepEqual(await (await post("/videoEditCancel", { directory, requestId })).json(), { settled: true });
    assert.equal((await post("/videoEditProject", { directory })).status, 200);
    const late = await post("/videoEdit", { directory, requestId, operation: "probe", path: "input.mp4" });
    assert.equal(late.status, 502);
    assert.match(JSON.stringify(await late.json()), /已取消/);
    assert.equal((await post("/videoEditProject", { directory })).status, 200);
    assert.equal((await post("/videoEditProject", { directory: null })).status, 200);
    const closed = await post("/videoEdit", { directory, requestId: randomUUID(), operation: "probe", path: "input.mp4" });
    assert.match(JSON.stringify(await closed.json()), /已切换/);
    await h.runtime.restart("media-http");
    const current = h.spawns.at(-1).options.env;
    assert.equal((await post("/videoEditCancel", { directory, requestId }, { Authorization: `Bearer ${first.TOONFLOW_BRIDGE_TOKEN}` }, current)).status, 403);
    await h.runtime.clearProjectGrants();
    assert.equal((await post("/videoEditCancel", { directory, requestId: randomUUID() }, {}, current)).status, 502);
  } finally { await h.runtime.dispose(); await rm(h.root, { recursive: true, force: true }); }
});

for (const transition of ["cancel", "project", "revoke"]) it(`restricted HTTP ${transition} reaps only its owned suspended media process before acknowledgement`, { skip: process.platform !== "darwin", timeout: 30_000 }, async t => {
  const h = await createHarness();
  let suspended = /** @type {import("node:child_process").ChildProcess | undefined} */ (undefined);
  try {
    const mediaRoot = fileURLToPath(new URL("../resources/mediaTools", import.meta.url));
    const tools = verifyMediaTools(mediaRoot, process, { phase: "built" });
    await cp(mediaRoot, path.join(h.root, "mediaTools"), { recursive: true });
    const directory = await realpath(h.selectedDirectory);
    await mkdir(path.join(directory, "outputs"));
    mediaRun(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x128:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "1", "-c:v", "libx264", "-threads", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(directory, "input.mp4")]);
    await h.runtime.open("media-real-http");
    await callDesktopBridge(h.spawns.at(-1), "selectDirectory");
    const env = h.spawns.at(-1).options.env;
    const post = (route, input) => fetch(`${env.TOONFLOW_BRIDGE_URL}${route}`, { method: "POST", headers: { Authorization: `Bearer ${env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal((await post("/videoEditProject", { directory })).status, 200);
    let observed = _child => {};
    const rendering = new Promise(resolve => { observed = child => resolve(child); });
    const prototype = /** @type {ChildProcess & { spawn(options: { file: string }): number }} */ (ChildProcess.prototype);
    const original = prototype.spawn;
    t.mock.method(prototype, "spawn", function(options) {
      const result = original.call(this, options);
      if (options.file === path.join(h.root, "mediaTools", path.relative(mediaRoot, tools.ffmpeg)) && !suspended) {
        suspended = this;
        process.kill(this.pid, "SIGSTOP");
        observed(this);
      }
      return result;
    });
    const requestId = randomUUID();
    const outcome = post("/videoEdit", { requestId, directory, operation: "separate", path: "input.mp4", outputDirectory: "outputs" });
    await Promise.race([rendering, outcome.then(async response => { throw new Error(`render did not start: ${response.status} ${await response.text()}`); })]);
    assert.ok(suspended);
    await h.runtime.clearProjectGrants("another-workspace");
    assert.equal(suspended.signalCode, null);
    process.kill(suspended.pid, 0);
    if (transition === "revoke") await h.runtime.clearProjectGrants();
    else assert.equal((await post(transition === "cancel" ? "/videoEditCancel" : "/videoEditProject", transition === "cancel" ? { requestId, directory } : { directory: null })).status, 200);
    assert.equal((await outcome).status, 502);
    assert.equal(suspended.signalCode, "SIGKILL");
    assert.throws(() => process.kill(suspended.pid, 0), { code: "ESRCH" });
    assert.deepEqual(await readdir(path.join(directory, "outputs")), []);
    assert.deepEqual((await readdir(directory)).sort(), ["input.mp4", "outputs"]);
  } finally {
    try { if (suspended) suspended.kill("SIGKILL"); } catch {}
    await h.runtime.dispose();
    await rm(h.root, { recursive: true, force: true });
  }
});

async function callDesktopBridge(spawn, command, headers = {}) {
  return fetch(`${spawn.options.env.TOONFLOW_BRIDGE_URL}/desktop/${command}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${spawn.options.env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ args: [] }),
  });
}

describe("toon factory workspace isolation", () => {
  it("authorizes a confirmed existing project without a directory picker and persists the grant", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      harness.dialog.showOpenDialog = async () => { throw new Error("Must not show a folder picker"); };
      const directory = await realpath(harness.selectedDirectory);
      const state = { projects: [{ directory, name: "story" }], currentDirectory: null };
      const env = harness.spawns[0].options.env;
      const bridge = {
        getProjectState: () => state,
        chooseProject: async () => {
          const response = await fetch(`${env.TOONFLOW_BRIDGE_URL}/desktop/selectDirectory`, {
            method: "POST",
            headers: { Authorization: `Bearer ${env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify({ args: [] }),
          });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error.message);
          const { result } = payload;
          assert.equal(result, directory);
          return { ...state, currentDirectory: result, mode: "imported" };
        },
      };
      harness.views[0].webContents.executeJavaScript = source => runInNewContext(source, { __TOONFLOW_JUGGLEWORK_HOST__: bridge });
      await assert.rejects(harness.runtime.authorizeProject("relative"), /目录无效/);
      await assert.rejects(harness.runtime.authorizeProject("/unlisted"), /项目列表/);
      const opened = await harness.runtime.authorizeProject(directory);
      assert.equal(opened.currentDirectory, directory);
      const grants = JSON.parse(await readFile(path.join(env.TOONFLOW_DATA_DIR, "directory-grants.json"), "utf8"));
      assert.deepEqual(grants.directories, [directory]);
      // The approved path is consumed once; later selection still requires its normal picker.
      await assert.rejects(harness.runtime.chooseProject(), /Must not show a folder picker|Unexpected end of JSON/);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("preserves directory authorization failures across the page bridge without misclassifying other 403s", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const webContents = harness.views[0].webContents;
      const denied = Object.assign(new Error("Request failed with status code 403"), {
        response: { status: 403, data: { data: { code: "DIRECTORY_GRANT_REQUIRED" } } },
      });
      /** @type {Error} */
      let failure = denied;
      webContents.executeJavaScript = source => runInNewContext(source, {
        __TOONFLOW_JUGGLEWORK_HOST__: { openProject: async () => { throw failure; } },
      });
      await assert.rejects(harness.runtime.openProject("/tmp/story"), /\[DIRECTORY_GRANT_REQUIRED\].*授权并打开/);
      failure = Object.assign(new Error("Other forbidden request"), { response: { status: 403, data: {} } });
      await assert.rejects(harness.runtime.openProject("/tmp/story"), /Other forbidden request/);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("reads and opens projects through the managed page bridge", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const state = { projects: [{ directory: "/tmp/story", name: "story", lastOpenedAt: 1 }], currentDirectory: null };
      harness.views[0].webContents.executeJavaScriptResult = state;
      assert.deepEqual(await harness.runtime.projectState(), state);
      assert.match(harness.views[0].webContents.executedJavaScript, /getProjectState/);

      assert.deepEqual(await harness.runtime.enter(), state);
      assert.match(harness.views[0].webContents.executedJavaScript, /showHome/);

      harness.views[0].webContents.executeJavaScriptResult = null;
      assert.equal(await harness.runtime.chooseProject(), null);
      assert.match(harness.views[0].webContents.executedJavaScript, /chooseProject/);

      const opened = { ...state, currentDirectory: "/tmp/story", mode: "imported" };
      harness.views[0].webContents.executeJavaScriptResult = opened;
      assert.deepEqual(await harness.runtime.openProject(" /tmp/story "), opened);
      assert.match(harness.views[0].webContents.executedJavaScript, /openProject/);
      assert.match(harness.views[0].webContents.executedJavaScript, /\/tmp\/story/);
      const beforeReturn = harness.views[0].webContents.executedJavaScripts.length;
      assert.deepEqual(await harness.runtime.enter(), opened);
      const returnScripts = harness.views[0].webContents.executedJavaScripts.slice(beforeReturn);
      assert.equal(returnScripts.length, 2);
      assert.match(returnScripts[0], /getProjectState/);
      assert.match(returnScripts[1], /openProject/);

      harness.views[0].webContents.executeJavaScriptResult = state;
      assert.deepEqual(await harness.runtime.renameProject(" /tmp/story ", " 新名称 "), state);
      assert.match(harness.views[0].webContents.executedJavaScript, /renameProject/);
      assert.match(harness.views[0].webContents.executedJavaScript, /新名称/);
      assert.deepEqual(await harness.runtime.removeProject(" /tmp/story "), state);
      assert.match(harness.views[0].webContents.executedJavaScript, /removeProject/);
      await assert.rejects(harness.runtime.openProject("  "), /目录无效/);
      await assert.rejects(harness.runtime.renameProject("/tmp/story", "  "), /名称无效/);
      await assert.rejects(harness.runtime.removeProject("  "), /目录无效/);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("keeps the native page viewport fixed when clipping host overlays", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const bounds = { x: 53, y: 45, width: 940, height: 648 };
      harness.runtime.layout(bounds);
      assert.deepEqual(harness.clipViews[0].bounds, bounds);
      assert.deepEqual(harness.views[0].bounds, { x: 0, y: 0, width: 940, height: 648 });
      assert.equal(harness.views[0].borderRadius, 17);
      harness.window.webContents.getZoomFactor = () => 1.25;
      harness.runtime.layout(bounds);
      assert.deepEqual(harness.clipViews[0].bounds, { x: 66, y: 56, width: 1134, height: 744 });
      assert.deepEqual(harness.views[0].bounds, { x: 0, y: 0, width: 1134, height: 744 });
      assert.equal(harness.views[0].borderRadius, 21);
      harness.runtime.layout({ ...bounds, clipLeft: 300 });
      assert.deepEqual(harness.clipViews[0].bounds, { x: 441, y: 56, width: 759, height: 744 });
      assert.deepEqual(harness.views[0].bounds, { x: -375, y: 0, width: 1134, height: 744 });
      harness.runtime.layout({ ...bounds, borderRadius: 0 });
      assert.equal(harness.views[0].borderRadius, 0);
      harness.runtime.layout(null);
      assert.equal(harness.clipViews[0].visible, false);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("captures the current native page without changing its layout", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const bounds = { x: 53, y: 45, width: 940, height: 648 };
      harness.runtime.layout(bounds);
      assert.equal(await harness.runtime.snapshot(), "data:image/png;base64,dG9vbmZsb3c=");
      assert.deepEqual(harness.clipViews[0].bounds, bounds);
      assert.deepEqual(harness.views[0].bounds, { x: 0, y: 0, width: 940, height: 648 });
      assert.equal(harness.clipViews[0].visible, true);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("derives stable opaque SHA-256 scope keys", () => {
    const key = toonFactoryWorkspaceScopeKey("workspace/customer-visible-id");
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(key, toonFactoryWorkspaceScopeKey("workspace/customer-visible-id"));
    assert.notEqual(key, toonFactoryWorkspaceScopeKey("other-workspace"));
    assert.equal(key.includes("customer-visible-id"), false);
  });

  it("canonicalizes selected directories and revokes native bridges on switch and close", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const firstSpawn = harness.spawns[0];
      const unauthorized = await fetch(`${firstSpawn.options.env.TOONFLOW_BRIDGE_URL}/desktop/selectDirectory`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ args: [] }),
      });
      assert.equal(unauthorized.status, 403);
      assert.equal((await callDesktopBridge(firstSpawn, "selectDirectory", { Origin: "http://127.0.0.1" })).status, 403);
      const selected = await callDesktopBridge(firstSpawn, "selectDirectory");
      assert.equal(selected.status, 200);
      assert.deepEqual(await selected.json(), { result: await realpath(harness.selectedDirectory) });

      await harness.runtime.open("workspace-b");
      await assert.rejects(callDesktopBridge(firstSpawn, "selectDirectory"));
      const secondSpawn = harness.spawns[1];
      assert.equal((await callDesktopBridge(secondSpawn, "selectDirectory")).status, 200);

      await harness.runtime.close();
      await assert.rejects(callDesktopBridge(secondSpawn, "selectDirectory"));
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("isolates data, logs, partitions, and per-start credentials by workspace", async () => {
    const harness = await createHarness((child) => {
      const { TOONFLOW_BRIDGE_TOKEN, TOONFLOW_SESSION_TOKEN } = harness.spawns.at(-1).options.env;
      child.stdout.write(`bridge=${TOONFLOW_BRIDGE_TOKEN}\n`);
      child.stderr.write(`session=${TOONFLOW_SESSION_TOKEN}\n`);
    });
    try {
      const first = await harness.runtime.open("workspace-a");
      const firstSpawn = harness.spawns[0];
      assert.deepEqual(first, { running: true, workspaceId: "workspace-a", error: null });
      assert.equal(firstSpawn.options.env.JUGGLEWORK_MANAGED, "1");
      assert.equal(firstSpawn.options.detached, process.platform !== "win32");
      assert.equal(firstSpawn.options.env.TOONFLOW_DATA_DIR, path.join(harness.userData, "toonFactoryV2", "workspaces", toonFactoryWorkspaceScopeKey("workspace-a")));
      assert.equal(harness.partitions[0], `persist:jugglework-toonflow-v2-${toonFactoryWorkspaceScopeKey("workspace-a")}`);
      assert.equal(harness.views[0].webContents.url.includes(firstSpawn.options.env.TOONFLOW_SESSION_TOKEN), false);

      await harness.runtime.open("workspace-b");
      const secondSpawn = harness.spawns[1];
      assert.deepEqual(harness.runtime.state(), { running: true, workspaceId: "workspace-b", error: null });
      assert.notEqual(secondSpawn.options.env.TOONFLOW_BRIDGE_TOKEN, firstSpawn.options.env.TOONFLOW_BRIDGE_TOKEN);
      assert.notEqual(secondSpawn.options.env.TOONFLOW_SESSION_TOKEN, firstSpawn.options.env.TOONFLOW_SESSION_TOKEN);
      assert.equal(harness.contentView.children.length, 1);
      assert.equal(harness.sessions[0].permissionHandlers.at(-1), null);
      assert.deepEqual(harness.sessions[0].webRequest.calls.at(-1), [null]);
      if (process.platform !== "win32") assert.deepEqual(harness.processKills[0], { pid: -harness.children[0].pid, signal: "SIGTERM" });

      await harness.runtime.dispose();
      const firstLog = await readFile(path.join(firstSpawn.options.env.TOONFLOW_DATA_DIR, "runtime.log"), "utf8");
      assert.equal(firstLog.includes(firstSpawn.options.env.TOONFLOW_BRIDGE_TOKEN), false);
      assert.equal(firstLog.includes(firstSpawn.options.env.TOONFLOW_SESSION_TOKEN), false);
      assert.match(firstLog, /\[REDACTED\]/);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: null });
      assert.equal(harness.contentView.children.length, 0);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent opens, reuses the same workspace, and switches different workspaces", async () => {
    const harness = await createHarness();
    try {
      const first = harness.runtime.open("workspace-a");
      const same = harness.runtime.open("workspace-a");
      const different = harness.runtime.open("workspace-b");
      assert.equal((await first).workspaceId, "workspace-a");
      assert.equal((await same).workspaceId, "workspace-a");
      assert.equal((await different).workspaceId, "workspace-b");
      assert.equal(harness.spawns.length, 2);
      assert.equal(harness.integrity.verifications, 1);
      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.deepEqual(harness.runtime.state(), { running: true, workspaceId: "workspace-b", error: null });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("refuses to start before broker or sidecar creation when bundle verification fails", async () => {
    const harness = await createHarness(undefined, false, process.platform, () => {
      throw new Error("bundle integrity failure");
    });
    try {
      await assert.rejects(harness.runtime.open("workspace-a"), /bundle integrity failure/);
      assert.equal(harness.spawns.length, 0);
      assert.equal(harness.contentView.children.length, 0);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: "bundle integrity failure" });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("hides immediately and cancels idle shutdown when the workspace is reopened", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      harness.runtime.layout({ x: 100, y: 20, width: 800, height: 600 });
      harness.runtime.hide();

      assert.equal(harness.clipViews[0].visible, false);
      assert.equal(harness.children[0].exitCode, null);
      assert.equal(harness.idleTimers.length, 1);
      assert.equal(harness.idleTimers[0].delay, TOON_FACTORY_IDLE_TIMEOUT_MS);

      await harness.runtime.open("workspace-a");
      assert.equal(harness.idleTimers[0].cleared, true);
      harness.idleTimers[0].callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.spawns.length, 1);
      assert.equal(harness.runtime.state().running, true);

      harness.runtime.hide();
      const layoutTimer = harness.idleTimers[1];
      harness.runtime.layout({ x: 100, y: 20, width: 800, height: 600 });
      assert.equal(layoutTimer.cleared, true);
      layoutTimer.callback();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.runtime.state().running, true);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("closes a hidden runtime when its idle timeout expires", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      harness.runtime.hide();
      const exited = new Promise((resolve) => harness.children[0].once("exit", resolve));
      harness.idleTimers[0].callback();
      await exited;

      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.equal(harness.contentView.children.length, 0);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: null });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("fully closes an active runtime and revokes its browser session hooks", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      await harness.runtime.close();

      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.equal(harness.contentView.children.length, 0);
      assert.equal(harness.sessions[0].permissionHandlers.at(-1), null);
      assert.deepEqual(harness.sessions[0].webRequest.calls.at(-1), [null]);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: null });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("forces a same-workspace restart and rotates both credentials", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      const firstEnv = harness.spawns[0].options.env;
      await harness.runtime.restart("workspace-a");
      const secondEnv = harness.spawns[1].options.env;

      assert.equal(harness.spawns.length, 2);
      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.notEqual(secondEnv.TOONFLOW_BRIDGE_TOKEN, firstEnv.TOONFLOW_BRIDGE_TOKEN);
      assert.notEqual(secondEnv.TOONFLOW_SESSION_TOKEN, firstEnv.TOONFLOW_SESSION_TOKEN);
      assert.deepEqual(harness.runtime.state(), { running: true, workspaceId: "workspace-a", error: null });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("can restart after child and view crashes", async () => {
    const harness = await createHarness();
    try {
      await harness.runtime.open("workspace-a");
      harness.children[0].exitCode = 1;
      harness.children[0].emit("exit", 1);
      assert.match(harness.runtime.state().error, /后端已退出/);
      await harness.runtime.restart("workspace-a");

      harness.views[1].webContents.emit("render-process-gone");
      assert.match(harness.runtime.state().error, /页面已退出/);
      await harness.runtime.restart("workspace-a");

      assert.equal(harness.spawns.length, 3);
      assert.deepEqual(harness.runtime.state(), { running: true, workspaceId: "workspace-a", error: null });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("cleans a failed start and can retry with fresh credentials", async () => {
    const harness = await createHarness();
    let healthChecks = 0;
    const originalRuntime = harness.runtime;
    await originalRuntime.dispose();
    harness.runtime = createToonFactoryRuntime({
      app: { getPath: (name) => name === "userData" ? harness.userData : harness.root },
      getWindow: () => ({
        contentView: harness.contentView,
        getContentSize: () => [1200, 800],
        webContents: { getZoomFactor: () => 1 },
      }),
      getAccess: async () => null,
      moduleRoot: path.join(harness.root, "module"),
      dependencies: {
        View: FakeView,
        WebContentsView: class extends FakeView {
          constructor(options) {
            super(options);
            this.webContents.loadURL = async (url) => {
              this.webContents.url = url;
              const env = harness.spawns.at(-1).options.env;
              const response = await fetch(`${env.TOONFLOW_BRIDGE_URL}/desktop/ready`, {
                method: "POST",
                headers: { Authorization: `Bearer ${env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify({ args: [false] }),
              });
              assert.equal(response.status, 200);
            };
          }
        },
        clipboard: { readText: () => "", writeText() {} },
        dialog: {},
        shell: { openExternal() {} },
        fetch: async () => ({ ok: ++healthChecks > 1 }),
        verifyToonFactoryBundle: () => ({ executablePath: path.join(harness.root, "module", process.platform === "win32" ? "bun.exe" : "bun") }),
        session: { fromPartition: () => ({ setPermissionRequestHandler() {}, webRequest: { onBeforeSendHeaders() {} } }) },
        spawn(program, args, options) {
          harness.spawns.push({ program, args, options });
          const child = new FakeChild(44000 + harness.children.length);
          harness.children.push(child);
          return child;
        },
      },
    });
    try {
      await assert.rejects(harness.runtime.open("workspace-a"), /健康检查失败/);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: "漫剧工厂健康检查失败" });
      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.equal(harness.contentView.children.length, 0);

      assert.equal((await harness.runtime.open("workspace-a")).running, true);
      assert.notEqual(harness.spawns[0].options.env.TOONFLOW_BRIDGE_TOKEN, harness.spawns[1].options.env.TOONFLOW_BRIDGE_TOKEN);
      assert.notEqual(harness.spawns[0].options.env.TOONFLOW_SESSION_TOKEN, harness.spawns[1].options.env.TOONFLOW_SESSION_TOKEN);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("keeps a page-reported startup failure visible after cleanup", async () => {
    const harness = await createHarness(undefined, true);
    try {
      await assert.rejects(harness.runtime.open("workspace-a"), /页面初始化失败/);
      assert.deepEqual(harness.runtime.state(), {
        running: false,
        workspaceId: null,
        error: "漫剧工厂页面初始化失败，可点击重试重新启动",
      });
      assert.equal(harness.children[0].killedWith, "SIGTERM");
      assert.equal(harness.contentView.children.length, 0);
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("interrupts an in-flight start during disposal without retaining an error", async () => {
    /** @type {(() => void) | undefined} */
    let releaseReady;
    const harness = await createHarness(() => new Promise((resolve) => { releaseReady = () => resolve(); }));
    try {
      const opening = harness.runtime.open("workspace-a");
      while (!harness.children.length) await new Promise((resolve) => setImmediate(resolve));
      await harness.runtime.dispose();
      await assert.rejects(opening, /应用正在退出/);
      assert.deepEqual(harness.runtime.state(), { running: false, workspaceId: null, error: null });
      assert.equal(harness.children[0].killedWith, "SIGTERM");
    } finally {
      releaseReady?.();
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });
});

describe("toon factory POSIX process group shutdown", () => {
  it("spawns POSIX sidecars detached and terminates their process group", async () => {
    const harness = await createHarness(undefined, false, "darwin");
    try {
      await harness.runtime.open("workspace-a");
      assert.equal(harness.spawns[0].options.detached, true);
      await harness.runtime.close();
      assert.deepEqual(harness.processKills[0], { pid: -harness.children[0].pid, signal: "SIGTERM" });
    } finally {
      await harness.runtime.dispose();
      await rm(harness.root, { recursive: true, force: true });
    }
  });

  it("escalates a detached process group from SIGTERM to SIGKILL", async () => {
    const child = new ShutdownChild(24680, false);
    const signals = [];
    let groupExists = true;
    await terminateSidecarProcess(child, {
      platform: "darwin",
      detached: true,
      parentPid: 13579,
      gracefulTimeoutMs: 0,
      forceTimeoutMs: 0,
      processKill(pid, signal) {
        if (signal === 0) {
          if (!groupExists) throw Object.assign(new Error("process group not found"), { code: "ESRCH" });
          return true;
        }
        signals.push({ pid, signal });
        if (signal === "SIGKILL") groupExists = false;
        return true;
      },
    });
    assert.deepEqual(signals, [
      { pid: -child.pid, signal: "SIGTERM" },
      { pid: -child.pid, signal: "SIGKILL" },
    ]);
    assert.equal(child.killedWith, undefined);
  });

  it("never sends a group signal for Electron's own pid", async () => {
    const child = new ShutdownChild(24680, true);
    await terminateSidecarProcess(child, {
      platform: "darwin",
      detached: true,
      parentPid: child.pid,
      processKill() { assert.fail("must not signal Electron's process group"); },
    });
    assert.equal(child.killedWith, "SIGTERM");
  });

  it("terminates a detached child and its grandchild without targeting Electron's process group", { timeout: 5000, skip: process.platform === "win32" }, async () => {
    const script = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'process.stdout.write(String(child.pid) + "\\n");',
      'setInterval(() => {}, 1000);',
    ].join("");
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    try {
      while (!output.includes("\n")) await Promise.race([once(child.stdout, "data"), new Promise((_, reject) => setTimeout(() => reject(new Error("helper startup timed out")), 1000))]);
      const grandchildPid = Number(output.trim());
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 1);
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 1);
      assert.notEqual(child.pid, process.pid);

      await terminateSidecarProcess(child, { detached: true, gracefulTimeoutMs: 1000, forceTimeoutMs: 1000 });
      const deadline = Date.now() + 1000;
      while (true) {
        try { process.kill(grandchildPid, 0); }
        catch (error) {
          assert.equal(error.code, "ESRCH");
          break;
        }
        if (Date.now() >= deadline) assert.fail("grandchild survived process group termination");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      if (Number.isSafeInteger(child.pid) && child.pid > 1 && child.pid !== process.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch {}
      }
    }
  });
});

describe("toon factory permission cleanup handlers", () => {
  it("keeps snapshot capture restricted to the main window main frame", () => {
    const handler = commandHandlerSource("toonFactorySnapshot", "toonFactoryStatus");
    assert.match(handler, /event\.sender !== mainWindow\?\.webContents/);
    assert.match(handler, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
    assert.match(handler, /toonFactoryRuntime\.snapshot\(\)/);
  });

  it("keeps project reads and opens restricted to the main window main frame", () => {
    const readHandler = commandHandlerSource("toonFactoryProjectState", "toonFactoryEnter");
    const enterHandler = commandHandlerSource("toonFactoryEnter", "toonFactoryChooseProject");
    const chooseHandler = commandHandlerSource("toonFactoryChooseProject", "toonFactoryOpenProject");
    const openHandler = commandHandlerSource("toonFactoryOpenProject", "toonFactoryAuthorizeProject");
    const authorizeHandler = commandHandlerSource("toonFactoryAuthorizeProject", "toonFactoryRenameProject");
    const renameHandler = commandHandlerSource("toonFactoryRenameProject", "toonFactoryRemoveProject");
    const removeHandler = commandHandlerSource("toonFactoryRemoveProject", "desktopRemoteControlSettingsRead");
    for (const handler of [readHandler, enterHandler, chooseHandler, openHandler, authorizeHandler, renameHandler, removeHandler]) {
      assert.match(handler, /event\.sender !== mainWindow\?\.webContents/);
      assert.match(handler, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
    }
    assert.match(readHandler, /toonFactoryRuntime\.projectState\(\)/);
    assert.match(enterHandler, /toonFactoryRuntime\.enter\(\)/);
    assert.match(chooseHandler, /toonFactoryRuntime\.chooseProject\(\)/);
    assert.match(openHandler, /toonFactoryRuntime\.openProject\(args\[0\]\)/);
    assert.match(authorizeHandler, /toonFactoryRuntime\.authorizeProject\(args\[0\]\)/);
    assert.match(renameHandler, /toonFactoryRuntime\.renameProject\(args\[0\], args\[1\]\)/);
    assert.match(removeHandler, /toonFactoryRuntime\.removeProject\(args\[0\]\)/);
  });

  it("keeps close restricted to the main window main frame", () => {
    const handler = commandHandlerSource("toonFactoryClose", "toonFactoryCloseAndClearGrants");
    assert.match(handler, /event\.sender !== mainWindow\?\.webContents/);
    assert.match(handler, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
    assert.match(handler, /await toonFactoryRuntime\.close\(\)/);
    assert.doesNotMatch(handler, /clearAllProjectGrants/);
  });

  it("clears persisted project grants only through the authority-change command", () => {
    const handler = commandHandlerSource("toonFactoryCloseAndClearGrants", "toonFactoryRestart");
    assert.match(handler, /event\.sender !== mainWindow\?\.webContents/);
    assert.match(handler, /await toonFactoryRuntime\.close\(\)/);
    assert.match(handler, /await toonFactoryRuntime\.clearAllProjectGrants\(\)/);
  });

  it("closes the active Toon Factory workspace before forgetting it", () => {
    const handler = commandHandlerSource("workspaceForget", "workspaceAddAuthorizedRoot");
    const close = handler.indexOf("await toonFactoryRuntime.close()");
    const forget = handler.indexOf("workspaceStore.forgetWorkspace(workspaceId)");
    assert.match(handler, /toonFactoryRuntime\.state\(\)\.workspaceId === workspaceId/);
    assert.ok(close >= 0 && forget > close);
  });

  it("closes Toon Factory before resetting JuggleWork state", () => {
    const handler = commandHandlerSource("resetJuggleWorkState", "resetOpencodeCache");
    const close = handler.indexOf("await toonFactoryRuntime.close()");
    const reset = handler.indexOf("workspaceStore.resetJuggleWorkState()");
    assert.ok(close >= 0 && reset > close);
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import { createToonFactoryRuntime, terminateSidecarProcess, TOON_FACTORY_IDLE_TIMEOUT_MS, toonFactoryWorkspaceScopeKey } from "./toonFactoryRuntime.mjs";

const mainSource = await readFile(new URL("./main.mjs", import.meta.url), "utf8");

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
  return { children, clipViews, contentView, idleTimers, integrity, partitions, processKills, root, runtime, selectedDirectory, sessions, spawns, userData, views, window };
}

async function callDesktopBridge(spawn, command, headers = {}) {
  return fetch(`${spawn.options.env.TOONFLOW_BRIDGE_URL}/desktop/${command}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${spawn.options.env.TOONFLOW_BRIDGE_TOKEN}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ args: [] }),
  });
}

describe("toon factory workspace isolation", () => {
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
    const openHandler = commandHandlerSource("toonFactoryOpenProject", "toonFactoryRenameProject");
    const renameHandler = commandHandlerSource("toonFactoryRenameProject", "toonFactoryRemoveProject");
    const removeHandler = commandHandlerSource("toonFactoryRemoveProject", "desktopRemoteControlSettingsRead");
    for (const handler of [readHandler, enterHandler, chooseHandler, openHandler, renameHandler, removeHandler]) {
      assert.match(handler, /event\.sender !== mainWindow\?\.webContents/);
      assert.match(handler, /event\.senderFrame !== mainWindow\.webContents\.mainFrame/);
    }
    assert.match(readHandler, /toonFactoryRuntime\.projectState\(\)/);
    assert.match(enterHandler, /toonFactoryRuntime\.enter\(\)/);
    assert.match(chooseHandler, /toonFactoryRuntime\.chooseProject\(\)/);
    assert.match(openHandler, /toonFactoryRuntime\.openProject\(args\[0\]\)/);
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

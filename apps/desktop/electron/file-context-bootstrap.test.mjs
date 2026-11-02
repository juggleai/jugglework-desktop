import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createFileContextBootstrap } from "./file-context-bootstrap.mjs";

/**
 * 构建实际 IPC 生命周期的替身，不替代初始化器的来源和请求核验。
 * @param {{bootstrap?: () => Promise<any>}} [options] 可控的配置读取，用于生命周期交错回归
 */
function fixture(options = {}) {
  const handlers = new Map(), windows = [], applied = [], requests = [];
  class BrowserWindow {
    destroyed = false;
    webContents = Object.assign(new EventEmitter(), { mainFrame: {}, setWindowOpenHandler() {} });
    constructor(options) { windows.push(this); this.options = options; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const loader = createFileContextBootstrap({ BrowserWindow, ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, preload: "/preload.cjs",
    load: async () => {}, bootstrap: options.bootstrap ?? (async () => ({ baseUrl: "https://cloud.example/jwork/api" })),
    fetcher: async (url, init) => { requests.push({ url, init }); return Response.json({ ok: true }); },
    apply: async (input) => { applied.push(input); }, fallback: () => ({ lang: "en", theme: "light" }) });
  const event = () => ({ sender: windows.at(-1).webContents, senderFrame: windows.at(-1).webContents.mainFrame });
  return { loader, windows, applied, requests, request: (command, ...args) => handlers.get("jugglework:file-context:request")(event(), command, ...args),
    complete: (result) => handlers.get("jugglework:file-context:complete")(event(), result), handlers, event };
}

test("初始化共用一次主分区页面，结果只保留外观字段，完成即释放页面", async () => {
  const f = fixture();
  const first = f.loader.initialize(), second = f.loader.initialize();
  assert.equal(first, second);
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].options.webPreferences.partition, undefined);
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
  await f.complete({ appearance: { lang: "zh", theme: "dark", token: "ignored" }, context: { signedIn: true } });
  assert.deepEqual(await first, { lang: "zh", theme: "dark" });
  assert.equal(f.windows[0].destroyed, true);
  await assert.rejects(f.complete({ context: {} }), /来源/);
  assert.equal(f.applied.length, 1);
});

test("初始化请求只允许可信顶层读取当前部署的会话、组织和策略", async () => {
  const f = fixture(), pending = f.loader.initialize();
  for (const path of ["/v1/me", "/v1/me/orgs", "/v1/me/desktop-config"]) {
    const response = await f.request("__fetch", `https://cloud.example/jwork/api${path}`, { method: "GET" });
    assert.equal(response.status, 200);
  }
  for (const [command, url, init] of [
    ["__fetch", "https://other.example/jwork/api/v1/me", { method: "GET" }],
    ["__fetch", "https://cloud.example/jwork/api/v1/me?token=canary", { method: "GET" }],
    ["__fetch", "https://cloud.example/jwork/api/v1/me", { method: "POST" }],
    ["__fetch", "https://cloud.example/jwork/api/v1/me", { method: "GET", body: "not-readonly" }],
    ["startSessionRun", "", {}],
  ]) await assert.rejects(f.request(command, url, init), /不可用/);
  await assert.rejects(f.handlers.get("jugglework:file-context:request")({ ...f.event(), senderFrame: {} }, "getDesktopBootstrapConfig"), /来源/);
  assert.equal(f.requests.length, 3);
  assert.ok(f.requests.every((request) => request.init.redirect === "error"));
  await f.complete({}); await pending;
});

test("主窗口切换账户取消旧初始化，迟到的结果不能重新应用旧策略", async () => {
  const f = fixture(), pending = f.loader.initialize();
  f.loader.invalidate();
  await assert.rejects(pending, /账户/);
  await assert.rejects(f.complete({ context: { signedIn: true } }), /来源/);
  assert.deepEqual(f.applied, []);
  const retry = f.loader.initialize();
  await f.complete({ appearance: { lang: "invalid", theme: "invalid" } });
  assert.deepEqual(await retry, { lang: "en", theme: "light" });
});

test("旧初始化失败不清除账户变化后已开始的新初始化", async () => {
  const f = fixture(), first = f.loader.initialize();
  const failed = assert.rejects(first, /账户/);
  f.loader.invalidate();
  const retry = f.loader.initialize();
  await failed;
  assert.equal(f.loader.initialize(), retry);
  assert.equal(f.windows.length, 2);
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.windows[1].destroyed, false);
  await f.complete({ appearance: { lang: "zh", theme: "light" } });
  assert.deepEqual(await retry, { lang: "zh", theme: "light" });
});

test("等待配置期间账户失效，迟到请求不能继续访问部署", async () => {
  /** @type {(value: any) => void} */
  let resolveBootstrap = (_value) => { throw new Error("配置读取尚未初始化"); };
  const bootstrap = new Promise((resolve) => { resolveBootstrap = resolve; });
  const f = fixture({ bootstrap: () => bootstrap }), pending = f.loader.initialize();
  const failed = assert.rejects(pending, /账户/);
  const request = assert.rejects(f.request("__fetch", "https://cloud.example/jwork/api/v1/me", { method: "GET" }), /来源/);
  f.loader.invalidate();
  await failed;
  resolveBootstrap({ baseUrl: "https://cloud.example/jwork/api" });
  await request;
  assert.equal(f.requests.length, 0);
});

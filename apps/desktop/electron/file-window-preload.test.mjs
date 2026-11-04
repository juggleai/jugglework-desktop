import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { EventEmitter } from "node:events";

test("shared UI initialization is harmless but unrelated desktop IPC stays denied", async () => {
  /** @type {{ bridge?: { invokeDesktop(command: string, ...args: unknown[]): Promise<unknown> } }} */
  const exposed = {};
  const calls = [];
  const source = readFileSync(new URL("./file-window-preload.mjs", import.meta.url), "utf8")
    .replace('import { contextBridge, ipcRenderer } from "electron";', "");
  vm.runInNewContext(source, {
    process: { platform: "darwin" },
    contextBridge: { exposeInMainWorld(_name, value) { exposed.bridge = value; } },
    ipcRenderer: { on() {}, invoke(...args) { calls.push(args); return Promise.resolve("ok"); } },
  });
  assert.ok(exposed.bridge, "preload must expose the desktop bridge");
  const bridge = exposed.bridge;
  await bridge.invokeDesktop("__setApplicationMenuVisible", false);
  await bridge.invokeDesktop("__setNativeTheme", "dark");
  assert.equal(calls.length, 0);
  assert.throws(() => bridge.invokeDesktop("__arbitraryCommand"), /文件窗口不支持此操作/);
  assert.equal(await bridge.invokeDesktop("__fetch", "request"), "ok");
  assert.equal(calls.length, 1);
  assert.deepEqual(Array.from(calls[0]), ["jugglework:desktop", "__fetch", "request"]);
});

test("subscription IDs remain private; early unsubscribe cancels Main after invoke resolves", async () => {
  /** @type {any} */
  let bridge;
  /** @type {any} */
  const ipc = new EventEmitter();
  const calls = [];
  let complete = (_value) => {};
  ipc.invoke = (...args) => {
    calls.push(args);
    if (args[0].endsWith("session-subscribe")) return new Promise((resolve) => { complete = resolve; });
    return Promise.resolve();
  };
  const source = readFileSync(new URL("./file-window-preload.mjs", import.meta.url), "utf8").replace('import { contextBridge, ipcRenderer } from "electron";', "");
  vm.runInNewContext(source, { process: { platform: "darwin" }, contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: ipc });
  const events = [];
  const stop = bridge.fileWindow.subscribeSessionEvents((event) => events.push(event));
  assert.equal(typeof stop, "function");
  ipc.emit("jugglework:file-window:session-event", {}, { id: "private-id", event: { type: "server.connected", properties: {} } });
  complete("private-id");
  await Promise.resolve();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, undefined);
  stop(); stop();
  assert.equal(ipc.listenerCount("jugglework:file-window:session-event"), 0);
  assert.equal(calls.filter(([name]) => name.endsWith("session-unsubscribe")).length, 1);
  const stopEarly = bridge.fileWindow.subscribeSessionEvents(() => assert.fail("unsubscribed"));
  stopEarly();
  complete("second-private-id");
  await Promise.resolve();
  assert.deepEqual(calls.at(-1), ["jugglework:file-window:session-unsubscribe", "second-private-id"]);
});

test("原生开窗检查早于 React 装配时保留请求，草稿桥就绪后只答复一次", async () => {
  /** @type {any} */
  let bridge;
  const replies = [], received = [];
  const ipc = Object.assign(new EventEmitter(), { send: (...args) => replies.push(args) });
  const source = readFileSync(new URL("./file-window-preload.mjs", import.meta.url), "utf8").replace('import { contextBridge, ipcRenderer } from "electron";', "");
  vm.runInNewContext(source, { process: { platform: "darwin" }, contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: ipc });
  const request = { requestId: "opening-guard", action: "guard", workspaceId: "ws", sessionId: "ses" };
  ipc.emit("jugglework:office:composer-request", {}, request);
  assert.equal(replies.length, 0);
  const stop = bridge.office.onComposerRequest(async (input) => { received.push(input); return { needsConfirmation: false }; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(received, [request]);
  assert.deepEqual(JSON.parse(JSON.stringify(replies)), [["jugglework:office:composer-reply", { requestId: request.requestId, result: { needsConfirmation: false } }]]);
  stop();
  const stopAgain = bridge.office.onComposerRequest(async () => assert.fail("旧请求不得重放"));
  await new Promise((resolve) => setImmediate(resolve));
  stopAgain();
  assert.equal(replies.length, 1);
  ipc.emit("jugglework:office:composer-request", {}, { requestId: "late-append", action: "append" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(replies.length, 2);
  assert.equal(replies[1][1].requestId, "late-append");
  assert.match(replies[1][1].error, /尚未就绪/);
});

test("only Main preload exposes stop preparation and acknowledges cleanup without forwarding extra data", async () => {
  /** @type {any} */
  let bridge;
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => { calls.push(args); }, sendSync: () => null });
  const calls = [];
  const load = (name) => vm.runInNewContext(readFileSync(new URL(name, import.meta.url), "utf8")
    .replace(/^import .* from "electron";$/m, ""), {
    process: { platform: "darwin", versions: {} }, contextBridge: { exposeInMainWorld(_name, value) { bridge = value; } }, ipcRenderer: ipc,
  });
  load("./file-window-preload.mjs");
  assert.equal(bridge.fileWindow.onSessionStopRequest, undefined);
  // Production Main preload includes a synchronous bootstrap; supply its harmless test response.
  load("./preload.mjs");
  const received = [];
  let finishCleanup = () => {};
  const cleanup = new Promise((resolve) => { finishCleanup = () => resolve(undefined); });
  const stop = bridge.fileWindow.onSessionStopRequest(async (target) => { received.push(target); await cleanup; return { ok: true }; });
  ipc.emit("jugglework:file-window:session-stop-request", {}, { requestId: "fixed-request", workspaceId: "ws", sessionId: "ses", path: "untrusted-extra" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(received)), [{ workspaceId: "ws", sessionId: "ses" }]);
  assert.deepEqual(calls, [], "Main must not receive an ack before queued resources finish releasing");
  finishCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["jugglework:file-window:session-stop-reply", { requestId: "fixed-request", ok: true }]]);
  stop();
  assert.equal(ipc.listenerCount("jugglework:file-window:session-stop-request"), 0);
  const stopFailure = bridge.fileWindow.onSessionStopRequest(async () => { throw new Error("private cleanup failure"); });
  ipc.emit("jugglework:file-window:session-stop-request", {}, { requestId: "failed-request", workspaceId: "ws", sessionId: "ses" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))), ["jugglework:file-window:session-stop-reply", { requestId: "failed-request", ok: false }]);
  stopFailure();
});

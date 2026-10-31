import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("shared UI initialization is harmless but unrelated desktop IPC stays denied", async () => {
  /** @type {{ bridge?: { invokeDesktop(command: string, ...args: unknown[]): Promise<unknown> } }} */
  const exposed = {};
  const calls = [];
  const source = readFileSync(new URL("./file-window-preload.mjs", import.meta.url), "utf8")
    .replace('import { contextBridge, ipcRenderer } from "electron";', "");
  vm.runInNewContext(source, {
    process: { platform: "darwin" },
    contextBridge: { exposeInMainWorld(_name, value) { exposed.bridge = value; } },
    ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve("ok"); } },
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

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import vm from "node:vm";

test("实际 preload 只暴露只读核对订阅，capture 不接受页面确认字段", async () => {
  const calls = [];
  const ipc = Object.assign(new EventEmitter(), { invoke: async (...args) => { calls.push(args); return { reference: {} }; } });
  /** @type {any} */ let bridge;
  const source = await readFile(new URL("./office-selection-preload.cjs", import.meta.url), "utf8");
  vm.runInNewContext(source, { require: () => ({ ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } } }) });
  assert.deepEqual(Object.keys(bridge), ["capture", "submit", "cancel", "onReview"]);
  await bridge.capture("capture", { ranges: [] }, { reviewedUnconfirmed: true });
  assert.equal(JSON.stringify(calls), JSON.stringify([["jugglework:office:selection-capture", { captureId: "capture", expectedSelection: { ranges: [] } }]]));
  const notifications = [];
  const stop = bridge.onReview((value) => notifications.push(value));
  ipc.emit("jugglework:office:selection-review-pending", {}, { captureId: "capture", pending: true, reviewedUnconfirmed: true });
  ipc.emit("jugglework:office:selection-review-pending", {}, { captureId: "capture", pending: "true" });
  assert.equal(JSON.stringify(notifications), JSON.stringify([{ captureId: "capture", pending: true }]));
  assert.equal(calls.length, 1);
  stop();
  assert.equal(ipc.listenerCount("jugglework:office:selection-review-pending"), 0);
});

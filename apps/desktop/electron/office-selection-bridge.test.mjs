import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOfficeSelectionBridge, officeSelectionFailure } from "./office-selection-bridge.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

test("选区采集失败显示本地原因，未知服务端内容不会进入编辑页", () => {
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_proof_unavailable" })).error.message, /普通正文/);
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_stale" })).error.message, /重新选择/);
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("timeout")).error.message, /超时/);
  const untrusted = new ManagedRuntimeClientError("http_error", { serverCode: "arbitrary-server-content" });
  assert.equal(officeSelectionFailure(untrusted).error.message, "暂时无法读取文档选区，请稍后重试");
  assert.throws(() => officeSelectionFailure(new Error("programming failure")), /programming failure/);
});

test("原生选区回复只能来自绑定主窗口，导航后迟到回复和旧采集不能追加", async () => {
  const ipcMain = new EventEmitter();
  /** @type {any} */ let sent;
  const sender = { isDestroyed: () => false, send: (_channel, input) => { sent = input; } };
  const bridge = createOfficeSelectionBridge(/** @type {any} */ ({ ipcMain, getWindow: () => ({ isDestroyed: () => false, webContents: sender }) }));
  const first = bridge.request({ action: "prepare", sessionId: "chat" });
  ipcMain.emit("jugglework:office:composer-reply", { sender: {} }, { requestId: sent.requestId, result: { epoch: 999 } });
  ipcMain.emit("jugglework:office:composer-reply", { sender }, { requestId: sent.requestId, result: { epoch: 1 } });
  assert.deepEqual(await first, { epoch: 1, bridgeGeneration: 0 });
  const second = bridge.request({ action: "guard", sessionId: "chat" });
  const late = sent;
  const rejected = assert.rejects(second, /已变化/);
  bridge.cancel(); await rejected;
  ipcMain.emit("jugglework:office:composer-reply", { sender }, { requestId: late.requestId, result: { ok: true } });
  await assert.rejects(bridge.request({ action: "append", bridgeGeneration: 0 }), /已变化/);
});

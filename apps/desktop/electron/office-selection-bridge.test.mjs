import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createOfficeSelectionBridge, officeSelectionFailure } from "./office-selection-bridge.mjs";
import { ManagedRuntimeClientError } from "./managed-runtime-client.mjs";

test("选区采集失败显示本地原因，未知服务端内容不会进入编辑页", () => {
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_proof_unavailable" })).error.message, /加载完成/);
  assert.equal(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_slide_pages_unsupported" })).error.message, "整页编辑目前一次支持一页，请只选择一张幻灯片");
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_slide_objects_unsupported" })).error.message, /对象或合并表格/);
  assert.equal(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_slide_picture_selected" })).error.message, "当前选区包含图片，不是整页选择；请点击左侧幻灯片缩略图选择整页。图片内文字暂不支持直接改写");
  const reasons = /** @type {Array<[string, RegExp]>} */ ([["office_selection_content_limit", /处理范围/], ["office_selection_sheet_partial_merge", /完整选择合并/],
    ["office_selection_sheet_dimension_unsupported", /整行列删除/], ["office_selection_doc_structure_unsupported", /Word 选区/]]);
  for (const [code, reason] of reasons)
    assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: code })).error.message, reason);
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_stale" })).error.message, /重新选择/);
  assert.match(officeSelectionFailure(new ManagedRuntimeClientError("http_error", { serverCode: "office_selection_save_blocked" })).error.message, /仍在运行或尚未核对/);
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

test("独立窗口准备和追加使用同一真实 sender，主窗口或子 frame 不能代答", async () => {
  const ipcMain = new EventEmitter();
  /** @type {any} */
  let sent;
  const sender = { mainFrame: {}, isDestroyed: () => false, send: (_channel, input) => { sent = input; } };
  const host = { isDestroyed: () => false, webContents: sender };
  const bridge = createOfficeSelectionBridge(/** @type {any} */ ({ ipcMain, getWindow: (input) => input.windowId === 2 ? host : null }));
  for (const input of [{ action: "prepare" }, { action: "append", bridgeGeneration: 0 }]) {
    const pending = bridge.request({ ...input, windowId: 2, workspaceId: "ws", sessionId: "ses" });
    assert.ok(sent);
    ipcMain.emit("jugglework:office:composer-reply", { sender: {}, senderFrame: sender.mainFrame }, { requestId: sent.requestId, result: { wrong: true } });
    ipcMain.emit("jugglework:office:composer-reply", { sender, senderFrame: {} }, { requestId: sent.requestId, result: { wrong: true } });
    ipcMain.emit("jugglework:office:composer-reply", { sender, senderFrame: sender.mainFrame }, { requestId: sent.requestId, result: { ok: true } });
    assert.deepEqual(await pending, { ok: true, bridgeGeneration: 0 });
  }
});

test("主窗口导航只取消本窗口请求，独立窗口仍可准备和追加；全局退出清理所有宿主", async () => {
  const ipcMain = new EventEmitter();
  const sent = new Map();
  const hosts = /** @type {any[]} */ ([1, 2].map((id) => ({ isDestroyed: () => false, webContents: {
    mainFrame: {}, isDestroyed: () => false, send: (_channel, input) => sent.set(id, input),
  } })));
  const bridge = createOfficeSelectionBridge(/** @type {any} */ ({ ipcMain, getWindow: (input) => hosts[input.windowId - 1] }));
  const reply = (id, result) => {
    const sender = hosts[id - 1].webContents;
    ipcMain.emit("jugglework:office:composer-reply", { sender, senderFrame: sender.mainFrame }, { requestId: sent.get(id).requestId, result });
  };
  const main = bridge.request({ action: "prepare", windowId: 1 });
  const file = bridge.request({ action: "prepare", windowId: 2 });
  const rejected = assert.rejects(main, /已变化/);
  bridge.cancel(hosts[0].webContents);
  await rejected;
  reply(1, { epoch: 999 });
  reply(2, { epoch: 1 });
  const ready = await file;
  assert.equal(ready.bridgeGeneration, 0);
  await assert.rejects(bridge.request({ action: "append", windowId: 1, bridgeGeneration: 0 }), /已变化/);
  const append = bridge.request({ action: "append", windowId: 2, bridgeGeneration: ready.bridgeGeneration });
  reply(2, { ok: true });
  assert.equal((await append).ok, true);
  const pending = bridge.request({ action: "guard", windowId: 2 });
  const canceled = assert.rejects(pending, /已变化/);
  bridge.cancel();
  await canceled;
  await assert.rejects(bridge.request({ action: "append", windowId: 2, bridgeGeneration: ready.bridgeGeneration }), /已变化/);
});

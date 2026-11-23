import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createNativeActionsApi } from "./native-actions-api.mjs";

function harness(timeoutMs = 1_000) {
  const sent = [];
  const mainFrame = {};
  const webContents = { mainFrame, send: (channel, value) => sent.push({ channel, value }) };
  const window = { webContents, isDestroyed: () => false };
  const ipcMain = new EventEmitter();
  const api = createNativeActionsApi({ getWindow: () => window, timeoutMs });
  api.registerIpc(ipcMain);
  /** @param {object} message @param {object} [sender] @param {object} [senderFrame] */
  const reply = (message, sender = webContents, senderFrame = mainFrame) =>
    ipcMain.emit("jugglework:native-actions:response", { sender, senderFrame }, message);
  return { api, sent, reply, webContents };
}

test("a renderer answer resolves the matching request", async () => {
  const { api, sent, reply } = harness();
  const pending = api.request({ op: "product_tasks.list", scope: { baseUrl: "b", userId: "u", organizationId: "o" }, params: {} });
  assert.equal(sent[0].channel, "jugglework:native-actions:request");
  reply({ requestId: sent[0].value.requestId, ok: true, result: { items: [] } });
  assert.deepEqual(await pending, { items: [] });
});

test("answers from a subframe or another window are ignored", async () => {
  const { api, sent, reply, webContents } = harness(50);
  const pending = api.request({ op: "contacts.search", scope: {}, params: {} });
  const requestId = sent[0].value.requestId;
  reply({ requestId, ok: true, result: "forged" }, webContents, {});
  reply({ requestId, ok: true, result: "forged" }, {}, webContents.mainFrame);
  await assert.rejects(pending, { code: "native_action_timeout" });
});

test("a structured renderer failure keeps its code", async () => {
  const { api, sent, reply } = harness();
  const pending = api.request({ op: "product_tasks.list", scope: {}, params: {} });
  reply({ requestId: sent[0].value.requestId, ok: false, code: "native_actions_scope_changed", error: "账号或组织已切换" });
  await assert.rejects(pending, { code: "native_actions_scope_changed", message: /切换/ });
});

test("no main window means unavailable, not a hang", async () => {
  const api = createNativeActionsApi({ getWindow: () => null });
  await assert.rejects(api.request({ op: "contacts.search", scope: {}, params: {} }), { code: "native_actions_unavailable" });
});

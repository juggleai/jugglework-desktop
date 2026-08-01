import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createJuggleChatSkillBridge,
  JUGGLECHAT_SKILL_INVOKE_CHANNEL,
  JUGGLECHAT_SKILL_REPLY_CHANNEL,
} from "./jugglechat-skill-bridge.mjs";

function fixture(timeoutMs = 100) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const win = { isDestroyed: () => false, webContents };
  const bridge = createJuggleChatSkillBridge({ ipcMain, getWindow: () => win, timeoutMs });
  return { bridge, ipcMain, sent, webContents };
}

test("skill bridge pairs renderer replies by requestId", async (t) => {
  const { bridge, ipcMain, sent, webContents } = fixture();
  t.after(() => bridge.dispose());
  const pending = bridge.invoke({ source: "jugglechat-im-sdk", module: "message", action: "getMessages" });
  assert.equal(sent[0].channel, JUGGLECHAT_SKILL_INVOKE_CHANNEL);

  ipcMain.emit(JUGGLECHAT_SKILL_REPLY_CHANNEL, { sender: webContents }, {
    requestId: sent[0].payload.requestId,
    ok: true,
    data: { count: 2 },
  });
  assert.deepEqual(await pending, { ok: true, data: { count: 2 }, error: undefined });
});

test("skill bridge reports renderer timeouts", async (t) => {
  const { bridge } = fixture(5);
  t.after(() => bridge.dispose());
  const result = await bridge.invoke({ source: "jugglechat-im-sdk", module: "message", action: "getMessages" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "TIMEOUT");
});

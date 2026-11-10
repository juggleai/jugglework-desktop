import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";

import {
  callOfficeWordCloudBridge,
  installOfficeWordCloudBridge,
} from "./office-word-cloud-bridge.mjs";

function fixture() {
  const messages = [];
  const scope = {
    location: { origin: "https://office.test" },
    postMessage(message, origin) {
      messages.push({ message, origin });
    },
  };
  const adapter = {
    snapshot: () => ({ status: "active", revision: 3, blocks: [] }),
    applyRemoteAtRevision: (frames, revision) => ({
      status: "applied",
      frames,
      revision,
    }),
    applyRemoteStructureAtRevision: (change, revision) => ({
      status: "applied",
      change,
      revision,
    }),
    dispose() {
      this.disposed = true;
    },
  };
  let callbacks;
  const create = (options) => {
    callbacks = options;
    return adapter;
  };
  return { scope, messages, adapter, create, callbacks: () => callbacks };
}

test("正式注入的安装与调用脚本不依赖主进程模块闭包", () => {
  const value = fixture();
  const context = { window: value.scope, read: () => [], create: value.create };
  const id = "11111111-1111-4111-8111-111111111111";
  const installed = runInNewContext(`(${installOfficeWordCloudBridge.toString()})(window, ${JSON.stringify(id)}, read, create)`, context);
  assert.equal(installed.status, "active");
  const result = runInNewContext(`(${callOfficeWordCloudBridge.toString()})(window, ${JSON.stringify(id)}, "snapshot", {})`, context);
  assert.equal(result.revision, 3);
});

test("Office Word 云文档桥只执行固定对象操作并转发带代次事件", () => {
  const value = fixture();
  const initial = installOfficeWordCloudBridge(
    value.scope,
    "11111111-1111-4111-8111-111111111111",
    () => [],
    value.create,
  );
  assert.equal(initial.revision, 3);

  value.callbacks().onChange({ revision: 4, frames: [] });
  assert.deepEqual(value.messages[0], {
    origin: "https://office.test",
    message: {
      channel: "jugglework-office-word-cloud",
      message: {
        bridgeId: "11111111-1111-4111-8111-111111111111",
        type: "word.changed",
        payload: { revision: 4, frames: [] },
      },
    },
  });

  assert.equal(
    callOfficeWordCloudBridge(
      value.scope,
      "11111111-1111-4111-8111-111111111111",
      "apply",
      { frames: [{ paragraphId: "aaaaaaaa" }], revision: 4 },
    ).revision,
    4,
  );
  assert.equal(
    callOfficeWordCloudBridge(
      value.scope,
      "11111111-1111-4111-8111-111111111111",
      "dispose",
      {},
    ).status,
    "disposed",
  );
  assert.equal(value.adapter.disposed, true);
});

test("旧桥代次不能操作新页面桥", () => {
  const value = fixture();
  installOfficeWordCloudBridge(
    value.scope,
    "22222222-2222-4222-8222-222222222222",
    () => [],
    value.create,
  );
  assert.throws(
    () =>
      callOfficeWordCloudBridge(
        value.scope,
        "11111111-1111-4111-8111-111111111111",
        "snapshot",
        {},
      ),
    /word_bridge_generation_changed/,
  );
});

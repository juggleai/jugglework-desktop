import assert from "node:assert/strict";
import { test } from "node:test";
import { createOfficeCloudDocsSession } from "./office-cloud-docs-session.mjs";

/** 仅验证真实异步消息窗口的顺序和失败策略；合并语义由真实 Yjs 及双客户端验收证明。 */
function fixture(overrides = {}) {
  let revision = 0,
    remote = false,
    token = 0;
  const calls = [],
    states = [];
  const word = {
    snapshot: async () => ({ status: "active", revision, blocks: [] }),
    apply: async (frames, expected) => {
      if (expected !== revision) return { status: "stale", revision };
      if (frames.length) revision++;
      return { status: "applied", revision };
    },
    structure: async () => ({
      status: "applied",
      revision: ++revision,
      blocks: [],
    }),
  };
  const native = {
    call: async (type, payload) => {
      calls.push({ type, payload });
      if (overrides.call) {
        const value = await overrides.call(type, payload);
        if (value !== undefined) return value;
      }
      if (type === "editor.attach") return { status: "attached" };
      if (type === "editor.project")
        return {
          status: "prepared",
          token: ++token,
          frames: remote ? [{ paragraphId: "553DBC6B" }] : [],
        };
      if (type === "editor.ack") remote = false;
      return { status: type === "editor.discard" ? "discarded" : "applied" };
    },
  };
  const controller = createOfficeCloudDocsSession({
    word,
    native,
    onState: (s) => states.push(s),
  });
  return {
    word,
    native,
    calls,
    states,
    controller,
    setRevision: (n) => {
      revision = n;
    },
    remote() {
      remote = true;
      controller.nativeChanged();
    },
    change(n = revision + 1) {
      revision = n;
      controller.wordChanged({ source: "word", revision: n, frames: [] });
    },
  };
}

/** 桌面进程有 IPC 存活；测试用明确超时等待，避免 unref 的状态重试被测试运行器提前退出。 */
async function flush(f) {
 let timer;try{return await Promise.race([f.controller.flush(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('flush deadline exceeded')),2000)})])}finally{clearTimeout(timer)}
}

test("恢复必须收到对象基线核验回执，旧版 Docs 不能直接开启回写", async () => {
  const f = fixture({ call: type => type === "editor.restore" ? { status: "attached" } : undefined });
  const result = await f.controller.attach([], false, { nativeSnapshot: "fixture" });
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "word_recovery_baseline_unconfirmed");
  assert.ok(!f.calls.some(item => item.type === "editor.project" || item.type === "editor.apply"));
  f.controller.dispose();
});

test("本地内容分叉时保留两端，不发送任何回写", async () => {
  const f = fixture({ call: type => type === "editor.restore" ? { status: "rejected", reason: "word_recovery_content_changed" } : undefined });
  const result = await f.controller.attach([], false, { nativeSnapshot: "fixture" });
  assert.equal(result.status, "paused");
  assert.equal(result.reason, "word_recovery_content_changed");
  assert.ok(!f.calls.some(item => item.type === "editor.project" || item.type === "editor.apply"));
  f.controller.dispose();
});

test("迟到 Word IPC 事件到来前不把新代次配旧原生映射；旧投影无写入丢弃", async () => {
  const f = fixture();
  await f.controller.attach([]);
  await flush(f);
  const original = f.word.apply;
  let stale = 0,
    injected = false;
  f.word.apply = async (frames, expected) => {
    if (frames.length && !injected) {
      injected = true;
      f.setRevision(1);
      setTimeout(() => f.change(1), 5);
    }
    const r = await original(frames, expected);
    if (r.status === "stale") stale++;
    return r;
  };
  f.remote();
  await flush(f);
  assert.equal(f.controller.state().status, "active");
  assert.equal(stale, 1);
  assert.equal(f.calls.filter((c) => c.type === "editor.apply").length, 1);
  assert.ok(f.calls.some((c) => c.type === "editor.discard"));
  f.controller.dispose();
});

test("原生写入响应丢失保持 unknown，不自动再次发送正文", async () => {
  const f = fixture({
    call: async (type) => {
      if (type === "editor.apply") throw new Error("response lost");
    },
  });
  await f.controller.attach([]);
  await flush(f);
  f.change();
  assert.equal((await flush(f)).status, "unknown");
  f.controller.nativeChanged();
  assert.equal((await flush(f)).status, "unknown");
  assert.equal(f.calls.filter((c) => c.type === "editor.apply").length, 1);
  f.controller.dispose();
});

test("等待 attach 回应时切换上下文，旧回应不能恢复 disposed 会话", async () => {
  let release = () => {};
  const gate = new Promise((resolve) => (release = () => resolve(undefined))),
    f = fixture({
      call: async (type) => {
        if (type === "editor.attach") {
          await gate;
          return { status: "attached" };
        }
      },
    });
  const task = f.controller.attach([]);
  await new Promise((resolve) => setImmediate(resolve));
  f.controller.dispose();
  release();
  assert.equal((await task).status, "disposed");
  assert.equal(f.controller.state().status, "disposed");
  assert.ok(!f.states.some((s) => s.status === "active"));
});

test("输入法 busy 时丢弃未应用投影，待后续输入完成再处理", async () => {
  const f = fixture();
  await f.controller.attach([]);
  await flush(f);
  const original = f.word.apply;
  let busy = true;
  f.word.apply = async (frames, expected) => {
    if (frames.length && busy) {
      busy = false;
      setTimeout(() => f.change(), 10);
      return { status: "busy", revision: expected };
    }
    return original(frames, expected);
  };
  f.remote();
  const result = await flush(f);
  assert.equal(result.status, "active");
  assert.equal(f.calls.filter((c) => c.type === "editor.apply").length, 1);
  assert.ok(f.calls.some((c) => c.type === "editor.discard"));
  f.controller.dispose();
});

test("Office 事件代次缺失时暂停，不按新代次猜测已经同步", async () => {
  const f = fixture();
  await f.controller.attach([]);
  await flush(f);
  f.change(2);
  assert.equal((await flush(f)).status, "paused");
  assert.ok(f.states.some((s) => s.reason === "word_event_gap"));
  assert.equal(f.calls.filter((c) => c.type === "editor.apply").length, 0);
  f.controller.dispose();
});

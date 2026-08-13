import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCodexRuntimeAdapter } from "./codex-runtime-adapter.mjs";

function fixture() {
  const calls = [];
  const notifications = [];
  const requests = new Map();
  const client = {
    onNotification(listener) { notifications.push(listener); return () => {}; },
    onRequest(method, handler) { requests.set(method, handler); return () => {}; },
    async request(method, params) {
      calls.push([method, params]);
      if (method === "thread/start") return { thread: { id: "thr_1", createdAt: 2 }, modelProvider: "jugglework_gateway", model: "model_1" };
      if (method === "thread/resume") return { thread: { id: params.threadId, createdAt: 2 }, modelProvider: "jugglework_gateway", model: "model_1" };
      if (method === "turn/start") return { turn: { id: "turn_1" } };
      return {};
    },
  };
  const processManager = {
    async startWorkspace() { return { appServer: client }; },
    async stopWorkspace() {},
  };
  let sequence = 0;
  const adapter = createCodexRuntimeAdapter({ processManager, resolveLaunch: async () => ({ deviceId: "dev", providerId: "lpr", model: "model_1" }), now: () => 10, randomId: () => String(++sequence) });
  return { adapter, calls, notifications, requests };
}

const ws = { orgId: "org_1", workspaceId: "ws_1", cwd: "/workspace" };
const create = { ...ws, sessionId: "ses_1", modelProviderId: "lpr", modelId: "model_1" };
const scope = { orgId: "org_1", workspaceId: "ws_1", sessionId: "ses_1", threadId: "thr_1" };

describe("Codex runtime adapter", () => {
  it("maps thread and turn operations to the locked App Server protocol", async () => {
    const f = fixture();
    const events = [];
    f.adapter.subscribe((event) => events.push(event));
    await f.adapter.startWorkspace(ws);
    assert.equal(f.calls.length, 0);
    const thread = await f.adapter.createThread(create);
    assert.equal(thread.backendThreadId, "thr_1");
    await f.adapter.sendTurn({ ...scope, content: [{ type: "text", text: "hello" }] });
    await f.adapter.steerTurn({ ...scope, turnId: "turn_1", content: [{ type: "text", text: "more" }] });
    await f.adapter.interruptTurn({ ...scope, turnId: "turn_1" });
    await f.adapter.archiveThread(scope);
    assert.deepEqual(f.calls.map(([method]) => method), ["thread/start", "turn/start", "turn/steer", "turn/interrupt", "thread/archive"]);
    assert.deepEqual(f.calls[1][1].input, [{ type: "text", text: "hello" }]);
    assert.equal(events.filter((event) => event.type === "user.message").length, 2);
  });

  it("normalizes deltas, usage, terminal state and unknown notifications", async () => {
    const f = fixture();
    const events = [];
    f.adapter.subscribe((event) => events.push(event));
    await f.adapter.startWorkspace(ws);
    await f.adapter.createThread(create);
    const notify = f.notifications[0];
    notify({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } });
    notify({ method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", delta: "answer", secret: "no" } });
    notify({ method: "item/reasoning/summaryTextDelta", params: { threadId: "thr_1", turnId: "turn_1", delta: "reason" } });
    notify({ method: "thread/tokenUsage/updated", params: { threadId: "thr_1", turnId: "turn_1", tokenUsage: { last: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1, reasoningOutputTokens: 1 } } } });
    notify({ method: "vendor/private", params: { threadId: "thr_1", raw: "secret" } });
    notify({ method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_1", status: "completed" } } });
    assert.deepEqual(events.map((event) => event.type), ["thread.created", "turn.started", "assistant.delta", "reasoning.delta", "usage.updated", "unknown", "turn.completed"]);
    assert.equal(JSON.stringify(events).includes("secret"), false);
    assert.deepEqual(events[4].usage, { inputTokens: 4, outputTokens: 2, cachedInputTokens: 1, reasoningTokens: 1 });
  });

  it("maps gateway errors to a terminal turn and ignores thread status metadata", async () => {
    const f = fixture();
    const events = [];
    f.adapter.subscribe((event) => events.push(event));
    await f.adapter.startWorkspace(ws);
    await f.adapter.createThread(create);
    const notify = f.notifications[0];
    notify({ method: "thread/status/changed", params: { threadId: "thr_1", status: { type: "active" } } });
    notify({ method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_1" } } });
    notify({ method: "error", params: { threadId: "thr_1", turnId: "turn_1", willRetry: false, error: { message: "gateway 502", secret: "no" } } });
    assert.deepEqual(events.map((event) => event.type), ["thread.created", "turn.started", "turn.failed"]);
    assert.equal(events.at(-1).error.code, "gateway_unavailable");
    assert.equal(JSON.stringify(events).includes("secret"), false);
  });

  it("bridges command approvals without exposing backend request payloads", async () => {
    const f = fixture();
    const events = [];
    f.adapter.subscribe((event) => events.push(event));
    await f.adapter.startWorkspace(ws);
    await f.adapter.createThread(create);
    const reply = f.requests.get("item/commandExecution/requestApproval")({ threadId: "thr_1", turnId: "turn_1", itemId: "req_1", command: "secret command", reason: "Needs permission" });
    await f.adapter.respondToApproval({ ...scope, requestId: "req_1", decision: "allow_once" });
    assert.deepEqual(await reply, { decision: "accept" });
    assert.equal(events.at(-1).type, "approval.requested");
    assert.equal(JSON.stringify(events.at(-1)).includes("secret command"), false);
  });
});

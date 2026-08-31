import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { desktopRemoteSessionEventSchema } from "../dist/runtime/desktop-remote-control.js";

import { createRemoteSessionProjector } from "./remote-session-projector.mjs";

const CONTROL_1 = "11111111-1111-4111-8111-111111111111";
const CONTROL_2 = "22222222-2222-4222-8222-222222222222";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE = "ws_1";
const SESSION = "ses_1";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

/** @param {1 | 2} [payloadVersion] */
function harness(payloadVersion = 1) {
  const emitted = [];
  const scheduled = new Map();
  let timerId = 0;
  let uuidId = 0;
  let runId = "run_1";
  const projector = createRemoteSessionProjector({
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuidId).padStart(12, "0")}`,
    now: () => NOW,
    timers: {
      setTimeout(callback) { const id = ++timerId; scheduled.set(id, callback); return id; },
      clearTimeout(id) { scheduled.delete(id); },
    },
    getActiveRunId: () => runId,
    emit: (payload) => { emitted.push(payload); return true; },
  });
  projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION, payloadVersion });
  return {
    projector,
    emitted,
    setRunId(value) { runId = value; },
    flush() {
      const callbacks = [...scheduled.values()];
      scheduled.clear();
      for (const callback of callbacks) callback();
    },
  };
}

const info = (id = "msg_1") => ({ id, sessionID: SESSION, role: "assistant", time: { created: 1_000 } });
const part = (overrides = {}) => ({ id: "prt_1", messageID: "msg_1", sessionID: SESSION, type: "text", text: "hello", ...overrides });

describe("remote session projector", () => {
  it("maps legacy, global, and V2 message sources while preserving safe parts", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.updated", properties: { info: info() } });
    assert.equal(h.emitted.length, 0);
    h.projector.accept(WORKSPACE, { payload: { type: "message.part.updated", properties: { part: part() } } });
    assert.equal(h.emitted[0].data.type, "message.upsert");
    assert.deepEqual(h.emitted[0].data.message.parts, [{ type: "text", id: "prt_1", text: "hello" }]);
    h.flush();
    assert.equal(h.emitted[1].data.type, "message.part.upsert");
    h.projector.accept(WORKSPACE, { type: "message.part.updated", data: { part: part({ id: "prt_2", type: "reasoning", text: "think" }) }, durable: 1 });
    h.flush();
    assert.deepEqual(h.emitted.at(-1).data.part, { type: "reasoning", id: "prt_2", text: "think" });
    for (const event of h.emitted) desktopRemoteSessionEventSchema.parse(event);
  });

  it("filters unbound, malformed, and cross-session events and ignores duplicate durable V2 events", () => {
    const h = harness();
    h.projector.accept("ws_other", { type: "message.updated", properties: { info: info() } });
    h.projector.accept(WORKSPACE, { type: "message.updated", properties: {} });
    h.projector.accept(WORKSPACE, { type: "message.updated", data: { info: { ...info(), sessionID: "ses_other" } }, durable: 1 });
    h.projector.accept(WORKSPACE, { type: "todo.updated", data: { sessionID: SESSION, todos: [] }, durable: 4 });
    h.projector.accept(WORKSPACE, { type: "todo.updated", data: { sessionID: SESSION, todos: [] }, durable: 4 });
    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0].data.type, "todos.replace");
  });

  it("keeps positive monotonic sequences independently per control session", () => {
    const h = harness();
    h.projector.bind({ controlSessionId: CONTROL_2, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION });
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    h.projector.accept(WORKSPACE, { type: "message.removed", properties: { sessionID: SESSION, messageID: "msg_1" } });
    assert.deepEqual(h.emitted.filter((e) => e.controlSessionId === CONTROL_1).map((e) => e.sequence), [1, 2]);
    assert.deepEqual(h.emitted.filter((e) => e.controlSessionId === CONTROL_2).map((e) => e.sequence), [1, 2]);
  });

  it("keeps sequence on identical bind and rejects a conflicting control session binding", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    assert.equal(h.projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION }), true);
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    assert.deepEqual(h.emitted.map((event) => event.sequence), [1, 2]);
    assert.equal(h.projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: "ses_other" }), false);
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    assert.equal(h.emitted.at(-1).sequence, 3);
  });

  it("upgrades an immutable root binding from v1 to v2 without resetting sequence", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    assert.equal(h.projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION, payloadVersion: 2 }), true);
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [] } });
    assert.equal(h.emitted.at(-1).payloadVersion, 2);
    assert.equal(h.emitted.at(-1).sequence, 2);
  });

  it("buffers deltas until declaration and reconciles only prefix-compatible cumulative text", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_1", partID: "prt_1", delta: "hel" } });
    h.projector.accept(WORKSPACE, { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_1", partID: "prt_1", delta: "lo" } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "hel" }) } });
    h.projector.accept(WORKSPACE, { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_1", partID: "prt_1", delta: "!" } });
    h.flush();
    assert.equal(h.emitted[0].data.part.text, "hello!");

    h.projector.accept(WORKSPACE, { type: "message.part.delta", properties: { sessionID: SESSION, messageID: "msg_2", partID: "prt_2", delta: "lo" } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ id: "prt_2", messageID: "msg_2", text: "hello" }) } });
    h.flush();
    assert.equal(h.emitted.at(-1).data.part.text, "hello");
  });

  it("does not regress cached cumulative text when a shorter declaration arrives", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "hello world" }) } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "hello" }) } });
    h.flush();
    assert.equal(h.emitted.at(-1).data.part.text, "hello world");
  });

  it("recovers a part removal with a full message or requires a snapshot", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.updated", properties: { info: info() } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part() } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ id: "prt_2", text: "world" }) } });
    h.projector.accept(WORKSPACE, { type: "message.part.removed", properties: { sessionID: SESSION, messageID: "msg_1", partID: "prt_2" } });
    assert.equal(h.emitted.at(-1).data.type, "message.upsert");
    h.projector.accept(WORKSPACE, { type: "message.part.removed", properties: { sessionID: SESSION, messageID: "msg_1", partID: "prt_1" } });
    assert.deepEqual(h.emitted.at(-1).data, { type: "snapshot_required", reason: "sequence_gap" });
  });

  it("normalizes deterministic todo IDs and interaction upsert/removal with stable time and run", () => {
    const h = harness();
    const todo = { content: " Ship it ", status: "completed", priority: "high" };
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [todo] } });
    const firstId = h.emitted.at(-1).data.todos[0].id;
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos: [todo] } });
    assert.equal(h.emitted.at(-1).data.todos[0].id, firstId);
    const ownership = { rootSessionId: SESSION, targetSessionId: SESSION, parentSessionId: null };
    h.projector.accept(WORKSPACE, { type: "permission.v2.asked", data: { id: "perm_1", sessionID: SESSION, permission: "bash", patterns: ["pwd"] } }, ownership);
    assert.equal(h.emitted.at(-1).data.interaction.runId, "run_1");
    assert.equal(h.emitted.at(-1).data.interaction.createdAt, new Date(NOW).toISOString());
    h.projector.accept(WORKSPACE, { type: "permission.v2.replied", data: { sessionID: SESSION, requestID: "perm_1" } }, ownership);
    assert.deepEqual(h.emitted.at(-1).data, {
      type: "interaction.remove",
      interactionId: "perm_1",
    });
    h.projector.accept(WORKSPACE, { type: "question.asked", properties: { id: "question_1", sessionID: SESSION, questions: [{ id: "q_1", question: "Continue?", options: ["Yes"] }] } }, ownership);
    assert.equal(h.emitted.at(-1).data.interaction.type, "question");
    h.projector.accept(WORKSPACE, { type: "question.rejected", properties: { sessionID: SESSION, requestID: "question_1" } }, ownership);
    assert.equal(h.emitted.at(-1).data.type, "interaction.remove");
  });

  it("projects descendant interactions to the bound root with the exact child mutation target", () => {
    const h = harness(2);
    const ownership = {
      rootSessionId: SESSION,
      targetSessionId: "ses_child",
      parentSessionId: SESSION,
    };
    h.projector.accept(WORKSPACE, {
      type: "permission.asked",
      properties: { id: "perm_child", sessionID: "ses_child", permission: "external_directory", patterns: ["/outside"] },
    }, ownership);

    assert.equal(h.emitted.length, 1);
    assert.equal(h.emitted[0].sessionId, SESSION);
    assert.deepEqual({
      rootSessionId: h.emitted[0].data.interaction.rootSessionId,
      targetSessionId: h.emitted[0].data.interaction.targetSessionId,
      parentSessionId: h.emitted[0].data.interaction.parentSessionId,
      sessionId: h.emitted[0].data.interaction.sessionId,
    }, {
      rootSessionId: SESSION,
      targetSessionId: "ses_child",
      parentSessionId: SESSION,
      sessionId: "ses_child",
    });
    h.projector.accept(WORKSPACE, {
      type: "permission.replied",
      properties: { sessionID: "ses_child", requestID: "perm_child" },
    }, ownership);
    assert.deepEqual(h.emitted.at(-1).data, {
      type: "interaction.remove",
      interactionId: "perm_child",
      rootSessionId: SESSION,
      targetSessionId: "ses_child",
    });
  });

  it("does not project an interaction owned by an unrelated root", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, {
      type: "question.asked",
      properties: { id: "question_other", sessionID: "ses_other_child", questions: [{ question: "Continue?", options: ["Yes"] }] },
    }, {
      rootSessionId: "ses_other_root",
      targetSessionId: "ses_other_child",
      parentSessionId: "ses_other_root",
    });
    assert.equal(h.emitted.length, 0);
  });

  it("keeps v1 root-only and emits descendant shape only to a v2 binding", () => {
    const h = harness();
    h.projector.bind({ controlSessionId: CONTROL_2, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION, payloadVersion: 2 });
    const ownership = { rootSessionId: SESSION, targetSessionId: "ses_child", parentSessionId: SESSION };
    h.projector.accept(WORKSPACE, {
      type: "permission.asked",
      properties: { id: "permission_child", sessionID: "ses_child", permission: "bash" },
    }, ownership);
    assert.equal(h.emitted.filter((event) => event.controlSessionId === CONTROL_1).length, 0);
    const v2 = h.emitted.find((event) => event.controlSessionId === CONTROL_2);
    assert.equal(v2.payloadVersion, 2);
    assert.equal(v2.data.interaction.targetSessionId, "ses_child");
  });

  it("projects session and coordinator run status without mutating the coordinator", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "session.status", properties: { sessionID: SESSION, status: { type: "busy" } } });
    assert.equal(h.emitted[0].data.status, "running");
    assert.equal(h.emitted[0].data.run.runId, "run_1");
    assert.equal(h.emitted[1].data.status, "running");
    h.projector.accept(WORKSPACE, { type: "session.idle", properties: { sessionID: SESSION } });
    assert.equal(h.emitted.at(-2).data.status, "completed");
    assert.equal(h.emitted.at(-1).data.status, "completed");
    h.projector.accept(WORKSPACE, { type: "session.error", properties: { sessionID: SESSION, error: { message: "boom" } } });
    assert.equal(h.emitted.at(-2).data.status, "failed");
    assert.equal(h.emitted.at(-1).data.error.message, "boom");
  });

  it("ignores unknown session statuses instead of fabricating idle completion", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "session.status", properties: { sessionID: SESSION, status: { type: "future-status" } } });
    assert.equal(h.emitted.length, 0);
  });

  it("detects durable gaps and reports reconnect gaps for every workspace binding", () => {
    const h = harness();
    h.projector.bind({ controlSessionId: CONTROL_2, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION });
    h.projector.accept(WORKSPACE, { type: "todo.updated", data: { sessionID: SESSION, todos: [] }, durable: { sequence: 10 } });
    h.projector.accept(WORKSPACE, { type: "todo.updated", data: { sessionID: SESSION, todos: [] }, durable: { sequence: 12 } });
    assert.deepEqual(h.emitted.at(-1).data, { type: "snapshot_required", reason: "sequence_gap" });
    const beforeReconnect = h.emitted.length;
    h.projector.reconnectGap(WORKSPACE, "cursor_expired");
    assert.equal(h.emitted.length - beforeReconnect, 2);
    assert.deepEqual(h.emitted.slice(-2).map((e) => [e.controlSessionId, e.data.reason]), [[CONTROL_1, "cursor_expired"], [CONTROL_2, "cursor_expired"]]);
  });

  it("never emits JSON above 512 KiB and trims streamed content", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "x".repeat(700 * 1024) }) } });
    h.flush();
    assert.ok(h.emitted.length > 0);
    for (const event of h.emitted) assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") <= 512 * 1024);
    assert.equal(h.emitted.at(-1).data.part.text.length, 128 * 1024);
  });

  it("turns an oversize meaningful projection into a bounded snapshot requirement", () => {
    const h = harness();
    const todos = Array.from({ length: 10_000 }, (_, index) => ({
      content: `${index}-${"x".repeat(100)}`,
      status: "pending",
      priority: "high",
    }));
    h.projector.accept(WORKSPACE, { type: "todo.updated", properties: { sessionID: SESSION, todos } });
    assert.deepEqual(h.emitted.at(-1).data, { type: "snapshot_required", reason: "sequence_gap" });
    assert.ok(Buffer.byteLength(JSON.stringify(h.emitted.at(-1)), "utf8") <= 512 * 1024);
  });

  it("cancels pending output on unbind and stop and rejects later use", () => {
    const h = harness();
    h.projector.accept(WORKSPACE, { type: "message.updated", properties: { info: info() } });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "long cached text" }) } });
    const beforeUnbind = h.emitted.length;
    h.projector.unbind(CONTROL_1);
    h.flush();
    assert.equal(h.emitted.length, beforeUnbind);
    h.projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION });
    h.projector.accept(WORKSPACE, { type: "message.part.updated", properties: { part: part({ text: "new" }) } });
    h.flush();
    assert.equal(h.emitted.at(-1).data.part.text, "new");
    const beforeStop = h.emitted.length;
    h.projector.stop();
    h.flush();
    assert.equal(h.emitted.length, beforeStop);
    assert.throws(() => h.projector.bind({ controlSessionId: CONTROL_1, deviceId: DEVICE, workspaceId: WORKSPACE, sessionId: SESSION }), TypeError);
    h.projector.reconnectGap(WORKSPACE);
    assert.equal(h.emitted.length, beforeStop);
  });
});

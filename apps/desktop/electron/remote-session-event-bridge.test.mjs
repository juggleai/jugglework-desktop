import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRemoteSessionEventBridge } from "./remote-session-event-bridge.mjs";

const CONTROL = "11111111-1111-4111-8111-111111111111";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

/** @param {{ publish?: (event: unknown, options: { connectionGeneration: number }) => boolean, observeRun?: (input: any) => Promise<unknown>, listActiveRuns?: () => Promise<unknown>, resolveOwnership?: (input: any) => Promise<unknown> }} [input] */
function harness({ publish = () => true, observeRun, listActiveRuns = async () => ({ items: [] }), resolveOwnership = async ({ targetSessionId }) => ({ rootSessionId: targetSessionId, targetSessionId, parentSessionId: null }) } = {}) {
  const subscriptions = [];
  const published = [];
  const terminalCalls = [];
  const observationCalls = [];
  const mirroredRuns = [];
  const notificationEvents = [];
  let uuid = 0;
  let runId = "run_1";
  const sseClient = {
    subscribe(input) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      subscriptions.push({ ...input, resolve, reject });
      return promise;
    },
  };
  const coordinator = {
    getActiveRunId: () => runId,
    recordServerRun: (run) => { mirroredRuns.push(run); if (typeof run?.runId === "string") runId = run.runId; return true; },
    clearTerminalRun: (input) => { terminalCalls.push(input); if (input.runId === runId) runId = null; return true; },
  };
  const bridge = createRemoteSessionEventBridge({
    sseClient,
    coordinator,
    listActiveRuns,
    observeRun: async (input) => {
      observationCalls.push({ input, publishedCount: published.length });
      return observeRun ? observeRun(input) : { cleared: true, run: null, terminalStatus: "completed" };
    },
    publish: (event, options) => { published.push({ event, options }); return publish(event, options); },
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    now: () => NOW,
    timers: { setTimeout: (callback) => { callback(); return 1; }, clearTimeout() {} },
    onNotificationEvent: (event) => notificationEvents.push(event),
    interactions: { resolveOwnership },
  });
  const binding = { controlSessionId: CONTROL, deviceId: DEVICE, workspaceId: "ws_1", sessionId: "ses_1", connectionGeneration: 7 };
  return {
    bridge,
    binding,
    subscriptions,
    published,
    terminalCalls,
    observationCalls,
    mirroredRuns,
    notificationEvents,
    setRunId(value) { runId = value; },
    getRunId() { return runId; },
  };
}

describe("remote session event bridge", () => {
  it("shares one workspace subscription and treats exact bindings as immutable", () => {
    const h = harness();
    assert.equal(h.bridge.bind(h.binding), true);
    assert.equal(h.bridge.bind(h.binding), true);
    assert.equal(h.subscriptions.length, 1);
    assert.equal(h.bridge.bind({ ...h.binding, sessionId: "ses_other" }), false);
    assert.equal(h.bridge.bind({ ...h.binding, connectionGeneration: 8 }), false);
  });

  it("publishes with the bound generation and marks terminal only after projection", async () => {
    const h = harness();
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    assert.equal(h.published[0].event.data.type, "session.status");
    assert.equal(h.published[1].event.data.type, "run.status");
    assert.equal(h.published[1].event.data.runId, "run_1");
    assert.deepEqual(h.published[0].options, { connectionGeneration: 7 });
    assert.deepEqual(h.observationCalls, [{
      input: { workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1", status: "idle" },
      publishedCount: 2,
    }]);
    assert.deepEqual(h.terminalCalls, [{ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1" }]);
  });

  it("hydrates server-owned active runs when a workspace subscription starts", async () => {
    const serverRun = { runId: "run_local", origin: "local-renderer" };
    const h = harness({ listActiveRuns: async () => ({ items: [serverRun] }) });
    h.bridge.bind({ ...h.binding, payloadVersion: 2, rootSessionId: h.binding.sessionId });
    await Promise.resolve();
    assert.deepEqual(h.mirroredRuns, [serverRun]);
    assert.deepEqual(h.notificationEvents, []);
  });

  it("hydrates a queued run only after authoritative admission produces a status event", async () => {
    const admitted = { workspaceId: "ws_1", sessionId: "ses_1", runId: "run_admitted", origin: "remote-control" };
    let listCalls = 0;
    const h = harness({
      listActiveRuns: async () => {
        listCalls += 1;
        return listCalls === 1 ? { items: [] } : { items: [admitted] };
      },
    });
    h.setRunId(null);
    h.bridge.bind(h.binding);
    await Promise.resolve();
    await h.subscriptions[0].onEvent({ type: "session.status", properties: { sessionID: "ses_1", status: "busy" } });
    assert.equal(listCalls, 2);
    assert.deepEqual(h.mirroredRuns, [admitted]);
    assert.equal(h.observationCalls[0].input.runId, "run_admitted");
  });

  it("emits content-minimized waiting and terminal notification source events after projection", async () => {
    const h = harness();
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "question.asked",
      properties: {
        id: "question_1",
        sessionID: "ses_1",
        questions: [{ id: "q_1", question: "prompt-secret", options: ["tool-payload-secret"] }],
      },
    });
    await h.subscriptions[0].onEvent({
      type: "session.error",
      properties: { sessionID: "ses_1", error: { message: "raw-error-secret /private/path token-secret" } },
    });
    assert.deepEqual(h.notificationEvents, [
      {
        origin: "live",
        type: "interaction.waiting",
        workspaceId: "ws_1",
        sessionId: "ses_1",
        interactionId: "question_1",
        interactionType: "question",
      },
      {
        origin: "live",
        type: "run.terminal",
        workspaceId: "ws_1",
        sessionId: "ses_1",
        runId: "run_1",
        outcome: "completed",
      },
    ]);
    assert.equal(JSON.stringify(h.notificationEvents).includes("prompt-secret"), false);
    assert.equal(JSON.stringify(h.notificationEvents).includes("raw-error-secret"), false);
  });

  it("does not create notification source events when remote publication is rejected", async () => {
    const h = harness({ publish: () => false });
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "permission.asked",
      properties: { id: "permission_1", sessionID: "ses_1", permission: "bash", patterns: ["resource-secret"] },
    });
    assert.deepEqual(h.notificationEvents, []);
  });

  it("resolves descendant ownership before projecting to a root binding", async () => {
    const ownershipCalls = [];
    const h = harness({
      resolveOwnership: async (input) => {
        ownershipCalls.push(input);
        return { rootSessionId: "ses_1", targetSessionId: "ses_child", parentSessionId: "ses_1" };
      },
    });
    h.bridge.bind({ ...h.binding, payloadVersion: 2, rootSessionId: h.binding.sessionId });
    await h.subscriptions[0].onEvent({
      type: "permission.asked",
      properties: { id: "perm_child", sessionID: "ses_child", permission: "bash" },
    });

    assert.deepEqual(ownershipCalls, [{ workspaceId: "ws_1", targetSessionId: "ses_child" }]);
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0].event.sessionId, "ses_1");
    assert.equal(h.published[0].event.data.interaction.targetSessionId, "ses_child");
    assert.equal(h.published[0].event.data.interaction.sessionId, "ses_child");
  });

  it("does not publish a descendant interaction resolved to an unrelated root", async () => {
    const h = harness({
      resolveOwnership: async () => ({ rootSessionId: "ses_other", targetSessionId: "ses_child", parentSessionId: "ses_other" }),
    });
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "permission.asked",
      properties: { id: "perm_other", sessionID: "ses_child", permission: "bash" },
    });
    assert.equal(h.published.length, 0);
  });

  it("requires a snapshot when terminal interaction ownership cannot be resolved", async () => {
    const h = harness({ resolveOwnership: async () => null });
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "question_1" },
    });
    assert.equal(h.published.length, 1);
    assert.deepEqual(h.published[0].event.data, { type: "snapshot_required", reason: "sequence_gap" });
  });

  it("cannot clear a replacement when a stale terminal observation completes", async () => {
    let resolveObservation;
    const h = harness({
      observeRun: () => new Promise((resolve) => { resolveObservation = resolve; }),
    });
    h.bridge.bind(h.binding);
    const terminal = h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    h.setRunId("run_2");
    assert.equal(typeof resolveObservation, "function");
    /** @type {(value: unknown) => void} */ (resolveObservation)({ cleared: true, run: null, terminalStatus: "completed" });
    await terminal;
    assert.deepEqual(h.terminalCalls, [{ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1" }]);
    assert.equal(h.getRunId(), "run_2");
  });

  it("retries a transient terminal observation while the exact run remains active", async () => {
    let attempts = 0;
    const h = harness({
      observeRun: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("temporary"), { status: 503 });
        return { cleared: true, run: null, terminalStatus: "completed" };
      },
    });
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    assert.equal(attempts, 2);
    assert.deepEqual(h.terminalCalls, [{ workspaceId: "ws_1", sessionId: "ses_1", runId: "run_1" }]);
  });

  it("rehydrates the mirror after a run mismatch", async () => {
    const replacement = { runId: "run_2", sessionId: "ses_1", origin: "local-renderer" };
    let lists = 0;
    const h = harness({
      listActiveRuns: async () => {
        lists += 1;
        return lists === 1 ? { items: [] } : { items: [replacement] };
      },
      observeRun: async () => {
        throw { serverCode: "run_mismatch" };
      },
    });
    h.bridge.bind(h.binding);
    await Promise.resolve();
    await h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    assert.equal(h.getRunId(), "run_2");
    assert.deepEqual(h.mirroredRuns, [replacement]);
  });

  it("synchronously aborts and fences stale callbacks on clear, then remains reusable", async () => {
    const h = harness();
    h.bridge.bind(h.binding);
    const stale = h.subscriptions[0];
    h.bridge.clear();
    assert.equal(stale.signal.aborted, true);
    await stale.onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published.length, 0);
    assert.equal(h.bridge.bind(h.binding), true);
    assert.equal(h.subscriptions.length, 2);
  });

  it("reports a subscription failure and retries on a later identical bind", async () => {
    const h = harness();
    h.bridge.bind(h.binding);
    h.subscriptions[0].reject(new Error("secret url and token"));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.published.at(-1).event.data.type, "snapshot_required");
    assert.equal(h.bridge.bind(h.binding), true);
    assert.equal(h.subscriptions.length, 2);
  });

  it("makes stop permanent", () => {
    const h = harness();
    h.bridge.bind(h.binding);
    h.bridge.stop();
    assert.equal(h.subscriptions[0].signal.aborted, true);
    assert.equal(h.bridge.bind(h.binding), false);
  });

  it("unbinds immediately when publication is rejected without advancing a hidden sequence", async () => {
    let accepted = false;
    const h = harness({ publish: () => accepted });
    h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published[0].event.sequence, 1);
    accepted = true;
    assert.equal(h.bridge.bind(h.binding), true);
    await h.subscriptions[1].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published[1].event.sequence, 1);
  });
});

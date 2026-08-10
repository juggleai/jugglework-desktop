import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRemoteSessionEventBridge } from "./remote-session-event-bridge.mjs";

const CONTROL = "11111111-1111-4111-8111-111111111111";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

/** @param {{ publish?: (event: unknown, options: { connectionGeneration: number }) => boolean, observeRun?: (input: any) => Promise<unknown>, listActiveRuns?: () => Promise<unknown> }} [input] */
function harness({ publish = () => true, observeRun, listActiveRuns = async () => ({ items: [] }) } = {}) {
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
    recordServerRun: (run) => { mirroredRuns.push(run); return true; },
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
    h.bridge.bind(h.binding);
    await Promise.resolve();
    assert.deepEqual(h.mirroredRuns, [serverRun]);
    assert.deepEqual(h.notificationEvents, []);
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

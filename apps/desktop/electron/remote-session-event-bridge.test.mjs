import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRemoteSessionEventBridge } from "./remote-session-event-bridge.mjs";

const CONTROL = "11111111-1111-4111-8111-111111111111";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = Date.parse("2026-08-09T12:00:00.000Z");

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @param {{ publish?: (event: unknown, options: { connectionGeneration: number }) => boolean, observeRun?: (input: any) => Promise<unknown>, listActiveRuns?: () => Promise<unknown>, resolveOwnership?: (input: any) => Promise<unknown>, timers?: any, logger?: any, subscriptionReadinessTimeoutMs?: number, subscriptionRetryDelaysMs?: number[], autoConnect?: boolean }} [input] */
function harness({ publish = () => true, observeRun, listActiveRuns = async () => ({ items: [] }), resolveOwnership = async ({ targetSessionId }) => ({ rootSessionId: targetSessionId, targetSessionId, parentSessionId: null }), timers = { setTimeout: (callback, delay) => { if (delay < 3_000) callback(); return 1; }, clearTimeout() {} }, logger = {}, subscriptionReadinessTimeoutMs, subscriptionRetryDelaysMs, autoConnect = true } = {}) {
  const subscriptions = [];
  const published = [];
  const terminalCalls = [];
  const observationCalls = [];
  const mirroredRuns = [];
  const notificationEvents = [];
  let uuid = 0;
  let runId = "run_1";
  const sseClient = {
    async subscribe(input) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      subscriptions.push({ ...input, resolve, reject });
      if (autoConnect) await input.onConnected?.();
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
    timers,
    logger,
    ...(subscriptionReadinessTimeoutMs ? { subscriptionReadinessTimeoutMs } : {}),
    ...(subscriptionRetryDelaysMs ? { subscriptionRetryDelaysMs } : {}),
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
  it("shares one workspace subscription and treats exact bindings as immutable", async () => {
    const h = harness();
    assert.equal(await h.bridge.bind(h.binding), true);
    assert.equal(await h.bridge.bind(h.binding), true);
    assert.equal(h.subscriptions.length, 1);
    assert.equal(await h.bridge.bind({ ...h.binding, sessionId: "ses_other" }), false);
    assert.equal(await h.bridge.bind({ ...h.binding, connectionGeneration: 8 }), false);
  });

  it("blocks binding until SSE is connected and captures output emitted immediately after readiness", async () => {
    const h = harness({ autoConnect: false, timers: globalThis });
    let settled = false;
    const binding = h.bridge.bind(h.binding).then((ready) => { settled = true; return ready; });
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(h.published.length, 0);

    h.subscriptions[0].onConnected();
    assert.equal(await binding, true);
    await h.subscriptions[0].onEvent({
      type: "message.updated",
      properties: { info: { id: "msg_fast", sessionID: "ses_1", role: "assistant", time: { created: 1 } } },
    });
    await h.subscriptions[0].onEvent({
      type: "message.part.updated",
      properties: { part: { id: "part_fast", messageID: "msg_fast", sessionID: "ses_1", type: "text", text: "fast reply" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.published.map(({ event }) => event.data.type), ["message.upsert", "message.part.upsert"]);
    assert.equal(h.published[1].event.data.part.text, "fast reply");
  });

  it("fails binding closed on readiness timeout and removes the provisional subscription", async () => {
    const scheduled = [];
    const h = harness({
      autoConnect: false,
      subscriptionReadinessTimeoutMs: 3_000,
      timers: {
        setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return callback; },
        clearTimeout: (handle) => { const index = scheduled.findIndex((item) => item.callback === handle); if (index >= 0) scheduled.splice(index, 1); },
      },
    });
    const binding = h.bridge.bind(h.binding);
    assert.equal(scheduled.find(({ delay }) => delay === 3_000)?.delay, 3_000);
    scheduled.find(({ delay }) => delay === 3_000).callback();
    assert.equal(await binding, false);
    assert.equal(h.subscriptions[0].signal.aborted, true);
    const retry = h.bridge.bind(h.binding);
    await h.subscriptions[1].onConnected();
    assert.equal(await retry, true);
  });

  it("fails pending binding readiness on unbind and clear", async () => {
    const h = harness({ autoConnect: false, timers: globalThis });
    const unbound = h.bridge.bind(h.binding);
    assert.equal(h.bridge.unbind(h.binding.controlSessionId), true);
    assert.equal(await unbound, false);
    assert.equal(h.subscriptions[0].signal.aborted, true);

    const cleared = h.bridge.bind(h.binding);
    h.bridge.clear();
    assert.equal(await cleared, false);
    assert.equal(h.subscriptions[1].signal.aborted, true);
  });

  it("makes a second binding immediate when the workspace subscription is already connected", async () => {
    const h = harness({ autoConnect: false, timers: globalThis });
    const first = h.bridge.bind(h.binding);
    h.subscriptions[0].onConnected();
    assert.equal(await first, true);
    const secondBinding = { ...h.binding, controlSessionId: "22222222-2222-4222-8222-222222222222", sessionId: "ses_2" };
    assert.equal(await h.bridge.bind(secondBinding), true);
    assert.equal(h.subscriptions.length, 1);
  });

  it("invalidates readiness on a live drop, publishes one gap, and makes a second bind wait for fresh live", async () => {
    const scheduled = [];
    const h = harness({
      autoConnect: false,
      timers: {
        setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return callback; },
        clearTimeout: (handle) => { const index = scheduled.findIndex((item) => item.callback === handle); if (index >= 0) scheduled.splice(index, 1); },
      },
      subscriptionRetryDelaysMs: [100],
    });
    const first = h.bridge.bind(h.binding);
    await h.subscriptions[0].onConnected();
    assert.equal(await first, true);
    await h.subscriptions[0].onReconnectGap("sequence_gap");
    h.subscriptions[0].reject(new Error("dropped"));
    await flush();
    assert.deepEqual(h.published.map(({ event }) => event.data.type), ["snapshot_required"]);

    let secondSettled = false;
    const second = h.bridge.bind({ ...h.binding, controlSessionId: "22222222-2222-4222-8222-222222222222", sessionId: "ses_2" })
      .then((value) => { secondSettled = true; return value; });
    await Promise.resolve();
    assert.equal(secondSettled, false);
    scheduled.find(({ delay }) => delay === 100).callback();
    await flush();
    await h.subscriptions[1].onConnected();
    assert.equal(await second, true);
  });

  it("a provisional timeout does not mutate an established binding in the same workspace", async () => {
    const scheduled = [];
    const h = harness({
      autoConnect: false,
      timers: {
        setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return callback; },
        clearTimeout: (handle) => { const index = scheduled.findIndex((item) => item.callback === handle); if (index >= 0) scheduled.splice(index, 1); },
      },
    });
    const first = h.bridge.bind(h.binding);
    await h.subscriptions[0].onConnected();
    assert.equal(await first, true);
    await h.subscriptions[0].onReconnectGap("sequence_gap");
    const provisional = h.bridge.bind({ ...h.binding, controlSessionId: "22222222-2222-4222-8222-222222222222", sessionId: "ses_2" });
    scheduled.find(({ delay }) => delay === 3_000).callback();
    assert.equal(await provisional, false);
    assert.equal(h.subscriptions[0].signal.aborted, false);
    await h.subscriptions[0].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published.at(-1).event.sessionId, "ses_1");
  });

  it("isolates subscriptions and projections across multiple workspaces", async () => {
    const h = harness({ autoConnect: false, timers: globalThis });
    const first = h.bridge.bind(h.binding);
    await h.subscriptions[0].onConnected();
    assert.equal(await first, true);
    const secondBinding = { ...h.binding, controlSessionId: "22222222-2222-4222-8222-222222222222", workspaceId: "ws_2", sessionId: "ses_2", rootSessionId: "ses_2" };
    const second = h.bridge.bind(secondBinding);
    await h.subscriptions[1].onConnected();
    assert.equal(await second, true);
    await h.subscriptions[1].onEvent({ type: "todo.updated", properties: { sessionID: "ses_2", todos: [] } });
    assert.deepEqual(h.published.map(({ event }) => [event.workspaceId, event.sessionId]), [["ws_2", "ses_2"]]);
  });

  it("publishes with the bound generation and marks terminal only after projection", async () => {
    const h = harness();
    await h.bridge.bind(h.binding);
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

  it("processes message records while a prior status observation remains unresolved", async () => {
    let resolveObservation;
    const h = harness({
      observeRun: () => new Promise((resolve) => { resolveObservation = resolve; }),
    });
    await h.bridge.bind(h.binding);

    await h.subscriptions[0].onEvent({
      type: "session.status",
      properties: { sessionID: "ses_1", status: "busy" },
    });
    await h.subscriptions[0].onEvent({
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } },
    });
    await h.subscriptions[0].onEvent({
      type: "message.part.updated",
      properties: { part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "reply" } },
    });

    assert.equal(typeof resolveObservation, "function");
    assert.deepEqual(h.published.map(({ event }) => event.data.type), [
      "session.status",
      "run.status",
      "message.upsert",
      "message.part.upsert",
    ]);
    assert.equal(h.published[2].event.data.message.parts[0].text, "reply");
    assert.equal(h.published[3].event.data.part.text, "reply");
    /** @type {(value: unknown) => void} */ (resolveObservation)({ cleared: false, run: null });
  });

  it("observes statuses in arrival order for the same workspace session", async () => {
    const resolvers = [];
    const h = harness({
      observeRun: () => new Promise((resolve) => resolvers.push(resolve)),
    });
    await h.bridge.bind(h.binding);

    await h.subscriptions[0].onEvent({ type: "session.status", properties: { sessionID: "ses_1", status: "busy" } });
    await h.subscriptions[0].onEvent({ type: "session.status", properties: { sessionID: "ses_1", status: "retry" } });
    assert.deepEqual(h.observationCalls.map(({ input }) => input.status), ["running"]);

    resolvers[0]({ cleared: false, run: { runId: "run_1" } });
    await flush();
    assert.deepEqual(h.observationCalls.map(({ input }) => input.status), ["running", "retrying"]);
    resolvers[1]({ cleared: false, run: { runId: "run_1" } });
  });

  it("hydrates server-owned active runs when a workspace subscription starts", async () => {
    const serverRun = { runId: "run_local", origin: "local-renderer" };
    const h = harness({ listActiveRuns: async () => ({ items: [serverRun] }) });
    await h.bridge.bind({ ...h.binding, payloadVersion: 2, rootSessionId: h.binding.sessionId });
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
    await h.bridge.bind(h.binding);
    await Promise.resolve();
    await h.subscriptions[0].onEvent({ type: "session.status", properties: { sessionID: "ses_1", status: "busy" } });
    await flush();
    assert.equal(listCalls, 2);
    assert.deepEqual(h.mirroredRuns, [admitted]);
    assert.equal(h.observationCalls[0].input.runId, "run_admitted");
  });

  it("emits content-minimized waiting and terminal notification source events after projection", async () => {
    const h = harness();
    await h.bridge.bind(h.binding);
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
    await h.bridge.bind(h.binding);
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
    await h.bridge.bind({ ...h.binding, payloadVersion: 2, rootSessionId: h.binding.sessionId });
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
    await h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "permission.asked",
      properties: { id: "perm_other", sessionID: "ses_child", permission: "bash" },
    });
    assert.equal(h.published.length, 0);
  });

  it("requires a snapshot when terminal interaction ownership cannot be resolved", async () => {
    const h = harness({ resolveOwnership: async () => null });
    await h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "question_1" },
    });
    assert.equal(h.published.length, 1);
    assert.deepEqual(h.published[0].event.data, { type: "snapshot_required", reason: "sequence_gap" });
  });

  it("does not clear a replacement when a stale terminal observation completes", async () => {
    let resolveObservation;
    const h = harness({
      observeRun: () => new Promise((resolve) => { resolveObservation = resolve; }),
    });
    await h.bridge.bind(h.binding);
    const terminal = h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    h.setRunId("run_2");
    assert.equal(typeof resolveObservation, "function");
    /** @type {(value: unknown) => void} */ (resolveObservation)({ cleared: true, run: null, terminalStatus: "completed" });
    await terminal;
    await flush();
    assert.deepEqual(h.terminalCalls, []);
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
    await h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await flush();
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
    await h.bridge.bind(h.binding);
    await Promise.resolve();
    await h.subscriptions[0].onEvent({ type: "session.idle", properties: { sessionID: "ses_1" } });
    await flush();
    assert.equal(h.getRunId(), "run_2");
    assert.deepEqual(h.mirroredRuns, [replacement]);
  });

  it("synchronously aborts and fences stale callbacks on clear, then remains reusable", async () => {
    const h = harness();
    await h.bridge.bind(h.binding);
    const stale = h.subscriptions[0];
    h.bridge.clear();
    assert.equal(stale.signal.aborted, true);
    await stale.onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published.length, 0);
    assert.equal(await h.bridge.bind(h.binding), true);
    assert.equal(h.subscriptions.length, 2);
  });

  for (const status of [401, 404]) {
    it(`retries an initial ${status} subscription while its binding remains active`, async () => {
      const scheduled = [];
      const logs = [];
      const h = harness({
        autoConnect: false,
        timers: { setTimeout: (callback, delay) => { scheduled.push({ callback, delay }); return callback; }, clearTimeout() {} },
        logger: { warn: (message, metadata) => logs.push({ message, metadata }) },
        subscriptionRetryDelaysMs: [100, 500],
      });
      let bindingSettled = false;
      const binding = h.bridge.bind(h.binding).then((ready) => { bindingSettled = true; return ready; });
      h.subscriptions[0].reject(Object.assign(new Error("secret url and token"), { code: "unauthorized", status }));
      await flush();
      assert.equal(bindingSettled, false);
      assert.equal(h.published.length, 0);
      assert.equal(h.subscriptions.length, 1);
      assert.equal(scheduled.find(({ delay }) => delay === 100)?.delay, 100);
      scheduled.find(({ delay }) => delay === 100).callback();
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(h.subscriptions.length, 2);
      await h.subscriptions[1].onConnected();
      assert.equal(await binding, true);
      await h.subscriptions[1].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
      assert.equal(h.published.at(-1).event.data.type, "todos.replace");
      assert.deepEqual(logs[0], {
        message: "remote_session_subscription_retry",
        metadata: { code: "unauthorized", status, attempt: 1, retryDelayMs: 100 },
      });
    });
  }

  it("makes stop permanent", async () => {
    const h = harness();
    await h.bridge.bind(h.binding);
    h.bridge.stop();
    assert.equal(h.subscriptions[0].signal.aborted, true);
    assert.equal(await h.bridge.bind(h.binding), false);
  });

  it("unbinds immediately when publication is rejected without advancing a hidden sequence", async () => {
    let accepted = false;
    const h = harness({ publish: () => accepted });
    await h.bridge.bind(h.binding);
    await h.subscriptions[0].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published[0].event.sequence, 1);
    accepted = true;
    assert.equal(await h.bridge.bind(h.binding), true);
    await h.subscriptions[1].onEvent({ type: "todo.updated", properties: { sessionID: "ses_1", todos: [] } });
    assert.equal(h.published[1].event.sequence, 1);
  });
});

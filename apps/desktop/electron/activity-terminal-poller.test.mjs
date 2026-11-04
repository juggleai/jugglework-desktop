import { test } from "node:test";
import assert from "node:assert/strict";
import { createActivityTerminalPoller } from "./activity-terminal-poller.mjs";
import { createRemoteSessionEventBridge } from "./remote-session-event-bridge.mjs";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test("throwing diagnostics cannot prevent ACK cursor advancement or the next timer", async () => {
  const h = harness({ logger: { info() { throw new TypeError("disk/clock"); }, warn() { throw new Error("disk"); } } });
  await flush(); h.fire(5000); await flush();
  h.controller.abort();
  assert.equal(h.calls.at(-1).after, 2);
  assert.equal(h.events.length, 2);
  assert.equal(h.jobs.size, 0);
});
test("fixed retention explicitly counts undelivered expiry without blocking fresh records", async () => {
  const now = Date.now(); const warnings = []; const sent = [];
  const h = harness({ now: () => now,
    logger: { warn: (...args) => warnings.push(args) },
    list: async ({ after }) => ({ items: [
      { ...row(1), occurredAt: now - 30 * 86400000 - 1 },
      { ...row(2), occurredAt: now - 30 * 86400000 },
    ].filter(r => r.id > after) }),
    publish: async event => { sent.push(event); return true; },
  });
  await flush();
  assert.deepEqual(sent.map(e => e.runId), ["run-2"]);
  assert.equal(sent[0].occurredAt, new Date(now - 30 * 86400000).toISOString());
  assert.equal(warnings[0][0], "remote_activity_journal_expired_undelivered");
  assert.deepEqual(h.poller.diagnostics(), { expiredUndeliveredCount: 1 });
  await h.poller.tick(); assert.equal(sent.length, 1);
  h.controller.abort();
});
for (const reason of ["invalid", "forbidden", "unavailable"]) {
  test(`in-retention ${reason} ACK remains undelivered and retryable`, async () => {
    const h = harness({ publish: async (_, options) => { options.onAck(reason); return false; } });
    await flush(); h.fire(5000); await flush();
    assert.equal(h.calls.at(-1).after, 0);
    assert.equal(h.poller.diagnostics().expiredUndeliveredCount, 0);
    h.controller.abort();
  });
}
const row = (id) => ({ id, workspaceId: "ws", sessionId: "session", runId: `run-${id}`,
  generation: id, terminalReason: "completed", occurredAt: Date.now() - 2 * 86400000 + id });
test("native timer callbacks release handles; abort during fetch fences late callbacks", async t => {
  const handles = new Set();
  const timers = {
    setTimeout(fn, ms) { const handle = setTimeout(() => { handles.delete(handle); fn(); }, ms); handles.add(handle); return handle; },
    clearTimeout(handle) { handles.delete(handle); clearTimeout(handle); },
  };
  const controller = new AbortController();
  t.after(() => controller.abort());
  let reads = 0; let late = (_) => {}; let published = 0;
  createActivityTerminalPoller({ workspaceId: "ws", signal: controller.signal, timers,
    isCurrent: () => true, intervalMs: 5, timeoutMs: 100,
    list: async () => { reads++; return reads === 1 ? { items: [] } : new Promise(resolve => { late = resolve; }); },
    publish: async () => { published++; return true; },
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(reads, 2);
  controller.abort(); late({ items: [row(1)] }); await flush();
  assert.equal(handles.size, 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 2); assert.equal(published, 0);
});
function harness(overrides = {}) {
  const jobs = new Map(); let id = 0;
  const controller = new AbortController();
  const calls = []; const events = [];
  const timers = { setTimeout(fn, delay) { jobs.set(++id, { fn, delay }); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const poller = createActivityTerminalPoller({ workspaceId: "ws", signal: controller.signal,
    isCurrent: () => true, timers,
    list: async (input) => { calls.push(input); return { items: [row(1), row(2)].filter(x => x.id > input.after) }; },
    publish: async (event) => { events.push(event); return true; }, ...overrides });
  return { poller, jobs, controller, calls, events,
    fire(delay) { for (const [id, job] of jobs) if (job.delay === delay) { jobs.delete(id); job.fn(); return; } } };
}
test("without SSE or phone binding ACKs two runs and advances exact journal cursor", async () => {
  const h = harness(); await flush();
  assert.deepEqual(h.events.map(e => [e.runId, e.generation]), [["run-1", 1], ["run-2", 2]]);
  assert.deepEqual(h.events.map(e => e.title), ["", ""]);
  assert.ok(Date.parse(h.events[0].occurredAt) < Date.now() - 86400000);
  h.fire(5000); await flush(); assert.equal(h.calls.at(-1).after, 2);
  assert.equal(h.events.length, 2); h.controller.abort(); assert.equal(h.jobs.size, 0);
});
test("timeout retains page and invalidates late ACK; next poll retries", async () => {
  let resolve = (_) => {}; let valid = () => true; let attempts = 0;
  const h = harness({ publish: (_, options) => {
    attempts++; valid = options.isCurrent;
    return attempts === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve(true);
  } });
  await flush(); const oldValid = valid; h.fire(10000); await flush();
  assert.equal(oldValid(), false); resolve(true); await flush();
  h.fire(5000); await flush(); assert.equal(h.calls.at(-1).after, 0);
  assert.equal(attempts, 3); h.controller.abort();
});
test("restart replays durable terminals with empty memory; failed ACK retained", async () => {
  const first = harness({ publish: async () => false }); await flush();
  first.fire(5000); await flush(); assert.equal(first.calls.at(-1).after, 0);
  first.controller.abort();
  const restarted = harness(); await flush(); assert.equal(restarted.events.length, 2);
  restarted.controller.abort();
});
test("more than four offline rounds retain the cursor and resume delivery", async () => {
  let online = false;
  const delivered = [];
  const h = harness({ publish: async event => { if (!online) return false; delivered.push(event); return true; } });
  await flush();
  for (let i = 0; i < 6; i++) { h.fire(5000); await flush(); }
  assert.ok(h.calls.every(call => call.after === 0));
  online = true; h.fire(5000); await flush();
  assert.equal(delivered.length, 2);
  h.fire(5000); await flush(); assert.equal(h.calls.at(-1).after, 2);
  h.controller.abort(); assert.equal(h.jobs.size, 0);
});
test("pages over cleanup gaps independently per workspace and rejects foreign rows", async () => {
  const rows = Array.from({ length: 101 }, (_, i) => row(1000 + i * 3));
  const a = harness({ list: async input => ({ items: rows.filter(r => r.id > input.after).slice(0, 100) }) });
  const b = harness({ workspaceId: "other", list: async () => ({ items: [row(9999)] }) });
  // Allow all 100 sequential ACK promises to drain.
  for (let i = 0; i < 30; i++) await flush();
  assert.equal(a.events.length, 100); assert.equal(b.events.length, 0);
  a.fire(5000); await flush(); assert.equal(a.events.length, 101);
  assert.equal(a.events.at(-1).runId, "run-1300");
  a.controller.abort(); b.controller.abort();
  assert.equal(a.jobs.size + b.jobs.size, 0);
});
test("stop aborts request and late result cannot publish into replacement generation", async () => {
  let resolve = (_) => {}; let requestSignal = new AbortController().signal;
  const old = harness({ list: input => { requestSignal = input.signal; return new Promise(r => { resolve = r; }); } });
  old.controller.abort(); await flush(); assert.equal(requestSignal.aborted, true);
  const next = harness(); await flush(); resolve({ items: [row(1)] }); await flush();
  assert.equal(old.events.length, 0); assert.equal(old.jobs.size, 0);
  assert.equal(next.events.length, 2); next.controller.abort();
});
test("old terminal retains A identity while cloud has newer B; never rewrites B", async () => {
  const cloud = { runId: "run-2", generation: 2, status: "running" };
  const h = harness({ publish: async (event, options) => {
    if (event.generation === cloud.generation && event.runId === cloud.runId) cloud.status = event.status;
    else { assert.equal(cloud.status, "running"); options.onAck("stale"); return false; }
    return true;
  } }); await flush(); assert.equal(cloud.status, "completed"); h.controller.abort();
});

test("workspace bridge polls idle journal without SSE and clears old generation on clear/stop", async () => {
  const jobs = new Map(); let id = 0; let records = []; const sent = []; const signals = [];
  const timers = { setTimeout(fn, delay) { jobs.set(++id, { fn, delay }); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const bridge = createRemoteSessionEventBridge({
    sseClient: { subscribe: async () => new Promise(() => {}) },
    coordinator: { getActiveRunId: () => null, recordServerRun: () => true, clearTerminalRun: () => true },
    listActiveRuns: async () => ({ items: [] }), observeRun: async () => ({}), publish: () => true,
    listRunTerminals: async input => { signals.push(input.signal); return { items: records.filter(r => r.id > input.after) }; },
    publishActivityTaskStatus: async (event, options) => { assert.equal(options.isCurrent(), true); sent.push(event); return true; },
    randomUUID: () => "unused", now: Date.now, timers,
  });
  const poll = async () => {
    const entry = [...jobs].find(([, job]) => job.delay === 5000);
    assert.ok(entry); jobs.delete(entry[0]); entry[1].fn(); await flush();
  };
  bridge.watch([{ id: "ws" }]); await flush();
  records = [row(1)]; await poll(); records.push(row(2)); await poll();
  assert.deepEqual(sent.map(e => e.runId), ["run-1", "run-2"]);
  bridge.clear(); await flush();
  assert.deepEqual(sent.slice(2).map(e => e.runId), ["run-1", "run-2"]);
  bridge.stop(); await flush(); assert.equal(jobs.size, 0);
});

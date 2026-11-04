import { test } from "node:test";
import assert from "node:assert/strict";
import { createMainActivityTerminalOptions } from "./main-activity-terminal-options.mjs";
import { createManagedRuntimeClient } from "./managed-runtime-client.mjs";
import { createMainProcessFetch } from "./main-fetch.mjs";
import { createRemoteSessionEventBridge } from "./remote-session-event-bridge.mjs";

const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
test("main wiring: stalled reconciliation cannot hide durable outbox; native timers keep polling after 12 ACKs", async t => {
  const requests = []; const sent = []; let rows = [];
  const ws = "fake workspace";
  const makeRow = id => ({ id, workspaceId: ws, sessionId: "fake-session", runId: `fake-run-${id}`,
    generation: id, terminalReason: "completed", occurredAt: Date.now() });
  rows = Array.from({ length: 12 }, (_, i) => makeRow(74 + i));
  const client = createManagedRuntimeClient({
    getAccess: () => ({ baseUrl: "http://127.0.0.1:1", clientToken: "fake-test-token" }),
    fetcher: createMainProcessFetch({
      electronFetch: () => { throw new Error("unexpected external transport"); },
      nodeFetch: async (url, init) => {
        requests.push(url);
        if (url.pathname.endsWith("/session-runs")) return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        assert.equal(url.searchParams.get("limit"), "100");
        assert.equal(decodeURIComponent(url.pathname.split("/")[2]), ws);
        const after = Number(url.searchParams.get("after"));
        return Response.json({ items: rows.filter(r => r.id > after), cursor: 999999 });
      },
    }),
  });
  const bridge = createRemoteSessionEventBridge({
    ...createMainActivityTerminalOptions(client),
    sseClient: { subscribe: () => new Promise(() => {}) },
    coordinator: { getActiveRunId: () => null, recordServerRun: () => true, clearTerminalRun: () => true },
    listActiveRuns: async () => ({ items: [] }), observeRun: async () => ({}), publish: () => true,
    publishActivityTaskStatus: async event => { sent.push(event); return true; },
    randomUUID: () => "fake", now: Date.now,
  });
  t.after(() => bridge.stop());
  bridge.watch([{ id: ws }]); await flush();
  assert.equal(sent.length, 12, "durable fetch must not await reconciliation");
  await new Promise(resolve => setTimeout(resolve, 5100));
  rows.push(makeRow(86));
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(sent.length, 13);
  assert.equal(requests.filter(u => u.pathname.endsWith("/session-run-terminals")).at(-1).searchParams.get("after"), "85");
  bridge.clear(); await flush();
  assert.equal(sent.length, 26, "clear replaces poller and replays watched workspace without phone");
  bridge.watch([]); await flush();
  const count = requests.length;
  await new Promise(resolve => setTimeout(resolve, 5100));
  assert.equal(requests.length, count, "removed workspace cannot reschedule");
});
test("reconciliation deadline aborts an uncooperative request and releases the next round", async () => {
  const signals = [];
  const lifetime = new AbortController();
  const options = createMainActivityTerminalOptions({ getJson: async (path, { signal }) => {
    if (path.endsWith("/session-runs")) { signals.push(signal); return new Promise(() => {}); }
    return { items: [] };
  } }, { reconciliationTimeoutMs: 20 });
  const input = { workspaceId: "ws", after: 0, signal: lifetime.signal };
  await options.listRunTerminals(input);
  await options.listRunTerminals(input);
  assert.equal(signals.length, 1);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(signals[0].aborted, true);
  await options.listRunTerminals(input);
  assert.equal(signals.length, 2);
  lifetime.abort();
  assert.equal(signals[1].aborted, true);
});

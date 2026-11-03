import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeLifecycleFeedPump } from "./runtime-lifecycle-feed-pump.mjs";

const item = Object.freeze({ deviceEpoch: "11111111-1111-4111-8111-111111111111", sequence: 1,
  eventId: "22222222-2222-4222-8222-222222222222", workspaceId: "w", sessionId: "s", runId: "r",
  generation: 1, revision: 2, origin: "local-renderer", status: "running", title: "A", occurredAt: 1_000 });

test("ACKs only after cloud acceptance and preserves the runtime event identity", async () => {
  const controller = new AbortController();
  const calls = [];
  const runtimeClient = {
    async getJson() { return { deviceEpoch: item.deviceEpoch, nextSequence: 1, items: [item] }; },
    async postJson(path, body) { calls.push([path, body]); controller.abort(); },
  };
  createRuntimeLifecycleFeedPump({ runtimeClient, signal: controller.signal,
    publish: async (event) => { assert.equal(event.eventId, item.eventId); return true; },
    getConsumerId: () => "device-cloud-id",
    timers: /** @type {any} */ ({ setTimeout: () => 1, clearTimeout() {} }) });
  while (!controller.signal.aborted) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["/session-lifecycle/feed/ack", {
    consumerId: "device-cloud-id", deviceEpoch: item.deviceEpoch, sequence: 1, eventId: item.eventId,
  }]]);
});

test("does not ACK timeout and retries the same eventId", async () => {
  const controller = new AbortController();
  const sent = [];
  let reads = 0;
  const pump = createRuntimeLifecycleFeedPump({
    runtimeClient: { async getJson() { reads++; return { deviceEpoch: item.deviceEpoch, nextSequence: 1, items: [item] }; },
      async postJson() { assert.fail("must not ACK"); } },
    publish: async (event) => { sent.push(event.eventId); return false; }, signal: controller.signal,
    getConsumerId: () => "device-cloud-id",
    timers: /** @type {any} */ ({ setTimeout: () => 1, clearTimeout() {} }),
  });
  while (sent.length < 1) await new Promise((resolve) => setImmediate(resolve));
  await pump.tick(); controller.abort();
  assert.ok(reads >= 2);
  assert.deepEqual(sent, [item.eventId, item.eventId]);
});

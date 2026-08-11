import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRemoteControlPendingPolicySynchronizer } from "./remote-control-pending-policy.mjs";

const validContext = {
  signedIn: true,
  policyFresh: true,
  featureGates: {
    enrollment: true,
    readOnlyControl: true,
    sessionMutation: true,
    busySessionSteer: true,
    busySessionEnqueue: true,
  },
};

function harness() {
  const policies = [];
  const synchronizer = createRemoteControlPendingPolicySynchronizer({
    readSettings: async () => ({ enabled: true, allowBusySessionSteer: true, allowBusySessionEnqueue: true }),
    postPolicy: async (policy) => { policies.push(policy); },
    normalizeContext: (input) => {
      if (input?.schemaVersion !== 1) throw new TypeError("invalid context");
      return validContext;
    },
  });
  return { policies, synchronizer };
}

describe("remote pending policy synchronization", () => {
  it("fails closed before propagating malformed or future context", async () => {
    for (const input of [null, { schemaVersion: 2 }]) {
      const h = harness();
      await h.synchronizer.syncContext({ schemaVersion: 1 }, async () => "ready");
      h.policies.length = 0;
      await assert.rejects(h.synchronizer.syncContext(input, async () => { throw new TypeError("agent rejected context"); }), /agent rejected/);
      assert.deepEqual(h.policies, [{ enabled: false, steer: false, enqueue: false }]);
    }
  });

  it("revokes prior managed authorization when agent synchronization fails", async () => {
    const h = harness();
    await h.synchronizer.syncContext({ schemaVersion: 1 }, async () => "ready");
    assert.deepEqual(h.policies.at(-1), { enabled: true, steer: true, enqueue: true });
    await assert.rejects(
      h.synchronizer.syncContext({ schemaVersion: 1 }, async () => { throw new Error("agent sync failed"); }),
      /agent sync failed/,
    );
    assert.deepEqual(h.policies.at(-1), { enabled: false, steer: false, enqueue: false });
  });

  it("fences prior authorization before invoking an agent context refresh", async () => {
    const h = harness();
    await h.synchronizer.syncContext({ schemaVersion: 1 }, async () => "ready");
    const observed = [];
    await h.synchronizer.syncContext({ schemaVersion: 1 }, async () => {
      observed.push(h.policies.at(-1));
      return "ready";
    });
    assert.deepEqual(observed, [{ enabled: false, steer: false, enqueue: false }]);
    assert.deepEqual(h.policies.at(-1), { enabled: true, steer: true, enqueue: true });
  });
});

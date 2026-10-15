import assert from "node:assert/strict";
import test from "node:test";
import type { CloudProvider } from "@jugglework/cloud-provider";
import { modelFitsAvailablePoints } from "../src/managed-points.js";

const provider: CloudProvider = {
  id: "lpr_router", providerId: "JuggleRouter", name: "JuggleRouter", source: "juggle_router",
  models: [{
    id: "kimi-k3", name: "Kimi K3", config: {
      limit: { context: 1_048_576, output: 1_048_576 },
      cost_metadata: { source_currency: "CNY", source_cost: { input: 20, output: 100, cache_read: 2 } },
    },
  }],
};

test("one posted point admits expensive managed models without a reservation estimate", () => {
  assert.equal(modelFitsAvailablePoints(provider, 1), true);
  assert.equal(modelFitsAvailablePoints(provider, 888), true);
});

test("managed admission requires a positive balance regardless of cost metadata", () => {
  for (const available of [0, -1, null]) {
    assert.equal(modelFitsAvailablePoints(provider, available), false);
    assert.equal(modelFitsAvailablePoints({ ...provider, models: [{ id: "unknown-cost", name: "Unknown cost" }] }, available), false);
  }
});

test("BYOK is not gated by managed points", () => {
  for (const source of ["custom", "models_dev", undefined]) {
    for (const available of [1, 0, -1, null]) {
      assert.equal(modelFitsAvailablePoints({ ...provider, source }, available), true);
    }
  }
});

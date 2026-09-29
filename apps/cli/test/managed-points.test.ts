import assert from "node:assert/strict";
import test from "node:test";
import type { CloudProvider } from "@jugglework/cloud-provider";
import { managedModelReservationPoints, modelFitsAvailablePoints } from "../src/managed-points.js";

const provider: CloudProvider = {
  id: "lpr_router", providerId: "JuggleRouter", name: "JuggleRouter", source: "juggle_router",
  models: [{
    id: "kimi-k3", name: "Kimi K3", config: {
      limit: { context: 1_048_576, output: 1_048_576 },
      cost_metadata: { source_currency: "CNY", source_cost: { input: 20, output: 100, cache_read: 2 } },
    },
  }],
};

test("managed reservation mirrors full-context gateway point admission", () => {
  const model = provider.models[0]!;
  assert.equal(managedModelReservationPoints(provider, model), 12_583);
  assert.equal(modelFitsAvailablePoints(provider, model, 888), false);
  assert.equal(modelFitsAvailablePoints(provider, model, 12_583), true);
  assert.equal(managedModelReservationPoints({ ...provider, source: "custom" }, model), null);
});

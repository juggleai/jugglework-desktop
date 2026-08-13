import { describe, expect, test } from "bun:test";
import { agentRuntimeSupportDiagnosticsSchema } from "@jugglework/types/agent-runtime";

import { AgentRuntimeTelemetry } from "./agent-runtime-telemetry.js";

describe("agent runtime telemetry", () => {
  test("aggregates bounded operational signals without private identifiers or content", () => {
    let now = 1_000;
    const telemetry = new AgentRuntimeTelemetry({ now: () => now, workerStatus: "stopped" });
    telemetry.workerStatus("starting");
    telemetry.workerStatus("healthy");
    telemetry.workerCrash();
    telemetry.queryStarted("run-private-id");
    telemetry.interactionRequested("interaction-private-id");
    telemetry.mcp("connected");
    telemetry.mcp("output_truncated");
    telemetry.eventObserved(900);
    telemetry.eventPersisted(true);
    telemetry.eventPersisted(false);
    telemetry.queueCreated();
    telemetry.queueSnapshot([{ state: "pending" }, { state: "dispatching" }]);
    now = 1_250;
    telemetry.interactionResolved("interaction-private-id", "allow");
    telemetry.usage("run-private-id", {
      inputTokens: 10,
      outputTokens: 5,
      turns: 2,
      durationMs: 200,
      estimatedCostUsd: 0.01,
      estimateOnly: true,
    });
    telemetry.queryFinished("run-private-id", "completed");
    telemetry.queueAdmitted(125);
    telemetry.advancedFeatureConfigured("resident", true);
    telemetry.advancedFeature("resident", "used");
    telemetry.advancedFeature("steer", "killed");

    const snapshot = telemetry.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(agentRuntimeSupportDiagnosticsSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({
      worker: { status: "healthy", starts: 1, crashes: 1 },
      query: { active: 0, started: 1, completed: 1, durationMs: { count: 1, total: 250, max: 250 } },
      mcp: { events: 2, connected: 1, outputTruncated: 1 },
      interaction: { requested: 1, resolved: 1, allowed: 1 },
      event: { observed: 1, persisted: 1, duplicates: 1, lagMs: { count: 1, total: 100, max: 100 } },
      queue: { created: 1, pending: 1, dispatching: 1, waitMs: { count: 1, total: 125, max: 125 } },
      advancedRollout: { features: expect.arrayContaining([
        expect.objectContaining({ feature: "resident", enabled: true, attempts: 1, used: 1 }),
        expect.objectContaining({ feature: "steer", enabled: false, attempts: 1, killed: 1, fallbacks: 1 }),
      ]) },
      usage: { samples: 1, inputTokens: 10, outputTokens: 5, turns: 2, durationMs: 200, estimatedCostUsd: 0.01 },
      crash: { total: 1, worker: 1, lastReason: "worker_exit" },
    });
    for (const privateValue of ["run-private-id", "interaction-private-id", "/Users/private", "secret-token", "prompt", "transcript"]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  test("support schema rejects unknown private fields and unbounded counters", () => {
    const telemetry = new AgentRuntimeTelemetry({ now: () => 1_000 });
    const snapshot = telemetry.snapshot();
    expect(agentRuntimeSupportDiagnosticsSchema.safeParse({ ...snapshot, prompt: "private" }).success).toBe(false);
    expect(agentRuntimeSupportDiagnosticsSchema.safeParse({
      ...snapshot,
      query: { ...snapshot.query, started: Number.MAX_SAFE_INTEGER },
    }).success).toBe(false);
  });
});

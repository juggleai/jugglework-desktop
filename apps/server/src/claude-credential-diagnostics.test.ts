import { expect, test } from "bun:test";

import { ClaudeAgentEngineAdapter } from "./agent-engine/claude-adapter.js";

test("Claude runtime health exposes only stable provider credential diagnostics", async () => {
  const secretCanary = "fixture-only-not-a-real-provider-token";
  let clientCalls = 0;
  const adapter = new ClaudeAgentEngineAdapter({
    getClient: async () => {
      clientCalls += 1;
      throw new Error(`must not start worker with ${secretCanary}`);
    },
    credentialReadiness: async () => ({
      ready: false,
      reasonCode: "provider_not_approved",
      provider: "bedrock",
      authMethod: "bearer_token",
    }),
  });

  const health = await adapter.health();
  expect(health).toMatchObject({
    status: "unavailable",
    reasonCode: "provider_not_approved",
    message: "Claude Agent bedrock authentication is unavailable (bearer_token).",
  });
  expect(JSON.stringify(health)).not.toContain(secretCanary);
  expect(clientCalls).toBe(0);
});

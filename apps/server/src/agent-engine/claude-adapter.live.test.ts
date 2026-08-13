import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ClaudeAgentEngineAdapter } from "./claude-adapter.js";
import { createClaudeWorkerProcessManagerFromEnv } from "../claude-worker-process-manager.js";

export const CLAUDE_AGENT_LIVE_SMOKE_ENV = "JUGGLEWORK_CLAUDE_AGENT_LIVE_SMOKE";

export function claudeLiveSmokeEnabled(env: NodeJS.ProcessEnv): boolean {
  const enabled = ["1", "true", "yes", "on"].includes(env[CLAUDE_AGENT_LIVE_SMOKE_ENV]?.trim().toLowerCase() ?? "");
  return enabled
    && Boolean(env.ANTHROPIC_API_KEY?.trim())
    && Boolean(env.JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH?.trim())
    && Boolean(env.JUGGLEWORK_CLAUDE_EXECUTABLE_PATH?.trim());
}

test("live smoke remains disabled without both an explicit gate and credentials", () => {
  expect(claudeLiveSmokeEnabled({})).toBe(false);
  expect(claudeLiveSmokeEnabled({ [CLAUDE_AGENT_LIVE_SMOKE_ENV]: "1" })).toBe(false);
  expect(claudeLiveSmokeEnabled({ ANTHROPIC_API_KEY: "secret" })).toBe(false);
});

const describeLive = claudeLiveSmokeEnabled(process.env) ? describe : describe.skip;

describeLive("ClaudeAgentEngineAdapter live smoke", () => {
  test("starts a credentialed worker run and observes a terminal event", async () => {
    const manager = createClaudeWorkerProcessManagerFromEnv({
      ...process.env,
      JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1",
      JUGGLEWORK_CLAUDE_ROLLOUT_STAGE: "internal",
      JUGGLEWORK_CLAUDE_INTERNAL_COHORT: "1",
    }, {
      credentialBroker: {
        readiness: async () => ({ ready: true, reasonCode: "credential_ready" }),
        acquire: async () => ({
          environment: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! },
          release() {},
        }),
      },
      profileDataDir: process.env.JUGGLEWORK_CLAUDE_AGENT_PROFILE_DATA_DIR?.trim()
        || join(tmpdir(), "jugglework-claude-live-smoke"),
    });
    if (!manager) throw new Error("Claude worker manager was not enabled");
    const adapter = new ClaudeAgentEngineAdapter({ getClient: () => manager.start() });
    const context = { workspaceId: "live-smoke", directory: process.cwd() };
    const session = await adapter.createSession({
      ...context,
      sessionId: `live-${Date.now()}`,
      title: "Claude adapter live smoke",
      configuration: { maxTurns: 1 },
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Claude live smoke timed out")), 60_000);
    try {
      await adapter.startRun({
        ...context,
        sessionId: session.id,
        backendSessionId: null,
        runId: `run-${Date.now()}`,
        prompt: { parts: [{ type: "text", text: "Reply with exactly: smoke-ok" }] },
      });
      let terminal = false;
      for await (const event of adapter.subscribeEvents(context, controller.signal)) {
        if (["run.completed", "run.failed", "run.aborted"].includes(event.data.type)) {
          terminal = true;
          break;
        }
      }
      expect(terminal).toBe(true);
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await adapter.dispose();
      await manager.stop();
    }
  }, 70_000);
});

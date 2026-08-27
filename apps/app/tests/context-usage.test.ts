import { describe, expect, test } from "bun:test";

import type { JuggleWorkSessionMessage } from "../src/app/lib/jugglework-server";
import {
  deriveContextUsage,
  formatTokenCount,
  resolveModelContextLimit,
} from "../src/react-app/domains/session/surface/composer/context-usage-data";

function assistantMessage(input: {
  id: string;
  modelID?: string;
  providerID?: string;
  cost?: number;
  steps: Array<{
    input: number;
    output: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
  }>;
}): JuggleWorkSessionMessage {
  const total = input.steps.reduce(
    (sum, step) => ({
      input: sum.input + step.input,
      output: sum.output + step.output,
      reasoning: sum.reasoning + (step.reasoning ?? 0),
      cache: {
        read: sum.cache.read + (step.cacheRead ?? 0),
        write: sum.cache.write + (step.cacheWrite ?? 0),
      },
    }),
    { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  );

  return {
    info: {
      id: input.id,
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1 },
      parentID: "user-1",
      modelID: input.modelID ?? "gpt-5",
      providerID: input.providerID ?? "openai",
      mode: "chat",
      agent: "jugglework",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: input.cost ?? 0,
      tokens: total,
    },
    parts: input.steps.map((step, index) => ({
      id: `${input.id}:step:${index}`,
      sessionID: "session-1",
      messageID: input.id,
      type: "step-finish" as const,
      reason: "stop",
      cost: 0,
      tokens: {
        input: step.input,
        output: step.output,
        reasoning: step.reasoning ?? 0,
        cache: { read: step.cacheRead ?? 0, write: step.cacheWrite ?? 0 },
      },
    })),
  };
}

describe("context usage", () => {
  test("uses the context limit published by the selected server model", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_zhipu", modelID: "glm-5.2" },
      [{
        id: "lpr_zhipu",
        models: {
          "glm-5.2": { limit: { context: 1_000_000 } },
        },
      }],
    )).toBe(1_000_000);
  });

  test("returns zero when the server context limit is unavailable or invalid", () => {
    const model = { providerID: "lpr_zhipu", modelID: "glm-5.2" };
    expect(resolveModelContextLimit(model, [])).toBe(0);
    expect(resolveModelContextLimit(model, [{
      id: "lpr_zhipu",
      models: { "glm-5.2": { limit: { context: 0 } } },
    }])).toBe(0);
  });

  test("falls back to the organization model config while the engine list is stale", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_zhipu", modelID: "glm-5.2" },
      [{ id: "lpr_zhipu", models: { "glm-5.2": {} } }],
      [{
        id: "lpr_zhipu",
        providerId: "zhipuai-coding-plan",
        models: [{
          id: "glm-5.2",
          config: { limit: { context: 1_000_000, output: 131_072 } },
        }],
      }],
    )).toBe(1_000_000);
  });

  test("keeps the engine route limit ahead of the server's stored limit", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_codex", modelID: "gpt-5.6-sol" },
      [{
        id: "lpr_codex",
        models: { "gpt-5.6-sol": { limit: { context: 372_000 } } },
      }],
      [{
        id: "lpr_codex",
        providerId: "codex",
        models: [{
          id: "gpt-5.6-sol",
          config: { limit: { context: 1_050_000 } },
        }],
      }],
    )).toBe(372_000);
  });

  test("uses the latest provider call for the selected model and keeps session totals", () => {
    const usage = deriveContextUsage([
      assistantMessage({
        id: "assistant-1",
        cost: 0.01,
        steps: [
          { input: 1_000, output: 100, cacheRead: 2_000 },
          { input: 500, output: 50, reasoning: 25, cacheRead: 3_000, cacheWrite: 100 },
        ],
      }),
      assistantMessage({
        id: "assistant-2",
        cost: 0.02,
        steps: [{ input: 800, output: 80, reasoning: 10, cacheRead: 4_000, cacheWrite: 120 }],
      }),
    ], { providerID: "openai", modelID: "gpt-5" }, 100_000);

    expect(usage.current).toEqual({
      input: 800,
      output: 80,
      reasoning: 10,
      cacheRead: 4_000,
      cacheWrite: 120,
    });
    expect(usage.currentUsed).toBe(5_000);
    expect(usage.percentage).toBe(5);
    expect(usage.sessionCalls).toBe(3);
    expect(usage.session.input).toBe(2_300);
    expect(usage.session.cacheRead).toBe(9_000);
    expect(usage.sessionCost).toBeCloseTo(0.03);
  });

  test("does not present another model's usage as the current model context", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100 }] }),
    ], { providerID: "anthropic", modelID: "claude" }, 200_000);

    expect(usage.current).toBeNull();
    expect(usage.percentage).toBeNull();
    expect(usage.sessionCalls).toBe(1);
  });

  test("does not reuse an older matching model after the latest call used another model", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100 }] }),
      assistantMessage({
        id: "assistant-2",
        providerID: "anthropic",
        modelID: "claude",
        steps: [{ input: 2_000, output: 200 }],
      }),
    ], { providerID: "openai", modelID: "gpt-5" }, 100_000);

    expect(usage.current).toBeNull();
    expect(usage.sessionCalls).toBe(2);
  });

  test("keeps the latest valid usage when an unknown zero-token step terminates the run", () => {
    const valid = assistantMessage({
      id: "assistant-valid",
      steps: [{ input: 2_000, output: 100, cacheRead: 30_000 }],
    });
    const interrupted = assistantMessage({
      id: "assistant-interrupted",
      steps: [{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }],
    });
    interrupted.info.finish = "unknown";
    const finish = interrupted.parts.find((part) => part.type === "step-finish");
    if (finish?.type === "step-finish") finish.reason = "unknown";

    const usage = deriveContextUsage([
      valid,
      interrupted,
    ], { providerID: "openai", modelID: "gpt-5" }, 100_000);

    expect(usage.currentUsed).toBe(32_100);
    expect(usage.percentage).toBeCloseTo(32.1);
    expect(usage.sessionCalls).toBe(1);
  });

  test("formats compact token counts for the toolbar", () => {
    expect(formatTokenCount(503)).toBe("503");
    expect(formatTokenCount(50_300)).toBe("50.3K");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });
});

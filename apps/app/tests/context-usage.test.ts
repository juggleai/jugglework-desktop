import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import type { JuggleWorkSessionMessage } from "../src/app/lib/jugglework-server";
import {
  deriveContextUsage,
  estimateTextTokens,
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

function uiMessage(id: string, role: UIMessage["role"], text: string, metadata?: UIMessage["metadata"]): UIMessage {
  return {
    id,
    role,
    metadata,
    parts: [{ type: "text", text, state: "done" }],
  };
}

const OPENAI_MODEL = { providerID: "openai", modelID: "gpt-5" };

describe("context usage", () => {
  test("uses the context limit published by the selected server model", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_zhipu", modelID: "glm-5.2" },
      [{ id: "lpr_zhipu", models: { "glm-5.2": { limit: { context: 1_000_000 } } } }],
    )).toBe(1_000_000);
  });

  test("returns zero when the server context limit is unavailable or invalid", () => {
    const model = { providerID: "lpr_zhipu", modelID: "glm-5.2" };
    expect(resolveModelContextLimit(model, [])).toBe(0);
    expect(resolveModelContextLimit(model, [{ id: "lpr_zhipu", models: { "glm-5.2": { limit: { context: 0 } } } }])).toBe(0);
  });

  test("falls back to the organization model config while the engine list is stale", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_zhipu", modelID: "glm-5.2" },
      [{ id: "lpr_zhipu", models: { "glm-5.2": {} } }],
      [{ id: "lpr_zhipu", providerId: "zhipuai-coding-plan", models: [{ id: "glm-5.2", config: { limit: { context: 1_000_000, output: 131_072 } } }] }],
    )).toBe(1_000_000);
  });

  test("keeps the engine route limit ahead of the server's stored limit", () => {
    expect(resolveModelContextLimit(
      { providerID: "lpr_codex", modelID: "gpt-5.6-sol" },
      [{ id: "lpr_codex", models: { "gpt-5.6-sol": { limit: { context: 372_000 } } } }],
      [{ id: "lpr_codex", providerId: "codex", models: [{ id: "gpt-5.6-sol", config: { limit: { context: 1_050_000 } } }] }],
    )).toBe(372_000);
  });

  test("estimates multilingual text without requiring a provider call", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("你好")).toBe(2);

    const usage = deriveContextUsage([], [
      uiMessage("user-1", "user", "Please summarize 这段内容"),
    ], OPENAI_MODEL, 100_000);

    expect(usage.currentSource).toBe("estimated");
    expect(usage.currentUsed).toBeGreaterThan(0);
    expect(usage.percentage).toBeGreaterThan(0);
  });

  test("uses the provider report when it is the current selected-model boundary", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", cost: 0.02, steps: [{ input: 800, output: 80, reasoning: 10, cacheRead: 4_000, cacheWrite: 120 }] }),
    ], [
      uiMessage("user-1", "user", "Hello"),
      uiMessage("assistant-1", "assistant", "Hi"),
    ], OPENAI_MODEL, 100_000);

    expect(usage.currentSource).toBe("provider-reported");
    expect(usage.currentUsed).toBe(5_000);
    expect(usage.currentTokens?.reasoning).toBe(10);
    expect(usage.percentage).toBe(5);
    expect(usage.sessionCalls).toBe(1);
    expect(usage.optionalFields).toEqual({ reasoning: true, cacheRead: true, cacheWrite: true });
  });

  test("extends the latest report with content that arrived after it", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100 }] }),
    ], [
      uiMessage("assistant-1", "assistant", "Previous response"),
      uiMessage("user-2", "user", "A new prompt that has not completed yet"),
    ], OPENAI_MODEL, 100_000, true);

    expect(usage.currentSource).toBe("streaming-estimate");
    expect(usage.currentUsed).toBeGreaterThan(1_100);
  });

  test("re-estimates the whole active transcript while a tool loop streams in the same assistant message", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 20_000, output: 100 }] }),
    ], [{
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "read",
          toolCallId: "call-1",
          state: "output-available",
          input: { filePath: "/tmp/report.txt" },
          output: "new tool output",
        },
      ],
    }], OPENAI_MODEL, 100_000, true);

    expect(usage.currentSource).toBe("streaming-estimate");
    expect(usage.currentUsed).toBeGreaterThan(20_100);
  });

  test("re-estimates when the selected model differs from the latest report", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100 }] }),
    ], [uiMessage("assistant-1", "assistant", "Previous response")], { providerID: "anthropic", modelID: "claude" }, 200_000);

    expect(usage.currentSource).toBe("estimated");
    expect(usage.currentUsed).toBeGreaterThanOrEqual(1_100);
    expect(usage.latestCall?.providerID).toBe("openai");
  });

  test("estimates from the latest completed compaction summary", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "summary", steps: [{ input: 90_000, output: 500 }] }),
    ], [
      uiMessage("user-old", "user", "x".repeat(4_000)),
      uiMessage("summary", "assistant", "Compact summary", { opencode: { summary: true, completed: 20 } }),
      uiMessage("user-new", "user", "New prompt"),
    ], OPENAI_MODEL, 100_000);

    expect(usage.currentSource).toBe("post-compaction-estimate");
    expect(usage.currentUsed).toBeLessThan(100);
  });

  test("ignores unfinished zero-token provider snapshots", () => {
    const complete = assistantMessage({ id: "assistant-complete", steps: [{ input: 1_000, output: 100 }] });
    const running = assistantMessage({ id: "assistant-running", steps: [] });
    const usage = deriveContextUsage([complete, running], [
      uiMessage("assistant-complete", "assistant", "Done"),
      uiMessage("assistant-running", "assistant", "Streaming"),
    ], OPENAI_MODEL, 100_000, true);

    expect(usage.latestCall?.messageID).toBe("assistant-complete");
    expect(usage.sessionCalls).toBe(1);
  });

  test("ignores completed zero-token samples that do not contain usable provider accounting", () => {
    const zero = assistantMessage({ id: "assistant-zero", steps: [{ input: 0, output: 0 }] });
    const usage = deriveContextUsage([zero], [
      uiMessage("assistant-zero", "assistant", "A real response without provider usage"),
    ], OPENAI_MODEL, 100_000);

    expect(usage.latestCall).toBeNull();
    expect(usage.currentSource).toBe("estimated");
    expect(usage.currentUsed).toBeGreaterThan(0);
  });

  test("does not establish a compaction boundary before completion", () => {
    const usage = deriveContextUsage([], [
      uiMessage("user-old", "user", "x".repeat(4_000)),
      uiMessage("summary", "assistant", "", { opencode: { summary: true, created: 10 } }),
    ], OPENAI_MODEL, 100_000, true);

    expect(usage.currentSource).toBe("streaming-estimate");
    expect(usage.currentUsed).toBeGreaterThan(1_000);
  });

  test("keeps the latest valid usage when an unknown zero-token step terminates the run", () => {
    const valid = assistantMessage({ id: "assistant-valid", steps: [{ input: 2_000, output: 100, cacheRead: 30_000 }] });
    const interrupted = assistantMessage({ id: "assistant-interrupted", steps: [{ input: 0, output: 0 }] });
    interrupted.info.finish = "unknown";
    const finish = interrupted.parts.find((part) => part.type === "step-finish");
    if (finish?.type === "step-finish") finish.reason = "unknown";

    const usage = deriveContextUsage([valid, interrupted], [
      uiMessage("assistant-valid", "assistant", "Done"),
      uiMessage("assistant-interrupted", "assistant", ""),
    ], OPENAI_MODEL, 100_000);

    expect(usage.currentUsed).toBe(32_100);
    expect(usage.currentSource).toBe("provider-reported");
    expect(usage.sessionCalls).toBe(1);
  });

  test("does not present an interrupted same-message step as a settled provider report", () => {
    const interrupted = assistantMessage({ id: "assistant-1", steps: [{ input: 20_000, output: 100 }] });
    interrupted.info.finish = "unknown";
    const usage = deriveContextUsage([interrupted], [{
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "Partial output after the measured tool step", state: "done" }],
    }], OPENAI_MODEL, 100_000, false);

    expect(usage.currentSource).toBe("estimated");
    expect(usage.currentUsed).toBeGreaterThan(20_100);
  });

  test("treats zero-only optional provider fields as unavailable", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100 }] }),
    ], [uiMessage("assistant-1", "assistant", "Done")], OPENAI_MODEL, 100_000);

    expect(usage.optionalFields).toEqual({ reasoning: false, cacheRead: false, cacheWrite: false });
  });

  test("does not borrow optional-field availability from an older provider call", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100, reasoning: 20, cacheRead: 500 }] }),
      assistantMessage({ id: "assistant-2", providerID: "anthropic", modelID: "claude", steps: [{ input: 2_000, output: 200 }] }),
    ], [
      uiMessage("assistant-1", "assistant", "First"),
      uiMessage("assistant-2", "assistant", "Second"),
    ], { providerID: "anthropic", modelID: "claude" }, 200_000);

    expect(usage.optionalFields).toEqual({ reasoning: false, cacheRead: false, cacheWrite: false });
  });

  test("keeps optional-field capability established by the same model", () => {
    const usage = deriveContextUsage([
      assistantMessage({ id: "assistant-1", steps: [{ input: 1_000, output: 100, reasoning: 20, cacheRead: 500 }] }),
      assistantMessage({ id: "assistant-2", steps: [{ input: 2_000, output: 200 }] }),
    ], [
      uiMessage("assistant-1", "assistant", "First"),
      uiMessage("assistant-2", "assistant", "Second"),
    ], OPENAI_MODEL, 100_000);

    expect(usage.optionalFields).toEqual({ reasoning: true, cacheRead: true, cacheWrite: false });
    expect(usage.sessionOptionalFields.reasoning).toBe(true);
  });

  test("formats compact token counts for the toolbar", () => {
    expect(formatTokenCount(503)).toBe("503");
    expect(formatTokenCount(50_300)).toBe("50.3K");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });
});

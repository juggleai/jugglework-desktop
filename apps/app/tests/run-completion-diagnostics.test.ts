import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  analyzeRunCompletion,
  reconcileRunCompletionDiagnostic,
} from "../src/react-app/domains/session/sync/run-completion-diagnostics";

function textMessage(id: string, role: "user" | "assistant", text: string, finish?: string): UIMessage {
  return {
    id,
    role,
    metadata: finish ? { opencode: { finish } } : undefined,
    parts: text ? [{ type: "text", text }] : [],
  };
}

function toolMessage(id: string, toolName: string, input: Record<string, unknown>): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName,
      toolCallId: `${id}:call`,
      state: "output-available",
      input,
      output: "ok",
    }],
  };
}

const openTodo = [{ id: "todo-1", content: "Finish implementation", status: "in_progress", priority: "high" }];

describe("run completion diagnostics", () => {
  test("treats a successful file edit followed by an empty assistant as abnormal", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Implement it"),
      toolMessage("assistant-tools", "apply_patch", { patchText: "*** Begin Patch" }),
      textMessage("assistant-empty", "assistant", "", "stop"),
    ], []);

    expect(result).toMatchObject({
      anomalousEmptyTurn: true,
      finishReason: "tool_loop_terminated",
      unverified: true,
    });
    expect(result?.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Changes applied but not verified"),
    });
  });

  test("shows unfinished todos even when the provider reports stop", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Do all tasks"),
      textMessage("assistant-1", "assistant", "Started", "stop"),
    ], openTodo);

    expect(result).toMatchObject({ incomplete: true, finishReason: "stop" });
    expect(result?.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("1 todo item remains"),
    });
  });

  test("treats an unknown provider finish as an abnormal terminal state", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Continue the task"),
      textMessage("assistant-empty", "assistant", "", "unknown"),
    ], []);

    expect(result).toMatchObject({
      incomplete: true,
      finishReason: "unknown",
    });
    expect(result?.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("finish_reason: unknown"),
    });
  });

  test("does not warn when a file edit is followed by verification and all todos are complete", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Implement it"),
      toolMessage("assistant-write", "write", { filePath: "src/a.ts", content: "ok" }),
      toolMessage("assistant-test", "bash", { command: "pnpm test" }),
      textMessage("assistant-final", "assistant", "Implemented and verified.", "stop"),
    ], [{ ...openTodo[0]!, status: "completed" }]);

    expect(result).toBeNull();
  });

  test("records an explicit interruption without replacing the real summary", () => {
    const reconciled = reconcileRunCompletionDiagnostic([
      textMessage("user-1", "user", "Implement it"),
      toolMessage("assistant-tools", "apply_patch", { patchText: "*** Begin Patch" }),
      textMessage("assistant-1", "assistant", "Real final summary", "stop"),
    ], [], { finishReason: "provider_disconnected" });

    expect(reconciled.diagnostic?.finishReason).toBe("provider_disconnected");
    expect(reconciled.messages.map((message) => message.id)).toEqual(["user-1", "assistant-tools", "assistant-1"]);
    expect(reconciled.messages.at(-1)?.parts[0]).toMatchObject({ type: "text", text: "Real final summary" });
  });

  test("removes synthetic diagnostics left by older builds", () => {
    const reconciled = reconcileRunCompletionDiagnostic([
      textMessage("user-1", "user", "Implement it"),
      textMessage("assistant-1", "assistant", "Real final summary", "stop"),
      {
        id: "session-run-diagnostic:user-1",
        role: "assistant",
        metadata: { opencode: { syntheticRunDiagnostic: true } },
        parts: [{ type: "text", text: "Task incomplete.\nfinish_reason: stop" }],
      },
    ], openTodo);

    expect(reconciled.diagnostic?.finishReason).toBe("stop");
    expect(reconciled.messages.map((message) => message.id)).toEqual(["user-1", "assistant-1"]);
  });
});

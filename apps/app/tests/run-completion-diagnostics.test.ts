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

function interruptedToolMessage(id: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "task",
      toolCallId: `${id}:call`,
      state: "output-error",
      input: { description: "Review implementation" },
      errorText: "Execution ended before this tool returned a result.",
    }],
  };
}

const openTodo = [{ id: "todo-1", content: "Finish implementation", status: "in_progress", priority: "high" }];

describe("run completion diagnostics", () => {
  test("reports an orphaned child task as an incomplete terminal run", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Review it"),
      interruptedToolMessage("assistant-task"),
    ], []);

    expect(result).toMatchObject({
      incomplete: true,
      interruptedTool: true,
      finishReason: "child_session_orphaned",
    });
    expect(result?.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("stopped without returning a terminal result"),
    });
  });

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

  test("does not mark a successful stop incomplete solely because the last edit lacks a recognized verification command", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Publish the release"),
      toolMessage("assistant-write", "apply_patch", { patchText: "*** Begin Patch" }),
      toolMessage("assistant-push", "bash", { command: "git commit -m release && git push" }),
      textMessage("assistant-final", "assistant", "Release published and verified remotely.", "stop"),
    ], []);

    expect(result).toBeNull();
  });

  test("keeps missing verification as context when another incomplete signal exists", () => {
    const result = analyzeRunCompletion([
      textMessage("user-1", "user", "Implement everything"),
      toolMessage("assistant-write", "write", { filePath: "src/a.ts", content: "ok" }),
      textMessage("assistant-final", "assistant", "Implemented the first part.", "stop"),
    ], openTodo);

    expect(result).toMatchObject({ incomplete: true, unverified: true });
    expect(result?.message.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Changes applied but not verified"),
    });
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

describe("benign finish reasons with a completed summary", () => {
  const summary = (finish: string, extra: Partial<UIMessage> = {}): UIMessage => ({
    ...textMessage("assistant-final", "assistant", "All done, here is the summary.", finish), ...extra,
  });

  test("a written summary after tool-calls, unknown or other counts as completed", () => {
    for (const finish of ["tool-calls", "unknown", "other"]) {
      expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), summary(finish)], [])).toBeNull();
    }
  });

  test("the summary also counts when file edits were not verified", () => {
    expect(analyzeRunCompletion([
      textMessage("user-1", "user", "Go"),
      toolMessage("assistant-tools", "apply_patch", { patchText: "*** Begin Patch" }),
      summary("tool-calls"),
    ], [])).toBeNull();
  });

  test("truncated or filtered output is still abnormal even with text", () => {
    for (const finish of ["length", "content-filter", "error"]) {
      expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), summary(finish)], []))
        .toMatchObject({ incomplete: true, finishReason: finish });
    }
  });

  test("an empty or whitespace-only message is still abnormal", () => {
    for (const finish of ["tool-calls", "unknown"]) {
      expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), textMessage("a", "assistant", "  ", finish)], []))
        .toMatchObject({ incomplete: true, finishReason: finish });
    }
  });

  test("text that is still streaming is not a completed summary", () => {
    const streaming: UIMessage = {
      id: "assistant-stream", role: "assistant", metadata: { opencode: { finish: "tool-calls" } },
      parts: [{ type: "text", text: "partial", state: "streaming" }],
    };
    expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), streaming], [])).toMatchObject({ incomplete: true });
  });

  test("a pending tool call after the text is not a completed summary", () => {
    const pending: UIMessage = {
      id: "assistant-pending", role: "assistant", metadata: { opencode: { finish: "tool-calls" } },
      parts: [
        { type: "text", text: "Running the check", state: "done" },
        { type: "dynamic-tool", toolName: "bash", toolCallId: "c1", state: "input-available", input: { command: "ls" } },
      ],
    };
    expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), pending], [])).toMatchObject({ incomplete: true });
  });

  test("other incomplete signals still win over a written summary", () => {
    const base = [textMessage("user-1", "user", "Go"), summary("tool-calls")];
    expect(analyzeRunCompletion(base, openTodo)).toMatchObject({ incomplete: true });
    expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), interruptedToolMessage("t"), summary("tool-calls")], []))
      .toMatchObject({ incomplete: true, finishReason: "child_session_orphaned" });
    expect(analyzeRunCompletion(base, [], { finishReason: "provider_disconnected" }))
      .toMatchObject({ incomplete: true, finishReason: "provider_disconnected" });
  });

  test("a user stop is never softened", () => {
    const stopped = summary("tool-calls", { metadata: { opencode: { finish: "tool-calls", stopped: true } } });
    expect(analyzeRunCompletion([textMessage("user-1", "user", "Go"), stopped], []))
      .toMatchObject({ incomplete: true, finishReason: "user_cancelled" });
  });
});

test("a persisted stopped assistant is resumable even without todos", () => {
  const stopped = textMessage("assistant-stop", "assistant", "", "stop");
  stopped.metadata = { opencode: { finish: "stop", stopped: true } };
  expect(analyzeRunCompletion([textMessage("user-stop", "user", "Work"), stopped], []))
    .toMatchObject({ incomplete: true, finishReason: "user_cancelled" });
});

test("a successful new user turn is not contaminated by an older stopped turn", () => {
  const stopped = textMessage("assistant-stop", "assistant", "", "stop");
  stopped.metadata = { opencode: { stopped: true } };
  expect(analyzeRunCompletion([textMessage("user-old", "user", "Work"), stopped,
    textMessage("user-new", "user", "Continue"), textMessage("assistant-new", "assistant", "Done", "stop")], []))
    .toBeNull();
});

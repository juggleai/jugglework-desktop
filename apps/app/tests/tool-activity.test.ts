import { expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { getActiveToolLabel, getActiveToolPart, getToolActivityLabel, getToolActivitySummary } from "../src/lib/tool-activity";

function tool(toolName: string, input: Record<string, unknown>, toolCallId = toolName, state: DynamicToolUIPart["state"] = "input-available"): DynamicToolUIPart {
  return { type: "dynamic-tool", toolName, input, toolCallId, state } as DynamicToolUIPart;
}

test("activity labels show the actual command and use descriptions only when args are absent", () => {
  expect(getToolActivityLabel(tool("bash", { command: "  bun test --isolate tests/live-activity.test.ts  ", description: "Run checks" }))).toBe("bun test --isolate tests/live-activity.test.ts");
  expect(getToolActivityLabel(tool("bash", { command: " ", description: "Run checks" }))).toBe("Run checks");
  expect(getToolActivityLabel(tool("bash", {}))).toBe("Running a command");
});

test("commands are redacted before truncation and never mutate execution input", () => {
  const command = `curl --data '${"private-payload".repeat(10)}' http://127.0.0.1:17832/router`;
  const part = tool("bash", { command, description: "Send message" });
  expect(getToolActivityLabel(part)).toBe("[JuggleChat IM operation hidden]");
  expect(part.input).toEqual({ command, description: "Send message" });
});

test("task labels prefer description, then agent type, tolerating partial streamed input", () => {
  expect(getToolActivityLabel(tool("task", { description: "Check status flow", subagent_type: "explore" }))).toBe("Agent: Check status flow");
  expect(getToolActivityLabel(tool("task", { description: " ", subagent_type: "explore" }))).toBe("Agent: explore");
  expect(getToolActivityLabel(tool("task", {}))).toBe("Running an agent");
});

test("active detail and summary share latest-call deduplication, including terminal snapshots", () => {
  const older = tool("bash", { command: "old command" }, "command");
  const task = tool("task", { description: "Inspect code" });
  const completed = { ...older, state: "output-available", output: "done" } as DynamicToolUIPart;
  const parts = [older, task, completed];
  expect(getActiveToolPart(parts)).toBe(task);
  expect(getActiveToolLabel(parts)).toBe("Agent: Inspect code");
  expect(getToolActivitySummary([{ id: "a", role: "assistant", parts } as UIMessage])).toEqual({ total: 2, completed: 1, running: 1 });
  expect(getActiveToolLabel([older, completed])).toBeNull();
  const latest = tool("bash", { command: "current command" }, "command");
  expect(getActiveToolLabel([...parts, latest])).toBe("current command");
});

import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { getLiveActivityKind } from "../src/lib/live-activity";

type PartState = "input-streaming" | "input-available" | "output-available";

function toolPart(toolName: string, state: PartState, input: Record<string, unknown> = {}) {
  return { type: "dynamic-tool", toolName, toolCallId: `${toolName}-1`, state, input } as never;
}

function assistant(...parts: unknown[]): UIMessage {
  return { id: "m1", role: "assistant", parts: parts as never } as UIMessage;
}

describe("实时动作推导", () => {
  test("没有在途工具也没有推理流时兜底为「生成回复中」", () => {
    expect(getLiveActivityKind([assistant({ type: "text", text: "hi" })])).toBe("responding");
    expect(getLiveActivityKind([])).toBe("responding");
  });

  test("已完成的工具不再算作当前动作", () => {
    expect(getLiveActivityKind([assistant(toolPart("bash", "output-available"))])).toBe("responding");
  });

  test("bash 按阶段区分「准备」与「正在执行」", () => {
    expect(getLiveActivityKind([assistant(toolPart("bash", "input-streaming"))])).toBe("command_preparing");
    expect(getLiveActivityKind([assistant(toolPart("bash", "input-available"))])).toBe("command_running");
  });

  test("文件类工具映射到各自的动作", () => {
    const cases: Array<[string, string]> = [
      ["write", "writing_file"],
      ["edit", "editing_file"],
      ["read", "reading_file"],
      ["grep", "searching_files"],
      ["glob", "searching_files"],
      ["websearch", "searching_web"],
      ["webfetch", "reading_web"],
      ["skill", "loading_skill"],
      ["todowrite", "updating_plan"],
      ["task", "delegating"],
    ];
    for (const [toolName, expected] of cases) {
      expect(getLiveActivityKind([assistant(toolPart(toolName, "input-available"))])).toBe(expected);
    }
  });

  test("未知工具落到「工具调用中」而不是兜底文案", () => {
    expect(getLiveActivityKind([assistant(toolPart("some_mcp_tool", "input-available"))])).toBe("tool_calling");
  });

  test("取最新发起的那次在途调用", () => {
    const messages = [assistant(
      toolPart("read", "output-available"),
      toolPart("bash", "input-available"),
      toolPart("write", "input-streaming"),
    )];
    expect(getLiveActivityKind(messages)).toBe("writing_file");
  });

  test("推理流式输出时显示「正在思考」", () => {
    expect(getLiveActivityKind([assistant({ type: "reasoning", text: "…", state: "streaming" })]))
      .toBe("thinking");
  });

  test("在途工具优先于推理流", () => {
    const messages = [assistant(
      { type: "reasoning", text: "…", state: "streaming" },
      toolPart("bash", "input-available"),
    )];
    expect(getLiveActivityKind(messages)).toBe("command_running");
  });

  test("推理已结束则不再显示「正在思考」", () => {
    expect(getLiveActivityKind([assistant({ type: "reasoning", text: "…", state: "done" })]))
      .toBe("responding");
  });
});

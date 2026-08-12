import { describe, expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"

import { toolRunPreviewLabel } from "../src/components/chat/message-list"
import {
  formatTaskDuration,
  getAssistantRenderGroups,
  getTaskTiming,
  mergeAssistantProcessItems,
  splitAssistantTaskMessages,
} from "../src/components/chat/utils"

const message = (
  id: string,
  role: UIMessage["role"],
  created: number,
  parts: UIMessage["parts"],
  completed?: number,
): UIMessage => ({
  id,
  role,
  metadata: {
    opencode: {
      created,
      ...(completed === undefined ? {} : { completed }),
    },
  },
  parts,
})

describe("task message presentation", () => {
  test("formats short and long task durations", () => {
    expect(formatTaskDuration(900)).toBe("0s")
    expect(formatTaskDuration(61_000)).toBe("1m 1s")
    expect(formatTaskDuration(3_661_000)).toBe("1h 1m 1s")
    expect(formatTaskDuration(265_000, "zh")).toBe("4分钟 25秒")
  })

  test("updates a running task from the user message start", () => {
    const startedAt = 1_700_000_000_000
    const messages = [message("user-1", "user", startedAt, [{ type: "text", text: "Do it" }])]

    expect(getTaskTiming(messages, 0, true, startedAt + 12_000)).toEqual({
      startedAt,
      endedAt: startedAt + 12_000,
      running: true,
    })
  })

  test("uses assistant completion time for a completed task", () => {
    const startedAt = 1_700_000_000_000
    const completedAt = startedAt + 42_000
    const messages = [
      message("user-1", "user", startedAt, [{ type: "text", text: "Do it" }]),
      message("assistant-1", "assistant", startedAt + 1_000, [{ type: "text", text: "Done" }], completedAt),
    ]

    expect(getTaskTiming(messages, 0, false)).toEqual({
      startedAt,
      endedAt: completedAt,
      running: false,
    })
  })

  test("keeps only the final assistant text outside the process disclosure", () => {
    const runningTool: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "call-1",
      state: "input-streaming",
      input: { filePath: "/tmp/report.md" },
    }
    const items = [
      {
        index: 1,
        message: message("assistant-1", "assistant", 1_700_000_001_000, [
          { type: "reasoning", text: "Inspecting files", state: "done" },
          runningTool,
          { type: "text", text: "Intermediate update" },
        ]),
      },
      {
        index: 2,
        message: message("assistant-2", "assistant", 1_700_000_002_000, [
          { type: "reasoning", text: "Preparing summary", state: "done" },
          { type: "text", text: "Final summary" },
        ]),
      },
    ]

    const split = splitAssistantTaskMessages(items)

    expect(split.processItems).toHaveLength(2)
    expect(split.processItems.flatMap((item) => item.message.parts).some((part) => part.type === "dynamic-tool")).toBe(true)
    expect(split.summaryItems).toHaveLength(1)
    expect(split.summaryItems[0]?.message.parts).toEqual([{ type: "text", text: "Final summary" }])
  })

  test("collapses consecutive tool calls into one render group without hiding text updates", () => {
    const firstTool: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "call-1",
      state: "output-available",
      input: { command: "git status", description: "" },
      output: "clean",
    }
    const secondTool: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "call-2",
      state: "input-available",
      input: { command: "pnpm test", description: "" },
    }

    const groups = getAssistantRenderGroups([
      { type: "text", text: "Checking the workspace" },
      firstTool,
      secondTool,
      { type: "text", text: "Checks passed" },
    ], false)

    expect(groups.map((group) => group.kind)).toEqual(["text", "tools", "text"])
    expect(groups[1]?.kind === "tools" ? groups[1].parts : []).toEqual([firstTool, secondTool])
  })

  test("merges streamed process messages so tool runs can collapse across message boundaries", () => {
    const tool: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "call-1",
      state: "input-available",
      input: { command: "pnpm test", description: "" },
    }
    const items = [
      { index: 1, message: message("assistant-1", "assistant", 1_700_000_001_000, [{ type: "text", text: "Starting" }, tool]) },
      { index: 2, message: message("assistant-2", "assistant", 1_700_000_002_000, [tool, { type: "text", text: "Still working" }]) },
    ]

    const merged = mergeAssistantProcessItems(items)

    expect(merged?.index).toBe(2)
    expect(merged?.message.id).toBe("assistant-1")
    expect(merged?.message.parts).toEqual(items.flatMap((item) => item.message.parts))
  })

  test("renders a safe preview for a partially streamed bash call", () => {
    const partialTool = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "call-partial",
      state: "input-streaming",
      input: {},
    } as DynamicToolUIPart

    expect(toolRunPreviewLabel(partialTool)).toBe("Running a command")
  })
})

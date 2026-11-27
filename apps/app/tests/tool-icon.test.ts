import { describe, expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import {
  Bot,
  BookOpen,
  FilePen,
  Globe,
  ListTodo,
  Search,
  SquareTerminal,
  Wrench,
} from "lucide-react"

import { toolIcon } from "../src/components/tools/tool-icon"

const tool = (toolName: string): DynamicToolUIPart => ({
  type: "dynamic-tool",
  toolName,
  toolCallId: `call-${toolName}`,
  state: "output-available",
  input: {},
  output: "",
}) as DynamicToolUIPart

describe("tool row icons", () => {
  test("maps built-in tools to distinct icons", () => {
    expect(toolIcon(tool("bash"))).toBe(SquareTerminal)
    expect(toolIcon(tool("read"))).toBe(BookOpen)
    expect(toolIcon(tool("edit"))).toBe(FilePen)
    expect(toolIcon(tool("write"))).toBe(FilePen)
    expect(toolIcon(tool("grep"))).toBe(Search)
    expect(toolIcon(tool("glob"))).toBe(Search)
    expect(toolIcon(tool("websearch"))).toBe(Search)
    expect(toolIcon(tool("webfetch"))).toBe(Globe)
    expect(toolIcon(tool("todowrite"))).toBe(ListTodo)
    expect(toolIcon(tool("task"))).toBe(Bot)
  })

  test("falls back to a wrench for unknown tools", () => {
    expect(toolIcon(tool("some_mcp_tool"))).toBe(Wrench)
  })
})

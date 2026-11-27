import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { ReadFileTool, WriteFileTool } from "../src/components/tools/file"

const write = (state: string) => ({
  type: "dynamic-tool",
  toolName: "write",
  toolCallId: "call-write",
  state,
  input: { filePath: "/tmp/make_doc.py", content: "x" },
  output: "ok",
}) as never

describe("file tool rows", () => {
  test("write row renders an icon before the label", () => {
    const html = renderToStaticMarkup(<WriteFileTool part={write("output-available")} />)
    expect(html).toContain("<svg")
    expect(html.indexOf("<svg")).toBeLessThan(html.indexOf("Write make_doc.py"))
  })

  test("failed write and read rows keep their icon", () => {
    expect(renderToStaticMarkup(<WriteFileTool part={write("output-error")} />)).toContain("<svg")
    const read = {
      type: "dynamic-tool", toolName: "read", toolCallId: "call-read", state: "output-error",
      input: { filePath: "/tmp/a.md" },
    } as never
    expect(renderToStaticMarkup(<ReadFileTool part={read} />)).toContain("<svg")
  })
})

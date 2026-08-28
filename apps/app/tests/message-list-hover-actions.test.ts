import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"

const messageListPath = fileURLToPath(
  new URL("../src/components/chat/message-list.tsx", import.meta.url),
)

describe("message list hover actions", () => {
  test("assistant action bar gates on the live group, not the list-wide streaming flag", () => {
    const source = readFileSync(messageListPath, "utf8")

    // The per-group flag exists and is scoped to the trailing message.
    expect(source).toContain(
      "const isLiveGroup = isStreaming && lastItem !== undefined && lastItem.index === messages.length - 1",
    )

    // History blocks must keep copy/fork/revert/timestamp while another run
    // streams; only the actively streaming block hides its action bar.
    expect(source).toContain("{lastTextMessage && !isLiveGroup && (")
    expect(source).not.toContain("{lastTextMessage && !isStreaming && (")
  })
})

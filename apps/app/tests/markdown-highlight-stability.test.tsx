import { describe, expect, test } from "bun:test"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

import { MarkdownBlock } from "../src/components/markdown/markdown"
import { FileReferenceProvider } from "../src/lib/target-provider"
import type { OpenTarget } from "../src/react-app/domains/session/artifacts/open-target"

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MARKDOWN = "```bash\ncurl -s https://example.com\n```\n"
const frame = (view: TestRenderer.ReactTestRenderer) => JSON.stringify(view.toJSON()).includes("shiki") ? "shiki" : "plain"
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
const tree = (targets: OpenTarget[]) => (
  <FileReferenceProvider targets={targets}>
    <MarkdownBlock text={MARKDOWN} streaming={false} />
  </FileReferenceProvider>
)

describe("highlighted code blocks stay highlighted", () => {
  test("a parent re-render with an equal references array does not fall back to plain code", async () => {
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => { view = TestRenderer.create(tree([])) })
    await settle()
    expect(frame(view)).toBe("shiki")

    for (let index = 0; index < 3; index += 1) {
      act(() => { view.update(tree([])) })
      expect(frame(view)).toBe("shiki")
      await settle()
      expect(frame(view)).toBe("shiki")
    }
    await act(async () => view.unmount())
  })

  test("a changed set of file references still re-highlights with the new references", async () => {
    const target = { kind: "file", value: "notes.md", name: "notes.md", exists: true } as OpenTarget
    let view!: TestRenderer.ReactTestRenderer
    await act(async () => { view = TestRenderer.create(tree([])) })
    await settle()
    act(() => { view.update(tree([target])) })
    expect(frame(view)).toBe("plain")
    await settle()
    expect(frame(view)).toBe("shiki")
    await act(async () => view.unmount())
  })
})

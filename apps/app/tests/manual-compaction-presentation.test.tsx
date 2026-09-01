import { afterEach, describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"

import { StandaloneManualCompactionTask } from "../src/components/chat/message-list"
import { setLocale } from "../src/i18n"

describe("manual compaction presentation", () => {
  afterEach(() => setLocale("en"))

  test("shows only elapsed time and a collapsible in-progress receipt while running", () => {
    setLocale("zh")
    const html = renderToStaticMarkup(
      <StandaloneManualCompactionTask
        state={{
          mode: "manual",
          running: true,
          startedAt: Date.now() - 4_000,
          finishedAt: null,
        }}
      />,
    )

    expect(html).toContain('data-testid="manual-compaction-duration"')
    expect(html).toContain('data-testid="manual-compaction-toggle"')
    expect(html).toContain("耗时 4秒")
    expect(html).toContain("正在压缩上下文")
    expect(html).not.toContain("已处理")
  })

  test("reduces a completed manual compaction to one receipt", () => {
    setLocale("zh")
    const html = renderToStaticMarkup(
      <StandaloneManualCompactionTask
        state={{
          mode: "manual",
          running: false,
          startedAt: 1_700_000_000_000,
          finishedAt: 1_700_000_004_000,
        }}
      />,
    )

    expect(html).toContain("上下文已压缩")
    expect(html).not.toContain('data-testid="manual-compaction-duration"')
    expect(html).not.toContain('data-testid="manual-compaction-toggle"')
  })
})

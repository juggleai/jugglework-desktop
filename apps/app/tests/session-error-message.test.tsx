import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"

import { isMissingFileSessionError, SessionErrorMessage } from "../src/components/chat/session-error-message"
import { setLocale } from "../src/i18n"

describe("missing-file session error presentation", () => {
  test("renders the localized points limit notice without the generic error card", () => {
    try {
      setLocale("zh");
      const html = renderToStaticMarkup(<SessionErrorMessage error="The organization does not have enough available points for this managed model request." />);
      expect(html).toContain("你已达到使用上限。若需更多使用额度，请及时充值。");
      expect(html).toContain('data-testid="session-points-exhausted"');
      expect(html).not.toContain("border-red-300");
      setLocale("en");
      const english = renderToStaticMarkup(<SessionErrorMessage error="insufficient_points" />);
      expect(english).toContain("Please top up");
    } finally {
      setLocale("en");
    }
  });
  test.each([
    "File not found: /Users/example/Documents/IM\n\nDid you mean one of these?\n/Users/example/Documents/IM相关\n/Users/example/Documents/.qimei",
    "File not found: /apps/alias/set",
    "File not found: C:\\work\\missing.txt",
    " File not found: /workspace/文档.md ",
    "Error: File not found: /workspace/missing.txt",
    "NotFoundError: File not found: /workspace/missing.txt",
    "File not found",
    "ENOENT: no such file or directory, open '/workspace/missing.txt'",
    "Error: ENOENT: no such file or directory, stat '/workspace/missing.txt'",
  ])("omits the entire card: %s", (error) => {
    expect(isMissingFileSessionError(error)).toBe(true)
    expect(renderToStaticMarkup(<SessionErrorMessage error={error} />)).toBe("")
  })

  test.each([
    "EACCES: permission denied, open /workspace/private.txt",
    "Authentication failed",
    "Model not found: missing-model",
    "HTTP 404: endpoint not found",
    "Network request failed",
    "spawn opencode ENOENT",
    "ENOENT: no such file or directory, spawn opencode",
    "Provider failed while handling File not found: /workspace/missing.txt",
    "Request failed\nFile not found: /workspace/missing.txt",
  ])("preserves unrelated error cards: %s", (error) => {
    expect(isMissingFileSessionError(error)).toBe(false)
    const html = renderToStaticMarkup(<SessionErrorMessage error={error} />)
    expect(html).toContain(error)
    expect(html).toContain("text-destructive")
    expect(html).toContain("border-red-300")
  })

  test("does not classify absent text as a missing file", () => {
    expect(isMissingFileSessionError(null)).toBe(false)
    expect(isMissingFileSessionError("")).toBe(false)
  })

  test("historical errors and the live fallback both use the guarded renderer", () => {
    const source = readFileSync(new URL("../src/components/chat/message-list.tsx", import.meta.url), "utf8")
    expect(source).toContain('return <SessionErrorMessage error={getMessagesText([message]) || "Session failed"} />')
    expect(source).toContain("{error && !hasSessionErrorMessage ? <SessionErrorMessage error={error} /> : null}")
    expect(source).not.toContain("function ErrorMessage(")
  })
})

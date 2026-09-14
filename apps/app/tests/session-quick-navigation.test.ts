import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  buildSessionQuickNavigationEntries,
  resolveActiveQuickNavigationIndex,
} from "../src/react-app/domains/session/surface/session-quick-navigation";

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  } as UIMessage;
}

describe("session quick navigation", () => {
  test("creates one compact stop for each visible user task turn", () => {
    expect(buildSessionQuickNavigationEntries([
      message("user-1", "user", "  Inspect the release\nmetadata  "),
      message("assistant-1", "assistant", "Done"),
      message("user-2", "user", "Run final verification"),
      message("user-empty", "user", "  "),
    ])).toEqual([
      { messageId: "user-1", preview: "Inspect the release metadata" },
      { messageId: "user-2", preview: "Run final verification" },
    ]);
  });

  test("tracks the last turn above the reading line and pins the final turn at bottom", () => {
    const tops = [80, 240, 560, 900];
    expect(resolveActiveQuickNavigationIndex(tops, 500, false)).toBe(1);
    expect(resolveActiveQuickNavigationIndex(tops, 20, false)).toBe(0);
    expect(resolveActiveQuickNavigationIndex(tops, 500, true)).toBe(3);
    expect(resolveActiveQuickNavigationIndex([], 500, false)).toBe(-1);
  });

  test("bounds preview and accessibility text for very large prompts", () => {
    const [entry] = buildSessionQuickNavigationEntries([
      message("large", "user", "x".repeat(400)),
    ]);
    expect(entry?.preview.length).toBe(240);
    expect(entry?.preview.endsWith("…")).toBe(true);
  });
});

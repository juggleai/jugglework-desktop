import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import {
  buildSessionQuickNavigationEntries,
  resolveActiveQuickNavigationIndex,
  resolveQuickNavigationMarkerScale,
  resolveVisibleQuickNavigationIndices,
  shouldShowSessionQuickNavigation,
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

  test("highlights every task turn intersecting the current viewport", () => {
    const tops = [80, 240, 560, 900];
    expect(resolveVisibleQuickNavigationIndices(tops, 1_200, 200, 600)).toEqual([0, 1, 2]);
    expect(resolveVisibleQuickNavigationIndices(tops, 1_200, 250, 550)).toEqual([1]);
    expect(resolveVisibleQuickNavigationIndices(tops, 1_200, 850, 1_200)).toEqual([2, 3]);
  });

  test("bounds preview and accessibility text for very large prompts", () => {
    const [entry] = buildSessionQuickNavigationEntries([
      message("large", "user", "x".repeat(400)),
    ]);
    expect(entry?.preview.length).toBe(240);
    expect(entry?.preview.endsWith("…")).toBe(true);
  });

  test("uses the actual content gutter instead of an arbitrary pane width", () => {
    expect(shouldShowSessionQuickNavigation(5, 1_325, 58)).toBe(true);
    expect(shouldShowSessionQuickNavigation(5, 1_325, 47)).toBe(false);
    expect(shouldShowSessionQuickNavigation(1, 1_325, 58)).toBe(false);
    expect(shouldShowSessionQuickNavigation(5, 47, 58)).toBe(false);
  });

  test("fans marker lengths out progressively around the hovered task", () => {
    expect([0, 1, 2, 3, 4, 5].map((index) =>
      resolveQuickNavigationMarkerScale(index, 2),
    )).toEqual([1.6, 2.2, 2.8, 2.2, 1.6, 1.25]);
    expect(resolveQuickNavigationMarkerScale(2, null)).toBe(1);
  });
});

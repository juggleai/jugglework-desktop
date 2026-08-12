import { describe, expect, test } from "bun:test";
import { visibleLocalWorkspaceIndicator } from "../src/react-app/shell/app-navigation-status";

describe("local workspace rail status", () => {
  test("hides running status while the local workspace page is visible", () => {
    expect(visibleLocalWorkspaceIndicator("running", true, "local")).toBeNull();
  });

  test("shows running status after leaving the local workspace page", () => {
    expect(visibleLocalWorkspaceIndicator("running", false, "local")).toBe("running");
    expect(visibleLocalWorkspaceIndicator("running", true, "remote")).toBe("running");
  });

  test("only suppresses loading and preserves empty or unread aggregate states", () => {
    expect(visibleLocalWorkspaceIndicator(null, false, "local")).toBeNull();
    expect(visibleLocalWorkspaceIndicator("unread", false, "local")).toBe("unread");
    expect(visibleLocalWorkspaceIndicator("unread", true, "local")).toBe("unread");
  });
});

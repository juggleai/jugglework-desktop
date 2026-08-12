import { readFileSync } from "node:fs";
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

describe("settings notification reminder", () => {
  test("uses a small red dot without rendering the unread count", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const settings = source.slice(source.indexOf('label={t("navigation.settings")}'), source.indexOf("<Settings />"));
    expect(settings).toMatch(/badgeVariant="dot"/);
    expect(source).toMatch(/data-rail-unread-dot/);
    expect(source).toMatch(/right-0\.5 top-0\.5 size-2\.5[^\"]+bg-red-9/);
    expect(source).toMatch(/badgeVariant === "dot"[\s\S]+aria-hidden="true"/);
  });
});

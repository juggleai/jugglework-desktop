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

describe("chat unread reminder", () => {
  test("uses a small red dot instead of the unread count", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const chat = source.slice(source.indexOf('label={t("navigation.chat")}'), source.indexOf("<MessageSquare />"));
    expect(chat).toMatch(/badgeVariant="dot"/);
  });
});

describe("account menu", () => {
  test("moves the settings notification dot into the bottom account trigger and settings row", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-settings"');
    expect(source).toContain('data-testid="app-rail-account-menu"');
    expect(source).toContain('data-testid="account-menu-settings"');
    expect(source).toMatch(/data-rail-unread-dot/);
    expect(source).toMatch(/right-0\.5 top-0\.5 size-2\.5[^\"]+bg-red-9/);
    expect(source).toMatch(/badgeVariant === "dot"[\s\S]+aria-hidden="true"/);
  });

  test("keeps only the avatar in the bottom-left trigger", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const trigger = source.slice(source.indexOf('data-testid="app-rail-account-menu"'), source.indexOf("</button>", source.indexOf('data-testid="app-rail-account-menu"')));
    expect(trigger).toContain("<Avatar");
    expect(trigger).not.toContain("{tierLabel} · {organizationLabel}");
    expect(trigger).not.toContain("w-[220px]");
  });

  test("includes the requested account actions and organization submenu", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="account-menu-upgrade"');
    expect(source).toContain('data-testid="account-menu-balance"');
    expect(source).toContain('data-testid="account-menu-check-updates"');
    expect(source).toContain('data-testid="account-menu-help-feedback"');
    expect(source).toContain('data-testid="account-menu-switch-organization"');
    expect(source).toContain('data-testid="account-menu-management-console"');
    expect(source.indexOf('data-testid="account-menu-management-console"')).toBeGreaterThan(
      source.indexOf('data-testid="account-menu-switch-organization"'),
    );
    expect(source).toContain('data-testid="account-menu-sign-out"');
    expect(source).toContain("<DropdownMenuSubContent");
    expect(source).toContain("organizationGroups.personal.map");
    expect(source).toContain("organizationGroups.others.map");
    expect(source).toContain("<DropdownMenuSeparator />");
  });
});

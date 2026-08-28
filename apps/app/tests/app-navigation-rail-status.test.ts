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

  test("opens the centered membership selector from the upgrade button", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain("setUpgradeOpen(true)");
    expect(source).toContain("<MembershipUpgradeDialog");
    expect(source).toContain("currentTier={tier}");
  });

  test("keeps the membership dialog content-sized without internal scrollbars", () => {
    const source = readFileSync(new URL("../src/react-app/shell/membership-upgrade-dialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("max-w-[880px]");
    expect(source).toContain("md:h-[600px]");
    expect(source).not.toContain("overflow-y-auto");
    expect(source).not.toContain("h-[min(");
  });

  test("uses a full-height order card for the payment summary", () => {
    const source = readFileSync(new URL("../src/react-app/shell/membership-upgrade-dialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("relative flex size-40");
    expect(source).toContain("flex h-full flex-col rounded-[18px]");
    expect(source).toContain("支付完成后立即生效");
    expect(source).toContain("支付宝扫码支付");
  });

  test("gives billing choices the same white surface as tier choices", () => {
    const source = readFileSync(new URL("../src/react-app/shell/membership-upgrade-dialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("min-h-[68px] items-center justify-between gap-2 rounded-[14px] border bg-background");
  });

  test("disables plans below the current membership tier", () => {
    const source = readFileSync(new URL("../src/react-app/shell/membership-upgrade-dialog.tsx", import.meta.url), "utf8");
    expect(source).toContain("isMembershipTierSelectable(currentTier, plan.id)");
    expect(source).toContain("disabled={!selectable}");
    expect(source).toContain("不可降级");
  });
});

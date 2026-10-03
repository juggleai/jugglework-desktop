import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { isIMNavigationVisible, visibleLocalWorkspaceIndicator } from "../src/react-app/shell/app-navigation-status";

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
    expect(visibleLocalWorkspaceIndicator("completed", false, "local")).toBe("completed");
    expect(visibleLocalWorkspaceIndicator("completed", true, "local")).toBe("completed");
  });
});

describe("Code Review navigation", () => {
  test("keeps a dedicated workspace-scoped entry in the primary rail", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const reviews = source.slice(source.indexOf('label={t("navigation.reviews")}'), source.indexOf("<GitPullRequestArrow />"));

    expect(reviews).toContain("active={props.reviewsActive}");
    expect(reviews).toContain("onClick={props.onOpenReviews}");
    expect(reviews).toContain('testId="app-rail-reviews"');
  });
});

describe("navigation rail visual proportions", () => {
  test("uses a compact rail with larger, consistent icons and quiet selected states", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain("APP_NAVIGATION_RAIL_WIDTH = 48");
    expect(source).toContain('data-app-navigation-rail');
    expect(source).toContain('w-12');
    expect(source).toContain('size-9');
    expect(source).toContain('[&>svg]:size-5');
    expect(source).toContain('rounded-xl');
    expect(source).toContain('active && "bg-dls-active text-dls-text"');
    expect(source).not.toContain('active && "border-dls-border bg-background text-dls-text shadow-sm"');
  });

  test("keeps the account trigger visually lighter than the primary actions", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const trigger = source.slice(source.indexOf('data-testid="app-rail-account-menu"'), source.indexOf("</button>", source.indexOf('data-testid="app-rail-account-menu"')));
    expect(trigger).toContain('size-9');
    expect(trigger).toContain('className="size-7 bg-background ring-1 ring-dls-border/70"');
  });
});

describe("chat unread reminder", () => {
  test("uses a small red dot instead of the unread count", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const chat = source.slice(source.indexOf('label={t("navigation.chat")}'), source.indexOf("<MessageSquare />"));
    expect(chat).toMatch(/badgeVariant="dot"/);
  });

  test("shows Chat and Contacts only with current IM bootstrap availability", () => {
    const im = { provider: "juggleim", websocketUrl: "wss://im.example.com", appKey: "app", imUserId: "user", token: "token" };
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: "org", im })).toBe(true);
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: "org", im: null })).toBe(false);
    expect(isIMNavigationVisible({ authStatus: "checking", activeOrganizationId: "org", im })).toBe(false);
    expect(isIMNavigationVisible({ authStatus: "signed_in", activeOrganizationId: null, im })).toBe(false);
  });

  test("keeps Chat and Contacts visible while account details refresh", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-status.ts", import.meta.url), "utf8");
    expect(source).not.toContain("accountBusy");
  });

  test("gates the Chat and Contacts buttons as one block", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("{imNavigationVisible ? ("), source.indexOf("</nav>"));
    expect(block).toContain('testId="app-rail-chat"');
    expect(block).toContain('testId="app-rail-contacts"');
    expect(block).toContain(") : null}");
  });
});

describe("account menu", () => {
  test("moves the settings notification dot into the bottom account trigger and settings row", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).not.toContain('testId="app-rail-settings"');
    expect(source).toContain('data-testid="app-rail-account-menu"');
    expect(source).toContain('data-testid="account-menu-settings"');
    expect(source).toMatch(/data-rail-unread-dot/);
    expect(source).toMatch(/right-0 top-0 size-2\.5[^\"]+bg-red-9/);
    expect(source).toMatch(/-right-0\.5 -top-0\.5 size-2\.5[^\"]+bg-red-9/);
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

  test("opens the server-owned membership selector from the upgrade button", () => {
    const source = readFileSync(new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url), "utf8");
    expect(source).toContain("membershipUpgradeContext(tenantAccount, activeOrganization)");
    expect(source).toContain("buildDenMembershipUpgradeUrl(readDenSettings().baseUrl, upgradeContext)");
    expect(source).toContain("{upgradeContext ? (");
    expect(source).not.toContain("MembershipUpgradeDialog");
  });
});

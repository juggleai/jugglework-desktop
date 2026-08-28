import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const navigationRailPath = fileURLToPath(
  new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url),
);

describe("managed brand navigation identity", () => {
  test("does not duplicate account identity at the top of the primary rail", () => {
    const source = readFileSync(navigationRailPath, "utf8");

    expect(source).not.toContain("useBrandLogoUrl");
    expect(source).not.toContain('data-testid="app-rail-account"');
    expect(source).toContain('data-testid="app-rail-account-menu"');
    expect(source).toMatch(/className="flex h-full w-\[72px\] shrink-0 flex-col items-center/);
  });

  test("uses rail whitespace as a window drag region without swallowing button clicks", () => {
    const source = readFileSync(navigationRailPath, "utf8");

    expect(source).toContain("mac:titlebar-drag mac:pt-11");
    expect(source).toMatch(/data-testid=\{testId\}[\s\S]*mac:titlebar-no-drag/);
    expect(source).toContain('className="relative mt-auto flex h-11 w-full items-center justify-center mac:titlebar-no-drag"');
    expect(source).toContain('data-testid="app-rail-account-menu"');
  });

  test("starts primary actions at the top and keeps the account menu at the bottom", () => {
    const source = readFileSync(navigationRailPath, "utf8");
    const searchIndex = source.indexOf('testId="app-rail-task-search"');
    const createIndex = source.indexOf('data-testid="app-rail-create-workspace"');
    const homeIndex = source.indexOf('testId="app-rail-home"');
    const accountMenuIndex = source.indexOf('data-testid="app-rail-account-menu"');

    expect(searchIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(searchIndex);
    expect(homeIndex).toBeGreaterThan(createIndex);
    expect(accountMenuIndex).toBeGreaterThan(homeIndex);
    expect(source).toContain("<AvatarImage src={user.avatar} alt={identity} />");
  });
});

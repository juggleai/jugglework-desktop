import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const navigationRailPath = fileURLToPath(
  new URL("../src/react-app/shell/app-navigation-rail.tsx", import.meta.url),
);

describe("managed brand navigation identity", () => {
  test("shows the managed logo in the global rail and falls back to the user initial", () => {
    const source = readFileSync(navigationRailPath, "utf8");

    expect(source).toMatch(/\{brandLogoUrl \? \([\s\S]*?<img[\s\S]*?src=\{brandLogoUrl\}/);
    expect(source).toMatch(/<span aria-hidden="true">\{initial\}<\/span>/);
    expect(source).not.toContain("brand-app-name");
    expect(source).not.toContain("useBrandAppName");
    expect(source).toMatch(/className="flex h-full w-\[72px\] shrink-0 flex-col items-center/);
    expect(source).toMatch(/className="size-full object-cover"/);
  });

  test("uses rail whitespace as a window drag region without swallowing button clicks", () => {
    const source = readFileSync(navigationRailPath, "utf8");

    expect(source).toContain("mac:titlebar-drag mac:pt-11");
    expect(source).toMatch(/data-testid=\{testId\}[\s\S]*mac:titlebar-no-drag/);
    expect(source).toMatch(/className="[^"]*mac:titlebar-no-drag"[\s\S]*?data-testid="app-rail-account"/);
  });

  test("places Home first and Apps directly after it", () => {
    const source = readFileSync(navigationRailPath, "utf8");
    const avatarIndex = source.indexOf('data-testid="app-rail-account"');
    const homeIndex = source.indexOf('testId="app-rail-home"');
    const appsIndex = source.indexOf('testId="app-rail-apps"');
    const localTasksIndex = source.indexOf('testId="app-rail-create-local"');

    expect(avatarIndex).toBeGreaterThan(-1);
    expect(homeIndex).toBeGreaterThan(avatarIndex);
    expect(appsIndex).toBeGreaterThan(homeIndex);
    expect(localTasksIndex).toBeGreaterThan(appsIndex);
    expect(source).toContain('label={t("navigation.home")}');
    expect(source).toContain('onClick={props.onOpenHome}');
    expect(source).toContain('label={t("mcp.apps_title")}');
    expect(source).toContain('onClick={props.onOpenApps}');
  });
});

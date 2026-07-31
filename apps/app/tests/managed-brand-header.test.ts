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
});

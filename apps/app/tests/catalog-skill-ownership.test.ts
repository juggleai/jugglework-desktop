import { describe, expect, test } from "bun:test";
import { filterStandaloneCatalogSkills } from "../src/react-app/domains/settings/pages/catalog-skill-ownership";

describe("catalog plugin skill ownership", () => {
  const skills = [
    { name: "okf-coding", path: "/global/skills/jw-testplugin-a1/okf-b2/SKILL.md", scope: "global" as const, ownerPluginId: "testplugin", sourceKind: "plugin" as const },
    { name: "okf-coding", path: "/global/skills/okf-coding/SKILL.md", scope: "global" as const, sourceKind: "standalone" as const },
    { name: "jugglechat-busserver", path: "/global/skills/jugglechat-busserver/SKILL.md", scope: "global" as const },
  ];
  test("removes plugin-owned skills while preserving a standalone same-name skill at another path", () => {
    const result = filterStandaloneCatalogSkills(skills);
    expect(result.map((skill) => skill.path)).toEqual([
      "/global/skills/okf-coding/SKILL.md",
      "/global/skills/jugglechat-busserver/SKILL.md",
    ]);
  });

  test("excludes explicitly plugin-owned organization skills without hardcoded names", () => {
    const organizationSkill = { name: "organization-skill", path: "connect://skill", ownerPluginId: "connect-plugin-42" };
    expect(filterStandaloneCatalogSkills([organizationSkill])).toEqual([]);
  });

  test("does not infer ownership from names, path suffixes, or sourceKind alone", () => {
    const standalone = { name: "shared-name", path: "/global/skills/jw-old-org/shared-name/SKILL.md", sourceKind: "plugin" as const };
    expect(filterStandaloneCatalogSkills([standalone])).toEqual([standalone]);
  });
});

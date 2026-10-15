import type { SkillItem } from "./mcp-view";

/** Host-projected plugin skills remain discoverable by the runtime, but are not standalone catalog entries. */
export function filterStandaloneCatalogSkills(skills: SkillItem[]): SkillItem[] {
  return skills.filter((skill) => !skill.ownerPluginId);
}

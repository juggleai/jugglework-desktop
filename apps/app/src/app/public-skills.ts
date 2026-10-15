import skillCreatorTemplate from "./data/skill-creator.md?raw";

export type PublicSkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  content: string;
};

/** JuggleWork-owned skills that ship with the desktop app. */
export const PUBLIC_SKILL_CATALOG: readonly PublicSkillCatalogEntry[] = [
  {
    id: "skill-creator",
    name: "skill-creator",
    description: "Create or update a skill in the current Desktop workspace.",
    content: skillCreatorTemplate,
  },
];

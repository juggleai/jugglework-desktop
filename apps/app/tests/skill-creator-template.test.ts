import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const templatePath = join(import.meta.dir, "..", "src", "app", "data", "skill-creator.md");

describe("bundled skill creator template", () => {
  test("contains only workspace-local authoring guidance", async () => {
    const template = await readFile(templatePath, "utf8");

    expect(template).toContain("description: Create or update a skill only in the current Desktop workspace under .opencode/skills/.");
    expect(template).not.toContain("when the user asks for a reusable workflow or specialized instructions");
    expect(template).toContain(".opencode/skills/<skill-name>/SKILL.md");
    for (const required of [
      "User-provided valid details take precedence over generic defaults",
      "requested name, intended behavior, source or content, and workspace-local target",
      "Do not ask again for details the user already supplied",
      "preserve its body and content rather than regenerating it",
      "Never override a valid user-specified local target",
      "reject or clarify any target outside the current workspace",
      "Maintain one complete file",
      "re-read it and compare it with the intended complete source",
      "Never persist, publish, or save the authored Skill to Cloud or a server",
    ]) {
      expect(template).toContain(required);
    }
    expect(template).not.toContain("README.md");
    expect(template).not.toContain("templates/");
    expect(template).not.toContain("scripts/");
    for (const duplicatedCloudWorkflowTerm of [
      "Remote Cloud flow",
      "cloud.skill.create",
      "skill:create-skill",
      "plugin",
      "Marketplace",
      "JuggleWork Cloud",
      "server persistence",
    ]) {
      expect(template).not.toContain(duplicatedCloudWorkflowTerm);
    }
  });
});

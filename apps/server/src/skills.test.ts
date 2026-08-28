import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, listSkills } from "./skills.js";
import { exists } from "./utils.js";

let workspace: string;

async function writeSkill(dir: string, name: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nBody\n`, "utf8");
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "jugglework-skills-"));
  await mkdir(join(workspace, ".git"), { recursive: true });
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("deleteSkill", () => {
  test("deletes a flat skill", async () => {
    const dir = join(workspace, ".opencode", "skills", "flat-skill");
    await writeSkill(dir, "flat-skill");
    await deleteSkill(workspace, "flat-skill");
    expect(await exists(dir)).toBe(false);
  });

  test("deletes a plugin-namespaced (nested) skill", async () => {
    // Marketplace plugin bundles install skills under skills/<plugin>/<name>/
    const dir = join(workspace, ".opencode", "skills", "bio-research-plugin", "instrument-data-to-allotrope");
    await writeSkill(dir, "instrument-data-to-allotrope");

    const listed = await listSkills(workspace, false);
    expect(listed.map((s) => s.name)).toContain("instrument-data-to-allotrope");

    await deleteSkill(workspace, "instrument-data-to-allotrope");
    expect(await exists(dir)).toBe(false);
  });

  test("404s for unknown skills", async () => {
    await expect(deleteSkill(workspace, "does-not-exist")).rejects.toThrow("Skill not found");
  });
});

describe("deleteSkill with global scope", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jugglework-skills-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("deletes a skill from the global directory", async () => {
    const dir = join(home, ".config", "opencode", "skills", "global-skill");
    await writeSkill(dir, "global-skill");
    await deleteSkill(workspace, "global-skill", "global", { homeDir: home });
    expect(await exists(dir)).toBe(false);
  });

  test("resolves nested global layouts", async () => {
    const dir = join(home, ".claude", "skills", "domain", "nested-global");
    await writeSkill(dir, "nested-global");
    await deleteSkill(workspace, "nested-global", "global", { homeDir: home });
    expect(await exists(dir)).toBe(false);
  });

  // 两个作用域严格互不越界，否则全局技能页会误删工作区文件。
  test("global scope does not touch workspace skills", async () => {
    const projectDir = join(workspace, ".opencode", "skills", "only-project");
    await writeSkill(projectDir, "only-project");
    await expect(deleteSkill(workspace, "only-project", "global", { homeDir: home })).rejects.toThrow();
    expect(await exists(projectDir)).toBe(true);
  });

  test("project scope does not touch global skills", async () => {
    const globalDir = join(home, ".config", "opencode", "skills", "only-global");
    await writeSkill(globalDir, "only-global");
    await expect(deleteSkill(workspace, "only-global", "project", { homeDir: home })).rejects.toThrow();
    expect(await exists(globalDir)).toBe(true);
  });

  test("missing global skill reports not found", async () => {
    await expect(deleteSkill(workspace, "absent-skill", "global", { homeDir: home })).rejects.toThrow();
  });
});

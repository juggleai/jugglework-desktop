import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "./errors.js";
import { deleteSkill, listSkills, readSkillDetail } from "./skills.js";
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

  test("global-only listing is not shadowed by a same-name project skill", async () => {
    await writeSkill(join(workspace, ".opencode", "skills", "same-name"), "same-name");
    await writeSkill(join(home, ".config", "opencode", "skills", "same-name"), "same-name");

    const listed = await listSkills(workspace, true, { homeDir: home, scope: "global" });
    expect(listed.map((skill) => [skill.name, skill.scope])).toEqual([["same-name", "global"]]);
  });

  test("annotates exact plugin-owned paths and retains a standalone same-name skill", async () => {
    const pluginPath = join(home, ".config", "opencode", "skills", "plugin", "shared-name", "SKILL.md");
    const standalonePath = join(home, ".claude", "skills", "shared-name", "SKILL.md");
    await writeSkill(join(pluginPath, ".."), "shared-name");
    await writeSkill(join(standalonePath, ".."), "shared-name");

    const listed = await listSkills(workspace, true, {
      homeDir: home,
      scope: "global",
      ownerPluginIdForPath: (path) => path === pluginPath ? "test-plugin" : undefined,
    });

    expect(listed).toEqual([
      expect.objectContaining({ path: pluginPath, ownerPluginId: "test-plugin", sourceKind: "plugin" }),
      expect.objectContaining({ path: standalonePath, sourceKind: "standalone" }),
    ]);
  });

  test("classifies only an exactly marked global skill as public", async () => {
    const publicPath = join(home, ".config", "opencode", "skills", "skill-creator", "SKILL.md");
    const standalonePath = join(home, ".claude", "skills", "skill-creator", "SKILL.md");
    await writeSkill(join(publicPath, ".."), "skill-creator");
    await writeFile(join(publicPath, "..", ".jugglework-managed-skill.json"), JSON.stringify({
      schemaVersion: 1,
      owner: "jugglework-desktop:public-skill",
      digest: `sha256:${"a".repeat(64)}`,
    }), "utf8");
    await writeSkill(join(standalonePath, ".."), "skill-creator");

    const listed = await listSkills(workspace, true, { homeDir: home, scope: "global" });

    expect(listed).toEqual([
      expect.objectContaining({ path: publicPath, sourceKind: "public" }),
      expect.objectContaining({ path: standalonePath, sourceKind: "standalone" }),
    ]);
  });
});

describe("readSkillDetail", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jugglework-skill-detail-home-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("selects the exact global path and returns sorted regular files", async () => {
    const projectDir = join(workspace, ".opencode", "skills", "same-name");
    const globalDir = join(home, ".config", "opencode", "skills", "same-name");
    await writeSkill(projectDir, "same-name");
    await writeSkill(globalDir, "same-name");
    await mkdir(join(globalDir, "references", "nested"), { recursive: true });
    await writeFile(join(globalDir, "z.txt"), "zzz", "utf8");
    await writeFile(join(globalDir, ".jugglework-managed-skill.json"), "{}", "utf8");
    await writeFile(join(globalDir, "references", "a.txt"), "a", "utf8");
    await writeFile(join(globalDir, "references", "nested", "b.txt"), "bb", "utf8");
    await symlink(join(globalDir, "z.txt"), join(globalDir, "linked.txt"));

    const path = join(globalDir, "SKILL.md");
    const detail = await readSkillDetail(workspace, { scope: "global", path }, { homeDir: home });

    expect(detail.item).toMatchObject({ name: "same-name", path, scope: "global" });
    expect(detail.content).toContain("Test skill same-name");
    expect(detail.files).toEqual([
      { relPath: "SKILL.md", size: Buffer.byteLength(detail.content) },
      { relPath: "references/a.txt", size: 1 },
      { relPath: "references/nested/b.txt", size: 2 },
      { relPath: "z.txt", size: 3 },
    ]);
  });

  test.each([
    ["project", () => join(workspace, ".opencode", "skills", "same-name", "SKILL.md")],
    ["outside", () => join(home, "outside", "SKILL.md")],
    ["relative", () => "same-name/SKILL.md"],
    ["dot segment", () => `${join(home, ".config", "opencode", "skills")}/same-name/../same-name/SKILL.md`],
    ["NUL", () => `${join(home, ".config", "opencode", "skills", "same-name", "SKILL.md")}\0`],
    ["non-SKILL filename", () => join(home, ".config", "opencode", "skills", "same-name", "README.md")],
  ])("rejects an unsafe %s path", async (_label, pathForTest) => {
    await writeSkill(join(workspace, ".opencode", "skills", "same-name"), "same-name");
    await writeSkill(join(home, ".config", "opencode", "skills", "same-name"), "same-name");

    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: pathForTest() },
      { homeDir: home },
    )).rejects.toBeInstanceOf(ApiError);
  });

  test("rejects unsupported scope, unknown catalog paths, and symlink components", async () => {
    const globalRoot = join(home, ".config", "opencode", "skills");
    const realDir = join(globalRoot, "real-skill");
    await writeSkill(realDir, "real-skill");

    await expect(readSkillDetail(
      workspace,
      { scope: "project", path: join(realDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 400, code: "invalid_skill_scope" });

    const unknownDir = join(globalRoot, "unknown");
    await mkdir(unknownDir, { recursive: true });
    await writeFile(join(unknownDir, "SKILL.md"), "not a catalog skill", "utf8");
    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: join(unknownDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 404, code: "skill_not_found" });

    const linkedDir = join(globalRoot, "linked-skill");
    await symlink(realDir, linkedDir, "dir");
    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: join(linkedDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 400, code: "unsafe_skill_path" });

    await rm(join(realDir, "SKILL.md"));
    await symlink(join(unknownDir, "SKILL.md"), join(realDir, "SKILL.md"));
    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: join(realDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 400, code: "unsafe_skill_path" });
  });

  test("rejects SKILL.md content larger than five MiB", async () => {
    const globalDir = join(home, ".config", "opencode", "skills", "oversized");
    await writeSkill(globalDir, "oversized");
    await writeFile(join(globalDir, "SKILL.md"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));

    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: join(globalDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 413, code: "skill_too_large" });
  });

  test("rejects inventories larger than 800 regular files", async () => {
    const globalDir = join(home, ".config", "opencode", "skills", "too-many-files");
    await writeSkill(globalDir, "too-many-files");
    await mkdir(join(globalDir, "references"), { recursive: true });
    await Promise.all(Array.from({ length: 800 }, (_, index) =>
      writeFile(join(globalDir, "references", `${String(index).padStart(3, "0")}.txt`), "x")));

    await expect(readSkillDetail(
      workspace,
      { scope: "global", path: join(globalDir, "SKILL.md") },
      { homeDir: home },
    )).rejects.toMatchObject({ status: 413, code: "skill_file_limit_exceeded" });
  });
});

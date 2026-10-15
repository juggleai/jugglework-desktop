import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledJuggleChatSkills, installBundledSkillCollection } from "./bundled-jugglechat-skills.mjs";

test("bundled JuggleChat skills install as flat global OpenCode skills", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jugglechat-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "collection");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "jugglechat-im-sdk", "modules"), { recursive: true });
  await writeFile(path.join(source, "jugglechat-im-sdk", "SKILL.md"), "# IM skill\n", "utf8");

  const result = await installBundledJuggleChatSkills(source, destination);
  assert.deepEqual(result, {
    installed: ["jugglechat-im-sdk"],
    updated: [],
    unchanged: [],
    conflicts: [],
    skipped: false,
  });
  assert.equal(
    await readFile(path.join(destination, "jugglechat-im-sdk", "SKILL.md"), "utf8"),
    "# IM skill\n",
  );
});

test("bundled public skills install into the global OpenCode skill directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "skill-creator"), { recursive: true });
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Skill Creator\n", "utf8");

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result, {
    installed: ["skill-creator"],
    updated: [],
    unchanged: [],
    conflicts: [],
    skipped: false,
  });
  assert.equal(
    await readFile(path.join(destination, "skill-creator", "SKILL.md"), "utf8"),
    "# Skill Creator\n",
  );
  const marker = JSON.parse(await readFile(path.join(destination, "skill-creator", ".jugglework-managed-skill.json"), "utf8"));
  assert.equal(marker.owner, "jugglework-desktop:public-skill");
  assert.match(marker.digest, /^sha256:[a-f0-9]{64}$/);
});

test("managed bundled skills never overwrite an existing user-owned collision", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-collision-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "skill-creator"), { recursive: true });
  await mkdir(path.join(destination, "skill-creator"), { recursive: true });
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Bundled\n", "utf8");
  await writeFile(path.join(destination, "skill-creator", "SKILL.md"), "# User owned\n", "utf8");

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result.conflicts, ["skill-creator"]);
  assert.equal(await readFile(path.join(destination, "skill-creator", "SKILL.md"), "utf8"), "# User owned\n");
});

test("managed bundled skills update only an unmodified prior install", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  const sourceSkill = path.join(source, "skill-creator");
  const installedSkill = path.join(destination, "skill-creator");
  await mkdir(sourceSkill, { recursive: true });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "# Version one\n", "utf8");
  await writeFile(path.join(sourceSkill, "obsolete.md"), "old\n", "utf8");
  await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });
  await writeFile(path.join(sourceSkill, "SKILL.md"), "# Version two\n", "utf8");
  await rm(path.join(sourceSkill, "obsolete.md"));

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result.updated, ["skill-creator"]);
  assert.equal(await readFile(path.join(installedSkill, "SKILL.md"), "utf8"), "# Version two\n");
  await assert.rejects(stat(path.join(installedSkill, "obsolete.md")), { code: "ENOENT" });
});

test("managed bundled skills leave an unmodified install untouched", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-unchanged-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "skill-creator"), { recursive: true });
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Unchanged\n", "utf8");
  await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });
  const markerPath = path.join(destination, "skill-creator", ".jugglework-managed-skill.json");
  const before = await stat(markerPath);

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result.unchanged, ["skill-creator"]);
  assert.equal((await stat(markerPath)).mtimeMs, before.mtimeMs);
});

test("managed bundled skills preserve edits to a prior managed install", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-edited-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "skill-creator"), { recursive: true });
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Version one\n", "utf8");
  await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });
  await writeFile(path.join(destination, "skill-creator", "SKILL.md"), "# User edit\n", "utf8");
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Version two\n", "utf8");

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result.conflicts, ["skill-creator"]);
  assert.equal(await readFile(path.join(destination, "skill-creator", "SKILL.md"), "utf8"), "# User edit\n");
});

test("managed bundled skills reject a symlinked ownership marker", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-skills-marker-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "public-skills");
  const destination = path.join(root, "global-skills");
  const installedSkill = path.join(destination, "skill-creator");
  await mkdir(path.join(source, "skill-creator"), { recursive: true });
  await mkdir(installedSkill, { recursive: true });
  await writeFile(path.join(source, "skill-creator", "SKILL.md"), "# Bundled\n", "utf8");
  await writeFile(path.join(installedSkill, "SKILL.md"), "# User owned\n", "utf8");
  const externalMarker = path.join(root, "marker.json");
  await writeFile(externalMarker, JSON.stringify({
    schemaVersion: 1,
    owner: "jugglework-desktop:public-skill",
    digest: `sha256:${"a".repeat(64)}`,
  }), "utf8");
  await symlink(externalMarker, path.join(installedSkill, ".jugglework-managed-skill.json"));

  const result = await installBundledSkillCollection(source, destination, { ownershipMode: "managed" });

  assert.deepEqual(result.conflicts, ["skill-creator"]);
  assert.equal(await readFile(path.join(installedSkill, "SKILL.md"), "utf8"), "# User owned\n");
});

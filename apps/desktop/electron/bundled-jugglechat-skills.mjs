import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const BUNDLED_SKILL_MARKER_FILE = ".jugglework-managed-skill.json";
const BUNDLED_SKILL_MARKER_OWNER = "jugglework-desktop:public-skill";

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function pathType(target) {
  try {
    const metadata = await lstat(target);
    return metadata.isDirectory() ? "directory" : "other";
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
}

async function directoryDigest(root) {
  const hash = createHash("sha256");
  const visit = async (dir, relativeDir) => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!relativeDir && entry.name === BUNDLED_SKILL_MARKER_FILE) continue;
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const target = path.join(dir, entry.name);
      const metadata = await lstat(target);
      if (metadata.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        await visit(target, relativePath);
      } else if (metadata.isFile()) {
        const content = await readFile(target);
        hash.update(`file\0${relativePath}\0${content.byteLength}\0`);
        hash.update(content);
      } else {
        throw new Error(`Unsupported bundled skill entry: ${relativePath}`);
      }
    }
  };
  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}

async function readManagedDigest(skillDir) {
  try {
    const markerPath = path.join(skillDir, BUNDLED_SKILL_MARKER_FILE);
    const metadata = await lstat(markerPath);
    if (!metadata.isFile() || metadata.size > 4096) return null;
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    return marker
      && typeof marker === "object"
      && !Array.isArray(marker)
      && Object.keys(marker).length === 3
      && marker.schemaVersion === 1
      && marker?.owner === BUNDLED_SKILL_MARKER_OWNER
      && /^sha256:[a-f0-9]{64}$/.test(marker?.digest)
      ? marker.digest
      : null;
  } catch {
    return null;
  }
}

async function stageManagedSkill(source, globalSkillsDir, name, digest) {
  const staged = path.join(globalSkillsDir, `.${name}.jugglework-install-${randomUUID()}`);
  await cp(source, staged, { recursive: true, force: false, errorOnExist: true });
  await writeFile(path.join(staged, BUNDLED_SKILL_MARKER_FILE), `${JSON.stringify({
    schemaVersion: 1,
    owner: BUNDLED_SKILL_MARKER_OWNER,
    digest,
  }, null, 2)}\n`, "utf8");
  return staged;
}

async function replaceManagedSkill(source, destination, globalSkillsDir, name, digest) {
  const staged = await stageManagedSkill(source, globalSkillsDir, name, digest);
  const backup = path.join(globalSkillsDir, `.${name}.jugglework-backup-${randomUUID()}`);
  const destinationExists = await pathType(destination) !== "absent";
  try {
    if (destinationExists) await rename(destination, backup);
    try {
      await rename(staged, destination);
    } catch (error) {
      if (destinationExists) await rename(backup, destination);
      throw error;
    }
    if (destinationExists) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    throw error;
  }
}

export async function installBundledSkillCollection(sourceCollectionDir, globalSkillsDir, options = {}) {
  const ownershipMode = options.ownershipMode ?? "force";
  if (ownershipMode !== "force" && ownershipMode !== "managed") {
    throw new Error(`Unsupported bundled skill ownership mode: ${ownershipMode}`);
  }
  if (!(await isDirectory(sourceCollectionDir))) {
    return { installed: [], updated: [], unchanged: [], conflicts: [], skipped: true };
  }

  await mkdir(globalSkillsDir, { recursive: true });
  const entries = await readdir(sourceCollectionDir, { withFileTypes: true });
  const installed = [];
  const updated = [];
  const unchanged = [];
  const conflicts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceCollectionDir, entry.name);
    try {
      await stat(path.join(source, "SKILL.md"));
    } catch {
      continue;
    }
    const destination = path.join(globalSkillsDir, entry.name);
    if (ownershipMode === "force") {
      await cp(source, destination, { recursive: true, force: true });
      installed.push(entry.name);
      continue;
    }

    const sourceDigest = await directoryDigest(source);
    const destinationType = await pathType(destination);
    if (destinationType === "absent") {
      await replaceManagedSkill(source, destination, globalSkillsDir, entry.name, sourceDigest);
      installed.push(entry.name);
      continue;
    }
    if (destinationType !== "directory") {
      conflicts.push(entry.name);
      continue;
    }

    const managedDigest = await readManagedDigest(destination);
    let destinationDigest = null;
    if (managedDigest) {
      destinationDigest = await directoryDigest(destination).catch(() => null);
    }
    if (!managedDigest || destinationDigest !== managedDigest) {
      conflicts.push(entry.name);
      continue;
    }
    if (managedDigest === sourceDigest) {
      unchanged.push(entry.name);
      continue;
    }

    await replaceManagedSkill(source, destination, globalSkillsDir, entry.name, sourceDigest);
    updated.push(entry.name);
  }
  return { installed, updated, unchanged, conflicts, skipped: false };
}

// Backward-compatible name retained for callers and tests that predate the
// JuggleWork-owned public skill collection.
export const installBundledJuggleChatSkills = installBundledSkillCollection;

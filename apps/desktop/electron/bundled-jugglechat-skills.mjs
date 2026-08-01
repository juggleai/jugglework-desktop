import { cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function installBundledJuggleChatSkills(sourceCollectionDir, globalSkillsDir) {
  if (!(await isDirectory(sourceCollectionDir))) {
    return { installed: [], skipped: true };
  }

  await mkdir(globalSkillsDir, { recursive: true });
  const entries = await readdir(sourceCollectionDir, { withFileTypes: true });
  const installed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = path.join(sourceCollectionDir, entry.name);
    try {
      await stat(path.join(source, "SKILL.md"));
    } catch {
      continue;
    }
    await cp(source, path.join(globalSkillsDir, entry.name), { recursive: true, force: true });
    installed.push(entry.name);
  }
  return { installed, skipped: false };
}

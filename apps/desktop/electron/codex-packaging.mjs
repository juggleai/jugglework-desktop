import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export function codexTargetTriple(platform, arch) {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

export function codexTargetFromManifest(manifest, platform, arch) {
  const triple = codexTargetTriple(platform, arch);
  const target = triple ? manifest?.targets?.[triple] : null;
  if (!triple || !target) throw new Error(`Unsupported Codex package target: ${platform}/${arch}`);
  return Object.freeze({ triple, ...target });
}

export async function verifyCodexArchive(manifest, platform, arch, archivePath) {
  const target = codexTargetFromManifest(manifest, platform, arch);
  const bytes = await readFile(path.resolve(archivePath));
  const size = (await stat(path.resolve(archivePath))).size;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (size !== target.archiveBytes || sha256 !== target.archiveSha256) throw new Error("Codex archive verification failed.");
  return Object.freeze({ ...target, size, sha256 });
}

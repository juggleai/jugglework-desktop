import { lstat, mkdir, readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const DEFAULT_CLAUDE_TRANSCRIPT_RETENTION_DAYS = 30;

export type ClaudeProfileDataPaths = {
  rootDir: string;
  configDir: string;
  transcriptDir: string;
};

export type ClaudeProfileDiagnostics = {
  configured: true;
  configDirectoryExists: boolean;
  transcriptDirectoryExists: boolean;
  transcriptFileCount: number;
  transcriptBytes: number;
  oldestTranscriptAt: string | null;
  newestTranscriptAt: string | null;
};

export function claudeProfileDataPaths(rootDir: string): ClaudeProfileDataPaths {
  if (!rootDir.trim() || !isAbsolute(rootDir)) {
    throw new Error("Claude profile data directory must be an absolute path");
  }
  const configDir = join(rootDir, "config");
  return { rootDir, configDir, transcriptDir: join(configDir, "projects") };
}

export async function prepareClaudeProfileData(paths: ClaudeProfileDataPaths): Promise<void> {
  await mkdir(paths.configDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.transcriptDir, { recursive: true, mode: 0o700 });
}

async function transcriptFiles(root: string): Promise<Array<{ path: string; size: number; modifiedAt: number }>> {
  const files: Array<{ path: string; size: number; modifiedAt: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const details = await stat(path);
        files.push({ path, size: details.size, modifiedAt: details.mtimeMs });
      }
    }
  };
  await visit(root);
  return files;
}

export async function cleanupClaudeTranscripts(input: {
  paths: ClaudeProfileDataPaths;
  retentionDays?: number;
  now?: number;
}): Promise<{ removedFiles: number; removedBytes: number }> {
  const retentionDays = input.retentionDays ?? DEFAULT_CLAUDE_TRANSCRIPT_RETENTION_DAYS;
  if (!Number.isFinite(retentionDays) || retentionDays < 1 || retentionDays > 3_650) {
    throw new Error("Claude transcript retention must be between 1 and 3650 days");
  }
  const cutoff = (input.now ?? Date.now()) - retentionDays * 24 * 60 * 60 * 1_000;
  let removedFiles = 0;
  let removedBytes = 0;
  for (const file of await transcriptFiles(input.paths.transcriptDir)) {
    if (file.modifiedAt >= cutoff) continue;
    const details = await lstat(file.path);
    if (!details.isFile() || details.isSymbolicLink()) continue;
    await rm(file.path, { force: true });
    removedFiles += 1;
    removedBytes += file.size;
  }
  return { removedFiles, removedBytes };
}

export async function inspectClaudeProfileData(paths: ClaudeProfileDataPaths): Promise<ClaudeProfileDiagnostics> {
  const files = await transcriptFiles(paths.transcriptDir);
  const modified = files.map((file) => file.modifiedAt).sort((left, right) => left - right);
  const exists = async (path: string) => stat(path).then((value) => value.isDirectory(), () => false);
  return {
    configured: true,
    configDirectoryExists: await exists(paths.configDir),
    transcriptDirectoryExists: await exists(paths.transcriptDir),
    transcriptFileCount: files.length,
    transcriptBytes: files.reduce((total, file) => total + file.size, 0),
    oldestTranscriptAt: modified[0] === undefined ? null : new Date(modified[0]).toISOString(),
    newestTranscriptAt: modified.at(-1) === undefined ? null : new Date(modified.at(-1)!).toISOString(),
  };
}

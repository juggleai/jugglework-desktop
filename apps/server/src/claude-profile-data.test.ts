import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  claudeProfileDataPaths,
  cleanupClaudeTranscripts,
  inspectClaudeProfileData,
  prepareClaudeProfileData,
} from "./claude-profile-data.js";

describe("Claude profile data", () => {
  test("reports metadata without reading content and removes expired transcripts", async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-claude-profile-"));
    const paths = claudeProfileDataPaths(join(root, "profile-a", "claude-agent"));
    const canary = "RAW_TRANSCRIPT_CONTENT_MUST_NOT_REACH_DIAGNOSTICS";
    try {
      await prepareClaudeProfileData(paths);
      const oldPath = join(paths.transcriptDir, "old.jsonl");
      const recentPath = join(paths.transcriptDir, "nested", "recent.jsonl");
      await mkdir(join(paths.transcriptDir, "nested"), { recursive: true });
      await writeFile(oldPath, canary);
      await writeFile(recentPath, `${canary}-recent`);
      await writeFile(join(paths.transcriptDir, "ignored.txt"), canary);
      const now = Date.UTC(2026, 7, 13);
      await utimes(oldPath, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));
      await utimes(recentPath, new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));

      const diagnostics = await inspectClaudeProfileData(paths);
      expect(diagnostics.transcriptFileCount).toBe(2);
      expect(JSON.stringify(diagnostics)).not.toContain(canary);
      expect(await cleanupClaudeTranscripts({ paths, retentionDays: 30, now })).toEqual({
        removedFiles: 1,
        removedBytes: Buffer.byteLength(canary),
      });
      await expect(readFile(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(recentPath, "utf8")).toContain(canary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires an absolute profile root", () => {
    expect(() => claudeProfileDataPaths("relative/profile")).toThrow("absolute path");
  });
});

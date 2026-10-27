import path from "node:path";
import { execFile } from "node:child_process";
import type { ReviewDetail, ReviewFile } from "@jugglework/types/reviews";
import type { WorkspaceInfo } from "../types.js";

export type ReviewRepositoryContext = {
  matched: boolean;
  partial: boolean;
  note: string;
  guidance: Array<{ path: string; content: string }>;
  files: Array<{ path: string; content: string }>;
};

const empty = (note: string): ReviewRepositoryContext => ({ matched: false, partial: true, note, guidance: [], files: [] });

function safeRepositoryPath(value: string): string | null {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../") || normalized.includes("\0")) return null;
  return normalized;
}

function remoteIdentity(value: string): string | null {
  const trimmed = value.trim().replace(/\.git$/i, "");
  const scp = trimmed.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scp) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(trimmed);
    return `${url.hostname}/${url.pathname.replace(/^\/+/, "")}`.toLowerCase();
  } catch {
    return null;
  }
}

async function git(root: string, args: string[], timeoutMs = 5_000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 64_000,
      killSignal: "SIGKILL",
      windowsHide: true,
      shell: false,
    }, (error, stdout) => resolve({ ok: !error, stdout: error ? "" : stdout }));
    child.stdin?.end();
  });
}

async function showBounded(root: string, revision: string, file: string, limit: number): Promise<string | null> {
  const object = `${revision}:${file}`;
  const size = await git(root, ["cat-file", "-s", object]);
  if (!size.ok || !/^\d+\s*$/.test(size.stdout) || Number(size.stdout.trim()) > limit) return null;
  const shown = await git(root, ["show", object]);
  if (!shown.ok || shown.stdout.includes("\0")) return null;
  return shown.stdout;
}

function guidancePaths(files: string[]): string[] {
  const result = new Set(["AGENTS.md"]);
  for (const file of files) {
    const parts = file.split("/").slice(0, -1);
    for (let index = 1; index <= parts.length; index++) result.add(`${parts.slice(0, index).join("/")}/AGENTS.md`);
  }
  return [...result];
}

/** Read bounded, exact-revision context only when this local workspace is the PR repository. */
export async function loadReviewRepositoryContext(input: {
  workspace: WorkspaceInfo;
  review: ReviewDetail["item"];
  changedFiles: ReviewFile[];
}): Promise<ReviewRepositoryContext> {
  try {
    return await load(input);
  } catch {
    return empty("Local repository context could not be read safely; reviewed connector patches only.");
  }
}

async function load(input: {
  workspace: WorkspaceInfo;
  review: ReviewDetail["item"];
  changedFiles: ReviewFile[];
}): Promise<ReviewRepositoryContext> {
  const root = input.workspace.directory?.trim() || input.workspace.path?.trim();
  if (input.workspace.workspaceType !== "local" || !root) return empty("Local repository context is unavailable; reviewed connector patches only.");
  if (!/^[a-f0-9]{40,64}$/i.test(input.review.headRevision)) return empty("The pull request revision is not a verifiable Git commit; reviewed connector patches only.");
  const remote = await git(root, ["remote", "get-url", "--all", "origin"]);
  const expected = `${input.review.hostname}/${input.review.repository.fullName}`.toLowerCase();
  if (!remote.ok || !remote.stdout.split(/\r?\n/).some((value) => remoteIdentity(value) === expected)) {
    return empty("The current workspace Git remote does not match this pull request; reviewed connector patches only.");
  }
  const revision = await git(root, ["cat-file", "-e", `${input.review.headRevision}^{commit}`]);
  if (!revision.ok) return empty("The selected pull request revision is not present in this workspace; reviewed connector patches only.");

  const changedPaths = input.changedFiles.flatMap((file) => {
    const safe = safeRepositoryPath(file.path);
    return safe ? [safe] : [];
  });
  const guidance: ReviewRepositoryContext["guidance"] = [];
  let guidanceBytes = 0;
  for (const file of guidancePaths(changedPaths)) {
    const content = await showBounded(root, input.review.headRevision, file, 32_000);
    if (content === null || guidanceBytes + content.length > 64_000) continue;
    guidance.push({ path: file, content });
    guidanceBytes += content.length;
  }
  const files: ReviewRepositoryContext["files"] = [];
  let fileBytes = 0;
  let partial = changedPaths.length !== input.changedFiles.length;
  for (const file of changedPaths) {
    if (fileBytes >= 200_000) { partial = true; break; }
    const content = await showBounded(root, input.review.headRevision, file, 50_000);
    if (content === null || fileBytes + content.length > 200_000) { partial = true; continue; }
    files.push({ path: file, content });
    fileBytes += content.length;
  }
  if (files.length < changedPaths.length) partial = true;
  return {
    matched: true,
    partial,
    note: partial
      ? "Loaded bounded context from the matching local repository at the exact PR revision; some files were omitted by size or binary limits."
      : "Loaded changed files and applicable AGENTS.md guidance from the matching local repository at the exact PR revision.",
    guidance,
    files,
  };
}

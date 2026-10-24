import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewDetail, ReviewFile } from "@jugglework/types/reviews";
import type { WorkspaceInfo } from "../types.js";
import { loadReviewRepositoryContext } from "./repository-context.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(root: string, ...args: string[]) {
  const process = Bun.spawn(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  if (await process.exited) throw new Error(await new Response(process.stderr).text());
  return (await new Response(process.stdout).text()).trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "jw-review-repo-")); roots.push(root);
  await git(root, "init");
  await git(root, "config", "user.email", "review@example.com");
  await git(root, "config", "user.name", "Review Test");
  await git(root, "remote", "add", "origin", "git@github.com:team/repo.git");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "AGENTS.md"), "Root rules\n");
  await writeFile(join(root, "src", "AGENTS.md"), "Source rules\n");
  await writeFile(join(root, "src", "a.ts"), "export const value = 1;\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  return { root, revision: await git(root, "rev-parse", "HEAD") };
}

function review(revision: string, repository = "team/repo"): ReviewDetail["item"] {
  return { id: "review", title: "Review", body: "", url: "https://github.com/team/repo/pull/1", hostname: "github.com", repository: { fullName: repository }, number: 1, state: "open", headRevision: revision, baseBranch: "main", headBranch: "feature" } as ReviewDetail["item"];
}
const changedFiles = [{ id: "1", path: "src/a.ts", additions: 1, deletions: 0, changes: 1, status: "modified", patch: [], patchTruncated: false, binary: false }] as ReviewFile[];

describe("review repository context", () => {
  test("loads exact-revision files and applicable AGENTS.md from a matching local remote", async () => {
    const fixture = await repository();
    const context = await loadReviewRepositoryContext({ workspace: { id: "ws", name: "Repo", path: fixture.root, preset: "default", workspaceType: "local" } as WorkspaceInfo, review: review(fixture.revision), changedFiles });
    expect(context).toMatchObject({ matched: true, partial: false });
    expect(context.guidance.map((item) => item.path)).toEqual(["AGENTS.md", "src/AGENTS.md"]);
    expect(context.files).toEqual([{ path: "src/a.ts", content: "export const value = 1;\n" }]);
  });

  test("does not read files from a mismatched repository or missing revision", async () => {
    const fixture = await repository();
    const workspace = { id: "ws", name: "Repo", path: fixture.root, preset: "default", workspaceType: "local" } as WorkspaceInfo;
    const mismatch = await loadReviewRepositoryContext({ workspace, review: review(fixture.revision, "other/repo"), changedFiles });
    expect(mismatch).toMatchObject({ matched: false, partial: true, files: [], guidance: [] });
    const missing = await loadReviewRepositoryContext({ workspace, review: review("f".repeat(40)), changedFiles });
    expect(missing).toMatchObject({ matched: false, partial: true, files: [], guidance: [] });
  });
});

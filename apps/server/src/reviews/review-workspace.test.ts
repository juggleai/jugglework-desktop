import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { ServerConfig } from "../types.js";
import { prepareCodeReviewWorkspace } from "./review-workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function config(): ServerConfig {
  return {
    host: "127.0.0.1", port: 0, token: "token", hostToken: "host", approval: { mode: "auto", timeoutMs: 1_000 },
    authorizedRoots: [], workspaces: [], readOnly: false, corsOrigins: [],
  } as unknown as ServerConfig;
}

test("code review workspaces use a date folder, are hidden, and avoid collisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-review-"));
  roots.push(root);
  const input = {
    config: config(),
    review: { id: "github:juggleai/jugglework-desktop:17", repository: { fullName: "juggleai/jugglework-desktop" }, number: 17, title: "Review: unsafe / title" },
    previous: null,
    now: new Date(2026, 9, 26, 12),
    root,
  };
  const first = await prepareCodeReviewWorkspace(input);
  const second = await prepareCodeReviewWorkspace(input);

  expect(first.hidden).toBe(true);
  expect(first.path).toContain(join("2026-10-26", "jugglework-desktop-pr-17-Review-unsafe-title"));
  expect(second.path).toBe(`${first.path}-2`);
  expect(JSON.parse(await readFile(join(first.path, ".jugglework", "review.json"), "utf8"))).toMatchObject({
    schemaVersion: 1,
    provider: "github",
    reviewId: "github:juggleai/jugglework-desktop:17",
    repository: "juggleai/jugglework-desktop",
    pullRequestNumber: 17,
  });
});

test("an existing hidden review workspace is reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-review-"));
  roots.push(root);
  const serverConfig = config();
  const first = await prepareCodeReviewWorkspace({
    config: serverConfig,
    review: { id: "github:org/repo:4", repository: { fullName: "org/repo" }, number: 4, title: "Fix" },
    previous: null,
    root,
  });
  serverConfig.workspaces.push(first);
  const reused = await prepareCodeReviewWorkspace({
    config: serverConfig,
    review: { id: "github:org/repo:4", repository: { fullName: "org/repo" }, number: 4, title: "Fix" },
    previous: { id: crypto.randomUUID(), reviewId: "4", headRevision: "a".repeat(40), status: "completed", createdAt: new Date().toISOString(), partial: false, workspaceId: first.id },
    root,
  });
  expect(reused.id).toBe(first.id);
  expect(reused.path).toBe(first.path);
});

test("a saved workspace reference is not reused for a different pull request", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-review-"));
  roots.push(root);
  const serverConfig = config();
  const first = await prepareCodeReviewWorkspace({
    config: serverConfig,
    review: { id: "github:org/repo:4", repository: { fullName: "org/repo" }, number: 4, title: "Fix" },
    previous: null,
    root,
  });
  serverConfig.workspaces.push(first);
  const other = await prepareCodeReviewWorkspace({
    config: serverConfig,
    review: { id: "github:org/repo:5", repository: { fullName: "org/repo" }, number: 5, title: "Other" },
    previous: { id: crypto.randomUUID(), reviewId: "github:org/repo:5", headRevision: "b".repeat(40), status: "completed", createdAt: new Date().toISOString(), partial: false, workspaceId: first.id },
    root,
  });
  expect(other.id).not.toBe(first.id);
  expect(other.path).not.toBe(first.path);
});

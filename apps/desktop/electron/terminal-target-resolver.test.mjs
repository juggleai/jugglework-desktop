import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTerminalTargetResolver } from "./terminal-target-resolver.mjs";
test("trusted directory, realpath aliases, remote veto and invalid/mismatched targets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "terminal-test-"));
  try {
    const directory = path.join(root, "目录 ' spaced"); await mkdir(directory);
    const alias = path.join(root, "alias"); await symlink(directory, alias);
    let local = { id: "w", path: directory, workspaceType: "local" };
    let workspace = { ...local }; let session = { id: "s", directory: alias };
    const resolve = createTerminalTargetResolver({ workspaceStore: { readWorkspaceState: async () => ({ workspaces: [local] }) }, client: { getJson: async (url) => url === "/workspaces" ? { items: [workspace] } : { item: session } } });
    const target = { workspaceId: "w", sessionId: "s", cwd: "/untrusted" };
    assert.equal((await resolve(target)).initialCwd, await realpath(directory));
    local.workspaceType = "remote"; await assert.rejects(resolve(target), /REMOTE/); local.workspaceType = "local";
    workspace.workspaceType = "remote"; await assert.rejects(resolve(target), /REMOTE/); workspace.workspaceType = "local";
    session.directory = path.join(root, "missing"); await assert.rejects(resolve(target), /CWD_NOT_FOUND/);
    session.directory = path.join(root, "file"); await writeFile(session.directory, "x"); await assert.rejects(resolve(target), /CWD_NOT_DIRECTORY/);
    session.directory = root; await assert.rejects(resolve(target), /MISMATCH/);
    session.id = "other"; await assert.rejects(resolve(target), /SESSION_NOT_FOUND/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

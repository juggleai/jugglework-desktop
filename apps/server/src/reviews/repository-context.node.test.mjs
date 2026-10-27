import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { loadReviewRepositoryContext } from "./repository-context.ts";

const execute = promisify(execFile);
const review = (revision) => ({ hostname: "github.com", repository: { fullName: "team/repo" }, headRevision: revision });
const workspace = (root) => ({ workspaceType: "local", path: root });

// Run explicitly with Node to catch regressions hidden by Bun's global APIs.
if (!process.versions.bun) {
  test("Node loads bounded exact-revision context with literal Git arguments", async () => {
    assert.equal(typeof globalThis.Bun, "undefined");
    const root = await mkdtemp(join(tmpdir(), "review node ; literal-"));
    const git = async (...args) => (await execute("git", ["-C", root, ...args])).stdout.trim();
    const file = "src/a ; $(not-a-command).ts";
    try {
      await git("init");
      await git("config", "user.email", "review@example.com");
      await git("config", "user.name", "Review Test");
      await git("remote", "add", "origin", "git@github.com:team/repo.git");
      await mkdir(join(root, "src"));
      await writeFile(join(root, "AGENTS.md"), "Root rules\n");
      await writeFile(join(root, "src/AGENTS.md"), "Source rules\n");
      await writeFile(join(root, file), "committed content\n");
      await writeFile(join(root, "large.txt"), "x".repeat(50_001));
      await writeFile(join(root, "binary.dat"), "binary\0content");
      await git("add", ".");
      await git("-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
      const revision = await git("rev-parse", "HEAD");
      await writeFile(join(root, file), "uncommitted, must not be read\n");
      const context = await loadReviewRepositoryContext({ workspace: workspace(root), review: review(revision), changedFiles: [{ path: file }, { path: "large.txt" }, { path: "binary.dat" }] });
      assert.equal(context.matched, true);
      assert.equal(context.partial, true);
      assert.deepEqual(context.files, [{ path: file, content: "committed content\n" }]);
      assert.deepEqual(context.guidance.map(({ path }) => path), ["AGENTS.md", "src/AGENTS.md"]);
      const missing = await loadReviewRepositoryContext({ workspace: workspace(root), review: review("f".repeat(40)), changedFiles: [] });
      assert.equal(missing.matched, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("Node bounds Git output and timeout, reaps the child, and handles spawn failures", { timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "review-node-git-"));
    const originalPath = process.env.PATH;
    const load = () => loadReviewRepositoryContext({ workspace: workspace(root), review: review("a".repeat(40)), changedFiles: [] });
    try {
      process.env.PATH = root;
      assert.equal((await load()).matched, false); // ENOENT
      const executable = join(root, "git");
      const script = async (body) => writeFile(executable, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
      await script("process.exit(1)");
      assert.equal((await load()).matched, false);
      for (const stream of ["stdout", "stderr"]) {
        await script(`process.${stream}.write('x'.repeat(100_000)); setInterval(() => {}, 1000);`);
        const started = Date.now();
        assert.equal((await load()).matched, false);
        assert.ok(Date.now() - started < 3_000, `${stream} limit should terminate the child before the timeout`);
      }
      const pidPath = join(root, "pid");
      await script(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
      const started = Date.now();
      assert.equal((await load()).matched, false);
      assert.ok(Date.now() - started < 8_000, "timeout must kill even a SIGTERM-resistant child");
      const pid = Number(await readFile(pidPath, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(root, { recursive: true, force: true });
    }
  });
}

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { claudeRuntimeEnvironment, resolveClaudeRuntimeAssets } from "./claude-runtime-assets.mjs";

test("resolves explicit target Claude assets outside app.asar", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-claude-assets-"));
  try {
    const assets = path.join(root, "claude-agent");
    await mkdir(path.join(assets, "worker", "dist"), { recursive: true });
    await mkdir(path.join(assets, "node", "bin"), { recursive: true });
    await mkdir(path.join(assets, "claude"), { recursive: true });
    await writeFile(path.join(assets, "worker", "dist", "cli.js"), "export {}\n");
    await writeFile(path.join(assets, "node", "bin", "node"), "#!/bin/sh\n");
    await writeFile(path.join(assets, "claude", "claude"), "#!/bin/sh\n");
    await chmod(path.join(assets, "node", "bin", "node"), 0o755);
    await chmod(path.join(assets, "claude", "claude"), 0o755);
    await writeFile(path.join(assets, "manifest.json"), JSON.stringify({
      target: "aarch64-apple-darwin",
      sdkVersion: "0.3.226",
      nodeVersion: "24.19.0",
      paths: { worker: "worker/dist/cli.js", node: "node/bin/node", claude: "claude/claude" },
    }));
    const resolved = await resolveClaudeRuntimeAssets({ resourcesPath: root, platform: "darwin", arch: "arm64" });
    assert.equal(resolved.root.includes("app.asar"), false);
    assert.deepEqual(claudeRuntimeEnvironment(resolved), {
      JUGGLEWORK_CLAUDE_AGENT_WORKER_PATH: path.join(assets, "worker", "dist", "cli.js"),
      JUGGLEWORK_CLAUDE_AGENT_NODE_PATH: path.join(assets, "node", "bin", "node"),
      JUGGLEWORK_CLAUDE_EXECUTABLE_PATH: path.join(assets, "claude", "claude"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails closed for a missing or wrong-architecture package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-claude-assets-missing-"));
  try {
    await assert.rejects(resolveClaudeRuntimeAssets({ resourcesPath: root, platform: "linux", arch: "x64" }), /manifest is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

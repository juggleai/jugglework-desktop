import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packageVersion = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;
const binary = process.platform === "win32"
  ? "package/dist/bin/jugglework-server.exe"
  : "package/dist/bin/jugglework-server";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  return result.stdout;
}

function runFailure(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
    shell: process.platform === "win32",
  });
  assert.notEqual(result.status, 0, `${command} ${args.join(" ")} should fail`);
  return `${result.stdout}${result.stderr}`;
}

function npmFiles(output) {
  const manifest = JSON.parse(output);
  assert.equal(manifest.length, 1, "npm pack should describe one package");
  return manifest[0].files.map(({ path }) => `package/${path}`);
}

function pnpmFiles(output) {
  const manifest = JSON.parse(output);
  const files = Array.isArray(manifest) ? manifest[0].files : manifest.files;
  return files.map(({ path }) => path.startsWith("package/") ? path : `package/${path}`);
}

function assertPackageContents(files, packer) {
  const included = new Set(files);
  for (const path of [
    "package/dist/index.js",
    "package/dist/index.d.ts",
    "package/bin/jugglework-server.mjs",
    "package/claude-agent-worker/dist/cli.js",
    "package/claude-agent-worker/sdk-package.json",
    binary,
  ]) {
    assert.ok(included.has(path), `${packer} package is missing ${path}`);
  }

  const tests = files.filter((path) => /(?:^|\/)[^/]*(?:\.e2e)?\.test\.[^/]+$/.test(path));
  assert.deepEqual(tests, [], `${packer} package contains tests: ${tests.join(", ")}`);
}

test("npm and pnpm package the production server", { timeout: 120_000 }, () => {
  run(pnpm, ["build"]);
  run(pnpm, ["prepare:claude-worker"]);
  run(pnpm, ["build:bin"]);
  assert.equal(run(process.execPath, ["bin/jugglework-server.mjs", "--version"]).trim(), packageVersion);
  assert.match(
    runFailure(process.execPath, ["bin/jugglework-server.mjs", "--version"], {
      JUGGLEWORK_CLAUDE_AGENT_ENABLED: "1",
      JUGGLEWORK_CLAUDE_ROLLOUT_STAGE: "ga",
      JUGGLEWORK_CLAUDE_AGENT_NODE_PATH: "",
      JUGGLEWORK_CLAUDE_EXECUTABLE_PATH: "",
    }),
    /requires JUGGLEWORK_CLAUDE_AGENT_NODE_PATH/,
  );

  assertPackageContents(npmFiles(run(npm, ["pack", "--dry-run", "--json"])), "npm");
  assertPackageContents(pnpmFiles(run(pnpm, ["pack", "--dry-run", "--json"])), "pnpm");
});

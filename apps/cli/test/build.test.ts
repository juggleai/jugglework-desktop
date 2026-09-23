import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanBinaryOutputs,
  outputName,
  REQUIRED_PLUGIN_FILES as BUILD_PLUGIN_FILES,
  stageDistribution,
  stagePluginAssets,
  refreshDistributionManifest,
} from "../script/build.js";
import { REQUIRED_PLUGIN_FILES as RUNTIME_PLUGIN_FILES } from "../src/runtime.js";
import {
  DISTRIBUTION_TARGETS,
  OPENCODE_DISTRIBUTION,
  parseDistributionManifest,
  sha256File,
  verifyDistribution,
} from "../src/distribution.js";
import packageJson from "../package.json" with { type: "json" };
import { CLI_VERSION } from "../src/version.js";

test("CLI version is sourced from package metadata", () => {
  assert.equal(CLI_VERSION, packageJson.version);
});

test("build and runtime require the same eight plugin assets", () => {
  assert.equal(BUILD_PLUGIN_FILES.length, 8);
  assert.deepEqual(BUILD_PLUGIN_FILES, RUNTIME_PLUGIN_FILES);
});

test("committed OpenCode descriptor pins v1.18.15 assets and digests for all six targets", () => {
  assert.equal(OPENCODE_DISTRIBUTION.version, "1.18.15");
  assert.deepEqual(Object.keys(OPENCODE_DISTRIBUTION.targets).sort(), [...DISTRIBUTION_TARGETS].sort());
  for (const target of DISTRIBUTION_TARGETS) {
    assert.match(OPENCODE_DISTRIBUTION.targets[target].sha256, /^[a-f0-9]{64}$/);
    assert.match(OPENCODE_DISTRIBUTION.targets[target].archive, /^opencode-/);
  }
});

test("staging copies only required plugin assets beside native binaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-build-"));
  const source = join(root, "server-plugins");
  const binaryDir = join(root, "dist", "bin");
  try {
    await mkdir(source, { recursive: true });
    for (const filename of BUILD_PLUGIN_FILES) {
      await writeFile(join(source, filename), "export default {}\n");
    }
    await writeFile(join(source, ".env"), "TOKEN=must-not-be-packaged\n");
    await writeFile(join(source, "credentials.json"), "{}\n");
    const destination = stagePluginAssets(source, binaryDir);
    assert.equal(destination, join(binaryDir, "opencode-plugins"));
    assert.deepEqual((await readdir(destination)).sort(), [...BUILD_PLUGIN_FILES].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("staging fails when any required plugin asset is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-build-missing-"));
  const source = join(root, "server-plugins");
  try {
    await mkdir(source);
    for (const filename of BUILD_PLUGIN_FILES.slice(1)) {
      await writeFile(join(source, filename), "export default {}\n");
    }
    assert.throws(
      () => stagePluginAssets(source, join(root, "bin")),
      /Missing or invalid required plugin asset:.*jugglework-extensions-preview\.js/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distribution staging writes a checksummed manifest using small local fixtures", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-distribution-"));
  const plugins = join(root, "source-plugins");
  const cli = join(root, "fixture-jugglework");
  const opencode = join(root, "fixture-opencode");
  const distribution = join(root, "release");
  try {
    await mkdir(plugins);
    for (const filename of BUILD_PLUGIN_FILES) await writeFile(join(plugins, filename), `// ${filename}\n`);
    await writeFile(cli, "fixture cli\n", { mode: 0o700 });
    await writeFile(opencode, "fixture opencode\n", { mode: 0o700 });
    if (process.platform !== "win32") {
      await chmod(cli, 0o700);
      await chmod(opencode, 0o700);
    }
    const manifest = stageDistribution({
      target: "bun-darwin-arm64",
      root: distribution,
      cliBinary: cli,
      opencodeBinary: opencode,
      pluginSource: plugins,
    });
    const stored = parseDistributionManifest(JSON.parse(await readFile(join(distribution, "manifest.json"), "utf8")));
    assert.deepEqual(stored, manifest);
    for (const file of [stored.cli.file, stored.opencode.file, ...stored.plugins.files, ...stored.notices]) {
      assert.equal(await sha256File(join(distribution, file.path)), file.sha256);
    }
    if (process.platform !== "win32") {
      assert.notEqual((await stat(join(distribution, stored.opencode.file.path))).mode & 0o111, 0);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("distribution verification detects mutation and accepts refreshed post-signing checksums", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-refresh-"));
  const plugins = join(root, "plugins");
  const distribution = join(root, "release");
  const cli = join(root, "cli");
  const opencode = join(root, "opencode");
  try {
    await mkdir(plugins);
    for (const filename of BUILD_PLUGIN_FILES) await writeFile(join(plugins, filename), `// ${filename}\n`);
    await writeFile(cli, "cli-before-signing\n", { mode: 0o755 });
    await writeFile(opencode, "opencode\n", { mode: 0o755 });
    stageDistribution({ target: "bun-darwin-arm64", root: distribution, cliBinary: cli, opencodeBinary: opencode, pluginSource: plugins });
    await writeFile(join(distribution, "bin", "jugglework"), "cli-after-signing\n", { mode: 0o755 });
    await assert.rejects(verifyDistribution(distribution, "bun-darwin-arm64"), /checksum mismatch/);
    refreshDistributionManifest(distribution);
    await verifyDistribution(distribution, "bun-darwin-arm64");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-target builds use launcher-compatible names", () => {
  assert.equal(outputName("bun-darwin-arm64"), "jugglework-bun-darwin-arm64");
  assert.equal(outputName("bun-linux-x64"), "jugglework-bun-linux-x64");
  assert.equal(outputName("bun-windows-x64"), "jugglework-bun-windows-x64.exe");
});

test("build cleanup removes stale CLI binaries without deleting unrelated files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-cli-build-clean-"));
  try {
    await writeFile(join(root, "jugglework"), "stale");
    await writeFile(join(root, "jugglework-bun-linux-x64"), "stale");
    await writeFile(join(root, "jugglework-server"), "keep");
    cleanBinaryOutputs(root);
    assert.deepEqual(await readdir(root), ["jugglework-server"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

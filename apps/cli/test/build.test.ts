import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cleanBinaryOutputs,
  outputName,
  REQUIRED_PLUGIN_FILES as BUILD_PLUGIN_FILES,
  stagePluginAssets,
} from "../script/build.js";
import { REQUIRED_PLUGIN_FILES as RUNTIME_PLUGIN_FILES } from "../src/runtime.js";

test("build and runtime require the same eight plugin assets", () => {
  assert.equal(BUILD_PLUGIN_FILES.length, 8);
  assert.deepEqual(BUILD_PLUGIN_FILES, RUNTIME_PLUGIN_FILES);
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

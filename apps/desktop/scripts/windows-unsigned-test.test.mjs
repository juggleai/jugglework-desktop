import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";
import { mediaRuntimeVerificationOptions } from "../electron/mediaTools.mjs";

const require = createRequire(import.meta.url);
const { verifyWindowsPackagedMedia } = require("./electron-after-pack.cjs");
const marker = { juggleworkUnsignedTestPackage: true };

test("北数Work installer and shortcuts use the brand without a test filename suffix", () => {
  const config = parse(readFileSync(new URL("../electron-builder.yml", import.meta.url), "utf8"));
  assert.equal(config.productName, "北数Work");
  assert.equal(config.nsis.shortcutName, "北数Work");
  assert.equal(config.win.executableName, "JuggleWork");
  assert.equal(config.artifactName, "北数Work-${os}-${arch}-${version}.${ext}");
  const result = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify(require('./electron-builder.unsigned-test.cjs')))"], {
    cwd: new URL("../", import.meta.url), encoding: "utf8",
    env: { ...process.env, JUGGLEWORK_WINDOWS_UNSIGNED_TEST: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const unsigned = JSON.parse(result.stdout);
  assert.equal(unsigned.artifactName, config.artifactName);
  assert.equal(unsigned.extraMetadata.juggleworkUnsignedTestPackage, true);
  assert.ok(!unsigned.directories.output.includes("test"));
  const main = readFileSync(new URL("../electron/main.mjs", import.meta.url), "utf8");
  assert.ok(main.includes("windowsInstalledShortcutFileName(DEFAULT_DISPLAY_APP_NAME)"));
});

test("only the exact Windows package marker enables built media at runtime", () => {
  assert.deepEqual(mediaRuntimeVerificationOptions(true, "win32", marker), { phase: "built" });
  for (const metadata of [{}, { juggleworkUnsignedTestPackage: "true" }]) {
    assert.equal(mediaRuntimeVerificationOptions(true, "win32", metadata).phase, "signed");
  }
  assert.equal(mediaRuntimeVerificationOptions(true, "darwin", marker).phase, "signed");
  assert.equal(mediaRuntimeVerificationOptions(false, "win32", {}).phase, "built");
});

function fixture(metadata = marker, environment = { JUGGLEWORK_WINDOWS_UNSIGNED_TEST: "1" }) {
  const calls = [];
  const manifest = { phase: "built", files: [] };
  return {
    calls, manifest,
    context: { packager: { projectDir: "source", config: { extraMetadata: metadata } } },
    deps: {
      environment,
      verifyMediaTools(root, target, options) { calls.push({ root, options }); return { manifest }; },
      mediaInventory() { throw new Error("signed path"); },
      windowsMediaSignature() { throw new Error("unexpected signature bypass"); },
    },
  };
}

test("unsigned packaging requires both a package marker and explicit build opt-in", async () => {
  const f = fixture();
  await verifyWindowsPackagedMedia(f.context, "output", { platform: "win32", arch: "x64" }, f.deps);
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(call => call.options.phase === "built"));
  assert.equal(f.manifest.phase, "built");
  const disabled = fixture(marker, {});
  await assert.rejects(verifyWindowsPackagedMedia(disabled.context, "output", { platform: "win32", arch: "x64" }, disabled.deps), /explicit/);
  const release = fixture({});
  await assert.rejects(verifyWindowsPackagedMedia(release.context, "output", { platform: "win32", arch: "x64" }, release.deps), /signed path/);
});

test("unsigned packaging still rejects invalid inventory and changed manifests", async () => {
  const f = fixture();
  f.deps.verifyMediaTools = root => {
    if (root === "output") throw new Error("Resource inventory/hash mismatch");
    return { manifest: f.manifest };
  };
  await assert.rejects(verifyWindowsPackagedMedia(f.context, "output", { platform: "win32", arch: "x64" }, f.deps), /hash mismatch/);
  f.deps.verifyMediaTools = root => ({ manifest: root === "output" ? { phase: "built", files: ["changed"] } : f.manifest });
  await assert.rejects(verifyWindowsPackagedMedia(f.context, "output", { platform: "win32", arch: "x64" }, f.deps), /differs/);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { parse } from "yaml";

import { ensureDependencies, resolveTrustedBunBinary, sourceRevision } from "./buildToonFactory.mjs";
import { buildMediaTools } from "./buildMediaTools.mjs";
import { MEDIA_SOURCES, mediaInventory, mediaRun, verifyMediaTools, verifyMediaExecutables } from "../electron/mediaTools.mjs";
import { createToonFactoryVideoEditor } from "../electron/toonFactoryVideoEdit.mjs";
import { signMediaTools } from "./signMediaTools.mjs";
import { spawnSync } from "node:child_process";
import {
  inspectToonFactoryExecutable,
  inventoryToonFactoryBundle,
  resolveToonFactoryBuildTarget,
  sha256File,
  trustedBunForTarget,
  verifyToonFactoryBundle,
} from "../electron/toonFactoryBundle.mjs";

const temporaryDirectories = [];
// Windows cannot represent POSIX execute bits for temporary Mach-O fixtures.
const requiresPosixExecuteBits = { skip: process.platform === "win32" };
const electronBuildSource = readFileSync(new URL("./electron-build.mjs", import.meta.url), "utf8");

it("rejects unsupported native media targets and missing bundles without system fallback", async () => {
  for (const arch of ["x64", "arm64"]) await assert.rejects(buildMediaTools({ target: { platform: "linux", arch } }), /Unsupported native target/);
  assert.throws(() => verifyMediaTools("/missing/mediaTools", { platform: "darwin", arch: "arm64" }), /重新构建/);
});

it("rejects corrupt offline source cache before executing a build", { skip: process.platform !== "darwin" }, async () => {
  const root = fixture();
  const cache = path.join(root, "cache");
  mkdirSync(cache);
  writeFileSync(path.join(cache, MEDIA_SOURCES.sources.ffmpeg.archive), "corrupt");
  await assert.rejects(buildMediaTools({ target: process, output: path.join(root, "out"), cache, offline: true }), /Cached source SHA-256 mismatch/);
});

it("rejects cross-architecture media builds before running cached binaries", { skip: process.platform !== "darwin" }, async () => {
  await assert.rejects(buildMediaTools({ target: { platform: "darwin", arch: process.arch === "arm64" ? "x64" : "arm64" } }), /Native .* host required/);
});

it("real bundled media: empty PATH, authorized editor operations and tamper rejection", { skip: process.env.MEDIA_TOOLS_SMOKE !== "1" }, async () => {
  const root = realpathSync(fixture());
  const resources = path.join(root, "mediaTools");
  cpSync(process.env.MEDIA_TOOLS_SMOKE_ROOT || new URL("../resources/mediaTools", import.meta.url), resources, { recursive: true });
  const tools = verifyMediaTools(resources);
  verifyMediaExecutables(tools);
  const source = path.join(root, "input.mp4");
  mediaRun(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-c:a", "aac", "-pix_fmt", "yuv420p", source]);
  mediaRun(tools.ffmpeg, ["-v", "error", "-nostdin", "-n", "-i", source, "-an", "-c:v", "copy", path.join(root, "silent.mp4")]);
  const editor = createToonFactoryVideoEditor({ isDirectoryGranted: directory => directory === root, mediaToolsRoot: resources });
  const probe = await editor.execute({ operation: "probe", directory: root, path: "input.mp4" });
  assert.equal(probe.hasAudio, true);
  for (const operation of ["trim", "extractAudio", "separate", "analyze"]) {
    mkdirSync(path.join(root, operation));
    const result = await editor.execute({ operation, directory: root, path: "input.mp4", outputDirectory: operation, ...(operation === "trim" ? { start: 0.5, end: 1.25 } : {}) });
    if (result.video) mediaRun(tools.ffmpeg, ["-v", "error", "-i", path.join(root, result.video), "-f", "null", "-"]);
    if (operation === "trim") assert.ok(Math.abs(result.duration - 0.75) < 0.05);
    if (operation === "analyze") assert.ok(result.scenes.length >= 1 && result.scenes[0].image.endsWith(".jpg"));
  }
  const exported = await editor.execute({ operation: "export", directory: root, clips: [{ path: "input.mp4", start: 0, end: 0.5 }, { path: "silent.mp4", start: 0.5, end: 1 }], output: "export.mp4", width: 160, height: 128, fps: 24 });
  assert.equal(exported.hasAudio, true);
  assert.equal(exported.clips, 2);
  assert.ok(Math.abs(exported.duration - 1) < 0.15);
  mediaRun(tools.ffmpeg, ["-v", "error", "-i", path.join(root, "export.mp4"), "-f", "null", "-"]);
  const originalHash = sha256File(source);
  await assert.rejects(editor.execute({ operation: "export", directory: root, clips: [{ path: "input.mp4" }], output: "input.mp4" }), /输出已存在/);
  assert.equal(sha256File(source), originalHash);
  mkdirSync(path.join(root, "no-audio"));
  await assert.rejects(editor.execute({ operation: "extractAudio", directory: root, path: "silent.mp4", outputDirectory: "no-audio" }), /没有音轨/);
  const aborted = AbortSignal.abort(new Error("fixture cancellation"));
  await assert.rejects(editor.execute({ operation: "probe", directory: root, path: "input.mp4" }, aborted), /fixture cancellation/);
  const denied = createToonFactoryVideoEditor({ isDirectoryGranted: () => false, mediaToolsRoot: resources });
  await assert.rejects(denied.execute({ operation: "probe", directory: root, path: "input.mp4" }), /未经 JuggleWork 授权/);
  if (process.platform !== "win32") {
    symlinkSync(source, path.join(root, "link.mp4"));
    await assert.rejects(editor.execute({ operation: "probe", directory: root, path: "link.mp4" }), /符号链接/);
  }
  await assert.rejects(editor.execute({ operation: "probe", directory: root, path: "../outside.mp4" }), /路径穿越/);
  await assert.rejects(editor.execute({ operation: "probe", directory: root, path: "input.mp4", args: ["-version"] }), /无效/);
  assert.throws(() => verifyMediaTools(resources, { platform: process.platform, arch: process.arch === "arm64" ? "x64" : "arm64" }), /target mismatch/);
  if (process.platform === "darwin") {
  const app = path.join(root, "Signing Fixture.app");
  const signedRoot = path.join(app, "Contents/Resources/mediaTools");
  mkdirSync(path.dirname(signedRoot), { recursive: true });
  cpSync(resources, signedRoot, { recursive: true });
  assert.throws(() => signMediaTools({ app, identity: "-", ignore: () => true }, process), /Developer ID/);
  // Real local ad-hoc byte mutation tests manifest sequencing only; it does NOT
  // stand in for the mandatory Developer ID release signature/timestamp gate.
  const verifyAfterSign = signMediaTools({ app, identity: "fixture-only", ignore: () => true }, process, {
    run(_command, args) { return spawnSync("/usr/bin/codesign", ["--force", "--sign", "-", args.at(-1)], { encoding: "utf8" }); },
    signature(file) { mediaRun("/usr/bin/codesign", ["--verify", "--strict", file]); },
    verify(directory, target, options) { return verifyMediaTools(directory, target, { phase: options.phase === "built" ? "built" : "any" }); },
  });
  const signed = verifyAfterSign();
  assert.equal(signed.manifest.phase, "signed");
  assert.deepEqual(signed.manifest.buildHashes, tools.manifest.buildHashes);
  assert.notEqual(sha256File(signed.ffmpeg), signed.manifest.buildHashes.ffmpeg);
  assert.throws(() => verifyMediaTools(signedRoot, process, { phase: "signed", team: "H7PDHSK3C7" }), /codesign/);
  writeFileSync(path.join(signedRoot, "NOTICE.txt"), "post-seal mutation");
  assert.throws(verifyAfterSign, /inventory\/hash mismatch/);
  }
  writeFileSync(path.join(resources, "NOTICE.txt"), "tampered");
  assert.throws(() => verifyMediaTools(resources), /inventory\/hash mismatch/);
  // Even rebaselining a local inventory cannot replace pinned source bytes.
  writeFileSync(path.join(resources, "sources", MEDIA_SOURCES.sources.ffmpeg.archive), "forged source");
  const forged = { ...tools.manifest, files: mediaInventory(resources) };
  writeFileSync(path.join(resources, "manifest.json"), JSON.stringify(forged));
  assert.throws(() => verifyMediaTools(resources), /Source hash mismatch/);
  await editor.stop();
});

it("keeps smoke timeout failures nonzero through window destruction and async cleanup", () => {
  const source = readFileSync(new URL("./toonFactorySmoke.mjs", import.meta.url), "utf8");
  const handler = source.indexOf('app.on("window-all-closed", () => {});');
  assert.ok(handler >= 0 && handler < source.indexOf("async function run()"));
  assert.match(source, /throw new Error\(`\$\{label\} timed out/);
  assert.match(source, /catch \(error\) \{\s*console\.error\([^\n]+\);\s*exitCode = 1;\s*\} finally \{/);
  assert.match(source, /finally \{\s*clearTimeout\(hardTimeout\);\s*await runtime\?\.dispose\(\)\.catch\(\(\) => \{\}\);\s*if \(window && !window\.isDestroyed\(\)\) window\.destroy\(\);\s*host\?\.closeAllConnections\(\);\s*await new Promise\([^\n]+\);\s*await rm\(temporary, \{ recursive: true, force: true \}\);\s*app\.exit\(exitCode\);/);
  const hardTimeout = source.slice(source.indexOf("const hardTimeout = setTimeout"), source.indexOf("}, smokeTimeoutMs);"));
  assert.match(hardTimeout, /finally\(\(\) => app\.exit\(1\)\)/);
  assert.match(hardTimeout, /setTimeout\(\(\) => app\.exit\(1\), 5000\)/);
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "toonflow-build-"));
  temporaryDirectories.push(directory);
  writeFileSync(path.join(directory, "bun.lock"), "pinned lockfile\n");
  return directory;
}

function createDependencySentinels(directory) {
  for (const entry of ["node_modules/.bun", "apps/server/node_modules/express", "apps/web/node_modules/vite"]) {
    mkdirSync(path.join(directory, entry), { recursive: true });
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Toonflow dependency bootstrap", () => {
  it("runs a frozen install when nested dependencies are absent", () => {
    const directory = fixture();
    let installs = 0;
    assert.equal(ensureDependencies(directory, () => {
      installs += 1;
      createDependencySentinels(directory);
    }), true);
    assert.equal(installs, 1);
    assert.equal(readFileSync(path.join(directory, "bun.lock"), "utf8"), "pinned lockfile\n");
  });

  it("does not install when nested dependencies already exist", () => {
    const directory = fixture();
    createDependencySentinels(directory);
    assert.equal(ensureDependencies(directory, () => assert.fail("install should not run")), false);
  });

  it("rejects an install that changes bun.lock", () => {
    const directory = fixture();
    assert.throws(() => ensureDependencies(directory, () => {
      createDependencySentinels(directory);
      writeFileSync(path.join(directory, "bun.lock"), "changed lockfile\n");
    }), /original lockfile was restored/);
    assert.equal(readFileSync(path.join(directory, "bun.lock"), "utf8"), "pinned lockfile\n");
  });
});

describe("Toonflow source revision", () => {
  it("ignores dependencies and generated component declarations", () => {
    const directory = fixture();
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(path.join(directory, "src", "entry.ts"), "export const value = 1;\n");
    const revision = sourceRevision(directory);

    mkdirSync(path.join(directory, "node_modules", "dependency"), { recursive: true });
    writeFileSync(path.join(directory, "node_modules", "dependency", "index.js"), "generated dependency\n");
    mkdirSync(path.join(directory, "apps", "web", "src", "types"), { recursive: true });
    writeFileSync(path.join(directory, "apps", "web", "src", "types", "components.d.ts"), "generated declarations\n");
    assert.equal(sourceRevision(directory), revision);

    writeFileSync(path.join(directory, "src", "entry.ts"), "export const value = 2;\n");
    assert.notEqual(sourceRevision(directory), revision);
  });
});

function writeMachO(filePath, cpu = 0x0100000c) {
  const buffer = Buffer.alloc(64);
  buffer.set([0xcf, 0xfa, 0xed, 0xfe]);
  buffer.writeUInt32LE(cpu, 4);
  writeFileSync(filePath, buffer);
  chmodSync(filePath, 0o755);
}

function createBundle(directory) {
  for (const name of ["server", "web", "tools", "nodes", "skills"]) mkdirSync(path.join(directory, name), { recursive: true });
  writeFileSync(path.join(directory, "server", "jugglework.js"), "server");
  for (const name of ["web", "tools", "nodes", "skills"]) writeFileSync(path.join(directory, name, "fixture.txt"), name);
  const executablePath = path.join(directory, "bun");
  writeMachO(executablePath);
  const binarySha256 = sha256File(executablePath);
  const trustedRelease = {
    version: "1.3.14",
    repositoryUrl: "https://github.com/oven-sh/bun",
    releaseUrl: "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
    shasumsUrl: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt",
    targets: {
      "darwin-arm64": {
        archiveName: "bun-darwin-aarch64.zip",
        archiveSha256: "a".repeat(64),
        binarySha256,
      },
    },
  };
  const trusted = trustedBunForTarget("darwin", "arm64", trustedRelease);
  const files = inventoryToonFactoryBundle(directory);
  const inventorySha256 = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  writeFileSync(path.join(directory, "build-manifest.json"), JSON.stringify({
    schemaVersion: 3,
    target: { platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o" },
    bun: { version: "1.3.14", platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o", bytes: 64, sha256: binarySha256, provenance: trusted.provenance },
    inventorySha256,
    files,
  }));
  return { executablePath, trustedRelease };
}

function rewriteBundleManifest(directory, trustedRelease) {
  const executablePath = path.join(directory, "bun");
  const trusted = trustedBunForTarget("darwin", "arm64", trustedRelease);
  const files = inventoryToonFactoryBundle(directory);
  writeFileSync(path.join(directory, "build-manifest.json"), JSON.stringify({
    schemaVersion: 3,
    target: { platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o" },
    bun: { version: "1.3.14", platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o", bytes: 64, sha256: trusted.binarySha256, provenance: trusted.provenance },
    inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  }));
}

describe("Toonflow bundle target and integrity", () => {
  it("normalizes native package targets and rejects explicit cross targets", () => {
    assert.deepEqual(resolveToonFactoryBuildTarget({ TARGET: "aarch64-apple-darwin", npm_config_arch: "aarch64" }, { platform: "darwin", arch: "arm64" }), {
      platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o",
    });
    assert.throws(
      () => resolveToonFactoryBuildTarget({ TARGET_ARCH: "x86_64" }, { platform: "darwin", arch: "arm64" }),
      /TARGET_ARCH requests x64.*build host darwin\/arm64/,
    );
    assert.throws(
      () => resolveToonFactoryBuildTarget({ npm_config_platform: "win32" }, { platform: "darwin", arch: "arm64" }),
      /npm_config_platform requests win32/,
    );
  });

  it("verifies required resources, executable format, permissions, and hashes", requiresPosixExecuteBits, async () => {
    const directory = fixture();
    const { executablePath, trustedRelease } = createBundle(directory);
    const result = verifyToonFactoryBundle(directory, { platform: "mac", arch: "aarch64" }, trustedRelease);
    assert.deepEqual(result.executable, { platform: "darwin", arch: "arm64", format: "mach-o" });
    assert.deepEqual(inspectToonFactoryExecutable(executablePath), result.executable);

    writeFileSync(path.join(directory, "web", "fixture.txt"), "tampered");
    assert.throws(() => verifyToonFactoryBundle(directory, { platform: "darwin", arch: "arm64" }, trustedRelease), /inventory does not match/);
  });

  it("rejects the wrong binary architecture and a non-executable Bun", async () => {
    const wrongArch = fixture();
    const { executablePath, trustedRelease } = createBundle(wrongArch);
    writeMachO(executablePath, 0x01000007);
    assert.throws(() => verifyToonFactoryBundle(wrongArch, { platform: "darwin", arch: "arm64" }, trustedRelease), /Bundled Bun is darwin\/x64/);

    const noExecute = fixture();
    const noExecuteBundle = createBundle(noExecute);
    chmodSync(noExecuteBundle.executablePath, 0o644);
    assert.throws(() => verifyToonFactoryBundle(noExecute, { platform: "darwin", arch: "arm64" }, noExecuteBundle.trustedRelease), /not executable/);
  });

  it("rejects a tampered Bun even when the manifest is rewritten to self-sign it", () => {
    const directory = fixture();
    const bundle = createBundle(directory);
    const tampered = readFileSync(bundle.executablePath);
    tampered[63] ^= 0xff;
    writeFileSync(bundle.executablePath, tampered);
    chmodSync(bundle.executablePath, 0o755);
    const forgedRelease = structuredClone(bundle.trustedRelease);
    forgedRelease.targets["darwin-arm64"].binarySha256 = sha256File(bundle.executablePath);
    rewriteBundleManifest(directory, forgedRelease);
    assert.throws(
      () => verifyToonFactoryBundle(directory, { platform: "darwin", arch: "arm64" }, bundle.trustedRelease),
      /Manifest Bun SHA-256 is not trusted|Bundled Bun SHA-256 is not trusted/,
    );
  });

  it("rejects forged provenance and additional files", requiresPosixExecuteBits, () => {
    const forged = fixture();
    const forgedBundle = createBundle(forged);
    const manifestPath = path.join(forged, "build-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.bun.provenance.releaseUrl = "https://attacker.invalid/bun";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyToonFactoryBundle(forged, { platform: "darwin", arch: "arm64" }, forgedBundle.trustedRelease), /provenance does not match/);

    const extra = fixture();
    const extraBundle = createBundle(extra);
    writeFileSync(path.join(extra, "unexpected.txt"), "not in manifest");
    assert.throws(() => verifyToonFactoryBundle(extra, { platform: "darwin", arch: "arm64" }, extraBundle.trustedRelease), /inventory does not match/);
  });

  it("rejects an untrusted BUN_BINARY override without executing it", () => {
    const directory = fixture();
    const binary = path.join(directory, "bun-override");
    writeMachO(binary);
    const release = createBundle(fixture()).trustedRelease;
    release.targets["darwin-arm64"].binarySha256 = "f".repeat(64);
    assert.throws(
      () => resolveTrustedBunBinary(binary, { platform: "darwin", arch: "arm64", executableName: "bun", format: "mach-o" }, { trustedRelease: release }),
      /SHA-256 is not trusted/,
    );
  });
});

describe("Electron workflow coverage", () => {
  it("tracks Toonflow inputs and uses the package-pinned Bun version", () => {
    const workflow = parse(readFileSync(new URL("../../../.github/workflows/build-electron-desktop.yml", import.meta.url), "utf8"));
    const paths = workflow.on.push.paths;
    assert.ok(paths.includes("modules/toonflowV2/**"));
    assert.ok(paths.includes("pnpm-workspace.yaml"));
    for (const job of Object.values(workflow.jobs)) {
      const setupBun = job.steps.find((step) => step.name === "Setup Bun");
      assert.equal(setupBun?.with?.["bun-version"], "1.3.14");
    }
  });

  it("runs Toonflow through Electron build and pins Bun in release build jobs", () => {
    assert.match(electronBuildSource, /buildToonFactory\.mjs/);
    for (const relative of ["release-macos-aarch64.yml", "qiniu-desktop-release.yml"]) {
      const workflow = parse(readFileSync(new URL(`../../../.github/workflows/${relative}`, import.meta.url), "utf8"));
      for (const job of Object.values(workflow.jobs)) {
        if (!job.steps?.some((step) => String(step.run || "").includes("build:electron"))) continue;
        const setupBun = job.steps.find((step) => step.name === "Setup Bun");
        assert.equal(setupBun?.with?.["bun-version"], "1.3.14", `${relative}:${job.name} must pin Bun 1.3.14`);
      }
    }
  });

  it("hard-gates real Linux unpacked bundles before artifact upload", () => {
    const buildWorkflow = parse(readFileSync(new URL("../../../.github/workflows/build-electron-desktop.yml", import.meta.url), "utf8"));
    const buildJob = buildWorkflow.jobs["build-electron"];
    const buildLinux = buildJob.strategy.matrix.include.find((entry) => entry.artifact === "linux");
    const buildVerifyIndex = buildJob.steps.findIndex((step) => step.name === "Verify packaged Linux Toon Factory bundle");
    const buildUploadIndex = buildJob.steps.findIndex((step) => step.name === "Upload Electron artifacts");
    assert.deepEqual(buildLinux, {
      os: "ubuntu-latest",
      artifact: "linux",
      expected_arch: "x64",
      linux_unpacked_dir: "linux-unpacked",
    });
    assert.ok(buildVerifyIndex >= 0 && buildVerifyIndex < buildUploadIndex);
    assert.equal(buildJob.steps[buildVerifyIndex].if, "matrix.artifact == 'linux'");
    assert.match(buildJob.steps[buildVerifyIndex].run, /verify:linux-package.*matrix\.linux_unpacked_dir.*matrix\.expected_arch/);

    const releaseWorkflow = parse(readFileSync(new URL("../../../.github/workflows/release-macos-aarch64.yml", import.meta.url), "utf8"));
    const releaseJob = releaseWorkflow.jobs["publish-electron"];
    const linuxMatrix = releaseJob.strategy.matrix.include
      .filter((entry) => entry.os_type === "linux")
      .map(({ artifact, expected_arch, linux_unpacked_dir }) => ({ artifact, expected_arch, linux_unpacked_dir }));
    assert.deepEqual(linuxMatrix, [
      { artifact: "electron-linux-x64", expected_arch: "x64", linux_unpacked_dir: "linux-unpacked" },
      { artifact: "electron-linux-arm64", expected_arch: "arm64", linux_unpacked_dir: "linux-arm64-unpacked" },
    ]);
    const packageIndex = releaseJob.steps.findIndex((step) => step.name === "Package Electron (Linux)");
    const verifyIndex = releaseJob.steps.findIndex((step) => step.name === "Verify packaged Linux Toon Factory bundle");
    const uploadIndex = releaseJob.steps.findIndex((step) => step.name === "Upload Electron updater manifest artifact");
    assert.ok(packageIndex < verifyIndex && verifyIndex < uploadIndex);
    assert.equal(releaseJob.steps[verifyIndex].if, "matrix.os_type == 'linux'");
    assert.match(releaseJob.steps[verifyIndex].run, /verify:linux-package.*matrix\.linux_unpacked_dir.*matrix\.expected_arch/);
  });
});

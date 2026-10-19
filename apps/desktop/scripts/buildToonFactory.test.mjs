import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { parse } from "yaml";

import { ensureDependencies, resolveTrustedBunBinary, sourceRevision } from "./buildToonFactory.mjs";
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

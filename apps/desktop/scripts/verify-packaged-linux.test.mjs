import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { inventoryToonFactoryBundle, sha256File, trustedBunForTarget } from "../electron/toonFactoryBundle.mjs";
import { findPackagedToonFactoryBundle, verifyPackagedLinux } from "./verify-packaged-linux.mjs";

const ELF_MACHINE = { x64: 62, arm64: 183 };

function writeElf(filePath, arch) {
  const buffer = Buffer.alloc(64);
  buffer.set([0x7f, 0x45, 0x4c, 0x46]);
  buffer[4] = 2;
  buffer[5] = 1;
  buffer[6] = 1;
  buffer.writeUInt16LE(ELF_MACHINE[arch], 18);
  writeFileSync(filePath, buffer);
  chmodSync(filePath, 0o755);
}

function createFixture(t, arch, relativeRoot = "linux-unpacked/resources/toonFactoryV2") {
  const staging = mkdtempSync(path.join(tmpdir(), "jugglework-verify-linux-"));
  t.after(() => rmSync(staging, { recursive: true, force: true }));
  const root = path.join(staging, relativeRoot);
  for (const name of ["server", "web", "tools", "nodes", "skills"]) mkdirSync(path.join(root, name), { recursive: true });
  writeFileSync(path.join(root, "server", "jugglework.js"), "server");
  for (const name of ["web", "tools", "nodes", "skills"]) writeFileSync(path.join(root, name, "fixture.txt"), name);
  const executablePath = path.join(root, "bun");
  writeElf(executablePath, arch);
  const binarySha256 = sha256File(executablePath);
  const trustedRelease = {
    version: "1.3.14",
    repositoryUrl: "https://github.com/oven-sh/bun",
    releaseUrl: "https://github.com/oven-sh/bun/releases/tag/bun-v1.3.14",
    shasumsUrl: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/SHASUMS256.txt",
    targets: {
      [`linux-${arch}`]: {
        archiveName: `bun-linux-${arch}.zip`,
        archiveSha256: "a".repeat(64),
        binarySha256,
      },
    },
  };
  const trusted = trustedBunForTarget("linux", arch, trustedRelease);
  const files = inventoryToonFactoryBundle(root);
  writeFileSync(path.join(root, "build-manifest.json"), JSON.stringify({
    schemaVersion: 3,
    target: { platform: "linux", arch, executableName: "bun", format: "elf" },
    bun: {
      version: "1.3.14",
      platform: "linux",
      arch,
      executableName: "bun",
      format: "elf",
      bytes: statSync(executablePath).size,
      sha256: binarySha256,
      provenance: trusted.provenance,
    },
    inventorySha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  }));
  return { staging, root, executablePath, trustedRelease };
}

describe("Linux packaged Toon Factory verifier", () => {
  it("verifies an x64 electron-builder unpacked directory", (t) => {
    const fixture = createFixture(t, "x64");
    const unpacked = path.join(fixture.staging, "linux-unpacked");
    const result = verifyPackagedLinux(unpacked, "x86_64", fixture.trustedRelease);

    assert.equal(result.toonFactoryRoot, fixture.root);
    assert.deepEqual(result.bundle.executable, { platform: "linux", arch: "x64", format: "elf" });
  });

  it("verifies arm64 in an AppImage or tar extraction staging tree", (t) => {
    const fixture = createFixture(t, "arm64", "squashfs-root/usr/lib/jugglework/resources/toonFactoryV2");
    const result = verifyPackagedLinux(fixture.staging, "aarch64", fixture.trustedRelease);

    assert.equal(result.toonFactoryRoot, fixture.root);
    assert.deepEqual(result.bundle.executable, { platform: "linux", arch: "arm64", format: "elf" });
  });

  it("rejects a wrong ELF machine architecture", (t) => {
    const fixture = createFixture(t, "x64");
    writeElf(fixture.executablePath, "arm64");
    assert.throws(() => verifyPackagedLinux(fixture.staging, "x64", fixture.trustedRelease), /Bundled Bun is linux\/arm64\/elf, expected linux\/x64\/elf/);
  });

  it("rejects a missing required bundle file", (t) => {
    const fixture = createFixture(t, "x64");
    unlinkSync(path.join(fixture.root, "server", "jugglework.js"));
    assert.throws(() => verifyPackagedLinux(fixture.staging, "x64", fixture.trustedRelease), /Managed server entry is missing/);
  });

  it("rejects a bundled Bun without an execute bit", (t) => {
    const fixture = createFixture(t, "x64");
    chmodSync(fixture.executablePath, 0o644);
    assert.throws(() => verifyPackagedLinux(fixture.staging, "x64", fixture.trustedRelease), /Bundled Bun is not executable/);
  });

  it("rejects a file hash tamper", (t) => {
    const fixture = createFixture(t, "x64");
    writeFileSync(path.join(fixture.root, "tools", "fixture.txt"), "TOOL!");
    assert.throws(() => verifyPackagedLinux(fixture.staging, "x64", fixture.trustedRelease), /Bundle file inventory does not match/);
  });

  it("requires exactly one packaged resources/toonFactoryV2", (t) => {
    const fixture = createFixture(t, "x64");
    mkdirSync(path.join(fixture.staging, "duplicate", "resources", "toonFactoryV2"), { recursive: true });
    assert.throws(() => findPackagedToonFactoryBundle(fixture.staging), /found 2/);
  });
});

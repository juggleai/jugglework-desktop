import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

import { CDN_ORIGIN } from "./constants.mjs";
import { normalizeMacManifest, normalizeWindowsManifest, validateMacManifest, validateWindowsManifest } from "./manifest.mjs";

const VERSION = "1.2.15";
const require = createRequire(import.meta.url);
const { findFile, resolveFiles } = require("electron-updater/out/providers/Provider.js");

function metadata(seed) {
  const bytes = Buffer.from(seed.repeat(3));
  return {
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512: createHash("sha512").update(bytes).digest("base64"),
    etag: "Fto5o-5ea0sNMlW_75VgGJCv2AcJ",
  };
}

function artifactsFor(architectures, version = VERSION) {
  return architectures.flatMap((arch) => ["zip", "dmg", "zip.blockmap", "dmg.blockmap"].map((type) => ({
    arch,
    type,
    path: path.join("dist", `jugglework-mac-${arch}-${version}.${type}`),
    ...metadata(`${arch}:${type}`),
  })));
}

function windowsArtifactsFor(architectures, version = VERSION) {
  return architectures.flatMap((arch) => ["exe", "exe.blockmap"].map((type) => ({
    arch,
    type,
    path: path.join("dist", arch, `jugglework-win-${arch}-${version}.${type}`),
    ...metadata(`${arch}:${type}`),
  })));
}

function windowsStagingFor(artifacts, version = VERSION) {
  return [...new Set(artifacts.map((artifact) => artifact.arch))].map((arch) => {
    const exe = artifacts.find((artifact) => artifact.arch === arch && artifact.type === "exe");
    return {
      arch,
      manifest: {
        version,
        files: [{ url: path.basename(exe.path), sha512: exe.sha512, size: exe.size }],
        path: path.basename(exe.path),
        sha512: exe.sha512,
      },
    };
  });
}

for (const [name, architectures, primaryArch] of [
  ["arm64-only", ["arm64"], "arm64"],
  ["x64-only", ["x64"], "x64"],
  ["mixed-architecture", ["arm64", "x64"], "arm64"],
  ["universal", ["universal"], "universal"],
]) {
  test(`normalizes and validates ${name} manifests deterministically`, () => {
    const input = { version: VERSION, platform: "mac", primaryArch, artifacts: artifactsFor(architectures) };
    const first = normalizeMacManifest(input);
    const second = normalizeMacManifest({ ...input, artifacts: [...input.artifacts].reverse() });
    assert.equal(first.yaml, second.yaml);
    assert.equal(first.manifest.files.length, architectures.length * 2);
    assert.match(first.manifest.path, new RegExp(`/v${VERSION}/mac/${primaryArch}/.*\\.zip$`));
    assert.equal(first.manifest.path.startsWith(`${CDN_ORIGIN}/`), true);
    assert.equal(validateMacManifest({ ...input, manifest: first.manifest }), first.manifest);
  });
}

test("rejects wrong CDN origins", () => {
  const input = { version: VERSION, platform: "mac", artifacts: artifactsFor(["arm64"]) };
  const normalized = normalizeMacManifest(input);
  normalized.manifest.files[0].url = normalized.manifest.files[0].url.replace(CDN_ORIGIN, "https://example.com");
  assert.throws(() => validateMacManifest({ ...input, manifest: normalized.manifest }), /Wrong CDN origin|Unexpected/);
});

test("rejects mutable artifact paths", () => {
  const artifacts = artifactsFor(["arm64"]);
  artifacts[0].url = `${CDN_ORIGIN}/jugglework/releases/stable/mac/arm64/${path.basename(artifacts[0].path)}`;
  assert.throws(() => normalizeMacManifest({ version: VERSION, platform: "mac", artifacts }), /mutable artifact URL/i);
});

test("rejects DMG-only and missing blockmap inventory", () => {
  const artifacts = artifactsFor(["arm64"]).filter((item) => item.type !== "zip");
  assert.throws(() => normalizeMacManifest({ version: VERSION, platform: "mac", artifacts }), /Missing zip artifact/);
  assert.throws(
    () => normalizeMacManifest({ version: VERSION, platform: "mac", artifacts: artifactsFor(["arm64"]).filter((item) => item.type !== "dmg.blockmap") }),
    /Missing dmg\.blockmap artifact/,
  );
});

test("rejects stale versions and wrong architecture/version names", () => {
  assert.throws(
    () => normalizeMacManifest({ version: VERSION, platform: "mac", artifacts: artifactsFor(["arm64"], "1.2.14") }),
    /Wrong architecture or version/,
  );
  const input = { version: VERSION, platform: "mac", artifacts: artifactsFor(["arm64"]) };
  const normalized = normalizeMacManifest(input);
  normalized.manifest.version = "1.2.14";
  assert.throws(() => validateMacManifest({ ...input, manifest: normalized.manifest }), /version mismatch/);
});

test("rejects duplicate files, corrupted hashes, sizes, and invalid versions", () => {
  const artifacts = artifactsFor(["arm64"]);
  assert.throws(
    () => normalizeMacManifest({ version: VERSION, platform: "mac", artifacts: [...artifacts, artifacts[0]] }),
    /Duplicate artifact/,
  );
  const input = { version: VERSION, platform: "mac", artifacts };
  const normalized = normalizeMacManifest(input);
  normalized.manifest.files[0].sha512 = Buffer.alloc(64, 1).toString("base64");
  assert.throws(() => validateMacManifest({ ...input, manifest: normalized.manifest }), /mismatch/);
  const wrongSize = normalizeMacManifest(input);
  wrongSize.manifest.files[0].size += 1;
  assert.throws(() => validateMacManifest({ ...input, manifest: wrongSize.manifest }), /mismatch/);
  artifacts[0].sha512 = "corrupt";
  assert.throws(() => normalizeMacManifest(input), /Invalid SHA-512/);
  assert.equal(normalizeMacManifest({ ...input, version: "1.2.16-alpha.1", artifacts: artifactsFor(["arm64"], "1.2.16-alpha.1") }).manifest.version, "1.2.16-alpha.1");
  assert.throws(() => normalizeMacManifest({ ...input, version: "1.2.15+build" }), /Invalid release version/);
});

test("macOS manifest entry points reject the Windows platform", () => {
  assert.throws(() => normalizeMacManifest({ version: VERSION, platform: "windows", artifacts: [] }), /requires mac platform/);
});

test("merges Windows architecture staging manifests into deterministic immutable URLs", () => {
  const artifacts = windowsArtifactsFor(["x64", "arm64"]);
  const stagingManifests = windowsStagingFor(artifacts);
  const input = { version: VERSION, platform: "windows", artifacts, stagingManifests };
  const first = normalizeWindowsManifest(input);
  const second = normalizeWindowsManifest({ ...input, artifacts: [...artifacts].reverse(), stagingManifests: [...stagingManifests].reverse() });
  assert.equal(first.yaml, second.yaml);
  assert.deepEqual(first.artifacts.map(({ arch, type }) => `${arch}:${type}`), ["arm64:exe", "arm64:exe.blockmap", "x64:exe", "x64:exe.blockmap"]);
  assert.deepEqual(first.manifest.files.map((file) => file.url), [
    `${CDN_ORIGIN}/jugglework/releases/v${VERSION}/windows/arm64/jugglework-win-arm64-${VERSION}.exe`,
    `${CDN_ORIGIN}/jugglework/releases/v${VERSION}/windows/x64/jugglework-win-x64-${VERSION}.exe`,
  ]);
  assert.equal(Object.hasOwn(first.manifest, "path"), false);
  assert.equal(Object.hasOwn(first.manifest, "sha512"), false);
  assert.equal(validateWindowsManifest({ ...input, manifest: first.manifest }), first.manifest);
});

test("rejects stale, cross-architecture, and unsigned-file metadata in Windows staging manifests", () => {
  const artifacts = windowsArtifactsFor(["arm64", "x64"]);
  const stale = windowsStagingFor(artifacts);
  stale[0].manifest.version = "1.2.16";
  assert.throws(() => normalizeWindowsManifest({ version: VERSION, platform: "windows", artifacts, stagingManifests: stale }), /version mismatch/);

  const wrongArchitecture = windowsStagingFor(artifacts);
  wrongArchitecture[0].manifest.files[0].url = `jugglework-win-x64-${VERSION}.exe`;
  assert.throws(() => normalizeWindowsManifest({ version: VERSION, platform: "windows", artifacts, stagingManifests: wrongArchitecture }), /wrong architecture or EXE/);

  const preSignatureMetadata = windowsStagingFor(artifacts);
  preSignatureMetadata[0].manifest.files[0].size += 1;
  assert.throws(() => normalizeWindowsManifest({ version: VERSION, platform: "windows", artifacts, stagingManifests: preSignatureMetadata }), /size or SHA-512 mismatch/);
});

test("rejects missing Windows blockmaps and mutable merged manifest URLs", () => {
  const complete = windowsArtifactsFor(["arm64", "x64"]);
  const stagingManifests = windowsStagingFor(complete);
  const artifacts = complete.filter((artifact) => artifact.type !== "exe.blockmap");
  assert.throws(() => normalizeWindowsManifest({ version: VERSION, platform: "windows", artifacts, stagingManifests }), /Missing exe\.blockmap/);

  const input = { version: VERSION, platform: "windows", artifacts: complete, stagingManifests };
  const normalized = normalizeWindowsManifest(input);
  normalized.manifest.files[0].url = `${CDN_ORIGIN}/jugglework/releases/stable/windows/${normalized.artifacts[0].name}`;
  assert.throws(() => validateWindowsManifest({ ...input, manifest: normalized.manifest }), /Mutable manifest path/);
});

test("electron-updater 6.8.3 selects Windows EXEs from files by process architecture and ignores top-level path", () => {
  assert.equal(require("electron-updater/package.json").version, "6.8.3");
  const artifacts = windowsArtifactsFor(["arm64", "x64"]);
  const manifest = normalizeWindowsManifest({
    version: VERSION,
    platform: "windows",
    artifacts,
    stagingManifests: windowsStagingFor(artifacts),
  }).manifest;
  const poisonedTopLevel = { ...manifest, path: "arm64-only.exe", sha512: artifacts[0].sha512 };
  const files = resolveFiles(poisonedTopLevel, new URL(`${CDN_ORIGIN}/jugglework/releases/stable/windows/`));
  const descriptor = Object.getOwnPropertyDescriptor(process, "arch");
  try {
    Object.defineProperty(process, "arch", { ...descriptor, value: "arm64" });
    assert.match(findFile(files, "exe").url.pathname, /win-arm64/);
    Object.defineProperty(process, "arch", { ...descriptor, value: "x64" });
    assert.match(findFile(files, "exe").url.pathname, /win-x64/);
  } finally {
    Object.defineProperty(process, "arch", descriptor);
  }
});

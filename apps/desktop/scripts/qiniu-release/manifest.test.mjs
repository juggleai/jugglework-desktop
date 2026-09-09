import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import { CDN_ORIGIN } from "./constants.mjs";
import { normalizeMacManifest, validateMacManifest } from "./manifest.mjs";

const VERSION = "1.2.15";

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

import assert from "node:assert/strict";
import test from "node:test";

import {
  artifactKey,
  assertArchitecture,
  assertWindowsReleaseVersion,
  channelManifestKey,
  normalizeReleaseArchitectures,
  promotionLockKey,
  versionManifestKey,
} from "./constants.mjs";

test("release keys default to the existing mac layout", () => {
  assert.equal(artifactKey("1.2.17", "arm64", "app.zip"), "jugglework/releases/v1.2.17/mac/arm64/app.zip");
  assert.equal(versionManifestKey("1.2.17"), "jugglework/releases/v1.2.17/mac/latest-mac.yml");
  assert.equal(channelManifestKey("stable"), "jugglework/releases/stable/mac/latest-mac.yml");
  assert.equal(promotionLockKey("stable"), "jugglework/releases/locks/stable-mac.lock");
});

test("Windows keys, manifests, locks, and architectures are platform-specific", () => {
  assert.equal(artifactKey("1.2.17", "x64", "app.exe", "windows"), "jugglework/releases/v1.2.17/windows/x64/app.exe");
  assert.equal(versionManifestKey("1.2.17", "windows"), "jugglework/releases/v1.2.17/windows/latest.yml");
  assert.equal(channelManifestKey("alpha", "windows"), "jugglework/releases/alpha/windows/latest.yml");
  assert.equal(promotionLockKey("alpha", "windows"), "jugglework/releases/locks/alpha-windows.lock");
  assert.equal(assertArchitecture("arm64", "windows"), "arm64");
  assert.equal(assertArchitecture("x64", "windows"), "x64");
  assert.throws(() => assertArchitecture("universal", "windows"), /Unsupported architecture for windows/);
});

test("Windows release coordinates are normalized and fenced above the historical candidate", () => {
  assert.deepEqual(normalizeReleaseArchitectures(["x64", "arm64"], "windows"), ["arm64", "x64"]);
  assert.throws(() => normalizeReleaseArchitectures(["arm64"], "windows"), /exactly arm64 and x64/);
  assert.throws(() => normalizeReleaseArchitectures(["arm64", "x64", "arm64"], "windows"), /Duplicate/);
  assert.equal(assertWindowsReleaseVersion("1.2.18"), "1.2.18");
  assert.throws(() => assertWindowsReleaseVersion("1.2.17"), /greater than 1\.2\.17/);
  assert.throws(() => assertWindowsReleaseVersion("1.2.16-alpha.1"), /greater than 1\.2\.17/);
});

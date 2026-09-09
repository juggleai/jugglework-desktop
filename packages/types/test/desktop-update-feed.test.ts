import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseDesktopUpdateManifest,
  resolveDesktopUpdateFeed,
  selectMacDmgArtifact,
  selectMacZipArtifact,
} from "../src/desktop-update-feed.ts";

describe("desktop update feeds", () => {
  it("resolves stable, Alpha and exact feeds per platform", () => {
    assert.equal(resolveDesktopUpdateFeed({ platform: "darwin" }).manifestUrl,
      "https://downloads.jugglechat.cn/jugglework/releases/stable/mac/latest-mac.yml");
    assert.equal(resolveDesktopUpdateFeed({ platform: "darwin", channel: "alpha" }).manifestUrl,
      "https://downloads.jugglechat.cn/jugglework/releases/alpha/mac/latest-mac.yml");
    assert.equal(resolveDesktopUpdateFeed({ platform: "darwin", targetVersion: "v1.2.15" }).feedUrl,
      "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac");
    assert.equal(resolveDesktopUpdateFeed({ platform: "win32" }).manifestUrl,
      "https://downloads.jugglechat.cn/jugglework/releases/stable/windows/latest.yml");
    assert.equal(resolveDesktopUpdateFeed({ platform: "linux", arch: "arm64" }).manifestUrl,
      "https://downloads.jugglechat.cn/jugglework/releases/stable/linux/latest-linux-arm64.yml");
  });

  it("rejects invalid and Alpha target versions", () => {
    assert.throws(() => resolveDesktopUpdateFeed({ platform: "darwin", targetVersion: "https://bad.test" }), /stable x\.y\.z/);
    assert.throws(() => resolveDesktopUpdateFeed({ platform: "darwin", channel: "alpha", targetVersion: "1.2.15" }), /only on the stable/);
  });
});

describe("macOS manual DMG selection", () => {
  const manifestUrl = "https://downloads.jugglechat.cn/jugglework/releases/stable/mac/latest-mac.yml";
  const yaml = `version: 1.2.15
files:
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.zip
    sha512: ZIP
    size: 100
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/universal/jugglework-mac-universal-1.2.15.dmg
    sha512: UNIVERSAL
    size: 200
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.dmg
    sha512: ARM
    size: 210
  - url: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/x64/jugglework-mac-x64-1.2.15.dmg
    sha512: X64
    size: 220
path: https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.zip
sha512: ZIP
`;

  it("prefers exact architecture and never selects ZIP", () => {
    const manifest = parseDesktopUpdateManifest(yaml);
    assert.equal(selectMacDmgArtifact(manifest, { arch: "arm64", manifestUrl })?.sha512, "ARM");
    assert.equal(selectMacDmgArtifact(manifest, { arch: "x64", manifestUrl })?.sha512, "X64");
    assert.equal(selectMacZipArtifact(manifest, { arch: "arm64", manifestUrl })?.sha512, "ZIP");
    assert.equal(selectMacZipArtifact(manifest, { arch: "x64", manifestUrl }), null);
  });

  it("falls back to universal and validates target version", () => {
    const universal = parseDesktopUpdateManifest(yaml.replace(/  - url: https:\/\/downloads[^\n]*arm64[^\n]*\.dmg\n    sha512: ARM\n    size: 210\n/, ""));
    assert.equal(selectMacDmgArtifact(universal, { arch: "arm64", manifestUrl, expectedVersion: "1.2.15" })?.arch, "universal");
    assert.throws(() => selectMacDmgArtifact(universal, { arch: "arm64", manifestUrl, expectedVersion: "1.2.16" }), /version mismatch/);
  });

  it("rejects unauthorized artifact origins", () => {
    const bad = parseDesktopUpdateManifest(yaml.replace("https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.dmg", "https://evil.test/update.dmg"));
    assert.throws(() => selectMacDmgArtifact(bad, { arch: "arm64", manifestUrl }), /unauthorized origin/);
    const badPath = parseDesktopUpdateManifest(yaml.replace(
      "https://downloads.jugglechat.cn/jugglework/releases/v1.2.15/mac/arm64/jugglework-mac-arm64-1.2.15.dmg",
      "https://downloads.jugglechat.cn/untrusted/update.dmg",
    ));
    assert.throws(() => selectMacDmgArtifact(badPath, { arch: "arm64", manifestUrl }), /unauthorized origin/);
  });
});

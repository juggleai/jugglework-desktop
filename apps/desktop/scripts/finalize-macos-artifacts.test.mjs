import assert from "node:assert/strict";
import { test } from "node:test";

import { createStagingManifest } from "./finalize-macos-artifacts.mjs";

test("rebuilds latest-mac.yml from the final ZIP and stapled DMG bytes", () => {
  const yaml = createStagingManifest({
    version: "1.2.21",
    zipName: "jugglework-mac-arm64-1.2.21.zip",
    zipMetadata: { size: 100, sha512: "zip-sha" },
    dmgName: "jugglework-mac-arm64-1.2.21.dmg",
    dmgMetadata: { size: 200, sha512: "dmg-sha-after-staple" },
    releaseDate: "2026-09-17T00:00:00.000Z",
  });
  assert.match(yaml, /url: "jugglework-mac-arm64-1\.2\.21\.dmg"/);
  assert.match(yaml, /sha512: "dmg-sha-after-staple"/);
  assert.match(yaml, /path: "jugglework-mac-arm64-1\.2\.21\.zip"/);
  assert.match(yaml, /releaseDate: "2026-09-17T00:00:00\.000Z"/);
});

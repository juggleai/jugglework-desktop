import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { verifyUpdaterArtifacts } from "./verify-electron-updater-assets.mjs";

function sha512(value) {
  return createHash("sha512").update(value).digest("base64");
}

async function fixture({ includeBlockmap = true, manifestSize = 7 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "jugglework-updater-assets-"));
  const assetName = "jugglework-mac-arm64-1.2.3.zip";
  const content = Buffer.from("release");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, assetName), content);
  if (includeBlockmap) await writeFile(join(root, `${assetName}.blockmap`), "blockmap");
  await writeFile(join(root, "latest-mac.yml"), [
    "version: 1.2.3",
    "files:",
    `  - url: ${assetName}`,
    `    sha512: ${sha512(content)}`,
    `    size: ${manifestSize}`,
    `path: ${assetName}`,
    `sha512: ${sha512(content)}`,
    "releaseDate: '2026-08-13T00:00:00.000Z'",
    "",
  ].join("\n"));
  return root;
}

test("accepts a target updater manifest whose asset, hash, size, and blockmap match", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(verifyUpdaterArtifacts({
      input: root,
      expectedVersion: "1.2.3",
      target: "aarch64-apple-darwin",
    }), [{ manifest: "latest-mac.yml", version: "1.2.3", files: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a missing blockmap and mismatched artifact size", async () => {
  const withoutBlockmap = await fixture({ includeBlockmap: false });
  const wrongSize = await fixture({ manifestSize: 8 });
  try {
    assert.throws(() => verifyUpdaterArtifacts({ input: withoutBlockmap }), /missing updater blockmap/);
    assert.throws(() => verifyUpdaterArtifacts({ input: wrongSize }), /size 8 does not match/);
  } finally {
    await rm(withoutBlockmap, { recursive: true, force: true });
    await rm(wrongSize, { recursive: true, force: true });
  }
});

test("validates merged manifests against release asset metadata", async () => {
  const root = await fixture();
  try {
    await rm(join(root, "jugglework-mac-arm64-1.2.3.zip"));
    await rm(join(root, "jugglework-mac-arm64-1.2.3.zip.blockmap"));
    assert.deepEqual(verifyUpdaterArtifacts({
      input: root,
      remoteAssets: [
        { name: "jugglework-mac-arm64-1.2.3.zip", size: 7 },
        { name: "jugglework-mac-arm64-1.2.3.zip.blockmap", size: 8 },
      ],
    })[0].files, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import path from "node:path";

import { codexTargetFromManifest, codexTargetTriple } from "./codex-packaging.mjs";

const manifest = JSON.parse(await readFile(path.resolve("resources/sidecars/codex-versions.json"), "utf8"));

describe("Codex packaging manifest", () => {
  it("maps exactly the supported macOS and Windows targets", () => {
    assert.equal(codexTargetTriple("darwin", "arm64"), "aarch64-apple-darwin");
    assert.equal(codexTargetTriple("darwin", "x64"), "x86_64-apple-darwin");
    assert.equal(codexTargetTriple("win32", "x64"), "x86_64-pc-windows-msvc");
    assert.equal(codexTargetTriple("win32", "arm64"), null);
  });

  it("pins one unique asset with size and SHA-256 per target", () => {
    const targets = [["darwin", "arm64"], ["darwin", "x64"], ["win32", "x64"]].map(([platform, arch]) => codexTargetFromManifest(manifest, platform, arch));
    assert.equal(new Set(targets.map((item) => item.archive)).size, 3);
    assert.equal(new Set(targets.map((item) => item.executable)).size, 3);
    for (const target of targets) {
      assert.match(target.archiveSha256, /^[a-f0-9]{64}$/);
      assert.ok(target.archiveBytes > 50_000_000);
    }
  });
});

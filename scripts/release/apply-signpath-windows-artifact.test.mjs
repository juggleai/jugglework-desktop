import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applySignedWindowsArtifact } from "./apply-signpath-windows-artifact.mjs";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const YAML = desktopRequire("yaml");

test("rebuilds the gzip blockmap from the signed EXE before updating latest.yml", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-apply-signpath-"));
  context.after(() => rm(root, { recursive: true, force: true }));

  const signedDir = join(root, "signed");
  const distDir = join(root, "dist");
  const installerName = "jugglework-win-x64-1.2.3.exe";
  const signedInstaller = join(signedDir, installerName);
  const distInstaller = join(distDir, installerName);
  const signedBytes = Buffer.from("signed executable bytes");
  const unsignedBytes = Buffer.from("unsigned bytes");
  const oldSha512 = createHash("sha512").update(unsignedBytes).digest("base64");

  await mkdir(signedDir, { recursive: true });
  await mkdir(distDir, { recursive: true });
  await writeFile(signedInstaller, signedBytes);
  await writeFile(distInstaller, unsignedBytes);
  await writeFile(`${distInstaller}.blockmap`, "old blockmap");
  await writeFile(join(distDir, "latest.yml"), YAML.stringify({
    version: "1.2.3",
    files: [{ url: installerName, sha512: oldSha512, size: unsignedBytes.length }],
    path: installerName,
    sha512: oldSha512,
  }));

  let blockmapFinished = false;
  await applySignedWindowsArtifact(signedDir, distDir, {
    buildBlockMap: async (inputPath, compression, outputPath) => {
      assert.equal(inputPath, distInstaller);
      assert.equal(compression, "gzip");
      assert.equal(outputPath, `${distInstaller}.blockmap`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      const input = await readFile(inputPath);
      assert.deepEqual(input, signedBytes);
      const manifestBeforeBlockmap = YAML.parse(await readFile(join(distDir, "latest.yml"), "utf8"));
      assert.equal(manifestBeforeBlockmap.sha512, oldSha512);
      await writeFile(outputPath, Buffer.concat([Buffer.from("gzip-blockmap:"), input]));
      blockmapFinished = true;
    },
  });

  assert.equal(blockmapFinished, true);
  assert.deepEqual(await readFile(distInstaller), signedBytes);
  assert.deepEqual(
    await readFile(`${distInstaller}.blockmap`),
    Buffer.concat([Buffer.from("gzip-blockmap:"), signedBytes]),
  );

  const expectedSha512 = createHash("sha512").update(signedBytes).digest("base64");
  const manifest = YAML.parse(await readFile(join(distDir, "latest.yml"), "utf8"));
  assert.deepEqual(manifest.files, [{
    url: installerName,
    sha512: expectedSha512,
    size: signedBytes.length,
  }]);
  assert.equal(manifest.path, installerName);
  assert.equal(manifest.sha512, expectedSha512);
});

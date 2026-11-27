import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { metadataForBuffer } from "./metadata.mjs";
import { createReleasePlan } from "./plan.mjs";

const VERSION = "1.2.18";

async function stageWindowsArchitecture(dist, arch, version = VERSION) {
  const directory = path.join(dist, arch);
  await mkdir(directory, { recursive: true });
  const exeName = `jugglework-win-${arch}-${version}.exe`;
  const exe = Buffer.from(`signed-${arch}-installer`);
  const exeMetadata = metadataForBuffer(exe, exeName);
  await writeFile(path.join(directory, exeName), exe);
  await writeFile(path.join(directory, `${exeName}.blockmap`), `blockmap-${arch}`);
  await writeFile(path.join(directory, "latest.yml"), stringifyYaml({
    version,
    files: [{ url: exeName, sha512: exeMetadata.sha512, size: exeMetadata.size }],
    path: exeName,
    sha512: exeMetadata.sha512,
  }));
}

test("creates a Windows plan from per-architecture signed staging directories", async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), "qiniu-windows-plan-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await Promise.all([stageWindowsArchitecture(dist, "x64"), stageWindowsArchitecture(dist, "arm64")]);

  const plan = await createReleasePlan({
    version: VERSION,
    channel: "stable",
    platform: "windows",
    architectures: ["x64", "arm64"],
    dist,
    persistManifest: true,
  });

  assert.deepEqual(plan.objects.map(({ arch, type }) => `${arch}:${type}`), ["arm64:exe", "arm64:exe.blockmap", "x64:exe", "x64:exe.blockmap"]);
  assert.deepEqual(plan.architectures, ["arm64", "x64"]);
  assert.equal(plan.manifest.key, `jugglework/releases/v${VERSION}/windows/latest.yml`);
  assert.equal(plan.channelManifest.key, "jugglework/releases/stable/windows/latest.yml");
  assert.equal(plan.manifest.path, path.join(dist, `qiniu-v${VERSION}-latest.yml`));
  assert.equal(await readFile(plan.manifest.path, "utf8"), plan.manifest.content);
  assert.doesNotMatch(plan.manifest.content, /^path:|^sha512:/m);
  assert.equal(plan.actions.at(-6), "acquire promotion lock for stable/windows");
  assert.equal(plan.actions.at(-4), "conditionally set and verify channel Cache-Control no-cache, no-store, must-revalidate");
});

test("fails a Windows plan when latest.yml does not match the signed EXE bytes", async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), "qiniu-windows-plan-stale-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await Promise.all([stageWindowsArchitecture(dist, "arm64"), stageWindowsArchitecture(dist, "x64")]);
  const manifestPath = path.join(dist, "arm64", "latest.yml");
  const stale = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, stale.replace(/size: \d+/, "size: 1"));
  await assert.rejects(createReleasePlan({
    version: VERSION,
    channel: "stable",
    platform: "windows",
    architectures: ["arm64", "x64"],
    dist,
  }), /size or SHA-512 mismatch/);
});

test("rejects incomplete or historical Windows release plans before inspecting artifacts", async () => {
  const inspect = async () => { throw new Error("must not inspect"); };
  await assert.rejects(createReleasePlan({
    version: VERSION, channel: "stable", platform: "windows", architectures: ["x64"], dist: "dist", inspect,
  }), /exactly arm64 and x64/);
  await assert.rejects(createReleasePlan({
    version: "1.2.17", channel: "stable", platform: "windows", architectures: ["arm64", "x64"], dist: "dist", inspect,
  }), /greater than 1\.2\.17/);
});

test("createReleasePlan retains mac as its default platform", async () => {
  const seen = [];
  const plan = await createReleasePlan({
    version: VERSION,
    channel: "stable",
    architectures: ["arm64"],
    dist: "dist",
    inspect: async (filePath) => {
      seen.push(path.basename(filePath));
      return metadataForBuffer(filePath, filePath);
    },
  });
  assert.equal(plan.platform, "mac");
  assert.deepEqual(seen, [
    `jugglework-mac-arm64-${VERSION}.zip`,
    `jugglework-mac-arm64-${VERSION}.dmg`,
    `jugglework-mac-arm64-${VERSION}.zip.blockmap`,
    `jugglework-mac-arm64-${VERSION}.dmg.blockmap`,
  ]);
});

test("1.2.41 Stable arm64 plan points all objects and manifest entries to the exact new origin", async () => {
  const plan = await createReleasePlan({ version: "1.2.41", channel: "stable", architectures: ["arm64"], dist: "dist",
    inspect: async (filePath) => metadataForBuffer(filePath, filePath) });
  for (const object of [...plan.objects, plan.manifest, plan.channelManifest]) {
    assert.equal(object.url, `https://downloads.jugglework.cn/${object.key}`);
  }
  assert.match(plan.manifest.content, /https:\/\/downloads\.jugglework\.cn\/jugglework\/releases\/v1\.2\.41\/mac\/arm64\//);
  assert.doesNotMatch(plan.manifest.content, /downloads\.jugglechat\.cn/);
});

test("Windows stable 1.2.42 and later migrate both architectures and shared manifests together", async (t) => {
  const dist = await mkdtemp(path.join(os.tmpdir(), "qiniu-windows-origin-"));
  t.after(() => rm(dist, { recursive: true, force: true }));
  for (const version of ["1.2.41", "1.2.42", "1.2.43"]) {
    await Promise.all(["arm64", "x64"].map((arch) => stageWindowsArchitecture(dist, arch, version)));
    for (const channel of ["stable", "alpha"]) {
      const plan = await createReleasePlan({ version, channel, platform: "windows", architectures: ["x64", "arm64"], dist });
      const origin = channel === "stable" && version !== "1.2.41" ? "https://downloads.jugglework.cn" : "https://downloads.jugglechat.cn";
      assert.equal(plan.origin, origin);
      for (const object of [...plan.objects, plan.manifest, plan.channelManifest]) assert.equal(object.url, `${origin}/${object.key}`);
      assert.match(plan.manifest.content, new RegExp(`${origin.replaceAll(".", "\\.")}/jugglework/releases/v${version}/windows/arm64/`));
      assert.match(plan.manifest.content, /\/windows\/x64\//);
      assert.doesNotMatch(plan.manifest.content, /^path:|^sha512:/m);
      assert.equal(plan.actions.some((action) => action.includes("insert-only")), channel === "stable" && version === "1.2.42");
    }
  }
});

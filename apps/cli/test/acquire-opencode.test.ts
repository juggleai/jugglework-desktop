import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireOpenCode } from "../script/acquire-opencode.js";
import { OPENCODE_DISTRIBUTION } from "../src/distribution.js";

test("OpenCode acquisition rejects a local archive whose digest does not match the descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-acquire-"));
  const archive = join(root, "fixture.zip");
  try {
    await writeFile(archive, "not an opencode archive");
    await assert.rejects(
      acquireOpenCode({ target: "bun-darwin-arm64", outdir: join(root, "out"), archivePath: archive }),
      /archive checksum mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode acquisition extracts a digest-verified local fixture without network access", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "jugglework-acquire-fixture-"));
  const source = join(root, "source");
  const archive = join(root, "fixture.tar.gz");
  const target = "bun-linux-x64" as const;
  const descriptor = OPENCODE_DISTRIBUTION.targets[target];
  const original = { ...descriptor };
  try {
    await mkdir(source);
    await writeFile(join(source, "opencode"), "fixture sidecar\n", { mode: 0o755 });
    const process = spawnSync("tar", ["-czf", archive, "opencode"], { cwd: source });
    assert.equal(process.status, 0);
    descriptor.archive = "fixture.tar.gz";
    descriptor.format = "tar.gz";
    descriptor.sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
    const output = await acquireOpenCode({ target, outdir: join(root, "out"), archivePath: archive });
    assert.equal(await readFile(output, "utf8"), "fixture sidecar\n");
  } finally {
    Object.assign(descriptor, original);
    await rm(root, { recursive: true, force: true });
  }
});

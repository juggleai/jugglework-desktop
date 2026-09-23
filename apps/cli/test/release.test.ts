import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { stageDistribution } from "../script/build.js";
import { archiveRelease, smokeRelease, validateRelease } from "../script/release.js";
import { REQUIRED_PLUGIN_FILES, sha256File } from "../src/distribution.js";
import packageJson from "../package.json" with { type: "json" };

test("release validation, clean-home smoke, archive, and archive checksum use local fixtures", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "jugglework-release-fixture-"));
  const plugins = join(root, "plugins");
  const distribution = join(root, "bun-darwin-arm64");
  const cli = join(root, "jugglework");
  const opencode = join(root, "opencode");
  const archives = join(root, "archives");
  try {
    await mkdir(plugins);
    for (const filename of REQUIRED_PLUGIN_FILES) await writeFile(join(plugins, filename), `// ${filename}\n`);
    await writeFile(cli, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${packageJson.version}"; exit 0; fi\nif [ "$1" = "status" ]; then exit 0; fi\nexit 2\n`);
    await writeFile(opencode, "#!/bin/sh\necho 'opencode 1.18.15'\n");
    await chmod(cli, 0o755);
    await chmod(opencode, 0o755);
    stageDistribution({ target: "bun-darwin-arm64", root: distribution, cliBinary: cli, opencodeBinary: opencode, pluginSource: plugins });

    await validateRelease(distribution, "bun-darwin-arm64");
    await smokeRelease(distribution, "bun-darwin-arm64");
    const archive = await archiveRelease(distribution, "bun-darwin-arm64", archives);
    assert.equal((await stat(archive)).isFile(), true);
    assert.equal(await readFile(`${archive}.sha256`, "utf8"), `${await sha256File(archive)}  ${basename(archive)}\n`);
    const entries = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    assert.equal(entries.status, 0, entries.stderr);
    assert.match(entries.stdout, /^\.\/bin\/jugglework$/m);
    assert.match(entries.stdout, /^\.\/manifest\.json$/m);
    assert.doesNotMatch(entries.stdout, /\.\/bun-darwin-arm64\/bin\/jugglework/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

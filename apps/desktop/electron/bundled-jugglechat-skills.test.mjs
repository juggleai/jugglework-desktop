import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installBundledJuggleChatSkills } from "./bundled-jugglechat-skills.mjs";

test("bundled JuggleChat skills install as flat global OpenCode skills", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jugglechat-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "collection");
  const destination = path.join(root, "global-skills");
  await mkdir(path.join(source, "jugglechat-im-sdk", "modules"), { recursive: true });
  await writeFile(path.join(source, "jugglechat-im-sdk", "SKILL.md"), "# IM skill\n", "utf8");

  const result = await installBundledJuggleChatSkills(source, destination);
  assert.deepEqual(result, { installed: ["jugglechat-im-sdk"], skipped: false });
  assert.equal(
    await readFile(path.join(destination, "jugglechat-im-sdk", "SKILL.md"), "utf8"),
    "# IM skill\n",
  );
});

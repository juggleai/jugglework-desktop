import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMeetingConfig } from "./meeting-config.mjs";
test("Desktop meeting file reads public config and rejects secrets/invalid values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meeting-config-"));
  const file = join(dir, "meeting.json");
  try {
    assert.equal((await readMeetingConfig(file)).appId, 0);
    await writeFile(
      file,
      JSON.stringify({
        enabled: true,
        appId: 123,
      }),
    );
    assert.deepEqual(await readMeetingConfig(file), {
      enabled: true,
      appId: 123,
      filePath: file,
    });
    for (const invalid of [
      { serverSecret: "do-not-expose" },
      { appSign: "do-not-expose" },
      { appId: "123" },
      { enabled: "false" },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(
        readMeetingConfig(file),
        (error) =>
          error instanceof Error && !error.message.includes("do-not-expose"),
      );
    }
    await writeFile(file, "{");
    await assert.rejects(readMeetingConfig(file), /JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

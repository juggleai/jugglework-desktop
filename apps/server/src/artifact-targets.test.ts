import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceArtifactTargets } from "./routes/files.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("batch artifact confirmation preserves Unicode names, zero bytes and missing status", async () => {
  const root = await mkdtemp(join(tmpdir(), "jugglework-artifact-targets-"));
  roots.push(root);
  await writeFile(join(root, "报告 Q1.docx"), "");
  const result = await resolveWorkspaceArtifactTargets(root, [
    { kind: "file", value: join(root, "报告 Q1.docx") },
    { kind: "file", value: "missing.docx" },
  ]);
  expect(result[0]).toMatchObject({
    value: "报告 Q1.docx",
    name: "报告 Q1.docx",
    exists: true,
    size: 0,
  });
  expect(result[1]).toMatchObject({ value: "missing.docx", exists: false });
});

test.skipIf(process.platform === "win32")(
  "POSIX artifact IDs do not collapse case-distinct paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "jugglework-artifact-targets-"));
    roots.push(root);
    const result = await resolveWorkspaceArtifactTargets(root, [
      { kind: "file", value: "Report.docx" },
      { kind: "file", value: "report.docx" },
    ]);
    expect(result.map((item) => item.id)).toEqual([
      "file:Report.docx",
      "file:report.docx",
    ]);
  },
);

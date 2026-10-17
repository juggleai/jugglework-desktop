import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveArtifactFileCopy } from "./artifact-file-operations.mjs";

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("copies zero-byte and large files with Unicode names without changing the source", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-file-copy-"));
  roots.push(root);
  for (const size of [0, 6_000_000]) {
    const name = `报告 Q1 ${size}.docx`;
    const source = path.join(root, name);
    const destination = path.join(root, `copy-${name}`);
    const bytes = Buffer.alloc(size, 42);
    await writeFile(source, bytes);
    assert.equal(
      await saveArtifactFileCopy({
        workspaceRoot: root,
        relativePath: name,
        choosePath: async (suggestion) => {
          assert.equal(suggestion, name);
          return destination;
        },
      }),
      destination,
    );
    assert.deepEqual(await readFile(destination), bytes);
    assert.deepEqual(await readFile(source), bytes);
  }
});

test("cancelling creates no copy and selecting the original is rejected", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jugglework-file-copy-"));
  roots.push(root);
  const source = path.join(root, "report.docx");
  await writeFile(source, "original");
  assert.equal(
    await saveArtifactFileCopy({
      workspaceRoot: root,
      relativePath: "report.docx",
      choosePath: async () => null,
    }),
    null,
  );
  await assert.rejects(
    saveArtifactFileCopy({
      workspaceRoot: root,
      relativePath: "report.docx",
      choosePath: async () => source,
    }),
    /different file/,
  );
  assert.equal(await readFile(source, "utf8"), "original");
});

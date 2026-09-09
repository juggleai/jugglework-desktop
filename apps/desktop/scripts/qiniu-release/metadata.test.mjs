import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectArtifact, metadataForBuffer, qiniuEtagBuffer, QINIU_BLOCK_SIZE } from "./metadata.mjs";

test("computes standard Qiniu ETags for empty and single-block content", () => {
  assert.equal(qiniuEtagBuffer(Buffer.alloc(0)), "Fto5o-5ea0sNMlW_75VgGJCv2AcJ");
  assert.equal(qiniuEtagBuffer("hello"), "Fqr0xh3cxeii2r7eDztILNmuqUNN");
});

test("computes the Qiniu multi-block format", () => {
  const bytes = Buffer.alloc(QINIU_BLOCK_SIZE + 1, 0x61);
  const blockDigests = [
    createHash("sha1").update(bytes.subarray(0, QINIU_BLOCK_SIZE)).digest(),
    createHash("sha1").update(bytes.subarray(QINIU_BLOCK_SIZE)).digest(),
  ];
  const expected = Buffer.concat([
    Buffer.from([0x96]),
    createHash("sha1").update(Buffer.concat(blockDigests)).digest(),
  ]).toString("base64url");
  assert.equal(qiniuEtagBuffer(bytes), expected);
  assert.equal(expected, "lieGn00gWdbfwEIHaUpzu4drHeun");
});

test("computes file metadata without credential inputs", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qiniu-metadata-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "release.zip");
  await writeFile(filePath, "hello");
  const actual = await inspectArtifact(filePath);
  assert.deepEqual(actual, metadataForBuffer("hello", filePath));
  assert.equal(actual.mime, "application/zip");
});

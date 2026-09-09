import assert from "node:assert/strict";
import test from "node:test";

import { createQshellAdapter, redactCommandOutput } from "./qshell.mjs";

test("qshell adapter uses argument arrays and omits overwrite for immutable files", async () => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "{}", stderr: "" };
  };
  const qiniu = createQshellAdapter({ bucket: "juggleim", run });
  await qiniu.uploadFile("immutable key", "/tmp/file name.zip", "application/zip");
  await qiniu.uploadFile("channel", "/tmp/latest.yml", "text/yaml", { overwrite: true });
  assert.deepEqual(calls[0].args, ["fput", "juggleim", "immutable key", "/tmp/file name.zip", "--mimetype", "application/zip", "--detect-mime", "-1"]);
  assert.equal(calls[0].args.includes("--overwrite"), false);
  assert.equal(calls[1].args.at(-1), "--overwrite");
});

test("qshell stat parses metadata and treats documented missing-object status as absent", async () => {
  let missing = false;
  const qiniu = createQshellAdapter({
    bucket: "juggleim",
    run: async () => missing
      ? { status: 1, stdout: "", stderr: "code: 612 no such file" }
      : { status: 0, stdout: JSON.stringify({ hash: "etag", fsize: 42, mimeType: "application/zip", putTime: 7 }), stderr: "" },
  });
  assert.deepEqual(await qiniu.stat("key"), { size: 42, etag: "etag", mime: "application/zip", putTime: "7" });
  missing = true;
  assert.equal(await qiniu.stat("missing"), null);
});

test("qshell stat parses textual putTime", async () => {
  const qiniu = createQshellAdapter({
    bucket: "juggleim",
    run: async () => ({ status: 0, stdout: "hash: etag\nfsize: 42\nmimeType: application/zip\nputTime: 123456789", stderr: "" }),
  });
  assert.deepEqual(await qiniu.stat("key"), { size: 42, etag: "etag", mime: "application/zip", putTime: "123456789" });
});

test("qshell failures conservatively redact stdout and stderr", async () => {
  const qiniu = createQshellAdapter({
    bucket: "juggleim",
    run: async () => ({ status: 1, stdout: "apiKey=abc123 Authorization: Bearer xyz", stderr: "clientSecret: hush sessionToken=token-value" }),
  });
  await assert.rejects(qiniu.uploadFile("key", "/tmp/file", "application/zip"), (error) => {
    assert.doesNotMatch(error.message, /abc123|xyz|hush|token-value/);
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.doesNotMatch(redactCommandOutput("Cookie: sessionToken=unsafe"), /unsafe/);
});

test("qshell CDN refresh sends URLs over stdin instead of shell interpolation", async () => {
  const calls = [];
  const qiniu = createQshellAdapter({
    bucket: "juggleim",
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    },
  });
  await qiniu.refresh(["https://downloads.jugglechat.cn/a", "https://downloads.jugglechat.cn/b"]);
  assert.deepEqual(calls[0].args, ["cdnrefresh"]);
  assert.equal(calls[0].options.input, "https://downloads.jugglechat.cn/a\nhttps://downloads.jugglechat.cn/b\n");
});

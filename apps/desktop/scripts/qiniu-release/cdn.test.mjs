import assert from "node:assert/strict";
import test from "node:test";

import { publicUrl } from "./constants.mjs";
import { metadataForBuffer } from "./metadata.mjs";
import { readBackDigest, verifyCdnObject } from "./cdn.mjs";

function response(body, { status = 200, headers = {} } = {}) {
  return new Response(body, { status, headers });
}

test("verifies CDN HEAD, byte range, and full content", async () => {
  const body = Buffer.from("release-bytes");
  const key = "jugglework/releases/v1.2.15/mac/arm64/app.zip";
  const object = { key, url: publicUrl(key), ...metadataForBuffer(body, key) };
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(options);
    if (options.method === "HEAD") {
      return response(null, { headers: { "content-length": String(body.length), "content-type": object.mime } });
    }
    if (options.headers?.Range) {
      return response(body.subarray(0, 1), { status: 206, headers: { "content-range": `bytes 0-0/${body.length}`, "content-length": "1" } });
    }
    return response(body, { headers: { "content-length": String(body.length) } });
  };
  const result = await verifyCdnObject(object, { fetchImpl });
  assert.equal(result.sha512, object.sha512);
  assert.deepEqual(requests.map((request) => request.method), ["HEAD", "GET", "GET"]);
});

test("rejects wrong origin, bad range, and corrupt full content", async () => {
  const body = Buffer.from("release-bytes");
  const key = "jugglework/releases/v1.2.15/mac/arm64/app.zip";
  const object = { key, url: publicUrl(key), ...metadataForBuffer(body, key) };
  await assert.rejects(verifyCdnObject({ ...object, url: "http://downloads.jugglechat.cn/file" }, { fetchImpl: async () => response(body) }), /Unapproved CDN URL/);
  await assert.rejects(verifyCdnObject(object, { fetchImpl: async (_url, options) => {
    if (options.method === "HEAD") return response(null, { headers: { "content-length": String(body.length), "content-type": object.mime } });
    return response(body, { status: 200 });
  } }), /Range GET.*HTTP 200/);
  await assert.rejects(verifyCdnObject(object, { fetchImpl: async (_url, options) => {
    if (options.method === "HEAD") return response(null, { headers: { "content-length": String(body.length), "content-type": object.mime } });
    if (options.headers?.Range) return response(body.subarray(0, 1), { status: 206, headers: { "content-range": `bytes 0-0/${body.length}`, "content-length": "1" } });
    return response(Buffer.from("corrupt-data!"), { headers: { "content-length": String(body.length) } });
  } }), /size or SHA-512 mismatch/);
});

test("rejects missing or mismatched Content-Length on HEAD, range, and full paths", async () => {
  const body = Buffer.from("release-bytes");
  const key = "jugglework/releases/v1.2.15/mac/arm64/app.zip";
  const object = { key, url: publicUrl(key), ...metadataForBuffer(body, key) };
  await assert.rejects(verifyCdnObject(object, { fetchImpl: async () => response(null, { headers: { "content-type": object.mime } }) }), /Content-Length mismatch/);
  await assert.rejects(verifyCdnObject(object, { fetchImpl: async (_url, options) => {
    if (options.method === "HEAD") return response(null, { headers: { "content-length": String(body.length), "content-type": object.mime } });
    return response(body.subarray(0, 1), { status: 206, headers: { "content-range": `bytes 0-0/${body.length}`, "content-length": "2" } });
  } }), /CDN range.*Content-Length mismatch/);
  await assert.rejects(verifyCdnObject(object, { fetchImpl: async (_url, options) => {
    if (options.method === "HEAD") return response(null, { headers: { "content-length": String(body.length), "content-type": object.mime } });
    if (options.headers?.Range) return response(body.subarray(0, 1), { status: 206, headers: { "content-range": `bytes 0-0/${body.length}`, "content-length": "1" } });
    return response(body, { headers: { "content-length": String(body.length + 1) } });
  } }), /CDN full response.*Content-Length mismatch/);
});

test("read-back polls until exact channel manifest digest and length converge", async () => {
  const body = Buffer.from("version: 1.2.15\n");
  const metadata = metadataForBuffer(body, "latest-mac.yml");
  const url = publicUrl("jugglework/releases/stable/mac/latest-mac.yml");
  let calls = 0;
  const old = Buffer.from("version: 1.2.14\n");
  const result = await readBackDigest(url, metadata.sha256, {
    expectedSize: body.length,
    attempts: 3,
    intervalMs: 0,
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      const value = calls < 3 ? old : body;
      return response(value, { headers: { "content-length": String(value.length) } });
    },
  });
  assert.equal(result.sha256, metadata.sha256);
  assert.equal(result.attempts, 3);
  await assert.rejects(readBackDigest(url, "0".repeat(64), { attempts: 2, intervalMs: 0, sleep: async () => {}, fetchImpl: async () => response(body, { headers: { "content-length": String(body.length) } }) }), /after 2 attempts/);
});

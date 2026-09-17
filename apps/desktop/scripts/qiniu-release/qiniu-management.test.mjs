import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createQiniuManagementClient } from "./qiniu-management.mjs";

const CACHE_CONTROL = "no-cache, no-store, must-revalidate";

function encoded(value) {
  return Buffer.from(value).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

function response(status, body = "") {
  if (status > 599) {
    return {
      status,
      async text() { return body; },
      async json() { return JSON.parse(body); },
    };
  }
  return new Response(body, { status, headers: body ? { "Content-Type": "application/json" } : undefined });
}

test("discovers the regional RS endpoint, signs conditional chgm, and verifies cacheControl", async () => {
  const calls = [];
  const accessKey = "test-access";
  const secretKey = "test-secret";
  const bucket = "juggleim";
  const key = "jugglework/releases/stable/windows/latest.yml";
  const expected = { size: 531, etag: "F-test", putTime: "123456" };
  const date = "20260915T010203Z";
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === "uc.qiniuapi.com") {
      return response(200, JSON.stringify({ hosts: [{ rs: { domains: ["rs-z2.qiniuapi.com"] } }] }));
    }
    if (url.pathname.startsWith("/chgm/")) return response(200);
    return response(200, JSON.stringify({
      fsize: expected.size,
      hash: expected.etag,
      putTime: expected.putTime,
      cacheControl: CACHE_CONTROL,
    }));
  };
  const client = createQiniuManagementClient({
    bucket,
    accessKey,
    secretKey,
    fetchImpl,
    now: () => new Date("2026-09-15T01:02:03.000Z"),
  });

  assert.deepEqual(await client.setCacheControl(key, CACHE_CONTROL, expected), {
    size: expected.size,
    etag: expected.etag,
    putTime: expected.putTime,
    cacheControl: CACHE_CONTROL,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url.href, `https://uc.qiniuapi.com/v4/query?ak=${accessKey}&bucket=${bucket}`);
  const condition = encoded(`hash=${expected.etag}&fsize=${expected.size}&putTime=${expected.putTime}`);
  const chgmPath = `/chgm/${encoded(`${bucket}:${key}`)}/cacheControl/${encoded(CACHE_CONTROL)}/cond/${condition}`;
  assert.equal(calls[1].url.href, `https://rs-z2.qiniuapi.com${chgmPath}`);
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls[1].init.headers["X-Qiniu-Date"], date);
  const signingText = `POST ${chgmPath}\nHost: rs-z2.qiniuapi.com\nContent-Type: application/x-www-form-urlencoded\nX-Qiniu-Date: ${date}\n\n`;
  const signature = encoded(createHmac("sha1", secretKey).update(signingText).digest());
  assert.equal(calls[1].init.headers.Authorization, `Qiniu ${accessKey}:${signature}`);
  assert.equal(calls[2].url.hostname, "rs-z2.qiniuapi.com");
  assert.match(calls[2].url.pathname, /^\/stat\//);
});

test("accepts and normalizes the official qbox.me regional RS endpoint returned by production discovery", async () => {
  const calls = [];
  const client = createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    fetchImpl: async (input) => {
      const url = new URL(input);
      calls.push(url);
      if (url.hostname === "uc.qiniuapi.com") return response(200, JSON.stringify({ hosts: [{ rs: { domains: ["rs-z2.qbox.me"] } }] }));
      return response(200, JSON.stringify({ fsize: 1, hash: "etag", putTime: "1" }));
    },
  });
  assert.deepEqual(await client.stat("stable/latest.yml"), { size: 1, etag: "etag", putTime: "1" });
  assert.equal(calls[1].hostname, "rs-z2.qiniuapi.com");
});

test("fails closed when the condition is rejected and does not stat after chgm", async () => {
  const calls = [];
  const client = createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    fetchImpl: async (input) => {
      const url = new URL(input);
      calls.push(url);
      if (url.hostname === "uc.qiniuapi.com") return response(200, JSON.stringify({ hosts: [{ rs: { domains: ["rs-z0.qiniuapi.com"] } }] }));
      return response(613, JSON.stringify({ error: "cond not match" }));
    },
  });
  await assert.rejects(client.setCacheControl("stable/latest.yml", CACHE_CONTROL, { size: 1, etag: "etag", putTime: "1" }), /object identity changed/);
  assert.equal(calls.length, 2);
});

test("rejects unapproved region endpoints before sending an authenticated request", async () => {
  for (const hostname of ["attacker.example", "qbox.me.attacker.example", "evilqbox.me", "qiniuapi.com.attacker.example"]) {
    let calls = 0;
    const client = createQiniuManagementClient({
      bucket: "juggleim",
      accessKey: "test-access",
      secretKey: "test-secret",
      fetchImpl: async () => {
        calls += 1;
        return response(200, JSON.stringify({ hosts: [{ rs: { domains: [hostname] } }] }));
      },
    });
    await assert.rejects(client.stat("key"), /unapproved RS endpoint/);
    assert.equal(calls, 1);
  }
});

test("rejects a caller-supplied region discovery origin", () => {
  assert.throws(() => createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    regionQueryEndpoint: "https://attacker.example/v4/query",
  }), /region query endpoint is invalid/);
});

test("fails verification if bytes or cache metadata do not match after mutation", async () => {
  for (const payload of [
    { fsize: 2, hash: "etag", cacheControl: CACHE_CONTROL },
    { fsize: 1, hash: "etag", cacheControl: "public, max-age=31536000" },
  ]) {
    const client = createQiniuManagementClient({
      bucket: "juggleim",
      accessKey: "test-access",
      secretKey: "test-secret",
      fetchImpl: async (input) => {
        const url = new URL(input);
        if (url.hostname === "uc.qiniuapi.com") return response(200, JSON.stringify({ hosts: [{ rs: { domains: ["rs-z1.qiniuapi.com"] } }] }));
        if (url.pathname.startsWith("/chgm/")) return response(200);
        return response(200, JSON.stringify(payload));
      },
    });
    await assert.rejects(client.setCacheControl("stable/latest.yml", CACHE_CONTROL, { size: 1, etag: "etag", putTime: "1" }), /identity changed|Cache-Control verification failed/);
  }
});

test("requires putTime in the conditional object identity", async () => {
  const client = createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  await assert.rejects(client.setCacheControl("stable/latest.yml", CACHE_CONTROL, { size: 1, etag: "etag" }), /object identity is required/);
});

test("bounds region and management requests with an abort signal", async () => {
  const client = createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    timeoutMs: 1_000,
    fetchImpl: async (_input, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      return response(500, JSON.stringify({ error: "stop" }));
    },
  });
  await assert.rejects(client.stat("key"), /region discovery failed/);
});

test("aborts a hung region request at the configured timeout", async () => {
  const client = createQiniuManagementClient({
    bucket: "juggleim",
    accessKey: "test-access",
    secretKey: "test-secret",
    timeoutMs: 1_000,
    fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }),
  });
  await assert.rejects(client.stat("key"), /timed out after 1000ms/);
});

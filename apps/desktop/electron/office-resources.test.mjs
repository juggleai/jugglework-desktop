import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createOfficeResources,
  classifyOfficeResource,
} from "./office-resources.mjs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { copyOfficeAssets } = require("../scripts/office-assets.cjs");

const manifest = {
  schema: 1,
  engineVersion: "0.0.0.499",
  wrapperVersion: "0.2.196-office.1",
  assetVersion: "1",
  entries: [],
  optional: [{ path: "/metrics", purpose: "日志统计" }],
};
const origin = "http://127.0.0.1:8800";
async function fixture(t, value = manifest) {
  const root = await mkdtemp(path.join(tmpdir(), "office-assets-中文 "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await mkdir(source);
  await writeFile(path.join(source, "manifest.json"), JSON.stringify(value));
  return {
    root,
    source,
    create: (options = {}) =>
      createOfficeResources({
        assetsDirectory: source,
        cacheDirectory: path.join(root, "cache"),
        ...options,
      }),
  };
}
function partition() {
  const handlers = new Map();
  const forwarded = [];
  return {
    handlers,
    forwarded,
    protocol: {
      handle(scheme, handler) {
        assert.equal(handlers.has(scheme), false);
        handlers.set(scheme, handler);
      },
      unhandle(scheme) {
        handlers.delete(scheme);
      },
    },
    async fetch(request, options) {
      forwarded.push({ request, options });
      return new Response("missing", { status: 404 });
    },
  };
}

test("classification keeps exact origin/query identity and leaves unknown workers unknown", () => {
  assert.equal(
    classifyOfficeResource(
      origin + "/static/doc/pc.html?file=a",
      origin,
      manifest,
    ).kind,
    "core",
  );
  assert.equal(
    classifyOfficeResource(origin + "/metrics", origin, manifest).kind,
    "optional",
  );
  assert.equal(
    classifyOfficeResource("https://other.test/metrics", origin, manifest).kind,
    "unknown",
  );
  assert.equal(
    classifyOfficeResource(
      origin + "/static/worker-unknown.js",
      origin,
      manifest,
    ).kind,
    "unknown",
  );
});

test("remote executable and unlisted font requests cannot download outside the catalog", async (t) => {
  const { create } = await fixture(t);
  const service = create();
  const session = partition();
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {
      assert.fail("optional network must not fail document");
    },
  });
  for (const url of [
    "https://other.test/editor.js",
    "https://other.test/a.woff",
  ]) {
    assert.equal(
      (await session.handlers.get("https")(new Request(url))).status,
      503,
    );
  }
  assert.equal(
    classifyOfficeResource(
      "https://other.test/extension",
      origin,
      manifest,
      "worker",
    ).kind,
    "remote-code",
  );
  assert.equal(
    classifyOfficeResource(
      "https://other.test/subset?text=private",
      origin,
      manifest,
      "font",
    ).kind,
    "unknown-font",
  );
  assert.equal(session.forwarded.length, 0);
  attached.dispose();
});

test("optional remote configuration matches only the audited HTTPS origin and path without forwarding account query parameters", async (t) => {
  const config = {
    origin: "https://config.example.test",
    path: "/flags",
    purpose: "失败时沿用调用方默认值",
  };
  const value = { ...manifest, optional: [...manifest.optional, config] };
  const { create } = await fixture(t, value);
  const service = create();
  const session = partition();
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {
      assert.fail("configuration must not fail editor");
    },
  });
  const response = await session.handlers.get("https")(
    new Request(config.origin + config.path + "?xsrf=private-value", {
      method: "POST",
      body: "private-body",
    }),
  );
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(session.forwarded.length, 0);
  for (const url of [
    origin + "/flags",
    "https://other.test/flags",
    config.origin + "/flags/extra",
    "http://config.example.test/flags",
  ]) {
    assert.equal(classifyOfficeResource(url, origin, value).kind, "unknown");
  }
  attached.dispose();
  const { source, root } = await fixture(t, {
    ...value,
    optional: [{ ...config, origin: "https://config.example.test/path" }],
  });
  assert.throws(
    () => copyOfficeAssets(source, path.join(root, "target")),
    /来源无效/,
  );
});

test("both schemes share routing; save priority, optional failure, unknown response and cleanup remain distinct", async (t) => {
  const { create } = await fixture(t);
  const service = create();
  const session = partition();
  let saves = 0;
  let failures = 0;
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => {
      saves++;
      return { engineFileId: "file" };
    },
    onCoreFailure: () => {
      failures++;
    },
  });
  const request = (url, options) =>
    session.handlers.get(new URL(url).protocol.slice(0, -1))(
      new Request(url, options),
    );
  assert.equal(session.handlers.size, 2);
  await request(origin + "/localapi/save", { method: "POST" });
  assert.equal(saves, 1);
  assert.equal(session.forwarded.length, 0);
  assert.equal((await request(origin + "/metrics")).status, 410);
  assert.equal(failures, 0);
  assert.equal((await request(origin + "/unclassified")).status, 404);
  assert.equal(session.forwarded[0].options.bypassCustomProtocolHandlers, true);
  assert.equal((await request(origin + "/static/doc/pc.html")).status, 404);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
  attached.dispose();
  assert.equal(session.handlers.size, 0);
  assert.equal(service.state("doc").coreFailures, 0);
});

test("same-origin worker bytes are local; missing or corrupted required resource prevents packaging", async (t) => {
  const bytes = Buffer.from("self.postMessage('ready')");
  const entry = {
    id: "worker",
    kind: "core",
    required: true,
    path: "/static/worker.js",
    file: "worker.js",
    mime: "text/javascript",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const { root, source, create } = await fixture(t, {
    ...manifest,
    entries: [entry],
  });
  assert.throws(
    () => copyOfficeAssets(source, path.join(root, "missing")),
    /ENOENT/,
  );
  await writeFile(path.join(source, "worker.js"), bytes);
  for (const platform of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
    const target = copyOfficeAssets(
      source,
      path.join(root, platform, "中文 Resources"),
    );
    assert.ok(target.endsWith(path.join("中文 Resources", "office-assets")));
  }
  const service = create();
  const session = partition();
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {},
  });
  const response = await session.handlers.get("http")(
    new Request(origin + "/static/worker.js"),
  );
  assert.equal(await response.text(), bytes.toString());
  assert.equal(session.forwarded.length, 0);
  attached.dispose();
  await writeFile(path.join(source, "worker.js"), "corrupt");
  assert.throws(
    () => copyOfficeAssets(source, path.join(root, "invalid")),
    /校验失败/,
  );
});

test("font failure is bounded per page; explicit prefetch succeeds without reloading a model", async (t) => {
  const bytes = Buffer.from("wOFFfont-fixture");
  const entry = {
    id: "font",
    kind: "font",
    required: false,
    url: "https://fonts.example.test/a.woff",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    mime: "font/woff",
    fontId: "font",
    version: "1",
    family: "fixture",
    purpose: "test",
    coverage: "test",
    use: "test",
  };
  const { create } = await fixture(t, { ...manifest, entries: [entry] });
  let calls = 0;
  const service = create({
    fetch: async () => {
      calls++;
      return new Response(calls === 1 ? "fail" : bytes);
    },
  });
  const session = partition();
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {
      assert.fail("font must not fail document");
    },
  });
  const request = () =>
    session.handlers.get("https")(
      new Request(entry.url, {
        headers: { Cookie: "must-not-forward", Referer: "private-document" },
      }),
    );
  assert.equal((await request()).status, 503);
  assert.equal((await request()).status, 503);
  assert.equal(calls, 1);
  assert.equal(service.state("doc").fontFailures, 1);
  await attached.retry();
  assert.equal(service.state("doc").readyOnReopen, true);
  assert.equal((await request()).status, 200);
  assert.equal(service.state("doc").fontFailures, 0);
  assert.equal(calls, 2);
  attached.dispose();
});

test("page disposal aborts its font request and late completion cannot restore resource state", async (t) => {
  const base = JSON.parse(
    await readFile(
      new URL("../resources/office-assets/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const { create } = await fixture(t, base);
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  let aborted = false;
  const service = create({
    fetch: (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("cancelled"));
          },
          { once: true },
        );
        started();
      }),
  });
  const session = partition();
  const attached = service.attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {},
  });
  const pending = session.handlers.get("https")(
    new Request(base.entries[0].url),
  );
  await ready;
  attached.dispose();
  await pending;
  assert.equal(aborted, true);
  assert.equal(session.handlers.size, 0);
  assert.equal(service.state("doc").fontFailures, 0);
});

test("asset manifest rejects reserved Windows names before copying", async (t) => {
  const bytes = Buffer.from("test");
  for (const file of [
    "CON.js",
    "fonts/NUL.font",
    "../escape.js",
    "C:\\assets\\font.woff",
    "fonts/trailing.",
  ]) {
    const entry = {
      id: "asset",
      kind: "core",
      required: true,
      path: "/static/a.js",
      file,
      mime: "text/javascript",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const { source, root } = await fixture(t, {
      ...manifest,
      entries: [entry],
    });
    assert.throws(
      () => copyOfficeAssets(source, path.join(root, "target")),
      /路径无效/,
    );
  }
});

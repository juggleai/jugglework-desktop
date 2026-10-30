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
import { createOfficeNetworkPolicy } from "./office-network.mjs";
import { runInNewContext } from "node:vm";
import { configureOfficePageResponse } from "./office-page-config.mjs";
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
    webRequest: {
      listener: null,
      onBeforeRequest(listener) {
        this.listener = listener;
      },
    },
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
    "online",
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

test("PPT 配置在 SDK 缓存建立前关闭内置 AI 编辑，保留普通编辑、保存及其他页面配置", async (t) => {
  const { create } = await fixture(t);
  const session = partition();
  session.fetch = async () => new Response(`<!doctype html><html><head>
    <script>window.AppConfig={normal:{custom:{toolbarFileMenu:{aiEdit:true,localFileSave:true}},feature:{comment:false}},reading:{toolbar:false}};</script>
    </head><body>演示内容<script>window.cachedConfig=JSON.parse(JSON.stringify(window.AppConfig));</script></body></html>`, {
    headers: { "Content-Type": "text/html", "Content-Length": "100", "ETag": "old" },
  });
  const attached = create().attach(session, {
    documentId: "slide", origin, filePath: "/tmp/a.pptx", kind: "slide",
    commit: { error: null }, save: async () => ({ engineFileId: "slide" }), onCoreFailure() {},
  });
  t.after(() => attached.dispose());
  const response = await session.handlers.get("http")(
    new Request(origin + "/static/slide/pc.html?localFilePath=/tmp/a.pptx"),
  );
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(response.headers.get("etag"), null);
  const html = await response.text();
  const scope = {};
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
    runInNewContext(script[1], { window: scope });
  assert.deepEqual(JSON.parse(JSON.stringify(scope.cachedConfig)), {
    normal: { custom: { toolbarFileMenu: { aiEdit: false, localFileSave: true } }, feature: { comment: false } },
    reading: { toolbar: false, custom: { toolbarFileMenu: { aiEdit: false } } },
  });
  assert.match(html, /演示内容/);
});

test("表格在 SDK 初始化前关闭原生 AI 入口，保留其他开关与宿主选区入口", async () => {
  const input = new Response(`<html><head><script>window.__WB_DOCS_FEATURE_LIST__={aiEdit:true,other:true};</script></head><body><script>window.cachedAi=window.__WB_DOCS_FEATURE_LIST__.aiEdit;</script></body></html>`, { headers: { "Content-Type": "text/html" } });
  const response = await configureOfficePageResponse(new Request(origin + "/static/sheet/pc.html"), input, { origin, kind: "sheet", selectionUi: true });
  const scope = {}, events = [];
  for (const script of (await response.text()).matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))
    runInNewContext(script[1], { window: scope, document: { addEventListener: (name) => events.push(name) } });
  assert.equal(scope.cachedAi, false);
  assert.equal(scope.__WB_DOCS_FEATURE_LIST__.other, true);
  assert.deepEqual(events, ["DOMContentLoaded"]);
});

test("界面配置只作用于当前来源的已绑定 HTML，不改变其他格式、资源和错误响应", async () => {
  /** @type {Array<[string, string, ResponseInit]>} */
  const cases = [
    ["doc", origin + "/static/doc/pc.html", { headers: { "Content-Type": "text/html" } }],
    ["sheet", origin + "/static/sheet/pc.html", { headers: { "Content-Type": "text/html" } }],
    ["slide", origin + "/static/slide/pc.js", {}],
    ["slide", "http://127.0.0.1:9900/static/slide/pc.html", { headers: { "Content-Type": "text/html" } }],
    ["slide", origin + "/static/slide/pc.html", { status: 404, headers: { "Content-Type": "text/html" } }],
  ];
  for (const [kind, url, init] of cases) {
    const response = new Response("original", init);
    assert.equal(await configureOfficePageResponse(new Request(url), response, { origin, kind }), response);
    assert.equal(await response.text(), "original");
  }
});

test("PPT 页面结构不匹配时报告实际故障，不能悄悄跳过配置仍声称入口已关闭", async (t) => {
  const { create } = await fixture(t);
  const session = partition();
  session.fetch = async () => new Response("<html><body>unknown</body></html>", { headers: { "Content-Type": "text/html" } });
  let failures = 0;
  const attached = create().attach(session, {
    documentId: "slide", origin, filePath: "/tmp/a.pptx", kind: "slide",
    commit: { error: null }, save: async () => ({ engineFileId: "slide" }), onCoreFailure() { failures++; },
  });
  t.after(() => attached.dispose());
  await assert.rejects(
    session.handlers.get("http")(new Request(origin + "/static/slide/pc.html")),
    /PPT 页面配置尚未适配/,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failures, 1);
});

test("local mode uses an origin and exact font allowlist for HTTP, WebSocket and embedded workers", () => {
  const font = "https://fonts.example.test/fixed.woff";
  const policy = createOfficeNetworkPolicy(origin, [
    { kind: "font", url: font },
  ]);
  for (const url of [
    origin + "/mcp",
    origin + "/static/lib/docs.qq.com/worker.js",
    "ws://127.0.0.1:8800/socket",
    "blob:" + origin + "/worker",
    "data:font/woff;base64,d09GRg==",
    font,
  ])
    assert.equal(policy.allows({ url }), true, url);
  for (const url of [
    "https://qq.com/api",
    "https://docs.qq.com/flags",
    "https://docs.qq.com./flags",
    "https://service.example.test/account",
    "wss://docs.qq.com/socket",
    "ws://127.0.0.1:8801/socket",
    "http://127.0.0.1:8801/redirect",
    font + "?text=private",
    "blob:https://service.example.test/worker",
    "file:///tmp/secret",
    "invalid-url",
  ])
    assert.equal(policy.allows({ url }), false, url);
  assert.equal(policy.allows({ url: font, method: "POST" }), false);
});

test("the session guard cancels every remote service method and WebSocket before forwarding; disposal releases the guard", async (t) => {
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
      assert.fail("online services cannot fail local editing");
    },
  });
  for (const method of ["GET", "POST", "OPTIONS", "HEAD", "PUT", "DELETE"]) {
    const request = {
      url: "https://docs.qq.com/api/unknown?xsrf=private",
      method,
    };
    session.webRequest.listener(request, (response) =>
      assert.equal(response.cancel, true),
    );
    assert.equal(
      (
        await session.handlers.get("https")(
          new Request(request.url, { method }),
        )
      ).status,
      410,
    );
  }
  session.webRequest.listener(
    { url: "wss://service.example.test/socket" },
    (response) => assert.equal(response.cancel, true),
  );
  session.webRequest.listener(
    { url: origin + "/static/worker.js" },
    (response) => assert.equal(response.cancel, false),
  );
  assert.equal(session.forwarded.length, 0);
  attached.dispose();
  assert.equal(session.webRequest.listener, null);
});

test("local forwarding returns redirects without automatically following them outside the session policy", async (t) => {
  const { create } = await fixture(t);
  const session = partition();
  session.fetch = async (request, options) => {
    session.forwarded.push({ request, options });
    assert.equal(options.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { Location: "https://service.example.test/account" },
    });
  };
  const attached = create().attach(session, {
    documentId: "doc",
    origin,
    filePath: "/tmp/a.docx",
    kind: "doc",
    commit: { error: null },
    save: async () => ({ engineFileId: "file" }),
    onCoreFailure() {},
  });
  assert.equal(
    (await session.handlers.get("http")(new Request(origin + "/redirect")))
      .status,
    302,
  );
  session.webRequest.listener(
    { url: "https://service.example.test/account" },
    (response) => assert.equal(response.cancel, true),
  );
  assert.equal(session.forwarded.length, 1);
  attached.dispose();
});

test("online services, executable code and unlisted fonts cannot leave the local-mode boundary", async (t) => {
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
      410,
    );
  }
  assert.equal(
    classifyOfficeResource(
      "https://other.test/extension",
      origin,
      manifest,
      "worker",
    ).kind,
    "online",
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { authorizeFileWindowFetch, fetchFileWindowResponse, FILE_WINDOW_RESPONSE_LIMITS_V1 } from "./file-window-fetch.mjs";

const access = { baseUrl: "http://127.0.0.1:1234", clientToken: "main-only" };
const entry = () => ({ workspaceId: "ws", sessionId: "ses", tabs: [
  { path: "目录/报告.docx", documentId: "od_A" }, { path: "notes.md" },
] });
const url = (route) => `${access.baseUrl}/workspace/ws/${route}`;
const post = (body) => ({ method: "POST", body: JSON.stringify(body) });

test("registered paths and Office operations retain binary and JSON compatibility", async () => {
  const context = entry();
  for (const route of ["files/raw?path=notes.md", "files/stat?path=notes.md", "office/capabilities", "office/od_A"]) {
    const request = authorizeFileWindowFetch(context, access, url(route), { headers: { Accept: "application/json" } });
    assert.equal(request.init.headers.Authorization, "Bearer main-only");
    assert.equal(request.init.headers.Host, undefined);
    assert.equal(request.init.redirect, "error");
  }
  authorizeFileWindowFetch(context, access, url("office/open"), post({ sessionId: "ses", path: "目录/报告.docx" }));
  authorizeFileWindowFetch(context, access, url("office/od_A/save"), post({}));
  const bytes = new Uint8Array([0, 255, 128, 42]);
  const result = await fetchFileWindowResponse(context, access, url("files/raw?path=notes.md"), {}, async (_url, init) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    return new Response(bytes);
  });
  assert.deepEqual(new Uint8Array(structuredClone(result).body), bytes);
});

test("deny arbitrary origins, workspaces, sessions, paths, endpoints and extra parameters before transport", async () => {
  const context = entry();
  const cases = [
    ["https://example.com/", {}], ["file:///etc/passwd", {}],
    ["http://127.0.0.1:1235/workspace/ws/office/capabilities", {}],
    ["http://localhost:1234/workspace/ws/office/capabilities", {}],
    ["http://user:pass@127.0.0.1:1234/workspace/ws/office/capabilities", {}],
    [url("office/capabilities#fragment"), {}],
    [`${access.baseUrl}/workspace/other/files/raw?path=notes.md`, {}],
    [url("files/raw?path=secret.txt"), {}],
    [url("files/raw?path=notes.md&path=secret.txt"), {}],
    [url("files/raw?path=notes.md&sessionId=other"), {}],
    [url("files/raw?path=..%2Fnotes.md"), {}],
    [url("files/raw?path=%252e%252e%252fnotes.md"), {}],
    [url("files/raw?path=notes.md"), { method: "DELETE" }],
    [url("files/raw?path=notes.md"), { body: "payload" }],
    [url("office/open"), post({ sessionId: "other", path: "notes.md" })],
    [url("office/open"), post({ sessionId: "ses", path: "secret.txt" })],
    [url("office/open"), post({ sessionId: "ses", path: "notes.md", workspaceId: "other" })],
    [url("office/od_other"), {}], [url("office/od_other/save"), post({})],
    [url("office/od_A/save"), post({ force: true })],
    [url("files/content"), post({ path: "notes.md", content: "overwrite" })],
    [`${access.baseUrl}/workspaces`, {}],
    [url("office/open"), { method: "POST", body: "x".repeat(65537) }],
    [url("office/open"), { method: "POST", bodyBytes: new Uint8Array(65537) }],
    [url("office/capabilities"), { headers: { Authorization: "attacker" } }],
    [url("office/capabilities"), { headers: { Host: "evil" } }],
  ];
  let calls = 0;
  for (const [target, init] of cases) {
    await assert.rejects(fetchFileWindowResponse(context, access, target, init, async () => { calls++; }));
  }
  assert.equal(calls, 0);
  context.tabs.push({ path: "../notes.md" }, { path: "C:/notes.md" }, { path: "a\\b" });
  for (const path of ["../notes.md", "C:/notes.md", "a\\b"]) {
    assert.throws(() => authorizeFileWindowFetch(context, access, url(`files/raw?path=${encodeURIComponent(path)}`)));
  }
});

test("versioned response limits allow an intact 9 MiB registered PDF binary", async () => {
  assert.deepEqual(FILE_WINDOW_RESPONSE_LIMITS_V1, { json: 8 * 1024 * 1024, raw: 64 * 1024 * 1024 });
  assert.ok(Object.isFrozen(FILE_WINDOW_RESPONSE_LIMITS_V1));
  const context = entry();
  context.tabs.push({ path: "report.pdf" });
  const bytes = new Uint8Array(9 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
  bytes.set(Buffer.from("%PDF-1.7\n"));
  for (const declared of [false, true]) {
    const result = await fetchFileWindowResponse(context, access, url("files/raw?path=report.pdf"), {}, async () =>
      new Response(new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
            controller.enqueue(bytes.subarray(offset, offset + 1024 * 1024));
          }
          controller.close();
        },
      }), { headers: { "content-type": "application/pdf", ...(declared ? { "content-length": String(bytes.length) } : {}) } }));
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(structuredClone(result).body), bytes);
  }
});

test("raw rejects declared and streaming responses above 64 MiB and cancels the body", async () => {
  const run = (fetchImpl, init = {}) => fetchFileWindowResponse(entry(), access, url("files/raw?path=notes.md"), init, fetchImpl);
  const limit = FILE_WINDOW_RESPONSE_LIMITS_V1.raw;
  let declaredCancelled = false;
  await assert.rejects(run(async () => new Response(new ReadableStream({
    cancel() { declaredCancelled = true; },
  }), { headers: { "content-length": String(limit + 1) } })), /响应过大/);
  assert.equal(declaredCancelled, true);
  for (const contentLength of [undefined, "1"]) {
    let cancelled = false;
    let emitted = 0;
    const chunk = new Uint8Array(1024 * 1024);
    await assert.rejects(run(async () => new Response(new ReadableStream({
      pull(controller) {
        const value = emitted < limit ? chunk : new Uint8Array(1);
        emitted += value.byteLength;
        controller.enqueue(value);
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: contentLength ? { "content-length": contentLength } : {} })), /响应过大/);
    assert.equal(emitted, limit + 1);
    assert.equal(cancelled, true);
  }
});

test("all non-raw endpoints still reject 9 MiB JSON regardless of path or MIME type", async () => {
  const context = entry();
  context.tabs.push({ path: "files/raw" }, { path: "raw.pdf", documentId: "raw" });
  const cases = [
    ["files/stat?path=files%2Fraw", {}],
    ["files/content?path=files%2Fraw", {}],
    ["office/capabilities", {}],
    ["office/od_A", {}],
    ["office/raw", {}],
    ["office/od_A/save", post({})],
    ["office/open", post({ sessionId: "ses", path: "files/raw" })],
    ["office/reopen", post({ sessionId: "ses", path: "files/raw" })],
  ];
  const bytes = new Uint8Array(9 * 1024 * 1024).fill(32);
  bytes.set(Buffer.from("{}"));
  for (const [route, init] of cases) {
    for (const declared of [false, true]) {
      let cancelled = false;
      await assert.rejects(fetchFileWindowResponse(context, access, url(route), init, async () =>
        new Response(new ReadableStream({
          pull(controller) { controller.enqueue(bytes); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }), { headers: {
          "content-type": declared ? "application/json" : "application/octet-stream",
          ...(declared ? { "content-length": String(bytes.length) } : {}),
      } })), /响应过大/, String(route));
      assert.equal(cancelled, true, String(route));
    }
  }
});

test("reject redirects and cancel their bodies; enforce header/body deadlines", async () => {
  const run = (fetchImpl, init = {}) => fetchFileWindowResponse(entry(), access, url("files/raw?path=notes.md"), init, fetchImpl);
  for (const redirected of [false, true]) {
    let cancelled = false;
    await assert.rejects(run(async (_url, init) => {
      assert.equal(init.redirect, "error");
      const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }),
        { status: redirected ? 200 : 302, headers: { location: "https://example.com" } });
      if (redirected) Object.defineProperty(response, "redirected", { value: true });
      return response;
    }));
    assert.equal(cancelled, true);
  }
  await assert.rejects(run(() => new Promise(() => {}), { timeoutMs: 10 }), /超时/);
  let cancelled = false;
  await assert.rejects(run(async () => new Response(new ReadableStream({
    start() {},
    cancel() { cancelled = true; },
  })), { timeoutMs: 10 }), /超时/);
  assert.equal(cancelled, true);
});

test("only bind Office open/reopen response IDs to the exact registered workspace/session/path", async () => {
  const context = entry();
  const document = { documentId: "od_new", workspaceId: "ws", ownerSessionId: "ses", relativePath: "notes.md" };
  const open = (value) => fetchFileWindowResponse(context, access, url("office/reopen"), post({ sessionId: "ses", path: "notes.md" }), async () => Response.json({ document: value }));
  for (const value of [{ ...document, workspaceId: "other" }, { ...document, ownerSessionId: "other" }, { ...document, relativePath: "secret" }]) {
    await assert.rejects(open(value));
    assert.equal(context.tabs[1].documentId, undefined);
  }
  await open(document);
  authorizeFileWindowFetch(context, access, url("office/od_new"));
  context.tabs.pop();
  assert.throws(() => authorizeFileWindowFetch(context, access, url("office/od_new")));
});

test("only the requested tab's exact Main-registered document ID permits an alias response", async () => {
  for (const route of ["open", "reopen"]) {
    const context = entry();
    const document = { documentId: "od_A", workspaceId: "ws", ownerSessionId: "ses", relativePath: "canonical/报告.docx" };
    const open = (path, value) => fetchFileWindowResponse(context, access, url(`office/${route}`),
      post({ sessionId: "ses", path }), async () => Response.json({ document: value }));
    await open("目录/报告.docx", document);
    assert.equal(context.tabs[0].documentId, "od_A");
    authorizeFileWindowFetch(context, access, url("office/od_A"));
    authorizeFileWindowFetch(context, access, url("office/od_A/save"), post({}));
    for (const value of [
      { ...document, documentId: "od_new" },
      { ...document, documentId: "od_A_suffix" },
      { ...document, documentId: 42 },
      { ...document, workspaceId: "other" },
      { ...document, ownerSessionId: "other" },
    ]) {
      await assert.rejects(open("目录/报告.docx", value));
      assert.equal(context.tabs[0].documentId, "od_A");
    }
    // 其他标签已登记的 ID 不能用于为当前标签绕过路径匹配。
    await assert.rejects(open("notes.md", document));
    assert.equal(context.tabs[1].documentId, undefined);
    assert.throws(() => authorizeFileWindowFetch(context, access, url("files/raw?path=canonical%2F报告.docx")));
  }
});

test("real HTTP transport never follows a redirect even to the same managed origin", async () => {
  let redirectTargetHits = 0;
  const server = createServer((request, response) => {
    if (request.url === "/forbidden") {
      redirectTargetHits++;
      response.end("secret");
    } else {
      response.writeHead(302, { location: "/forbidden" });
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await assert.rejects(fetchFileWindowResponse(entry(), { ...access, baseUrl },
      `${baseUrl}/workspace/ws/files/raw?path=notes.md`, {}, fetch));
    assert.equal(redirectTargetHits, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("conversation POST transport failures and deadlines have a fixed unconfirmed outcome without diagnostics", async () => {
  const context = { ...entry(), workspaceRoot: "/project", conversation: { desktopConfig: {} } };
  const body = post({ origin: "local-renderer", startCommandCorrelationId: null, prompt: {
    model: { providerID: "provider", modelID: "model" }, parts: [{ type: "text", text: "hello" }],
  } });
  const provider = () => Response.json({ all: [{ id: "provider", source: "api", models: { model: { id: "model" } } }], connected: ["provider"] });
  const expected = { message: "fetch failed: submission outcome unconfirmed" };
  for (const failure of [
    async () => { throw new Error("secret provider endpoint and bearer token"); },
    () => new Promise(() => {}),
    async () => new Response(new ReadableStream({ start() {}, cancel() {} })),
    async () => new Response(new ReadableStream({ pull() { throw new Error("secret read failure"); } })),
  ]) {
    await assert.rejects(fetchFileWindowResponse(context, access, url("sessions/ses/runs/start"), { ...body, timeoutMs: 30 },
      (target) => target.endsWith("/opencode/provider") ? Promise.resolve(provider()) : failure()), expected);
  }
  // Failure before the mutation is sent is a definite rejection, not an ambiguous submission.
  await assert.rejects(fetchFileWindowResponse(context, access, url("sessions/ses/runs/start"), body,
    async () => { throw new Error("secret preflight"); }), { message: "文件窗口会话请求不可用" });
  const rejection = await fetchFileWindowResponse(context, access, url("sessions/ses/runs/start"), body,
    async (target) => target.endsWith("/opencode/provider") ? provider() : Response.json({ code: "model_blocked", message: "secret" }, { status: 403 }));
  assert.equal(rejection.status, 403);
  assert.deepEqual(JSON.parse(Buffer.from(rejection.body).toString()), { error: "File-window session request failed", code: "model_blocked" });
});

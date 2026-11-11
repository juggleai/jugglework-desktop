/** 只在独占测试浏览器、临时 Word 文件和明确的可丢弃组织中运行；不代表完整 Word 双向验收。 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createOfficeWordBlocksAdapter,
  readOfficeWordBlocks,
} from "../apps/desktop/electron/office-word-blocks-adapter.mjs";
import { createOfficeCloudDocsSession } from "../apps/desktop/electron/office-cloud-docs-session.mjs";
const require = createRequire(import.meta.url);
const required = [
  "JW_TEST_PLAYWRIGHT_MODULE",
  "JW_TEST_DOCS_REPO",
  "JW_TEST_SOURCE_URL",
  "JW_TEST_WORD_CDP",
  "JW_TEST_DOCS_CDP",
  "JW_TEST_WORD_PATH",
  "JW_TEST_TENANT_ID",
  "JW_TEST_PEER_ACCOUNT",
  "JW_TEST_PEER_PASSWORD",
];
for (const key of required) assert.ok(process.env[key], key + " required");
assert.equal(process.env.JW_TEST_MUTATION_CONFIRM, "disposable-word-and-docs");
for (const key of [
  "JW_TEST_SOURCE_URL",
  "JW_TEST_WORD_CDP",
  "JW_TEST_DOCS_CDP",
])
  assert.equal(
    new URL(process.env[key]).hostname,
    "127.0.0.1",
    "Local test services only",
  );
const { resolve, isAbsolute, relative } = await import("node:path");
const { tmpdir } = await import("node:os");
const wordPath = resolve(process.env.JW_TEST_WORD_PATH);
const realWordPath = fs.realpathSync(wordPath);
const temporaryRoots = [
  fs.realpathSync(tmpdir()),
  ...(process.platform === "win32" ? [] : [fs.realpathSync("/tmp")]),
];
assert.ok(
  temporaryRoots.some((root) => {
    const child = relative(root, realWordPath);
    return (
      child &&
      child !== ".." &&
      !child.startsWith("../") &&
      !child.startsWith("..\\") &&
      !isAbsolute(child)
    );
  }),
  "Word fixture must be under a system temporary directory",
);
const { chromium } = require(process.env.JW_TEST_PLAYWRIGHT_MODULE);
let mcpUrl,
  mcpSession,
  rpcId = 0;
async function rpc(method, params) {
  const response = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json,text/event-stream",
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.ok(response.ok, "Office RPC failed");
  mcpSession = response.headers.get("mcp-session-id") || mcpSession;
  const text = await response.text();
  const envelope = JSON.parse(
    text.trim().startsWith("{")
      ? text
      : text
          .split("\n")
          .find((line) => line.startsWith("data: "))
          .slice(6),
  );
  if (envelope.error) throw new Error(envelope.error.message);
  return envelope.result;
}
const c = {
  async init() {
    return rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jugglework-word-probe", version: "1" },
    });
  },
  async tool(name, args) {
    if (name.startsWith("doc_") && !args.file_id) {
      const pool = await c.tool("get_pool_status", {});
      const editor = pool.open_editors.find(
        (e) => resolve(e.file_path || "/") === wordPath,
      );
      assert.ok(editor, "Word fixture is not open");
      args = { ...args, file_id: editor.file_id };
    }
    const result = await rpc("tools/call", { name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result));
    const text = result.content.find((c) => c.type === "text").text;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  },
};
const wordBrowser = await chromium.connectOverCDP(process.env.JW_TEST_WORD_CDP);
const docsBrowser = await chromium.connectOverCDP(process.env.JW_TEST_DOCS_CDP);
let peerContext, docsContext;
let controller;
try {
  const word = wordBrowser.contexts()[0].pages()[0];
  docsContext = await docsBrowser.newContext();
  const docs = await docsContext.newPage();
  const ownerSession = JSON.parse(
    fs.readFileSync(process.env.JW_TEST_OWNER_SESSION_PATH, "utf8"),
  );
  const home = await sourcePost(
    "/api/v1/docs/launch",
    {
      tenantId: process.env.JW_TEST_TENANT_ID,
      target: { kind: "home" },
      presentation: { instanceId: crypto.randomUUID(), mode: "product" },
    },
    ownerSession.token,
  );
  await docs.setContent('<form method="POST"><input name="grant"></form>');
  await docs.evaluate((g) => {
    const f = document.querySelector("form");
    f.action = g.bootstrapUrl;
    f.querySelector("input").value = g.launchGrant;
    f.submit();
  }, home);
  await docs.waitForURL(/\/workspace\//);
  await docs.waitForSelector("affine-paragraph,button");
  mcpUrl = new URL("/mcp", word.url()).href;
  await c.init();
  await word.reload();
  await word.waitForFunction(
    () => App?.GlobalConfig?.isLocalEditChunkFinish === true,
  );
  const baseline = await word.evaluate(
    (src) => eval("(" + src + ")")(window),
    readOfficeWordBlocks.toString(),
  );
  assert.equal(baseline.length, 1);
  assert.ok(Array.from(baseline[0].text).length >= 4);
  const context = await docs.evaluate(() =>
    fetch("/api/jw/session/context", { cache: "no-store" }).then((r) =>
      r.json(),
    ),
  );
  assert.equal(context.tenantId, process.env.JW_TEST_TENANT_ID);
  await docs.goto(
    new URL("/workspace/" + context.workspaceId + "/all", docs.url()).href,
  );
  await docs.getByRole("button", { name: /^(New Doc|新建文档)$/i }).click();
  await docs.waitForSelector("affine-paragraph");
  await docs.locator("div[contenteditable=true]").first().click();
  await docs.keyboard.type("Word composed session verification " + Date.now());
  const bindings = await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, blocks) => {
      if (el.model.props.text.length) throw Error("Blank fixture required");
      const s = el.store,
        p = s.getParent(el.model),
        Text = el.model.props.text.constructor;
      let id;
      s.transact(() => {
        id = s.addBlock(
          "affine:paragraph",
          { type: "text", text: new Text(blocks[0].text) },
          p.id,
        );
        s.deleteBlock(el.model);
      });
      return [{ paragraphId: blocks[0].id, blockId: id }];
    }, baseline);
  const pageId = new URL(docs.url()).pathname.split("/").pop();
  async function sourcePost(path, body, token) {
    const r = await fetch(process.env.JW_TEST_SOURCE_URL + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return r.json();
  }
  const ownerGrant = await sourcePost(
    "/api/v1/docs/launch",
    {
      tenantId: process.env.JW_TEST_TENANT_ID,
      target: { kind: "page", pageId },
      presentation: { instanceId: crypto.randomUUID(), mode: "editor" },
    },
    ownerSession.token,
  );
  const messages = [];
  await docs.exposeFunction("__receiveEditor", (m) => {
    messages.push(m);
    if (m.type === "editor.pending") controller?.nativeChanged();
    if (m.type === "editor.structure") controller?.nativeStructure(m.payload);
  });
  await docs.context().addInitScript(() => {
    if (window.__editorListenerInstalled) return;
    window.__editorListenerInstalled = true;
    window.__editorResponses = {};
    window.__editorMessages = [];
    window.addEventListener("message", (e) => {
      if (
        e.source !== window ||
        e.origin !== location.origin ||
        e.data?.channel !== "jugglework-docs-editor"
      )
        return;
      const m = e.data.message;
      __editorMessages.push(m);
      if (m.type === "editor.ready") window.__editorReady = m;
      if (m.type === "editor.response")
        __editorResponses[m.payload.requestId] = m.payload.result;
      window.__receiveEditor?.(m);
    });
  });
  await docs.setContent('<form method="POST"><input name="grant"></form>');
  await docs.evaluate((g) => {
    const f = document.querySelector("form");
    f.action = g.bootstrapUrl;
    f.querySelector("input").value = g.launchGrant;
    f.submit();
  }, ownerGrant);
  await docs.waitForURL(/\/workspace\//);
  await docs.waitForFunction(() => window.__editorReady, null, {
    timeout: 30000,
  });
  const ready = await docs.evaluate(() => __editorReady);
  assert.equal(ready.payload.canEdit, true);
  const peer = await sourcePost("/api/auth/sign-in/account", {
    account: process.env.JW_TEST_PEER_ACCOUNT,
    password: process.env.JW_TEST_PEER_PASSWORD,
  });
  const peerGrant = await sourcePost(
    "/api/v1/docs/launch",
    {
      tenantId: process.env.JW_TEST_TENANT_ID,
      target: { kind: "page", pageId },
      presentation: { instanceId: crypto.randomUUID(), mode: "product" },
    },
    peer.token,
  );
  peerContext = await docsBrowser.newContext();
  const peerPage = await peerContext.newPage();
  await peerPage.setContent('<form method="POST"><input name="grant"></form>');
  await peerPage.evaluate((g) => {
    const f = document.querySelector("form");
    f.action = g.bootstrapUrl;
    f.querySelector("input").value = g.launchGrant;
    f.submit();
  }, peerGrant);
  await peerPage.waitForURL(/\/workspace\//);
  await peerPage.waitForSelector("affine-paragraph");
  const wordEvents = [],
    states = [];
  const wordBinding = "__jwWord_" + crypto.randomUUID().replaceAll("-", "");
  await word.exposeFunction(wordBinding, (event) => {
    wordEvents.push(event);
    controller?.wordChanged(event);
  });
  await word.evaluate(
    ({ read, create, blocks, binding }) => {
      window.__readBlocks = eval("(" + read + ")");
      window.__wordPauses = [];
      window.__adapter = eval("(" + create + ")")(
        {
          blocks,
          onChange: (e) => window[binding](e),
          onStructure: (e) => window[binding](e),
          onPause: (r) => __wordPauses.push(r),
        },
        window,
        __readBlocks,
      );
    },
    {
      read: readOfficeWordBlocks.toString(),
      create: createOfficeWordBlocksAdapter.toString(),
      blocks: baseline,
      binding: wordBinding,
    },
  );
  let held, release, firstApply;
  const gate = new Promise((resolve) => (release = resolve));
  const nativeCall = async (type, payload, id = crypto.randomUUID()) => {
    if (type === "editor.apply" && held === true) {
      held = "waiting";
      firstApply = { type, payload, id };
      await gate;
    }
    await docs.evaluate(
      ({ type, payload, id }) => {
        const r = __editorReady;
        window.postMessage(
          {
            channel: "jugglework-docs-editor-command",
            message: {
              type,
              contractVersion: 1,
              instanceId: r.instanceId,
              bridgeId: r.bridgeId,
              tenantId: r.tenantId,
              workspaceId: r.workspaceId,
              pageId: r.pageId,
              requestId: id,
              payload,
            },
          },
          location.origin,
        );
      },
      { type, payload, id },
    );
    await docs.waitForFunction(
      (id) => Object.prototype.hasOwnProperty.call(__editorResponses, id),
      id,
      { timeout: 10000 },
    );
    return docs.evaluate((id) => __editorResponses[id], id);
  };
  let injectBeforeApply = false,
    staleProjections = 0;
  controller = createOfficeCloudDocsSession({
    word: {
      snapshot: () => word.evaluate(() => __adapter.snapshot()),
      apply: async (frames, revision) => {
        if (injectBeforeApply && frames.length) {
          injectBeforeApply = false;
          await word.locator("#melo-hidden-editor").focus();
          await word.evaluate(() =>
            pad.editor.service
              .getDocument()
              .getRange(0, 0, { updateSelection: false })
              .select(),
          );
          await word.keyboard.insertText("追");
          await word.waitForTimeout(50);
        }
        const result = await word.evaluate(
          ({ frames, revision }) =>
            __adapter.applyRemoteAtRevision(frames, revision),
          { frames, revision },
        );
        if (result.status === "stale") staleProjections++;
        return result;
      },
      structure: (change, revision) =>
        word.evaluate(
          ({ change, revision }) =>
            __adapter.applyRemoteStructureAtRevision(change, revision),
          { change, revision },
        ),
    },
    native: { call: nativeCall },
    onState: (s) => states.push(s),
  });
  assert.equal((await controller.attach(bindings)).status, "active");
  await controller.flush();
  async function flush() {
    const result = await controller.flush();
    assert.equal(result.status, "active", JSON.stringify(states));
    await word.waitForTimeout(750);
    assert.equal(controller.state().status, "active", JSON.stringify(states));
    assert.equal(
      await word.evaluate(() => __adapter.state()),
      "active",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
  }
  const snapshot = () => {
    const e = document.querySelector("affine-paragraph");
    return e.store
      .getParent(e.model)
      .children.map((m) => ({ id: m.id, text: m.props.text.toString() }));
  };
  async function converged() {
    const blocks = await word.evaluate(
      (src) => eval("(" + src + ")")(window),
      readOfficeWordBlocks.toString(),
    );
    for (const page of [docs, peerPage])
      await page.waitForFunction(
        ({ src, expected }) =>
          JSON.stringify(eval("(" + src + ")")().map((b) => b.text)) ===
          JSON.stringify(expected),
        { src: snapshot.toString(), expected: blocks.map((b) => b.text) },
        { timeout: 20000 },
      );
    return blocks;
  }
  // 先让 Word 输入发生，再刻意延迟其到原生 Store 的传送；其间另一成员已改同一位置。
  held = true;
  await word.locator("#melo-hidden-editor").focus();
  await word.evaluate(() =>
    pad.editor.service
      .getDocument()
      .getRange(1, 1, { updateSelection: false })
      .select(),
  );
  await word.keyboard.insertText("本😀");
  for (let i = 0; i < 100 && held !== "waiting"; i++)
    await word.waitForTimeout(20);
  assert.equal(held, "waiting");
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) =>
      el.store.transact(() => el.model.props.text.insert("云😀", 1)),
    );
  await docs.waitForFunction(() =>
    document
      .querySelector("affine-paragraph")
      .model.props.text.toString()
      .includes("云😀"),
  );
  held = false;
  release();
  await flush();
  const merged = await converged();
  assert.ok(merged[0].text.includes("云😀") && merged[0].text.includes("本😀"));
  const beforeReplay = await docs.evaluate(snapshot);
  assert.equal(
    (await nativeCall(firstApply.type, firstApply.payload, firstApply.id))
      .status,
    "applied",
  );
  assert.deepEqual(
    await docs.evaluate(snapshot),
    beforeReplay,
    "Duplicate request replayed body",
  );
  assert.equal(
    (await nativeCall(firstApply.type, { frames: [] }, firstApply.id)).reason,
    "operation_conflict",
  );
  injectBeforeApply = true;
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) =>
      el.store.transact(() => el.model.props.text.insert("远", 0)),
    );
  await docs.waitForTimeout(100);
  await flush();
  assert.ok((await converged())[0].text.includes("追"));
  assert.ok(
    staleProjections > 0,
    "Expected stale projection to be refused before any SDK write",
  );
  const point = Array.from(
    (await word.evaluate(() => __readBlocks(window)))[0].text,
  )
    .slice(0, 3)
    .join("").length;
  await word.locator("#melo-hidden-editor").focus();
  await word.evaluate(
    (point) =>
      pad.editor.service
        .getDocument()
        .getRange(point, point, { updateSelection: false })
        .select(),
    point,
  );
  await word.keyboard.press("Enter");
  await word.keyboard.insertText("拆后");
  await flush();
  assert.equal((await converged()).length, 2);
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) => {
      const s = el.store,
        p = s.getParent(el.model),
        m = p.children[0];
      s.transact(() => {
        const right = m.props.text.split(1);
        s.addBlock("affine:paragraph", { type: "text", text: right }, p.id, 1);
      });
    });
  await docs.waitForTimeout(100);
  await flush();
  assert.equal((await converged()).length, 3);
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) => {
      const s = el.store,
        [l, r] = s.getParent(el.model).children;
      s.transact(() => {
        l.props.text.join(r.props.text);
        s.deleteBlock(r);
      });
    });
  await docs.waitForTimeout(100);
  await flush();
  assert.equal((await converged()).length, 2);
  const current = await word.evaluate(() => __readBlocks(window));
  await c.tool("doc_insert_text", { idx: current[1].start + 1, text: "AI" });
  await flush();
  assert.ok(wordEvents.some((e) => e.source === "ai"));
  await converged();
  const end = Array.from(
    (await word.evaluate(() => __readBlocks(window)))[0].text,
  )
    .slice(0, 2)
    .join("").length;
  await c.tool("doc_update_text_property", {
    ranges: [{ begin: 0, end }],
    bold: true,
    italic: true,
  });
  await flush();
  await converged();
  const final = await word.evaluate(() => __readBlocks(window));
  const finalNativeState = await nativeCall("editor.state", {});
  assert.equal(finalNativeState.synchronized, true);
  assert.equal(controller.state().status, "active");
  controller.dispose();
  await nativeCall("editor.detach", {});
  await word.evaluate(() => __adapter.dispose());
  const pool = await c.tool("get_pool_status", {}),
    id = pool.open_editors.find(
      (e) => resolve(e.file_path || "/") === wordPath,
    ).file_id;
  await c.tool("save_file", { file_id: id, file_path: wordPath });
  await c.tool("close_file", { file_id: id, force: true });
  await word.reload();
  await word.waitForFunction(
    () => App?.GlobalConfig?.isLocalEditChunkFinish === true,
  );
  assert.deepEqual(
    await word.evaluate(
      (src) => eval("(" + src + ")")(window),
      readOfficeWordBlocks.toString(),
    ),
    final,
  );
  for (const page of [docs, peerPage]) {
    await page.reload();
    await page.waitForSelector("affine-paragraph");
  }
  await converged();
  for (const page of [docs, peerPage]) {
    const actual = await page
      .locator("affine-paragraph")
      .first()
      .evaluate(
        (el, bindings) =>
          bindings.map((binding) => {
            const m = el.store.getBlock(binding.blockId).model;
            const marks = [];
            let index = 0;
            for (const delta of m.props.text.yText.toDelta()) {
              const bold = delta.attributes?.bold === true,
                italic = delta.attributes?.italic === true,
                previous = marks.at(-1);
              if (
                previous &&
                previous.bold === bold &&
                previous.italic === italic
              )
                previous.length += delta.insert.length;
              else
                marks.push({
                  index,
                  length: delta.insert.length,
                  bold,
                  italic,
                });
              index += delta.insert.length;
            }
            return {
              id: binding.paragraphId,
              text: m.props.text.toString(),
              kind: m.props.type,
              marks,
            };
          }),
        finalNativeState.bindings,
      );
    assert.deepEqual(
      actual,
      final.map(({ start, ...block }) => block),
    );
  }
  const report = {
    passed: true,
    pageId,
    nativeSourceBridge: true,
    desktopSourceController: true,
    unforwardedSamePositionInsert: true,
    staleProjectionPreservesFollowingInput: true,
    wordAndCloudStructureInOneSession: true,
    continuedTextAndAiAfterStructure: true,
    boldItalicInComposedSession: true,
    duplicateRequestNoReplay: true,
    conflictingRequestIdRejected: true,
    savedReopened: true,
    twoNativeClientsReloaded: true,
    productionOfficeUiEntry: false,
    fullMilestone4Passed: false,
  };
  if (process.env.JW_TEST_REPORT_PATH)
    fs.writeFileSync(
      process.env.JW_TEST_REPORT_PATH,
      JSON.stringify(report, null, 2),
    );
  console.log(report);
} finally {
  controller?.dispose();
  await peerContext?.close();
  await docsContext?.close();
  await wordBrowser.close();
  await docsBrowser.close();
}

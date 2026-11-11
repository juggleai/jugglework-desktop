/** 只在独占测试浏览器、临时 Word 文件和明确的可丢弃组织中运行；不代表完整 Word 双向验收。 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createOfficeWordParagraphAdapter } from "../apps/desktop/electron/office-word-paragraph-adapter.mjs";
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
const ts = require(
  resolve(
    process.env.JW_TEST_DOCS_REPO,
    "node_modules/@typescript/old/lib/typescript.js",
  ),
);
const source = fs.readFileSync(
  resolve(
    process.env.JW_TEST_DOCS_REPO,
    "packages/frontend/core/src/utils/jugglework-word-paragraph-probe.ts",
  ),
  "utf8",
);
const native = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    ).toString("base64")
);
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
const wordBrowser = await chromium.connectOverCDP(process.env.JW_TEST_WORD_CDP),
  docsBrowser = await chromium.connectOverCDP(process.env.JW_TEST_DOCS_CDP);
let peerContext;
try {
  const word = wordBrowser.contexts()[0].pages()[0],
    docs = docsBrowser.contexts()[0].pages()[0];
  mcpUrl = new URL("/mcp", word.url()).href;
  assert.equal(new URL(mcpUrl).hostname, "127.0.0.1");
  await c.init();
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
  await docs.locator('div[contenteditable="true"]').first().click();
  await docs.keyboard.press(
    process.platform === "darwin" ? "Meta+A" : "Control+A",
  );
  await docs.keyboard.type("Word paragraph verification " + Date.now());
  await word.reload();
  await word.waitForFunction(
    () => getLocalEditManager?.()?.getLocalEditService?.()?.isFirstChunkApplied,
    null,
    { timeout: 15000 },
  );
  const structure = await c.tool("doc_resolve_document_structure", {
    mode: "full",
    limit: 0,
  });
  assert.equal(structure.nodes.length, 1);
  const para = structure.nodes[0];
  const base = await word.evaluate(
    (end) => pad.editor.service.getDocument().readText(0, end),
    para.end_index,
  );
  await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, base) => {
      if (el.model.text.length) throw Error("Use a blank fixture");
      el.store.transact(() => el.model.text.insert(base, 0));
    }, base);
  await word.evaluate(
    ({ source, paragraphId, text }) => {
      window.__wordEvents = [];
      window.__pauses = [];
      window.__wordAdapter = eval("(" + source + ")")(
        {
          paragraphId,
          start: 0,
          text,
          onChange: (e) => __wordEvents.push(e),
          onPause: (e) => __pauses.push(e),
        },
        window,
      );
    },
    {
      source: createOfficeWordParagraphAdapter.toString(),
      paragraphId: para.paragraph_id,
      text: base,
    },
  );
  await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, source) => {
      window.__cloudEvents = [];
      window.__nativePauses = [];
      window.__nativeProbe = eval("(" + source + ")")({
        store: el.store,
        blockId: el.model.id,
        onChange: (e) => __cloudEvents.push(e),
        onPause: (e) => __nativePauses.push(e),
      });
    }, native.createNativeWordParagraphProbe.toString());
  const blockId = await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el) => el.model.id);
  const common = { text: base };
  let consumed = 0;
  async function forwardWord() {
    const events = await word.evaluate(() => __wordEvents);
    for (const event of events.slice(consumed)) {
      if (event.source === "cloud") continue;
      const result = await docs.evaluate(
        ({ expectedText, edits }) =>
          __nativeProbe.applyLocal(expectedText, edits),
        { expectedText: common.text, edits: event.edits },
      );
      assert.equal(
        result.status,
        "applied",
        JSON.stringify(await docs.evaluate(() => __nativePauses)),
      );
      for (const edit of event.edits) {
        if (edit.kind === "insert")
          common.text =
            common.text.slice(0, edit.index) +
            edit.text +
            common.text.slice(edit.index);
        else
          common.text =
            common.text.slice(0, edit.index) +
            common.text.slice(edit.index + edit.length);
      }
    }
    consumed = events.length;
  }
  async function waitWordCount(minimum) {
    await word.waitForFunction(
      (count) =>
        __wordEvents.length >= count || __wordAdapter.state() !== "active",
      minimum,
    );
    assert.equal(
      await word.evaluate(() => __wordAdapter.state()),
      "active",
      JSON.stringify(await word.evaluate(() => __pauses)),
    );
  }
  await word.locator("#melo-hidden-editor").focus();
  await word.keyboard.press("Control+Home");
  await word.keyboard.insertText("人工壬😀");
  await waitWordCount(1);
  await forwardWord();
  await word.waitForTimeout(700);
  await word.keyboard.press("Backspace");
  await waitWordCount(2);
  await forwardWord();
  await word.waitForTimeout(700);
  await c.tool("doc_insert_text", { idx: 0, text: "AI癸" });
  await waitWordCount(3);
  assert.equal(await word.evaluate(() => __wordEvents[2].source), "ai");
  await forwardWord();

  async function sourcePost(path, body, token) {
    const response = await fetch(process.env.JW_TEST_SOURCE_URL + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, "Source fixture request failed");
    return response.json();
  }
  const peer = await sourcePost("/api/auth/sign-in/account", {
    account: process.env.JW_TEST_PEER_ACCOUNT,
    password: process.env.JW_TEST_PEER_PASSWORD,
  });
  const pageId = new URL(docs.url()).pathname.split("/").pop();
  const grant = await sourcePost(
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
    const form = document.querySelector("form");
    form.action = g.bootstrapUrl;
    form.querySelector("input").value = g.launchGrant;
    form.submit();
  }, grant);
  await peerPage.waitForURL(/\/workspace\//);
  await peerPage.waitForFunction(
    (text) =>
      document.querySelector("affine-paragraph")?.model?.text?.toString() ===
      text,
    common.text,
    { timeout: 20000 },
  );
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) =>
      el.store.transact(() => {
        el.model.text.delete(0, 1);
        el.model.text.insert("远端子😀", 0);
      }),
    );
  await docs.waitForFunction(() => __cloudEvents.length > 0);
  const changes = await docs.evaluate(() => __cloudEvents);
  assert.equal(changes.length, 1);
  await word.waitForTimeout(500);
  const remote = await word.evaluate(
    (edits) => __wordAdapter.applyRemote(edits),
    changes[0].edits,
  );
  assert.equal(
    remote.status,
    "applied",
    JSON.stringify(await word.evaluate(() => __pauses)),
  );
  common.text = "远端子😀" + common.text.slice(1);
  await word.waitForTimeout(800);
  const events = await word.evaluate(() => __wordEvents);
  assert.deepEqual(
    events.filter((e) => e.source !== "cloud").map((e) => e.source),
    ["word", "word", "ai"],
  );
  assert.equal(
    events.filter((e) => e.source === "cloud").length,
    changes[0].edits.length,
  );
  assert.equal(await docs.evaluate(() => __cloudEvents.length), 1);
  assert.equal(
    await word.evaluate(
      (length) => pad.editor.service.getDocument().readText(0, length),
      common.text.length,
    ),
    common.text,
  );
  const pool = await c.tool("get_pool_status", {}),
    id = pool.open_editors.find(
      (e) => resolve(e.file_path || "/") === wordPath,
    ).file_id;
  await c.tool("save_file", { file_id: id, file_path: wordPath });
  await c.tool("close_file", { file_id: id, force: true });
  await word.reload();
  await word.waitForFunction(
    () => getLocalEditManager?.()?.getLocalEditService?.()?.isFirstChunkApplied,
    null,
    { timeout: 15000 },
  );
  assert.equal(
    await word.evaluate(
      (len) => pad.editor.service.getDocument().readText(0, len),
      common.text.length,
    ),
    common.text,
  );
  assert.equal(
    (await c.tool("doc_resolve_document_structure", { mode: "full", limit: 0 }))
      .nodes[0].paragraph_id,
    para.paragraph_id,
  );
  await docs.reload();
  await docs.waitForFunction(
    (text) =>
      document.querySelector("affine-paragraph")?.model?.text?.toString() ===
      text,
    common.text,
    { timeout: 20000 },
  );
  await peerPage.reload();
  await peerPage.waitForFunction(
    (text) =>
      document.querySelector("affine-paragraph")?.model?.text?.toString() ===
      text,
    common.text,
    { timeout: 20000 },
  );
  assert.equal(
    await docs
      .locator("affine-paragraph")
      .first()
      .evaluate((el) => el.model.id),
    blockId,
  );
  const report = {
    passed: true,
    scope: "one plain paragraph, sequential operations only",
    pageId,
    paragraphId: para.paragraph_id,
    manualWordToTwoNativeClients: true,
    manualWordDeleteToNative: true,
    aiToolToTwoNativeClients: true,
    remoteNativeToSameWordModel: true,
    remoteNativeDeleteToWord: true,
    noEcho: true,
    continuousInputAcrossFormatChangesVerified: false,
    wordSavedAndReopened: true,
    paragraphIdStable: true,
    nativeBlockIdStable: true,
    nativeReloadPersisted: true,
    unsupportedFormatsEnabled: false,
    fullW01ToW16Passed: false,
  };
  if (process.env.JW_TEST_REPORT_PATH)
    fs.writeFileSync(
      process.env.JW_TEST_REPORT_PATH,
      JSON.stringify(report, null, 2),
    );
  console.log(report);
} finally {
  await peerContext?.close();
  await wordBrowser.close();
  await docsBrowser.close();
}

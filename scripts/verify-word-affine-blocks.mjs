/** 只在独占测试浏览器、临时 Word 文件和明确的可丢弃组织中运行；不代表完整 Word 双向验收。 */
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createOfficeWordBlocksAdapter,
  readOfficeWordBlocks,
} from "../apps/desktop/electron/office-word-blocks-adapter.mjs";
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
    "packages/frontend/core/src/utils/jugglework-word-blocks-probe.ts",
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
const wordBrowser = await chromium.connectOverCDP(process.env.JW_TEST_WORD_CDP);
const docsBrowser = await chromium.connectOverCDP(process.env.JW_TEST_DOCS_CDP);
let peerContext;
try {
  const word = wordBrowser.contexts()[0].pages()[0],
    docs = docsBrowser.contexts()[0].pages()[0];
  mcpUrl = new URL("/mcp", word.url()).href;
  assert.equal(new URL(mcpUrl).hostname, "127.0.0.1");
  await c.init();
  await word.reload();
  await word.waitForFunction(
    () => App?.GlobalConfig?.isLocalEditChunkFinish === true,
  );
  await word.evaluate((read) => {
    window.__readBlocks = eval("(" + read + ")");
  }, readOfficeWordBlocks.toString());
  const baseline = await word.evaluate(() => __readBlocks(window));
  for (const kind of ["text", "h1", "h2", "bulleted", "numbered"])
    assert.ok(
      baseline.some((b) => b.kind === kind),
      "Missing fixture kind " + kind,
    );
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
  await docs.keyboard.type("Word blocks verification " + Date.now());
  const bindings = await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, blocks) => {
      if (el.model.props.text.length) throw Error("Blank fixture required");
      const store = el.store,
        parent = store.getParent(el.model),
        Text = el.model.props.text.constructor;
      const bindings = [];
      store.transact(() => {
        for (const block of blocks) {
          const list = ["bulleted", "numbered"].includes(block.kind);
          const id = store.addBlock(
            list ? "affine:list" : "affine:paragraph",
            { type: block.kind, text: new Text(block.text) },
            parent.id,
          );
          bindings.push({ paragraphId: block.id, blockId: id });
        }
        store.deleteBlock(el.model);
      });
      if (bindings.length !== blocks.length)
        throw Error("Native fixture creation incomplete");
      store.transact(() => {
        for (let i = 0; i < blocks.length; i++) {
          const model = store.getBlock(bindings[i].blockId)?.model;
          if (!model) throw Error("Native fixture model unavailable");
          for (const mark of blocks[i].marks)
            model.props.text.format(mark.index, mark.length, {
              bold: mark.bold,
              italic: mark.italic,
            });
        }
      });
      return bindings;
    }, baseline);
  await word.evaluate(
    ({ create, blocks }) => {
      window.__wordEvents = [];
      window.__wordPauses = [];
      window.__adapter = eval("(" + create + ")")(
        {
          blocks,
          onChange: (e) => __wordEvents.push(e),
          onPause: (e) => __wordPauses.push(e),
        },
        window,
        __readBlocks,
      );
    },
    { create: createOfficeWordBlocksAdapter.toString(), blocks: baseline },
  );
  await docs
    .locator("affine-paragraph")
    .first()
    .evaluate(
      (el, { create, bindings }) => {
        window.__nativeEvents = [];
        window.__nativePauses = [];
        window.__probe = eval("(" + create + ")")({
          store: el.store,
          bindings,
          onChange: (e) => __nativeEvents.push(e),
          onPause: (e) => __nativePauses.push(e),
        });
        window.__bindings = bindings;
      },
      { create: native.createNativeWordBlocksProbe.toString(), bindings },
    );
  async function waitWord(minimum) {
    await word.waitForFunction(
      (n) =>
        __wordEvents.filter((e) => e.source !== "cloud").length >= n ||
        __adapter.state() !== "active",
      minimum,
    );
    assert.equal(
      await word.evaluate(() => __adapter.state()),
      "active",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
  }
  let consumed = 0;
  async function forwardWord() {
    const events = await word.evaluate(() => __wordEvents);
    for (const event of events.slice(consumed)) {
      if (event.source === "cloud") continue;
      const result = await docs.evaluate(
        (frames) => __probe.applyLocal(frames),
        event.frames,
      );
      assert.equal(
        result.status,
        "applied",
        JSON.stringify(await docs.evaluate(() => __nativePauses)),
      );
    }
    consumed = events.length;
  }
  await word.locator("#melo-hidden-editor").focus();
  await word.keyboard.press("Control+Home");
  await word.keyboard.insertText("人工😀");
  await waitWord(1);
  await forwardWord();
  await word.waitForTimeout(700);
  await word.keyboard.press("Backspace");
  await waitWord(2);
  await forwardWord();
  await word.waitForTimeout(700);
  let current = await word.evaluate(() => __readBlocks(window));
  const list = current.find((b) => b.kind === "numbered");
  await c.tool("doc_insert_text", { idx: list.start + 1, text: "AI" });
  await waitWord(3);
  await forwardWord();
  current = await word.evaluate(() => __readBlocks(window));
  const body = current.find((b) => b.kind === "text");
  await c.tool("doc_update_text_property", {
    ranges: [{ begin: body.start, end: body.start + 2 }],
    bold: !body.marks[0].bold,
    italic: !body.marks[0].italic,
  });
  await waitWord(4);
  await forwardWord();
  for (const kind of ["bulleted", "h2", "text"]) {
    const count = await word.evaluate(
      () => __wordEvents.filter((e) => e.source !== "cloud").length,
    );
    const block = (await word.evaluate(() => __readBlocks(window))).find(
      (b) => b.kind === kind,
    );
    await c.tool("doc_insert_text", { idx: block.start + 1, text: "AI" });
    await waitWord(count + 1);
    await forwardWord();
  }
  const expected = await word.evaluate(() => __readBlocks(window));
  async function sourcePost(path, body, token) {
    const r = await fetch(process.env.JW_TEST_SOURCE_URL + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: "Bearer " + token } : {}),
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200, "Source fixture request failed");
    return r.json();
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
    const f = document.querySelector("form");
    f.action = g.bootstrapUrl;
    f.querySelector("input").value = g.launchGrant;
    f.submit();
  }, grant);
  await peerPage.waitForURL(/\/workspace\//);
  await peerPage.waitForSelector("affine-paragraph");
  const readNative = (bindings) => {
    const store = document.querySelector("affine-paragraph").store;
    return bindings.map((binding) => {
      const m = store.getBlock(binding.blockId)?.model;
      if (!m) return null;
      const marks = [];
      let index = 0;
      for (const d of m.props.text.yText.toDelta()) {
        const bold = d.attributes?.bold === true,
          italic = d.attributes?.italic === true,
          previous = marks.at(-1);
        if (previous && previous.bold === bold && previous.italic === italic)
          previous.length += d.insert.length;
        else marks.push({ index, length: d.insert.length, bold, italic });
        index += d.insert.length;
      }
      return {
        id: binding.paragraphId,
        text: m.props.text.toString(),
        kind: m.props.type,
        marks,
      };
    });
  };
  const nativeReady = async (page, expected) => {
    await page.waitForFunction(
      ({ src, bindings, expected }) =>
        JSON.stringify(eval("(" + src + ")")(bindings)) ===
        JSON.stringify(expected),
      {
        src: readNative.toString(),
        bindings,
        expected: expected.map(({ start, ...b }) => b),
      },
      { timeout: 20000 },
    );
  };
  await nativeReady(peerPage, expected);
  const target = bindings.find((b) => b.paragraphId === body.id);
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate(
      (el, { id, heading }) => {
        const text = el.store.getBlock(id).model.props.text;
        el.store.transact(() => {
          text.insert("远端😀", 0);
          text.format(0, 4, { bold: true, italic: true });
          text.format(4, 1, { bold: false, italic: false });
          el.store.getBlock(heading).model.props.text.insert("协作", 1);
        });
      },
      { id: target.blockId, heading: bindings[0].blockId },
    );
  await docs.waitForFunction(
    () => __nativeEvents.length >= 2 || __probe.state() !== "active",
  );
  assert.equal(
    await docs.evaluate(() => __probe.state()),
    "active",
    JSON.stringify(await docs.evaluate(() => __nativePauses)),
  );
  await word.waitForTimeout(700);
  const remote = await docs.evaluate(() => __nativeEvents);
  {
    // 同一原生事务涉及不同段落，作为一批校验后回写；busy 不等于已经写入。
    const r = await word.evaluate(
      (frames) => __adapter.applyRemote(frames),
      remote.flatMap((change) => change.frames),
    );
    assert.equal(
      r.status,
      "applied",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
  }
  await word.waitForTimeout(800);
  const beforeFollowing = await word.evaluate(
    () => __wordEvents.filter((e) => e.source !== "cloud").length,
  );
  await word.locator("#melo-hidden-editor").focus();
  await word.keyboard.insertText("后续");
  await waitWord(beforeFollowing + 1);
  await forwardWord();
  await word.waitForTimeout(800);
  assert.equal(
    await docs.evaluate(() => __nativeEvents.length),
    remote.length,
    "Cloud echo",
  );
  const final = await word.evaluate(() => __readBlocks(window));
  const editedKinds = await word.evaluate(() => [
    ...new Set(
      __wordEvents
        .filter((e) => e.source !== "cloud")
        .flatMap((e) => e.frames.map((f) => f.after.kind)),
    ),
  ]);
  const nativeSnapshot = await docs.evaluate(readNative, bindings);
  assert.deepEqual(
    nativeSnapshot,
    final.map(({ start, ...b }) => b),
  );
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
  const reopened = await word.evaluate(
    (src) => eval("(" + src + ")")(window),
    readOfficeWordBlocks.toString(),
  );
  assert.deepEqual(reopened, final);
  for (const page of [docs, peerPage]) {
    await page.reload();
    await page.waitForSelector("affine-paragraph");
    await nativeReady(page, final);
  }
  const report = {
    passed: true,
    scope: "fixed paragraph identities and kinds; sequential text/bold/italic",
    pageId,
    paragraphCount: final.length,
    mappedKinds: [...new Set(final.map((b) => b.kind))],
    editedKinds,
    humanAndAiToTwoNativeClients: true,
    remoteTextAndMarksToWord: true,
    continuedHumanAfterRemote: true,
    noEcho: true,
    savedReopenedWithStableIdsAndMarks: true,
    nativeReloadPersisted: true,
    splitMergeEnabled: false,
    kindChangesEnabled: false,
    fullWordBidirectionalEnabled: false,
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

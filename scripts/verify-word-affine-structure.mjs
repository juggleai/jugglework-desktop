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
const structureSource = fs.readFileSync(
  resolve(
    process.env.JW_TEST_DOCS_REPO,
    "packages/frontend/core/src/utils/jugglework-word-structure-probe.ts",
  ),
  "utf8",
);
const structureNative = await import(
  "data:text/javascript;base64," +
    Buffer.from(
      ts.transpileModule(structureSource, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
    ).toString("base64")
);
try {
  const word = wordBrowser.contexts()[0].pages()[0],
    docs = docsBrowser.contexts()[0].pages()[0];
  mcpUrl = new URL("/mcp", word.url()).href;
  await c.init();
  await word.reload();
  await word.waitForFunction(
    () => App?.GlobalConfig?.isLocalEditChunkFinish === true,
  );
  await word.evaluate((src) => {
    window.__readBlocks = eval("(" + src + ")");
  }, readOfficeWordBlocks.toString());
  const baseline = await word.evaluate(() => __readBlocks(window));
  assert.equal(
    baseline.length,
    1,
    "Disposable fixture must start with one plain paragraph",
  );
  assert.equal(baseline[0].kind, "text");
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
  await docs.keyboard.type("Word structure verification " + Date.now());
  const bindings = await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, blocks) => {
      assertBlank();
      const store = el.store,
        Text = el.model.props.text.constructor,
        parent = store.getParent(el.model);
      let id;
      store.transact(() => {
        id = store.addBlock(
          "affine:paragraph",
          { type: "text", text: new Text(blocks[0].text) },
          parent.id,
        );
        store.deleteBlock(el.model);
      });
      return [{ paragraphId: blocks[0].id, blockId: id }];
      function assertBlank() {
        if (el.model.props.text.length) throw Error("Blank fixture required");
      }
    }, baseline);
  await word.evaluate(
    ({ create, blocks }) => {
      window.__wordStructures = [];
      window.__wordEvents = [];
      window.__wordPauses = [];
      window.__adapter = eval("(" + create + ")")(
        {
          blocks,
          onChange: (e) => __wordEvents.push(e),
          onStructure: (e) => __wordStructures.push(e),
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
        window.__bindings = bindings;
        window.__nativeStructures = [];
        window.__nativePauses = [];
        window.__structure = eval("(" + create + ")")({
          store: el.store,
          bindings,
          onStructure: (e) => __nativeStructures.push(e),
          onPause: (e) => __nativePauses.push(e),
        });
      },
      {
        create: structureNative.createNativeWordStructureProbe.toString(),
        bindings,
      },
    );
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
  const snapshot = () => {
    const e = document.querySelector("affine-paragraph");
    return e.store
      .getParent(e.model)
      .children.map((m) => ({ blockId: m.id, text: m.props.text.toString() }));
  };
  async function converged(expected) {
    for (const page of [docs, peerPage])
      await page.waitForFunction(
        ({ src, expected }) =>
          JSON.stringify(eval("(" + src + ")")().map((b) => b.text)) ===
          JSON.stringify(expected),
        { src: snapshot.toString(), expected: expected.map((b) => b.text) },
        { timeout: 20000 },
      );
  }
  await converged(baseline);
  async function idle() {
    await word.waitForFunction(() => {
      const s = getLocalEditManager().getLocalEditService(),
        c = App.changesetManager;
      return (
        !s.isCommitting &&
        !s.committingQueue.length &&
        !s.isGapFilling &&
        !c.composeCommands.length &&
        !c.localEditCommands.length &&
        !c.inFlightCommands.size &&
        App.GlobalConfig.isLocalEditChunkFinish
      );
    });
  }
  async function fromWord(count) {
    await word.waitForFunction(
      (n) =>
        __wordStructures.filter((e) => e.source !== "cloud").length >= n ||
        __adapter.state() !== "active",
      count,
    );
    assert.equal(
      await word.evaluate(() => __adapter.state()),
      "active",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
    const event = await word.evaluate(
      (n) => __wordStructures.filter((e) => e.source !== "cloud")[n - 1],
      count,
    );
    const result = await docs.evaluate((change) => {
      const r = __structure.applyLocal(change);
      if (r.status === "applied") __bindings = r.bindings;
      return r;
    }, event);
    assert.equal(
      result.status,
      "applied",
      JSON.stringify(await docs.evaluate(() => __nativePauses)),
    );
    await idle();
    await converged(await word.evaluate(() => __readBlocks(window)));
    return event;
  }
  await word.locator("#melo-hidden-editor").focus();
  await word.keyboard.press("Control+Home");
  await word.keyboard.press("ArrowRight");
  await word.keyboard.press("ArrowRight");
  await word.keyboard.press("Enter");
  const split = await fromWord(1);
  assert.equal(split.after[1].id, split.before[0].id);
  await word.keyboard.press("Backspace");
  const merge = await fromWord(2);
  assert.equal(merge.after[0].id, merge.before[1].id);
  let remoteCount = 0;
  async function fromCloud() {
    remoteCount++;
    await docs.waitForFunction(
      (n) => __nativeStructures.length >= n || __structure.state() === "paused",
      remoteCount,
    );
    assert.equal(
      await docs.evaluate(() => __structure.state()),
      "awaiting-word",
      JSON.stringify(await docs.evaluate(() => __nativePauses)),
    );
    const request = await docs.evaluate(
      (n) => __nativeStructures[n - 1],
      remoteCount,
    );
    await idle();
    const result = await word.evaluate(
      (request) => __adapter.applyRemoteStructure(request),
      request,
    );
    assert.equal(
      result.status,
      "applied",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
    const current = await word.evaluate(() =>
      __readBlocks(window).map(({ start, ...b }) => b),
    );
    const adopted = await docs.evaluate((blocks) => {
      const r = __structure.bindCurrent(blocks);
      if (r.status === "applied") __bindings = r.bindings;
      return r;
    }, current);
    assert.equal(
      adopted.status,
      "applied",
      JSON.stringify(await docs.evaluate(() => __nativePauses)),
    );
    await idle();
    await converged(current);
    return result.change;
  }
  async function cloudSplit(index) {
    await peerPage
      .locator("affine-paragraph")
      .first()
      .evaluate((el, index) => {
        const m = el.model,
          s = el.store,
          p = s.getParent(m);
        s.transact(() => {
          const right = m.props.text.split(index);
          s.addBlock(
            "affine:paragraph",
            { type: "text", text: right },
            p.id,
            1,
          );
        });
      }, index);
    return fromCloud();
  }
  async function cloudMerge() {
    await peerPage
      .locator("affine-paragraph")
      .first()
      .evaluate((el) => {
        const s = el.store,
          p = s.getParent(el.model),
          [left, right] = p.children;
        s.transact(() => {
          left.props.text.join(right.props.text);
          s.deleteBlock(right);
        });
      });
    return fromCloud();
  }
  const middle = Array.from(baseline[0].text).slice(0, 3).join("").length;
  await cloudSplit(middle);
  await cloudMerge();
  await cloudSplit(0);
  await cloudMerge();
  const length = (await word.evaluate(() => __readBlocks(window)))[0].text
    .length;
  await cloudSplit(length);
  await cloudMerge();
  assert.equal(
    await word.evaluate(
      () => __wordStructures.filter((e) => e.source !== "cloud").length,
    ),
    2,
    "Structure echo",
  );
  assert.equal(
    await docs.evaluate(() => __nativeStructures.length),
    6,
    "Structure echo",
  );
  // 结构观察器和固定文本观察器分别实验，正式组合与结构并发尚未开放。
  await docs
    .locator("affine-paragraph")
    .first()
    .evaluate((el, create) => {
      __structure.dispose();
      window.__nativeEvents = [];
      window.__textProbe = eval("(" + create + ")")({
        store: el.store,
        bindings: __bindings,
        onChange: (e) => __nativeEvents.push(e),
        onPause: (e) => __nativePauses.push(e),
      });
    }, native.createNativeWordBlocksProbe.toString());
  // 原生同步在 SharedWorker 中；只对另一成员所属 worker 注入断网，不停止服务端或 Owner。
  const pageCdp = await peerContext.newCDPSession(peerPage);
  const { targetInfo } = await pageCdp.send("Target.getTargetInfo");
  const browserCdp = await docsBrowser.newBrowserCDPSession();
  const { targetInfos } = await browserCdp.send("Target.getTargets");
  const worker = targetInfos.find(
    (t) =>
      t.type === "shared_worker" &&
      t.browserContextId === targetInfo.browserContextId &&
      /\/nbstore-/.test(t.url),
  );
  assert.ok(worker, "Isolated peer nbstore SharedWorker required");
  const { sessionId } = await browserCdp.send("Target.attachToTarget", {
    targetId: worker.targetId,
    flatten: false,
  });
  let commandId = 0;
  const pending = new Map();
  browserCdp.on("Target.receivedMessageFromTarget", (event) => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message),
      item = pending.get(message.id);
    if (item) {
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(Error(message.error.message));
      else item.resolve(message.result);
    }
  });
  async function workerCommand(method, params = {}) {
    const id = ++commandId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("Worker CDP timeout"));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
    });
    await browserCdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return result;
  }
  await workerCommand("Network.enable");
  await workerCommand("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  // 离线模拟不会终止已建立的 WebSocket；关闭该测试 worker 的现有连接并阻止重建，保留原生离线存储。
  const prototype = await workerCommand("Runtime.evaluate", {
    expression: "WebSocket.prototype",
  });
  const sockets = await workerCommand("Runtime.queryObjects", {
    prototypeObjectId: prototype.result.objectId,
    objectGroup: "jw-peer-offline",
  });
  const closed = await workerCommand("Runtime.callFunctionOn", {
    objectId: sockets.objects.objectId,
    functionDeclaration:
      "function(){let count=0;for(const socket of this){if(socket.readyState===0||socket.readyState===1){socket.close();count++}}return count}",
    returnByValue: true,
  });
  assert.ok(closed.result.value > 0, "Active peer native socket required");
  await workerCommand("Runtime.evaluate", {
    expression:
      'globalThis.__jwOriginalSocket=WebSocket;globalThis.WebSocket=class extends __jwOriginalSocket{constructor(...args){throw new Error("test peer offline")}}',
  });
  await peerPage
    .locator("affine-paragraph")
    .first()
    .evaluate((el) =>
      el.store.transact(() => el.model.props.text.insert("云😀", 1)),
    );
  await docs.waitForTimeout(600);
  assert.deepEqual(
    (await docs.evaluate(snapshot)).map((b) => b.text),
    (await word.evaluate(() => __readBlocks(window))).map((b) => b.text),
    "Peer isolation must precede concurrent edits",
  );
  await word.locator("#melo-hidden-editor").focus();
  await word.keyboard.press("Control+Home");
  await word.keyboard.press("ArrowRight");
  await word.keyboard.insertText("本地😀");
  await word.waitForFunction(
    () =>
      __wordEvents.some((e) => e.source === "word") ||
      __adapter.state() !== "active",
  );
  assert.equal(
    await word.evaluate(() => __adapter.state()),
    "active",
    JSON.stringify(await word.evaluate(() => __wordPauses)),
  );
  const local = await word.evaluate(() =>
    __wordEvents.filter((e) => e.source !== "cloud"),
  );
  for (const change of local) {
    const r = await docs.evaluate(
      (frames) => __textProbe.applyLocal(frames),
      change.frames,
    );
    assert.equal(
      r.status,
      "applied",
      JSON.stringify(await docs.evaluate(() => __nativePauses)),
    );
  }
  await idle();
  await workerCommand("Runtime.evaluate", {
    expression:
      "globalThis.WebSocket=__jwOriginalSocket;delete globalThis.__jwOriginalSocket",
  });
  await workerCommand("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await workerCommand("Runtime.releaseObjectGroup", {
    objectGroup: "jw-peer-offline",
  });
  await workerCommand("Network.disable");
  await browserCdp.send("Target.detachFromTarget", { sessionId });
  await browserCdp.detach();
  await pageCdp.detach();
  await docs.waitForFunction(
    () => __nativeEvents.length > 0 || __textProbe.state() !== "active",
    null,
    { timeout: 60000 },
  );
  assert.equal(
    await docs.evaluate(() => __textProbe.state()),
    "active",
    JSON.stringify(await docs.evaluate(() => __nativePauses)),
  );
  await idle();
  const remote = await docs.evaluate(() => __nativeEvents);
  for (const change of remote) {
    const r = await word.evaluate(
      (frames) => __adapter.applyRemote(frames),
      change.frames,
    );
    assert.equal(
      r.status,
      "applied",
      JSON.stringify(await word.evaluate(() => __wordPauses)),
    );
    await idle();
  }
  const final = await word.evaluate(() => __readBlocks(window));
  assert.ok(final[0].text.includes("本地😀") && final[0].text.includes("云😀"));
  await converged(final);
  assert.equal(
    await docs.evaluate(() => __nativeEvents.length),
    remote.length,
    "Text echo",
  );
  const finalBindings = await docs.evaluate(() => __bindings);
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
  await converged(final);
  assert.deepEqual(
    (await docs.evaluate(snapshot)).map((b) => b.blockId),
    finalBindings.map((b) => b.blockId),
  );
  const report = {
    passed: true,
    pageId,
    wordHumanSplitMerge: true,
    cloudSplitMergeOffsets: [0, middle, length],
    wordRetainsRightId: true,
    nativeRetainsLeftBlock: true,
    remappedBindings: true,
    noEcho: true,
    savedReopened: true,
    twoNativeReloads: true,
    nativeConcurrentTextMerge: true,
    networkPartitionVerified: true,
    bridgeConcurrencyWithUnforwardedWordEdits: false,
    structureConcurrencyEnabled: false,
    productionUiOrIpcMounted: false,
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

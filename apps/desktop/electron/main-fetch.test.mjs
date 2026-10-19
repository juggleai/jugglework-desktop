import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMainProcessFetch, isLoopbackHttpUrl, mainProcessFetchBody, mainProcessFetchResponse, selectMainProcessFetch } from "./main-fetch.mjs";

describe("main-process fetch transport", () => {
  it("recognizes supported loopback HTTP URLs", () => {
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:53078/workspaces"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost:53078/health"), true);
    assert.equal(isLoopbackHttpUrl("http://[::1]:53078/health"), true);
    assert.equal(isLoopbackHttpUrl("https://work.juggle.im/api"), false);
    assert.equal(isLoopbackHttpUrl("not a url"), false);
  });

  it("uses Node fetch for loopback and Electron fetch for external URLs", () => {
    const nodeFetch = () => "node";
    const electronFetch = () => "electron";

    assert.equal(
      selectMainProcessFetch("http://127.0.0.1:53078/health", { nodeFetch, electronFetch }),
      nodeFetch,
    );
    assert.equal(
      selectMainProcessFetch("https://work.juggle.im/api", { nodeFetch, electronFetch }),
      electronFetch,
    );
  });

  it("routes both URL objects and strings through the loopback-aware wrapper", async () => {
    const calls = [];
    const fetcher = createMainProcessFetch({
      nodeFetch: async (input) => { calls.push(["node", String(input)]); return new Response("{}"); },
      electronFetch: async (input) => { calls.push(["electron", String(input)]); return new Response("{}"); },
    });

    await fetcher(new URL("http://127.0.0.1:53078/health"));
    await fetcher("http://localhost:53078/health");
    await fetcher(new URL("http://[::1]:53078/health"));
    await fetcher("https://work.juggle.im/api");
    assert.deepEqual(calls.map(([transport]) => transport), ["node", "node", "node", "electron"]);
  });

  it("preserves binary upload bytes and existing string request bodies", () => {
    const bytes = Uint8Array.of(0, 255, 42, 128);
    const cloned = structuredClone({ bodyBytes: bytes });
    const body = mainProcessFetchBody(cloned);
    assert.ok(Buffer.isBuffer(body));
    assert.deepEqual(body, Buffer.from(bytes));
    assert.equal(mainProcessFetchBody({ body: '{"ok":true}' }), '{"ok":true}');
    assert.equal(mainProcessFetchBody({}), undefined);
  });
});


it("二进制响应跨 IPC 后保留 ZIP 及非 UTF-8 字节，同时兼容 JSON 和空响应", async () => {
  const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80, 0xfe);
  const result = structuredClone(await mainProcessFetchResponse(new Response(bytes)));
  const response = new Response(result.body, result);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  const json = await mainProcessFetchResponse(Response.json({ name: "中文" }));
  assert.deepEqual(await new Response(json.body, json).json(), { name: "中文" });
  const empty = await mainProcessFetchResponse(new Response(null, { status: 204 }));
  assert.equal(empty.body.byteLength, 0);
});

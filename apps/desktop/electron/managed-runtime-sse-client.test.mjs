import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createManagedRuntimeSseClient } from "./managed-runtime-sse-client.mjs";

const access = { baseUrl: "http://127.0.0.1:4096", clientToken: "runtime-token" };
const immediateTimers = {
  setTimeout(callback) { queueMicrotask(callback); return callback; },
  clearTimeout() {},
};

function streamResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("managed runtime SSE client", () => {
  it("frames chunked CRLF records, comments, and multiline data", async () => {
    const controller = new AbortController();
    const events = [];
    const client = createManagedRuntimeSseClient({
      getAccess: () => access,
      fetcher: async () => streamResponse([": ping\r\nid: 4\r\ndata: {\"value\":\r\n", "data: 1}\r\n\r\n"]),
      timers: immediateTimers,
    });
    await client.subscribe({
      workspaceId: "ws_1",
      signal: controller.signal,
      onReconnectGap: () => {},
      onEvent: (event) => { events.push(event); controller.abort(); },
    });
    assert.deepEqual(events, [{ value: 1 }]);
  });

  it("sends the committed cursor on reconnect and reports a gap", async () => {
    const controller = new AbortController();
    const headers = [];
    const gaps = [];
    let calls = 0;
    const client = createManagedRuntimeSseClient({
      getAccess: () => access,
      fetcher: async (_url, init) => {
        headers.push(init.headers);
        calls += 1;
        if (calls === 1) return streamResponse(["id: cursor-7\ndata: {\"ok\":true}\n\n"]);
        controller.abort();
        throw new Error("aborted");
      },
      timers: immediateTimers,
    });
    await client.subscribe({
      workspaceId: "ws_1",
      signal: controller.signal,
      onEvent: () => {},
      onReconnectGap: (reason) => { gaps.push(reason); },
    });
    assert.equal(headers[0]["Last-Event-ID"], undefined);
    assert.equal(headers[1]["Last-Event-ID"], "cursor-7");
    assert.deepEqual(gaps, ["sequence_gap"]);
  });

  it("does not commit an event ID when onEvent fails", async () => {
    const controller = new AbortController();
    const headers = [];
    let calls = 0;
    const client = createManagedRuntimeSseClient({
      getAccess: () => access,
      fetcher: async (_url, init) => {
        headers.push(init.headers);
        calls += 1;
        if (calls === 1) return streamResponse(["id: uncommitted\ndata: {\"ok\":true}\n\n"]);
        controller.abort();
        throw new Error("aborted");
      },
      timers: immediateTimers,
    });
    await client.subscribe({
      workspaceId: "ws_1",
      signal: controller.signal,
      onReconnectGap: () => {},
      onEvent: () => { throw new Error("consumer failed"); },
    });
    assert.equal(headers[1]["Last-Event-ID"], undefined);
  });

  it("aborts an in-flight request and resolves without reconnecting", async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = createManagedRuntimeSseClient({
      getAccess: () => access,
      fetcher: async (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });
    const subscription = client.subscribe({ workspaceId: "ws_1", signal: controller.signal, onEvent: () => {}, onReconnectGap: () => {} });
    await Promise.resolve();
    controller.abort();
    await subscription;
    assert.equal(calls, 1);
  });
});

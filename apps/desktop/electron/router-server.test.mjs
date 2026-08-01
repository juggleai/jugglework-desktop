import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import { createRouterServer, normalizeSendMessageArgs } from "./router-server.mjs";

test("normalizeSendMessageArgs converts legacy text messages without mutating input", () => {
  const input = { conversationId: "c1", message: { name: "text/plain", content: { text: "hello" } } };
  assert.deepEqual(normalizeSendMessageArgs(input), {
    conversationId: "c1",
    message: { name: "jg:text", content: { content: "hello" } },
  });
  assert.equal(input.message.name, "text/plain");
});

test("router health and invoke endpoints use the JuggleChat envelope", async (t) => {
  let received = null;
  const server = createRouterServer(async (payload) => {
    received = payload;
    return { ok: true, data: { accepted: true } };
  }, { port: 0 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.port, port);

  const response = await fetch(`http://127.0.0.1:${port}/router`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: " jugglechat-im-sdk ",
      module: "message",
      action: "sendMessage",
      args: { message: { name: "text/plain", content: "hello" } },
    }),
  });
  assert.deepEqual(await response.json(), { ok: true, data: { accepted: true } });
  assert.ok(received);
  const payload = /** @type {any} */ (received);
  assert.equal(payload.source, "jugglechat-im-sdk");
  assert.deepEqual(payload.args.message, { name: "jg:text", content: { content: "hello" } });
  assert.match(payload.requestId, /^[0-9a-f-]{36}$/);
});

test("router rejects malformed requests before invoking the renderer", async (t) => {
  let invokes = 0;
  const server = createRouterServer(async () => {
    invokes += 1;
    return { ok: true };
  }, { port: 0 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  const response = await fetch(`http://127.0.0.1:${port}/router`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "jugglechat-im-sdk", module: "message" }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "MISSING_FIELDS");
  assert.equal(invokes, 0);
});

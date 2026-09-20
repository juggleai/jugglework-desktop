import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { JuggleWorkApiClient, JuggleWorkApiError } from "../src/api.js";
import { createSignalController, validateHealthPayload } from "../src/args.js";

test("API client sends bearer authentication and decodes errors", async () => {
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer secret") {
      response.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "unauthorized", message: "bad auth" }));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, version: "test" }));
      return;
    }
    response.writeHead(409, { "Content-Type": "application/json" }).end(JSON.stringify({ code: "conflict", message: "conflicted" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const api = new JuggleWorkApiClient(`http://127.0.0.1:${address.port}`, "secret", null);
  try {
    assert.equal((await api.health()).version, "test");
    await assert.rejects(api.status(), (error: unknown) => {
      assert.ok(error instanceof JuggleWorkApiError);
      assert.equal(error.code, "conflict");
      assert.equal(error.status, 409);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("health validation requires ok=true and a non-empty version", () => {
  assert.doesNotThrow(() => validateHealthPayload({ ok: true, version: "1.2.3" }));
  assert.throws(() => validateHealthPayload({ ok: false, version: "1.2.3" }), /ok=true with a version/);
  assert.throws(() => validateHealthPayload({ ok: true, version: "" }), /ok=true with a version/);
  assert.throws(() => validateHealthPayload("healthy"), /invalid health response/);
});

test("signal controller aborts an active run and shuts down contextually", async () => {
  let aborts = 0;
  const shutdowns: Array<[string, number]> = [];
  const forced: number[] = [];
  const signals = createSignalController({
    hasActiveRun: () => true,
    abortActiveRun: async () => { aborts += 1; },
    beginShutdown: (signal, code) => shutdowns.push([signal, code]),
    forceExit: (code) => forced.push(code),
  });

  signals.handle("SIGINT");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(aborts, 1);
  assert.deepEqual(shutdowns, [["SIGINT", 130]]);
  signals.handle("SIGINT");
  assert.deepEqual(forced, [130]);
  signals.handle("SIGTERM");
  assert.deepEqual(forced, [130, 143]);
});

test("termination signals begin bounded shutdown even with an active run", () => {
  for (const [signal, expectedCode] of [["SIGHUP", 129], ["SIGTERM", 143]] as const) {
    const shutdowns: Array<[string, number]> = [];
    const signals = createSignalController({
      hasActiveRun: () => true,
      abortActiveRun: async () => {},
      beginShutdown: (received, code) => shutdowns.push([received, code]),
      forceExit: () => {},
    });
    signals.handle(signal);
    assert.deepEqual(shutdowns, [[signal, expectedCode]]);
  }
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import {
  CodexAppServerError,
  createCodexAppServerClient,
} from "./codex-app-server-client.mjs";

function createMockChild(options = {}) {
  /** @type {any} */
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = options.pid ?? 4242;
  child.exitCode = null;
  child.killed = false;
  child.killSignals = [];
  child.kill = (signal = "SIGTERM") => {
    child.killed = true;
    child.killSignals.push(signal);
    if (options.exitOnKill !== false) {
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("exit", 0, signal);
      });
    }
    return true;
  };
  return child;
}

function harness(options = {}) {
  const child = createMockChild(options.childOptions);
  const calls = [];
  const sent = [];
  let inputBuffer = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    inputBuffer += chunk;
    while (true) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline).trim();
      inputBuffer = inputBuffer.slice(newline + 1);
      if (line) sent.push(JSON.parse(line));
    }
  });
  const client = createCodexAppServerClient({
    requestTimeoutMs: 100,
    ...options.clientOptions,
    spawnProcess: (command, args, spawnOptions) => {
      calls.push({ command, args, options: spawnOptions });
      return child;
    },
  });
  return { child, client, calls, sent };
}

async function until(predicate, message = "condition was not met") {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function emitMessage(child, message) {
  child.stdout.write(`${JSON.stringify(message)}\n`);
}

describe("Codex App Server client", () => {
  it("spawns without a shell and completes initialize before sending initialized", async () => {
    const { child, client, calls, sent } = harness();
    const initialized = client.initialize({
      clientInfo: { name: "test-client", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    await until(() => sent.length === 1);
    assert.deepEqual(sent[0], {
      id: 1,
      method: "initialize",
      params: {
        clientInfo: { name: "test-client", version: "1.0.0" },
        capabilities: { experimentalApi: true },
      },
    });
    assert.equal(calls[0].command, "codex");
    assert.deepEqual(calls[0].args, ["app-server", "--stdio"]);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);

    emitMessage(child, { id: 1, result: { serverInfo: { name: "codex", version: "0.147.0" } } });
    assert.deepEqual(await initialized, { serverInfo: { name: "codex", version: "0.147.0" } });
    await until(() => sent.length === 2);
    assert.deepEqual(sent[1], { method: "initialized", params: {} });
    await client.close();
  });

  it("routes responses, notifications and server requests independently", async () => {
    const { child, client, sent } = harness();
    const notifications = [];
    client.onNotification((notification) => notifications.push(notification));
    client.onNotification(() => {
      throw new Error("consumer failure must be isolated");
    });
    client.onRequest("item/commandExecution/requestApproval", async (params) => ({ decision: params.expected }));

    const request = client.request("thread/start", { cwd: "/workspace" });
    await until(() => sent.length === 1);
    emitMessage(child, { method: "thread/started", params: { thread: { id: "thr_1" } } });
    emitMessage(child, { id: "approval_1", method: "item/commandExecution/requestApproval", params: { expected: "decline" } });
    emitMessage(child, { id: 1, result: { thread: { id: "thr_1" } } });

    assert.deepEqual(await request, { thread: { id: "thr_1" } });
    await until(() => sent.length === 2);
    assert.deepEqual(notifications, [{ method: "thread/started", params: { thread: { id: "thr_1" } } }]);
    assert.deepEqual(sent[1], { id: "approval_1", result: { decision: "decline" } });
    await client.close();
  });

  it("returns method-not-found for unsupported server requests", async () => {
    const { child, client, sent } = harness();
    client.start();
    emitMessage(child, { id: 7, method: "unsupported/request", params: {} });
    await until(() => sent.length === 1);
    assert.equal(sent[0].id, 7);
    assert.equal(sent[0].error.code, -32601);
    assert.match(sent[0].error.message, /unsupported\/request/);
    await client.close();
  });

  it("maps JSON-RPC errors and request timeouts to bounded client errors", async () => {
    const { child, client, sent } = harness({ clientOptions: { requestTimeoutMs: 10 } });
    const rejected = client.request("thread/start", {});
    await until(() => sent.length === 1);
    emitMessage(child, { id: 1, error: { code: -32602, message: "invalid params", data: { field: "cwd" } } });
    await assert.rejects(rejected, (error) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, -32602);
      assert.deepEqual(error.data, { field: "cwd" });
      return true;
    });

    await assert.rejects(client.request("turn/start", {}), (error) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, "request_timeout");
      assert.equal(error.data.method, "turn/start");
      return true;
    });
    await client.close();
  });

  it("reports invalid JSON without breaking subsequent protocol messages", async () => {
    const protocolErrors = [];
    const { child, client, sent } = harness({
      clientOptions: { onProtocolError: (error) => protocolErrors.push(error) },
    });
    const request = client.request("model/list", {});
    await until(() => sent.length === 1);
    child.stdout.write("{invalid}\n");
    emitMessage(child, { id: 1, result: { data: [] } });
    assert.deepEqual(await request, { data: [] });
    assert.equal(protocolErrors.length, 1);
    assert.equal(protocolErrors[0].code, "invalid_json");
    await client.close();
  });

  it("rejects pending work on exit and retains only a bounded stderr tail", async () => {
    const { child, client, sent } = harness({ clientOptions: { stderrLimit: 12 } });
    const request = client.request("thread/start", {});
    await until(() => sent.length === 1);
    child.stderr.write("secret-prefix-diagnostic-tail");
    child.exitCode = 9;
    child.emit("exit", 9, null);
    await assert.rejects(request, (error) => {
      assert.ok(error instanceof CodexAppServerError);
      assert.equal(error.code, "runtime_exited");
      assert.equal(error.data.code, 9);
      assert.equal(error.data.stderrTail, "gnostic-tail");
      return true;
    });
    assert.equal(client.snapshot().stderrTail, "gnostic-tail");
  });

  it("closes idempotently and force-kills a process that ignores SIGTERM", async () => {
    const { child, client } = harness({ childOptions: { exitOnKill: false } });
    client.start();
    const first = client.close({ forceAfterMs: 5 });
    const second = client.close({ forceAfterMs: 5 });
    assert.equal(first, second);
    await first;
    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
    assert.equal(client.snapshot().closed, true);
    assert.throws(() => client.start(), (error) => error instanceof CodexAppServerError && error.code === "client_closed");
  });
});

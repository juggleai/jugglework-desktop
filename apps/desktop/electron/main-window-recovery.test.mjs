import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { installMainWindowRecovery } from "./main-window-recovery.mjs";

function fixture() {
  let reloads = 0;
  let nextTimer = 1;
  const timers = new Map();
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    getOSProcessId: () => 99,
    reload: () => { reloads += 1; },
  });
  const window = Object.assign(new EventEmitter(), {
    id: 7,
    webContents,
    isDestroyed: () => false,
  });
  return {
    window,
    reloads: () => reloads,
    setTimeoutFn(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeoutFn(id) {
      timers.delete(id);
    },
    runTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const callback of callbacks) callback();
    },
  };
}

test("a transient renderer stall does not reload the main window", async () => {
  const f = fixture();
  installMainWindowRecovery(f.window, {
    setTimeoutFn: f.setTimeoutFn,
    clearTimeoutFn: f.clearTimeoutFn,
  });
  f.window.emit("unresponsive");
  f.window.emit("responsive");
  f.runTimers();
  await Promise.resolve();
  assert.equal(f.reloads(), 0);
});

test("a sustained live stall is diagnosed without reloading or interrupting a session", async () => {
  const f = fixture();
  const order = [];
  installMainWindowRecovery(f.window, {
    beforeReload: async () => { order.push("runtime"); },
    record: (event) => order.push(event),
    setTimeoutFn: f.setTimeoutFn,
    clearTimeoutFn: f.clearTimeoutFn,
  });
  f.window.emit("unresponsive");
  f.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reloads(), 0);
  assert.equal(order.includes("runtime"), false);
  assert.ok(order.includes("main.recovery.deferred"));
});

test("renderer exit reloads even if runtime recovery fails", async () => {
  const f = fixture();
  const records = [];
  installMainWindowRecovery(f.window, {
    beforeReload: async () => { throw new Error("runtime unavailable"); },
    record: (event) => records.push(event),
    setTimeoutFn: f.setTimeoutFn,
    clearTimeoutFn: f.clearTimeoutFn,
  });
  f.window.webContents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 9 });
  f.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reloads(), 1);
  assert.ok(records.includes("main.recovery.failed"));
});

test("renderer exit recovery is rate limited and reopens after the attempt window", async () => {
  const f = fixture();
  let now = 0;
  const recovery = installMainWindowRecovery(f.window, { now: () => now,
    setTimeoutFn: f.setTimeoutFn, clearTimeoutFn: f.clearTimeoutFn });
  for (let i = 0; i < 3; i++) {
    f.window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    f.runTimers();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(f.reloads(), 2);
  now = 10 * 60_000;
  f.window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  f.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.reloads(), 3);
  recovery.dispose();
});

for (const finish of ["responsive", "did-finish-load", "closed"]) {
  test(`${finish} cancels an in-flight asynchronous renderer recovery`, async () => {
    const f = fixture();
    let release = () => {};
    const pending = new Promise((resolve) => { release = () => resolve(undefined); });
    const recovery = installMainWindowRecovery(f.window, { beforeReload: () => pending,
      setTimeoutFn: f.setTimeoutFn, clearTimeoutFn: f.clearTimeoutFn });
    f.window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    f.runTimers();
    if (finish === "did-finish-load") f.window.webContents.emit(finish);
    else f.window.emit(finish);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.reloads(), 0);
    recovery.dispose();
    assert.equal(f.window.listenerCount("unresponsive"), 0);
    assert.equal(f.window.listenerCount("closed"), 0);
    assert.equal(f.window.webContents.listenerCount("render-process-gone"), 0);
  });
}

test("main integration never restarts a session runtime on renderer pressure", async () => {
  const { readFile } = await import("node:fs/promises");
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const integration = main.slice(main.indexOf("const windowRecovery ="), main.indexOf("ensureJuggleChatRouterServer();", main.indexOf("const windowRecovery =")));
  assert.match(integration, /installMainWindowRecovery/);
  assert.doesNotMatch(integration, /engineRestart|juggleworkServerRestart|beforeReload/);
});

test("an unavailable renderer reload is contained without an unhandled rejection", async () => {
  const f = fixture();
  const records = [];
  f.window.webContents.reload = () => { throw new Error("renderer unavailable"); };
  installMainWindowRecovery(f.window, { record: (event) => records.push(event),
    setTimeoutFn: f.setTimeoutFn, clearTimeoutFn: f.clearTimeoutFn });
  f.window.webContents.emit("render-process-gone", {}, { reason: "crashed" });
  f.runTimers();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(records.includes("main.recovery.reload-failed"));
});

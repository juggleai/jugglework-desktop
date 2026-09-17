import assert from "node:assert/strict";
import test from "node:test";

import { createJoinableCleanup, waitForQuitCleanup } from "./quit-cleanup.mjs";

test("concurrent cleanup callers join the same in-flight work", async () => {
  let calls = 0;
  let finish = () => {};
  const barrier = new Promise((resolve) => { finish = () => resolve(undefined); });
  const cleanup = createJoinableCleanup(async () => {
    calls += 1;
    await barrier;
  });

  const first = cleanup();
  const second = cleanup();
  assert.equal(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await first;
  await cleanup();
  assert.equal(calls, 2);
});

test("a failed joinable cleanup can be retried", async () => {
  let calls = 0;
  const cleanup = createJoinableCleanup(async () => {
    calls += 1;
    if (calls === 1) throw new Error("cleanup failed");
  });

  await assert.rejects(cleanup(), /cleanup failed/);
  await cleanup();
  assert.equal(calls, 2);
});

test("rejects a non-function joinable cleanup", () => {
  assert.throws(() => createJoinableCleanup(null), /must be a function/);
});

test("waits for every graceful quit cleanup task", async () => {
  const result = await waitForQuitCleanup([
    Promise.resolve("stopped"),
    Promise.reject(new Error("best-effort cleanup failed")),
  ]);
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.results.map((entry) => entry.status), ["fulfilled", "rejected"]);
});

test("bounds a stuck cleanup task so the updater can exit", async () => {
  let releaseTimeout = () => {};
  const timeoutSignal = new Promise((resolve) => { releaseTimeout = () => resolve(undefined); });
  const never = new Promise(() => {});
  const resultPromise = waitForQuitCleanup([never], {
    timeoutMs: 10_000,
    setTimeoutFn(callback) {
      void timeoutSignal.then(callback);
      return 7;
    },
    clearTimeoutFn() {},
  });
  releaseTimeout();
  assert.deepEqual(await resultPromise, { timedOut: true, results: [] });
});

test("rejects invalid cleanup inputs", async () => {
  await assert.rejects(waitForQuitCleanup(null), /must be an array/);
  await assert.rejects(waitForQuitCleanup([], { timeoutMs: 0 }), /must be positive/);
});

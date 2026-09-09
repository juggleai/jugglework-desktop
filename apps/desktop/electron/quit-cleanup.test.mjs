import assert from "node:assert/strict";
import test from "node:test";

import { waitForQuitCleanup } from "./quit-cleanup.mjs";

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
